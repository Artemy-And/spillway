import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { failingProviders, overview } from '../admin/stats.ts';
import { createApp } from '../app.ts';
import { type AppContext, RateLimiter } from '../context.ts';
import { openDb } from '../db/client.ts';
import { apiKeys, models, providers, requestLogs } from '../db/schema.ts';
import { loadEnv } from '../env.ts';
import { newGatewayKey, Vault } from '../lib/crypto.ts';
import { calendar } from '../lib/time.ts';
import { SettingsStore } from '../settings.ts';

// Cloud providers that fail in every way we have seen, and a local model that always answers.
let release: () => void = () => {};
const hang = new Promise<void>((resolve) => {
  release = resolve;
});
const upstream = new Hono()
  .post('/down/v1/chat/completions', (c) => c.json({ error: { message: 'Bad gateway' } }, 503))
  .post('/limited/v1/chat/completions', (c) =>
    c.json(
      {
        error: {
          message: 'Provider returned error',
          code: 429,
          metadata: { raw: 'free-model is temporarily rate-limited upstream. Retry shortly.' },
        },
      },
      429,
    ),
  )
  .post('/empty/v1/chat/completions', (c) =>
    c.json({ error: { message: 'Provider returned error', metadata: { raw: 'model crashed' } } }),
  )
  .post('/slow/v1/chat/completions', async (c) => {
    await hang;
    return c.json({});
  })
  .post('/local/v1/chat/completions', async (c) => {
    const body = await c.req.json();
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (!body.stream) {
      return c.json({
        id: 'local-1',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'local here' } }],
        usage,
      });
    }
    return streamSSE(c, async (stream) => {
      const base = {
        id: 'local-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
      };
      await stream.writeSSE({
        data: JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { content: 'local stream' }, finish_reason: 'stop' }],
        }),
      });
      await stream.writeSSE({ data: JSON.stringify({ ...base, choices: [], usage }) });
      await stream.writeSSE({ data: '[DONE]' });
    });
  });

let server: ReturnType<typeof serve>;
let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let key: string;
let keyId: string;

before(async () => {
  server = serve({ fetch: upstream.fetch, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { db } = await openDb(':memory:');
  const env = loadEnv({ PUBLIC_URL: 'http://localhost:8080', UPSTREAM_TIMEOUT_SECONDS: '1' });
  ctx = {
    db,
    env,
    secret: 'x'.repeat(40),
    vault: new Vault('x'.repeat(40)),
    settings: new SettingsStore(db),
    oidc: null,
    rateLimiter: new RateLimiter(),
    setupCode: 'TEST-SETUP-CODE',
    publicDir: null,
  };
  app = createApp(ctx);

  for (const name of ['down', 'limited', 'empty', 'slow']) {
    const [provider] = await db
      .insert(providers)
      .values({ name: `Cloud ${name}`, kind: 'openai', baseUrl: `${url}/${name}/v1` })
      .returning();
    await db.insert(models).values({
      name: `${name}-model`,
      providerId: provider!.id,
      upstreamModel: name,
      inputPrice: 1,
      outputPrice: 1,
    });
  }
  const [ollama] = await db
    .insert(providers)
    .values({ name: 'Ollama', kind: 'ollama', baseUrl: `${url}/local`, isLocal: true })
    .returning();
  const [local] = await db
    .insert(models)
    .values({ name: 'qwen', providerId: ollama!.id, upstreamModel: 'qwen3:1.7b' })
    .returning();
  await ctx.settings.update({ localModelId: local!.id });

  const created = newGatewayKey();
  const [row] = await db
    .insert(apiKeys)
    .values({ name: 'chat', kind: 'person', prefix: created.prefix, hash: created.hash })
    .returning();
  key = created.key;
  keyId = row!.id;
});

after(() => {
  release();
  server.close();
});

// biome-ignore lint/suspicious/noExplicitAny: tests assert on response fields directly
const json = (res: Response): Promise<any> => res.json();

const ask = (model: string, extra: Record<string, unknown> = {}) =>
  app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra }),
  });

async function lastLog() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const rows = await ctx.db.select().from(requestLogs).all();
  return rows.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  )[0]!;
}

test('a provider that is down: the local model answers instead', async () => {
  const res = await ask('down-model');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-spillway-result'), 'rerouted');
  assert.equal((await json(res)).choices[0].message.content, 'local here');
  const log = await lastLog();
  assert.equal(log.result, 'rerouted');
  assert.equal(log.ruleId, 'outage');
  assert.equal(log.servedLocal, true);
  assert.equal(log.savedUsd, 0, 'a failover is not counted as savings');
  const failed = log.trace.find((step) => step.code === 'providerFailed');
  assert.deepEqual(failed?.params, {
    provider: 'Cloud down',
    message: 'Cloud down returned 503: Bad gateway',
    status: 503,
    detail: 'Bad gateway',
  });
  assert.ok(log.trace.some((step) => step.code === 'failover'));
});

test('a provider that does not answer in time fails over after the deadline', async () => {
  const started = Date.now();
  const res = await ask('slow-model');
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 3000);
  const log = await lastLog();
  assert.equal(log.result, 'rerouted');
  assert.ok(log.trace.some((step) => step.text === 'Cloud slow did not answer within 1 s'));
});

test('a 200 with an error body counts as a failure', async () => {
  const res = await ask('empty-model');
  assert.equal(res.status, 200);
  assert.equal((await lastLog()).result, 'rerouted');
});

test('streams fail over before the first byte reaches the client', async () => {
  const res = await ask('down-model', { stream: true });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /local stream/);
  assert.equal((await lastLog()).result, 'rerouted');
});

test('with failover off, a rate limit comes back with the real reason', async () => {
  await ctx.settings.update({ rerouteOnFailure: false });
  const res = await ask('limited-model');
  assert.equal(res.status, 429);
  const body = await json(res);
  assert.equal(body.error.type, 'rate_limit_error');
  assert.match(body.error.message, /temporarily rate-limited upstream/);
  assert.equal((await lastLog()).result, 'error');
  await ctx.settings.update({ rerouteOnFailure: true });
});

test('keys that must not fall back get the error', async () => {
  await ctx.db.update(apiKeys).set({ fallbackToLocal: false }).where(eq(apiKeys.id, keyId));
  const res = await ask('down-model');
  assert.equal(res.status, 503);
  assert.equal((await lastLog()).result, 'error');
  await ctx.db.update(apiKeys).set({ fallbackToLocal: true }).where(eq(apiKeys.id, keyId));
});

test('failing providers show up in Needs attention', async () => {
  const data = await overview(ctx.db, 'month', null, calendar('UTC'));
  const down = data.alerts.find(
    (alert) => alert.code === 'providerFailing' && alert.provider === 'Cloud down',
  );
  assert.ok(down && down.code === 'providerFailing');
  assert.equal(down.failed, 1);
  assert.equal(down.rescued, 2);
  assert.equal(data.activity.sharedKeys, 1);
  assert.equal(data.activity.people, 0);
});

test('a provider counts as failing until it answers again', async () => {
  assert.ok((await failingProviders(ctx.db)).includes('Cloud down'));
  // The same provider now answers: point its model at the local fake that always works.
  const local = await ctx.db.query.providers.findFirst({ where: eq(providers.name, 'Ollama') });
  await ctx.db
    .update(providers)
    .set({ baseUrl: local!.baseUrl, kind: 'ollama' })
    .where(eq(providers.name, 'Cloud down'));
  assert.equal((await ask('down-model')).status, 200);
  await lastLog();
  assert.ok(!(await failingProviders(ctx.db)).includes('Cloud down'));
});
