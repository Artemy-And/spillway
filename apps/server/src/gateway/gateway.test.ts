import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { overview } from '../admin/stats.ts';
import { createApp } from '../app.ts';
import { type AppContext, RateLimiter } from '../context.ts';
import { openDb } from '../db/client.ts';
import { apiKeys, models, providers, requestLogs, teams } from '../db/schema.ts';
import { loadEnv } from '../env.ts';
import { newGatewayKey, Vault } from '../lib/crypto.ts';
import { calendar } from '../lib/time.ts';
import { SettingsStore } from '../settings.ts';

// A fake upstream that speaks OpenAI (/v1/chat/completions, /v1/responses) and Anthropic
// (/v1/messages).
const seen: { path: string; body: Record<string, unknown> }[] = [];
const upstream = new Hono()
  .post('/v1/responses', async (c) => {
    const body = await c.req.json();
    seen.push({ path: c.req.path, body });
    return streamSSE(c, async (stream) => {
      const send = (data: Record<string, unknown>) =>
        stream.writeSSE({ event: data.type as string, data: JSON.stringify(data) });
      const response = { id: 'resp_1', object: 'response', model: body.model, output: [] };
      await send({ type: 'response.created', response: { ...response, status: 'in_progress' } });
      if (body.input === 'fail') {
        await send({
          type: 'response.failed',
          response: {
            ...response,
            status: 'failed',
            error: { code: 'server_error', message: 'Model overloaded' },
          },
        });
        return;
      }
      await send({ type: 'response.output_text.delta', delta: 'native answer' });
      await send({
        type: 'response.completed',
        response: {
          ...response,
          status: 'completed',
          usage: {
            input_tokens: 2000,
            input_tokens_details: { cached_tokens: 1000 },
            output_tokens: 100,
            total_tokens: 2100,
          },
        },
      });
    });
  })
  .post('/v1/chat/completions', async (c) => {
    const body = await c.req.json();
    seen.push({ path: c.req.path, body });
    // Gemini's OpenAI-compatible endpoint answers errors as an array.
    if (JSON.stringify(body.messages).includes('use up the quota')) {
      return c.json(
        [
          {
            error: {
              code: 429,
              message: 'You exceeded your current quota. Please retry in 24.6s.',
              status: 'RESOURCE_EXHAUSTED',
            },
          },
        ],
        429,
      );
    }
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
let restoreFetch = () => {};

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
    setupCode: 'TEST-SETUP-CODE',
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

  // OpenAI itself answers the Responses API; its address leads to the fake upstream here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    realFetch(String(input).replace('https://api.openai.com', url), init)) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = realFetch;
  };
  const [platform] = await db
    .insert(providers)
    .values({
      name: 'OpenAI Platform',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnc: ctx.vault.encrypt('sk-platform'),
    })
    .returning();
  await db.insert(models).values({
    name: 'gpt-codex',
    providerId: platform!.id,
    upstreamModel: 'gpt-5.1-codex',
    inputPrice: 1.25,
    outputPrice: 10,
  });

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

after(() => {
  restoreFetch();
  server.close();
});

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
  await new Promise((resolve) => setTimeout(resolve, 100));
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

test('the log shows what the person asked, not the reminders and tool results around it', async () => {
  const reminder =
    '<system-reminder>\nCodebase and user instructions are shown below.\n</system-reminder>';
  // How Claude Code sends a turn: reminders before the question, tool results after it.
  const res = await call('/v1/messages', {
    model: 'claude-sonnet',
    max_tokens: 100,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: reminder },
          { type: 'text', text: 'What does this project do?' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'README.md' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '# Spillway\nA gateway.' },
          { type: 'text', text: reminder },
        ],
      },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal((await lastLog()).promptPreview, 'What does this project do?');
});

test('a provider’s refusal is logged with its status and words, not its JSON', async () => {
  const ask = { model: 'gpt-mini', messages: [{ role: 'user', content: 'use up the quota' }] };
  const said = {
    provider: 'OpenAI',
    status: 429,
    detail: 'You exceeded your current quota. Please retry in 24.6s.',
  };

  await ctx.db.update(apiKeys).set({ fallbackToLocal: false }).where(eq(apiKeys.id, keyId));
  const res = await call('/v1/chat/completions', ask);
  assert.equal(res.status, 429);
  const log = await lastLog();
  assert.equal(log.result, 'error');
  assert.equal(log.error, `OpenAI returned 429: ${said.detail}`);
  assert.deepEqual(log.trace.at(-1)?.params, { message: log.error, ...said });
  await ctx.db.update(apiKeys).set({ fallbackToLocal: true }).where(eq(apiKeys.id, keyId));
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

test('personal data in the calls a model made is checked as well', async () => {
  const before = seen.length;
  // The SSN follows a line break, which JSON writes as "\n" right before the digits.
  const written = JSON.stringify({ path: 'staff.txt', content: 'Bob\n123-45-6789' });
  const chat = await call('/v1/chat/completions', {
    model: 'gpt-mini',
    messages: [
      { role: 'user', content: 'Save it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'write', arguments: written } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ],
  });
  assert.equal(chat.status, 403);
  const claude = await call('/v1/messages', {
    model: 'claude-sonnet',
    max_tokens: 100,
    messages: [
      { role: 'user', content: 'Save it' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'write', input: JSON.parse(written) }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ],
  });
  assert.equal(claude.status, 403);
  const codex = await call('/v1/responses', {
    model: 'gpt-codex',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Save it' }] },
      { type: 'function_call', call_id: 'c1', name: 'write', arguments: written },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  });
  assert.equal(codex.status, 400);
  assert.equal(seen.length, before);
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
    'gpt-codex',
    'gpt-mini',
    'qwen-coder',
  ]);
});

// What Codex sends: instructions, typed input items and Responses-style tools.
const codexRequest = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  instructions: 'You are Codex.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files' }] }],
  tools: [
    { type: 'function', name: 'exec_command', parameters: { type: 'object' } },
    {
      type: 'namespace',
      name: 'multi_agent_v1',
      tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }],
    },
    { type: 'web_search' },
  ],
  store: false,
  ...extra,
});

/** The events of a Responses stream, parsed. */
async function responseEvents(res: Response) {
  return (await res.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

test('Responses client to an OpenAI-compatible provider: translated both ways', async () => {
  const res = await call('/v1/responses', codexRequest('gpt-mini', { stream: true }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const events = await responseEvents(res);
  const completed = events.at(-1);
  assert.equal(completed.type, 'response.completed');
  assert.equal(completed.response.output[0].content[0].text, 'hello there');
  assert.equal(completed.response.usage.input_tokens, 1000);

  const sent = seen.at(-1)!;
  assert.equal(sent.path, '/v1/chat/completions');
  assert.deepEqual(sent.body.messages, [
    { role: 'system', content: 'You are Codex.' },
    { role: 'user', content: 'List files' },
  ]);
  assert.deepEqual(
    (sent.body.tools as { function: { name: string } }[]).map((tool) => tool.function.name),
    ['exec_command', 'spawn_agent'],
  );
  const log = await lastLog();
  assert.equal(log.format, 'responses');
  assert.equal(log.promptPreview, 'List files');
  assert.equal(log.outputTokens, 500);
});

test('Responses client to Anthropic: a whole answer, with room to write', async () => {
  const res = await call('/v1/responses', codexRequest('claude-sonnet'));
  const body = await json(res);
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.equal(body.output[0].content[0].text, 'hi from claude');
  assert.equal(seen.at(-1)?.path, '/v1/messages');
  assert.equal(seen.at(-1)?.body.max_tokens, 32_000);
});

test('Responses client to OpenAI itself: passed through untouched and metered', async () => {
  const request = codexRequest('gpt-codex', { stream: true });
  const res = await call('/v1/responses', request);
  assert.equal(res.status, 200);
  const events = await responseEvents(res);
  assert.equal(events.at(-1).type, 'response.completed');
  const sent = seen.at(-1)!;
  assert.equal(sent.path, '/v1/responses');
  assert.deepEqual(sent.body, { ...request, model: 'gpt-5.1-codex' });
  const log = await lastLog();
  assert.equal(log.format, 'responses');
  assert.equal(log.responsePreview, 'native answer');
  // 1000 fresh input tokens, 1000 cached at a tenth of the price, 100 output tokens.
  assert.equal(log.costUsd, (1000 * 1.25 + 1000 * 0.125 + 100 * 10) / 1e6);
});

test('Responses client: a stream OpenAI fails is logged as an error', async () => {
  const res = await call('/v1/responses', { model: 'gpt-codex', input: 'fail', stream: true });
  const events = await responseEvents(res);
  assert.equal(events.at(-1).type, 'response.failed');
  const log = await lastLog();
  assert.match(log.error ?? '', /Model overloaded/);
});

test('Responses client: refusals are final, so Codex shows them instead of retrying', async () => {
  const pii = await call('/v1/responses', {
    model: 'gpt-mini',
    input: 'Charge 4111 1111 1111 1111',
  });
  assert.equal(pii.status, 400);
  assert.equal((await json(pii)).error.code, 'invalid_prompt');

  const missing = await call('/v1/responses', { model: 'no-such-model', input: 'Hi' });
  assert.equal(missing.status, 400);
  assert.equal((await json(missing)).error.code, 'model_not_found');

  await ctx.db
    .update(apiKeys)
    .set({ fallbackToLocal: false, dailyLimitUsd: 0.000001 })
    .where(eq(apiKeys.id, keyId));
  const broke = await call('/v1/responses', { model: 'gpt-mini', input: 'Hi' });
  assert.equal(broke.status, 429);
  assert.equal((await json(broke)).error.code, 'insufficient_quota');
  await ctx.db
    .update(apiKeys)
    .set({ fallbackToLocal: true, dailyLimitUsd: null })
    .where(eq(apiKeys.id, keyId));
});

test('Responses client without input gets a clear error', async () => {
  const res = await call('/v1/responses', { model: 'gpt-mini' });
  assert.equal(res.status, 400);
  assert.match((await json(res)).error.message, /"input"/);
});

test('Ollama dropping the start of a long prompt is logged and shown on the overview', async () => {
  const ask = (content: string) =>
    call('/v1/chat/completions', { model: 'qwen-coder', messages: [{ role: 'user', content }] });
  // A short prompt fits: the 1000 tokens the fake Ollama reports are about what was sent.
  await ask('hi '.repeat(1200));
  assert.ok(!(await lastLog()).trace.some((s) => s.code === 'promptCut'));

  // About 10,000 tokens sent, 1000 kept: the start was cut.
  await ask('word '.repeat(8000));
  const cut = (await lastLog()).trace.find((s) => s.code === 'promptCut');
  assert.equal(cut?.tone, 'warn');
  assert.equal(cut?.params?.kept, 1000);
  assert.ok(Number(cut?.params?.sent) > 9000);

  const { alerts } = await overview(ctx.db, '7d', null, calendar('UTC'));
  const alert = alerts.find((a) => a.code === 'promptCut');
  assert.deepEqual(alert && { model: alert.model, count: alert.count }, {
    model: 'Qwen Coder',
    count: 1,
  });
});
