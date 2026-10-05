import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { apiKeys, models, providers, requestLogs } from '../db/schema.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { json, testApp } from '../testing.ts';

// A provider that answers embeddings with numbers, as Ollama and most compatible APIs do.
const seen: { path: string; body: Record<string, unknown> }[] = [];
const upstream = new Hono().post('*', async (c) => {
  const body = await c.req.json();
  seen.push({ path: c.req.path, body });
  const inputs: unknown[] = Array.isArray(body.input) ? body.input : [body.input];
  return c.json({
    object: 'list',
    // Out of order on purpose: clients rely on `index`.
    data: inputs
      .map((_, index) => ({ object: 'embedding', index, embedding: [index, 0.5, -1] }))
      .reverse(),
    model: body.model,
    usage: { prompt_tokens: 100 * inputs.length, total_tokens: 100 * inputs.length },
  });
});

let server: ReturnType<typeof serve>;
let t: Awaited<ReturnType<typeof testApp>>;
let key: string;
let keyId: string;

before(async () => {
  server = serve({ fetch: upstream.fetch, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t = await testApp();
  const { db } = t.ctx;

  const [openai] = await db
    .insert(providers)
    .values({ name: 'OpenAI', kind: 'openai', baseUrl: `${url}/v1` })
    .returning();
  const [anthropic] = await db
    .insert(providers)
    .values({ name: 'Anthropic', kind: 'anthropic', baseUrl: url })
    .returning();
  const [ollama] = await db
    .insert(providers)
    .values({ name: 'Ollama', kind: 'ollama', baseUrl: url, isLocal: true })
    .returning();
  await db.insert(models).values([
    {
      name: 'text-embedding-3-small',
      providerId: openai!.id,
      upstreamModel: 'text-embedding-3-small',
      inputPrice: 0.02,
      outputPrice: 0,
    },
    { name: 'claude-haiku', providerId: anthropic!.id, upstreamModel: 'claude-haiku-4-5' },
    { name: 'nomic-embed-text', providerId: ollama!.id, upstreamModel: 'nomic-embed-text:v1.5' },
  ]);
  const [local] = await db
    .insert(models)
    .values({ name: 'qwen', providerId: ollama!.id, upstreamModel: 'qwen3:8b' })
    .returning();
  await t.ctx.settings.update({ localModelId: local!.id });

  const created = newGatewayKey();
  const [row] = await db
    .insert(apiKeys)
    .values({ name: 'rag', kind: 'agent', prefix: created.prefix, hash: created.hash })
    .returning();
  key = created.key;
  keyId = row!.id;
});

after(() => server.close());

const call = (path: string, body: unknown) =>
  t.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

async function lastLog() {
  const rows = await t.ctx.db.select().from(requestLogs).all();
  return rows.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  )[0]!;
}

test('OpenAI embeddings pass through and bill the input tokens', async () => {
  const res = await call('/v1/embeddings', {
    model: 'text-embedding-3-small',
    input: ['first', 'second'],
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.model, 'text-embedding-3-small');
  assert.equal(body.data.length, 2);
  assert.equal(seen.at(-1)?.path, '/v1/embeddings');
  const log = await lastLog();
  assert.equal(log.result, 'ok');
  assert.equal(log.inputTokens, 200);
  assert.equal(log.outputTokens, 0);
  assert.equal(log.costUsd, (200 * 0.02) / 1e6);
  assert.equal(log.promptPreview, 'first');
  assert.equal(log.trace[0]?.code, 'embeddings');
});

test('base64 is what OpenAI SDKs ask for, even when the provider sends numbers', async () => {
  const res = await call('/v1/embeddings', {
    model: 'nomic-embed-text',
    input: 'hello',
    encoding_format: 'base64',
  });
  const body = await json(res);
  const bytes = Buffer.from(body.data[0].embedding, 'base64');
  const vector = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  assert.deepEqual([...vector], [0, 0.5, -1]);
});

test('Ollama /api/embed gets vectors in input order', async () => {
  const res = await call('/api/embed', { model: 'nomic-embed-text', input: ['a', 'b'] });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.embeddings, [
    [0, 0.5, -1],
    [1, 0.5, -1],
  ]);
  assert.equal(body.prompt_eval_count, 200);
  assert.deepEqual(seen.at(-1)?.body, { model: 'nomic-embed-text:v1.5', input: ['a', 'b'] });
  assert.equal((await lastLog()).format, 'ollama');
});

test('the older Ollama /api/embeddings takes a prompt', async () => {
  const res = await call('/api/embeddings', { model: 'nomic-embed-text', prompt: 'a' });
  assert.deepEqual((await json(res)).embedding, [0, 0.5, -1]);
});

test('Anthropic models have no embeddings', async () => {
  const res = await call('/v1/embeddings', { model: 'claude-haiku', input: 'x' });
  assert.equal(res.status, 400);
  assert.match((await json(res)).error.message, /no embeddings API/);
  assert.equal((await lastLog()).result, 'error');
});

test('a missing input is the client’s mistake', async () => {
  const res = await call('/api/embed', { model: 'nomic-embed-text' });
  assert.equal(res.status, 400);
  assert.match((await json(res)).error, /"input"/);
});

test('working hours do not move embeddings to the local model', async () => {
  const away = (new Date().getUTCHours() + 12) % 24;
  const hour = String(away).padStart(2, '0');
  const settings = await t.ctx.settings.get();
  await t.ctx.settings.update({
    timeZone: 'UTC',
    rules: { ...settings.rules, offHours: { enabled: true, from: `${hour}:00`, to: `${hour}:30` } },
  });
  const res = await call('/v1/embeddings', { model: 'text-embedding-3-small', input: 'x' });
  assert.equal(res.status, 200);
  assert.equal(seen.at(-1)?.body.model, 'text-embedding-3-small');
  const log = await lastLog();
  assert.equal(log.result, 'ok');
  assert.ok(log.trace.some((step) => step.code === 'ruleSkippedEmbeddings'));
  await t.ctx.settings.update({ rules: settings.rules });
});

test('a used-up limit blocks embeddings instead of switching models', async () => {
  await t.ctx.db.update(apiKeys).set({ dailyLimitUsd: 0 }).where(eq(apiKeys.id, keyId));
  const before = seen.length;
  const res = await call('/v1/embeddings', { model: 'text-embedding-3-small', input: 'x' });
  assert.equal(res.status, 429);
  assert.equal(seen.length, before);
  const log = await lastLog();
  assert.equal(log.result, 'blocked_budget');
  assert.equal(log.trace.at(-1)?.code, 'blockedEmbeddings');
  await t.ctx.db.update(apiKeys).set({ dailyLimitUsd: null }).where(eq(apiKeys.id, keyId));
});

test('card numbers are not sent to a cloud embeddings model', async () => {
  const res = await call('/v1/embeddings', {
    model: 'text-embedding-3-small',
    input: ['Invoice paid with 4111 1111 1111 1111'],
  });
  assert.equal(res.status, 403);
  assert.equal((await lastLog()).result, 'blocked_pii');
});
