import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createApp } from '../app.ts';
import { type AppContext, RateLimiter } from '../context.ts';
import { openDb } from '../db/client.ts';
import { apiKeys, models, providers, requestLogs, teams } from '../db/schema.ts';
import { loadEnv } from '../env.ts';
import { newGatewayKey, Vault } from '../lib/crypto.ts';
import { SettingsStore } from '../settings.ts';

// A fake upstream that speaks both OpenAI (/v1/chat/completions) and Anthropic (/v1/messages).
const seen: { path: string; body: Record<string, unknown> }[] = [];
const upstream = new Hono()
  .post('/v1/chat/completions', async (c) => {
    const body = await c.req.json();
    seen.push({ path: c.req.path, body });
    const usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
    if (!body.stream) {
      return c.json({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `hello from ${body.model}` },
            finish_reason: 'stop',
          },
        ],
        usage,
      });
    }
    return streamSSE(c, async (stream) => {
      const base = {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
      };
      for (const content of ['hello ', 'there']) {
        await stream.writeSSE({
          data: JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          }),
        });
      }
      await stream.writeSSE({
        data: JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }),
      });
      await stream.writeSSE({ data: JSON.stringify({ ...base, choices: [], usage }) });
      await stream.writeSSE({ data: '[DONE]' });
    });
  })
  .post('/v1/messages', async (c) => {
    const body = await c.req.json();
    seen.push({ path: c.req.path, body });
    return c.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: 'hi from claude' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 2000, output_tokens: 100 },
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
  const env = loadEnv({ PUBLIC_URL: 'http://localhost:8080' });
  ctx = {
    db,
    env,
    secret: 'x'.repeat(40),
    vault: new Vault('x'.repeat(40)),
    settings: new SettingsStore(db),
    oidc: null,
    rateLimiter: new RateLimiter(),
    publicDir: null,
  };
  app = createApp(ctx);

  const [openai] = await db
    .insert(providers)
    .values({
      name: 'OpenAI',
      kind: 'openai',
      baseUrl: `${url}/v1`,
      apiKeyEnc: ctx.vault.encrypt('sk-upstream'),
    })
    .returning();
  const [anthropic] = await db
    .insert(providers)
    .values({
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: url,
      apiKeyEnc: ctx.vault.encrypt('sk-ant'),
    })
    .returning();
  const [ollama] = await db
    .insert(providers)
    .values({ name: 'Ollama', kind: 'ollama', baseUrl: url, isLocal: true })
    .returning();
  await db.insert(models).values([
    {
      name: 'gpt-mini',
      providerId: openai!.id,
      upstreamModel: 'gpt-5-mini',
      inputPrice: 1,
      outputPrice: 4,
    },
    {
      name: 'claude-sonnet',
      label: 'Claude Sonnet',
      providerId: anthropic!.id,
      upstreamModel: 'claude-sonnet-4-5',
      inputPrice: 3,
      outputPrice: 15,
    },
  ]);
  const [local] = await db
    .insert(models)
    .values({
      name: 'qwen-coder',
      label: 'Qwen Coder',
      providerId: ollama!.id,
      upstreamModel: 'qwen2.5-coder:7b',
    })
    .returning();
  await ctx.settings.update({ localModelId: local!.id });

  const [team] = await db
    .insert(teams)
    .values({ name: 'Engineering', monthlyBudgetUsd: 1000 })
    .returning();
  const created = newGatewayKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: 'anna-cli',
      kind: 'person',
      teamId: team!.id,
      prefix: created.prefix,
      hash: created.hash,
      dailyLimitUsd: 0.005,
    })
    .returning();
  key = created.key;
  keyId = row!.id;
});

after(() => server.close());

// biome-ignore lint/suspicious/noExplicitAny: tests assert on response fields directly
const json = (res: Response): Promise<any> => res.json();

const call = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
  });

async function lastLog() {
  // Logs are written right after the response finishes.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const rows = await ctx.db.select().from(requestLogs).all();
  return rows.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  )[0]!;
}

test('rejects unknown keys in the client format', async () => {
  const res = await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'sw-nope', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet', max_tokens: 10, messages: [] }),
  });
  assert.equal(res.status, 401);
  assert.equal((await json(res)).type, 'error');
});

test('OpenAI client to OpenAI provider: passes through and records the cost', async () => {
  const res = await call('/v1/chat/completions', {
    model: 'gpt-mini',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).choices[0].message.content, 'hello from gpt-5-mini');
  assert.equal(seen.at(-1)?.body.model, 'gpt-5-mini');
  const log = await lastLog();
  assert.equal(log.result, 'ok');
  assert.equal(log.inputTokens, 1000);
  assert.equal(log.costUsd, (1000 * 1 + 500 * 4) / 1e6);
});

test('Anthropic client to OpenAI provider: translated stream', async () => {
  const res = await call('/v1/messages', {
    model: 'gpt-mini',
    max_tokens: 100,
    stream: true,
    messages: [{ role: 'user', content: 'stream please' }],
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /"text":"hello "/);
  assert.match(text, /event: message_stop/);
  const log = await lastLog();
  assert.equal(log.outputTokens, 500);
  assert.equal(log.responsePreview, 'hello there');
});

test('over the daily limit: rerouted to the local model, savings recorded', async () => {
  const res = await call('/v1/chat/completions', {
    model: 'claude-sonnet',
    messages: [{ role: 'user', content: 'again' }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-spillway-result'), 'rerouted');
  assert.equal(seen.at(-1)?.body.model, 'qwen2.5-coder:7b');
  const log = await lastLog();
  assert.equal(log.result, 'rerouted');
  assert.equal(log.servedModel, 'Qwen Coder · local');
  assert.equal(log.costUsd, 0);
  assert.ok(log.savedUsd > 0);
  assert.ok(log.trace.some((step) => step.text.includes('daily limit')));
});

test('keys that must not fall back are blocked instead', async () => {
  await ctx.db.update(apiKeys).set({ fallbackToLocal: false }).where(eq(apiKeys.id, keyId));
  const res = await call('/v1/messages', {
    model: 'claude-sonnet',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(res.status, 429);
  assert.equal((await json(res)).error.type, 'rate_limit_error');
  await ctx.db
    .update(apiKeys)
    .set({ fallbackToLocal: true, dailyLimitUsd: null })
    .where(eq(apiKeys.id, keyId));
});

test('Anthropic client to Anthropic provider: passes through untouched', async () => {
  const res = await call('/v1/messages', {
    model: 'claude-sonnet',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hey' }],
  });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).content[0].text, 'hi from claude');
  assert.equal(seen.at(-1)?.path, '/v1/messages');
  const log = await lastLog();
  assert.equal(log.costUsd, (2000 * 3 + 100 * 15) / 1e6);
});

test('card numbers never reach a cloud model, and the log is masked', async () => {
  const before = seen.length;
  const res = await call('/v1/chat/completions', {
    model: 'gpt-mini',
    messages: [
      { role: 'user', content: 'Charge 4111 1111 1111 1111, receipt to anna@example.com' },
    ],
  });
  assert.equal(res.status, 403);
  assert.equal(seen.length, before);
  const log = await lastLog();
  assert.equal(log.result, 'blocked_pii');
  assert.equal(log.promptPreview, 'Charge [card hidden], receipt to [email hidden]');
});

test('Ollama clients get NDJSON streams by default', async () => {
  const res = await call('/api/chat', {
    model: 'qwen-coder',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
  const lines = (await res.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(lines.map((line) => line.message.content).join(''), 'hello there');
  assert.equal(lines.at(-1).done, true);
});

test('lists models in a shape both SDKs accept', async () => {
  const res = await app.request('/v1/models', { headers: { authorization: `Bearer ${key}` } });
  const body = await json(res);
  assert.deepEqual(body.data.map((m: { id: string }) => m.id).sort(), [
    'claude-sonnet',
    'gpt-mini',
    'qwen-coder',
  ]);
});
