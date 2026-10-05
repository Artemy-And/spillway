import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { apiKeys, models, providers, requestLogs, responseCache } from '../db/schema.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { json, testApp } from '../testing.ts';

// An upstream that counts its calls and never answers the same way twice.
let calls = 0;
const upstream = new Hono()
  .post('/v1/chat/completions', async (c) => {
    calls++;
    const body = await c.req.json();
    const usage = { prompt_tokens: 1000, completion_tokens: 100 };
    if (body.stream) {
      return streamSSE(c, async (stream) => {
        const chunk = { id: 'c', object: 'chat.completion.chunk', created: 0, model: body.model };
        await stream.writeSSE({
          data: JSON.stringify({
            ...chunk,
            choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
          }),
        });
        await stream.writeSSE({ data: JSON.stringify({ ...chunk, choices: [], usage }) });
        await stream.writeSSE({ data: '[DONE]' });
      });
    }
    return c.json({
      id: `chatcmpl-${calls}`,
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `answer ${calls}` } }],
      usage,
    });
  })
  .post('/v1/embeddings', async (c) => {
    calls++;
    return c.json({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [calls, 0] }],
      model: 'e',
      usage: { prompt_tokens: 50, total_tokens: 50 },
    });
  });

let server: ReturnType<typeof serve>;
let t: Awaited<ReturnType<typeof testApp>>;
let admin = '';
const keys: string[] = [];

before(async () => {
  server = serve({ fetch: upstream.fetch, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  t = await testApp();
  admin = await t.setupAdmin();
  const [provider] = await t.ctx.db
    .insert(providers)
    .values({ name: 'OpenAI', kind: 'openai', baseUrl: url })
    .returning();
  await t.ctx.db.insert(models).values([
    {
      name: 'gpt',
      providerId: provider!.id,
      upstreamModel: 'gpt-5-mini',
      inputPrice: 2,
      outputPrice: 10,
    },
    { name: 'embed', providerId: provider!.id, upstreamModel: 'e', inputPrice: 1, outputPrice: 0 },
  ]);
  for (const name of ['first', 'second']) {
    const created = newGatewayKey();
    await t.ctx.db
      .insert(apiKeys)
      .values({ name, kind: 'agent', prefix: created.prefix, hash: created.hash });
    keys.push(created.key);
  }
});

after(() => server.close());

beforeEach(async () => {
  await t.ctx.db.delete(responseCache);
  await t.ctx.settings.update({ cache: { enabled: true, ttlHours: 24 } });
});

const ask = (
  content: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  key = keys[0],
) =>
  t.app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify({ model: 'gpt', messages: [{ role: 'user', content }], ...extra }),
  });

async function lastLog() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rows = await t.ctx.db.select().from(requestLogs).all();
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
}

test('off by default: every request goes to the provider', async () => {
  await t.ctx.settings.update({ cache: { enabled: false, ttlHours: 24 } });
  const before = calls;
  await ask('same');
  await ask('same');
  assert.equal(calls, before + 2);
});

test('a repeated request is answered from the cache, and the saving is recorded', async () => {
  const first = await ask('classify this ticket', { temperature: 0 });
  assert.equal(first.headers.get('x-spillway-cache'), 'miss');
  const answer = await json(first);
  await lastLog();
  const before = calls;

  const again = await ask('classify this ticket', { temperature: 0, user: 'someone-else' });
  assert.equal(calls, before, 'the provider was not called');
  assert.equal(again.headers.get('x-spillway-cache'), 'hit');
  assert.deepEqual(await json(again), answer);
  const log = await lastLog();
  assert.equal(log.ruleId, 'cache');
  assert.equal(log.costUsd, 0);
  assert.equal(log.savedUsd, (1000 * 2 + 100 * 10) / 1e6);
  assert.equal(log.trace.at(-1)?.code, 'cacheHit');
  assert.ok(!log.trace.some((step) => step.code === 'sentTo'));

  const overview = await json(await t.get('/admin/api/overview', admin));
  assert.equal(overview.savedCache, log.savedUsd);
  assert.equal(overview.saved, 0, 'not counted as a local-model saving');
});

test('other parameters, other keys, streams and no-cache all miss', async () => {
  await ask('q');
  await lastLog();
  const before = calls;
  await ask('q', { temperature: 1 });
  await ask('q', {}, {}, keys[1]);
  await ask('q', {}, { 'cache-control': 'no-cache' });
  const streamed = await ask('q', { stream: true });
  await streamed.text();
  assert.equal(calls, before + 4);
});

test('prompts with personal data are never stored', async () => {
  await ask('mail anna@example.com about it');
  await lastLog();
  const before = calls;
  await ask('mail anna@example.com about it');
  assert.equal(calls, before + 1);
});

test('expired answers are not used', async () => {
  await ask('old');
  await lastLog();
  await t.ctx.db.update(responseCache).set({ expiresAt: new Date(Date.now() - 1000) });
  const before = calls;
  await ask('old');
  assert.equal(calls, before + 1);
});

test('embeddings of the same text come from the cache', async () => {
  const embed = () =>
    t.app.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keys[0]}` },
      body: JSON.stringify({ model: 'embed', input: 'a document' }),
    });
  const first = await json(await embed());
  const before = calls;
  const again = await embed();
  assert.equal(calls, before);
  assert.equal(again.headers.get('x-spillway-cache'), 'hit');
  assert.deepEqual(await json(again), first);
});

test('admins see how much is cached and can clear it', async () => {
  await ask('one');
  await lastLog();
  await ask('one');
  const stats = await json(await t.get('/admin/api/cache', admin));
  assert.deepEqual(stats, { entries: 1, hits: 1 });
  await t.send('/admin/api/cache', undefined, admin, 'DELETE');
  assert.equal((await json(await t.get('/admin/api/cache', admin))).entries, 0);
  const saved = await json(await t.get('/admin/api/settings', admin));
  assert.deepEqual(saved.cache, { enabled: true, ttlHours: 24 });
});
