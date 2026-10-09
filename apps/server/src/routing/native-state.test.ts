import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { estimateRequest } from '../budget/estimate.ts';
import { openDb } from '../db/client.ts';
import {
  apiKeys,
  budgetReservations,
  models,
  nativeSessionStates,
  providers,
  requestLogs,
  routingSessions,
} from '../db/schema.ts';
import { sse } from '../gateway/sse.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { testApp } from '../testing.ts';
import { routingTarget } from './resolve.ts';

type Obj = Record<string, unknown>;
const baseFetch = globalThis.fetch;
const session = 'native-session-DEMO-01';
const schema = {
  type: 'object',
  properties: { orderId: { type: 'string' } },
  required: ['orderId'],
  additionalProperties: false,
};
const thinking: Obj[] = [
  { type: 'thinking', thinking: 'Check the synthetic order', signature: 'signature-one' },
  { type: 'redacted_thinking', data: 'opaque-one' },
];
const call = { type: 'tool_use', id: 'call-demo', name: 'get_order', input: { orderId: 'DEMO' } };
const initial = [{ role: 'user', content: 'Find the order' }];
const result = { type: 'tool_result', tool_use_id: 'call-demo', content: 'paid' };
function body(format: 'responses' | 'anthropic'): Obj {
  const common = { model: 'native', stream: false };
  return format === 'responses'
    ? {
        ...common,
        input: 'Find the order',
        store: true,
        max_output_tokens: 2048,
        parallel_tool_calls: false,
        tools: [{ type: 'function', name: 'get_order', parameters: schema, strict: false }],
        reasoning: { effort: 'high' },
      }
    : {
        ...common,
        messages: initial,
        max_tokens: 2048,
        tools: [{ name: 'get_order', input_schema: schema }],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        thinking: { type: 'enabled', budget_tokens: 1024 },
      };
}
function continued(format: 'responses' | 'anthropic', id = 'resp-1'): Obj {
  return format === 'responses'
    ? {
        ...body(format),
        previous_response_id: id,
        input: [{ type: 'function_call_output', call_id: 'call-demo', output: 'paid' }],
      }
    : {
        ...body(format),
        messages: structuredClone([
          ...initial,
          { role: 'assistant', content: [...thinking, call] },
          { role: 'user', content: [result] },
        ]),
      };
}
async function fixture(t: TestContext, format: 'responses' | 'anthropic', file?: string) {
  const calls: Obj[] = [];
  const mode = {
    end: 'complete',
    missingUsage: false,
    failedJSON: false,
    outputPII: false,
    httpError: false,
    unsigned: false,
    omitted: false,
    gate: null as Promise<void> | null,
  };
  const upstream = new Hono().post('/v1/:api', async (c) => {
    const request = await c.req.json<Obj>();
    calls.push(request);
    if (mode.httpError) return c.json({ error: { message: 'Synthetic native HTTP failure' } }, 503);
    const final =
      format === 'responses'
        ? Array.isArray(request.input) &&
          request.input.some((item) => item.type === 'function_call_output')
        : (request.messages as { content: unknown }[]).some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some((block) => block.type === 'tool_result'),
          );
    const content: Obj[] = final
      ? [{ type: 'text', text: 'paid' }]
      : [
          {
            ...thinking[0],
            thinking: mode.omitted
              ? ''
              : mode.outputPII
                ? 'alice@example.com'
                : thinking[0]!.thinking,
            signature: mode.unsigned ? '' : 'signature-one',
          },
          thinking[1]!,
          call,
        ];
    const output = final
      ? [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'paid', annotations: [] }],
          },
        ]
      : [
          {
            type: 'reasoning',
            id: 'rs-demo',
            summary: [],
            encrypted_content: 'opaque-provider-state',
          },
          {
            type: 'function_call',
            id: 'fc-demo',
            call_id: 'call-demo',
            name: 'get_order',
            arguments: '{"orderId":"DEMO"}',
            status: 'completed',
          },
        ];
    const response =
      format === 'responses'
        ? {
            id: `resp-${calls.length}`,
            object: 'response',
            status: mode.failedJSON ? 'failed' : 'completed',
            output,
            ...(!mode.missingUsage ? { usage: { input_tokens: 100, output_tokens: 10 } } : {}),
          }
        : {
            id: 'msg-demo',
            type: 'message',
            role: 'assistant',
            content,
            stop_reason: mode.failedJSON ? 'max_tokens' : final ? 'end_turn' : 'tool_use',
            ...(!mode.missingUsage
              ? { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20 } }
              : {}),
          };
    if (!request.stream) {
      await mode.gate;
      return c.json(response);
    }
    const events: string[] = [];
    if (format === 'responses') {
      events.push(
        sse(
          { type: 'response.created', response: { id: response.id, output: [] } },
          'response.created',
        ),
      );
      if (mode.end === 'complete')
        events.push(sse({ type: 'response.completed', response }, 'response.completed'));
    } else {
      events.push(
        sse(
          {
            type: 'message_start',
            message: {
              ...response,
              content: [],
              usage: mode.missingUsage
                ? undefined
                : { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 20 },
            },
          },
          'message_start',
        ),
      );
      for (let index = 0; index < content.length; index++) {
        const block = content[index]!;
        const start =
          block.type === 'thinking'
            ? { type: 'thinking', thinking: '', signature: '' }
            : block.type === 'tool_use'
              ? { ...block, input: {} }
              : block.type === 'text'
                ? { type: 'text', text: '' }
                : block;
        events.push(
          sse({ type: 'content_block_start', index, content_block: start }, 'content_block_start'),
        );
        const deltas =
          block.type === 'thinking'
            ? [
                { type: 'thinking_delta', thinking: (block as (typeof thinking)[0]).thinking },
                { type: 'signature_delta', signature: 'signature-' },
                { type: 'signature_delta', signature: 'one' },
              ]
            : block.type === 'tool_use'
              ? [
                  { type: 'input_json_delta', partial_json: '{"orderId":' },
                  { type: 'input_json_delta', partial_json: '"DEMO"}' },
                ]
              : block.type === 'text'
                ? [{ type: 'text_delta', text: 'paid' }]
                : [];
        for (const delta of deltas)
          events.push(sse({ type: 'content_block_delta', index, delta }, 'content_block_delta'));
        events.push(sse({ type: 'content_block_stop', index }, 'content_block_stop'));
      }
      if (mode.end === 'complete')
        events.push(
          sse(
            {
              type: 'message_delta',
              delta: { stop_reason: final ? 'end_turn' : 'tool_use' },
              ...(!mode.missingUsage ? { usage: { output_tokens: 10 } } : {}),
            },
            'message_delta',
          ),
          sse({ type: 'message_stop' }, 'message_stop'),
        );
    }
    if (mode.end === 'error')
      events.push(sse({ type: 'error', error: { message: 'Synthetic native failure' } }, 'error'));
    const gate = mode.gate;
    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(events[0]));
          await gate;
          try {
            for (const event of events.slice(1)) controller.enqueue(encoder.encode(event));
            controller.close();
          } catch {
            /* canceled fixture */
          }
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const server = serve({ fetch: upstream.fetch, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  t.after(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    server.close();
  });
  if (format === 'responses') {
    globalThis.fetch = (input, init) =>
      baseFetch(
        String(input).startsWith('https://api.openai.com/v1/')
          ? String(input).replace('https://api.openai.com/v1', url)
          : input,
        init,
      );
    t.after(() => {
      globalThis.fetch = baseFetch;
    });
  }
  const f = await testApp();
  if (file) {
    const opened = await openDb(file);
    f.ctx.db = opened.db;
    t.after(opened.close);
  }
  await f.setupAdmin();
  const [provider] = await f.ctx.db
    .insert(providers)
    .values({
      name: 'Native test',
      kind: format === 'responses' ? 'openai' : 'anthropic',
      baseUrl: format === 'responses' ? 'https://api.openai.com/v1' : url.replace(/\/v1$/, ''),
    })
    .returning();
  const [model] = await f.ctx.db
    .insert(models)
    .values({
      name: 'native',
      providerId: provider!.id,
      upstreamModel: 'native-wire',
      inputPrice: 1,
      outputPrice: 2,
      cacheReadPrice: 0.1,
    })
    .returning();
  const token = newGatewayKey();
  const [key] = await f.ctx.db
    .insert(apiKeys)
    .values({
      name: 'Native',
      kind: 'agent',
      hash: token.hash,
      prefix: token.prefix,
      dailyLimitUsd: 1,
    })
    .returning();
  const request = (input: Obj = body(format), sid = session, keyToken = token.key) =>
    f.app.request(`/v1/${format === 'responses' ? 'responses' : 'messages'}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${keyToken}`,
        'content-type': 'application/json',
        'x-spillway-session': sid,
      },
      body: JSON.stringify(input),
    });
  return { ...f, calls, mode, provider: provider!, model: model!, key: key!, token, request };
}
async function log(f: Awaited<ReturnType<typeof fixture>>, response: Response) {
  for (let i = 0; i < 200; i++) {
    const row = await f.ctx.db.query.requestLogs.findFirst({
      where: eq(requestLogs.id, response.headers.get('x-spillway-request-id')!),
    });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Missing completed log');
}

test('Responses stored continuation pins the provider, validates its head and reserves hidden history', async (t) => {
  const f = await fixture(t, 'responses');
  const first = await f.request();
  assert.equal(first.status, 200, await first.clone().text());
  const answer = (await first.json()) as Obj;
  const state = (await f.ctx.db.select().from(nativeSessionStates))[0]!;
  const target = (await routingTarget(f.ctx, f.model.id))!;
  assert.ok(state.contextTokens > 2048);
  assert.equal(estimateRequest(target, 'responses', continued('responses')), null);
  const second = await f.request(continued('responses', answer.id as string));
  assert.equal(second.status, 200, await second.clone().text());
  const next = (await second.json()) as Obj;
  const reservations = await f.ctx.db.select().from(budgetReservations);
  assert.equal(
    reservations[1]!.estimatedUsd,
    estimateRequest(
      target,
      'responses',
      continued('responses', answer.id as string),
      state.contextTokens,
    ),
  );
  assert.ok(reservations[1]!.estimatedUsd! > reservations[0]!.estimatedUsd!);
  assert.deepEqual(
    f.calls.map((item) => item.model),
    ['native-wire', 'native-wire'],
  );
  assert.equal(f.calls[1]!.store, true);
  assert.equal(f.calls[1]!.previous_response_id, answer.id);
  assert.equal((await f.request(continued('responses', answer.id as string))).status, 409);
  assert.equal(
    (
      await f.request(
        { ...body('responses'), previous_response_id: next.id, input: 'Continue' },
        'another-session-DEMO-01',
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request({
        ...body('responses'),
        previous_response_id: next.id,
        input: 'Continue',
        reasoning: { effort: 'low' },
      })
    ).status,
    409,
  );
  assert.equal(f.calls.length, 2);
  assert.equal(
    JSON.stringify(await f.ctx.db.select().from(nativeSessionStates)).includes(
      'opaque-provider-state',
    ),
    false,
  );
});

test('Anthropic preserves signed and redacted thinking and rejects changed or imported history', async (t) => {
  const f = await fixture(t, 'anthropic');
  const first = await f.request();
  assert.equal(first.status, 200, await first.clone().text());
  assert.deepEqual(((await first.json()) as Obj).content, [...thinking, call]);
  for (const field of ['signature', 'thinking', 'data']) {
    const altered = structuredClone(continued('anthropic'));
    ((altered.messages as Obj[])[1]!.content as Obj[])[field === 'data' ? 1 : 0]![field] =
      'changed';
    assert.equal((await f.request(altered)).status, 409);
  }
  assert.equal((await f.request(continued('anthropic'), 'another-session-DEMO-01')).status, 409);
  const second = await f.request(continued('anthropic'));
  assert.equal(second.status, 200, await second.clone().text());
  assert.deepEqual(f.calls[1]!.messages, continued('anthropic').messages);
  assert.equal((await f.request(continued('anthropic'))).status, 409);
  assert.equal(f.calls.length, 2);
  const stored = JSON.stringify(await f.ctx.db.select().from(nativeSessionStates));
  assert.equal(stored.includes('signature-one'), false);
  assert.equal(stored.includes('synthetic order'), false);
  const recorded = await log(f, second);
  assert.equal(recorded.inputTokens, 120);
  assert.equal(recorded.outputTokens, 10);
  assert.equal(recorded.costKnown, true);
});

test('native streaming commits assembled signatures and response heads before the next turn', async (t) => {
  for (const format of ['responses', 'anthropic'] as const) {
    const f = await fixture(t, format);
    const first = await f.request({ ...body(format), stream: true });
    assert.equal(first.status, 200);
    const stream = await first.text();
    assert.ok(stream.includes(format === 'responses' ? 'response.completed' : 'signature_delta'));
    const second = await f.request({ ...continued(format), stream: true });
    assert.equal(second.status, 200, await second.clone().text());
    await second.text();
    assert.equal((await f.ctx.db.select().from(nativeSessionStates))[0]!.revision, 2);
    assert.equal((await log(f, second)).costKnown, true);
  }
});

test('native context survives SQLite reopening and rejects key, credential and expiry changes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spillway-native-'));
  const file = join(dir, 'context.db');
  const f = await fixture(t, 'responses', file);
  assert.equal((await f.request()).status, 200);
  const reopened = await openDb(file);
  t.after(reopened.close);
  f.ctx.db = reopened.db;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const other = newGatewayKey();
  await f.ctx.db
    .insert(apiKeys)
    .values({ name: 'Other', kind: 'agent', hash: other.hash, prefix: other.prefix });
  assert.equal((await f.request(continued('responses'), session, other.key)).status, 409);
  const second = await f.request(continued('responses'));
  assert.equal(second.status, 200, await second.clone().text());
  const next = { ...body('responses'), previous_response_id: 'resp-2', input: 'Continue' };
  await f.ctx.db
    .update(providers)
    .set({ apiKeyEnc: 'changed-encrypted-credential' })
    .where(eq(providers.id, f.provider.id));
  assert.equal((await f.request(next)).status, 409);
  await f.ctx.db.update(providers).set({ apiKeyEnc: null }).where(eq(providers.id, f.provider.id));
  await f.ctx.db.update(routingSessions).set({ expiresAt: new Date(Date.now() - 1) });
  assert.equal((await f.request(next)).status, 410);
  assert.equal(f.calls.length, 2);
});

test('native budget refusal preserves the head and permits continuation after the limit is raised', async (t) => {
  const f = await fixture(t, 'responses');
  assert.equal((await f.request()).status, 200);
  const before = (await f.ctx.db.select().from(nativeSessionStates))[0]!;
  await f.ctx.db.update(apiKeys).set({ dailyLimitUsd: 0.002 }).where(eq(apiKeys.id, f.key.id));
  assert.equal((await f.request(continued('responses'))).status, 429);
  assert.equal(f.calls.length, 1);
  assert.deepEqual((await f.ctx.db.select().from(nativeSessionStates))[0], before);
  await f.ctx.db.update(apiKeys).set({ dailyLimitUsd: 1 }).where(eq(apiKeys.id, f.key.id));
  assert.equal((await f.request(continued('responses'))).status, 200);
});

test('native parallel turns and interrupted process state fail closed without a second provider call', async (t) => {
  const f = await fixture(t, 'responses');
  let release!: () => void;
  f.mode.gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = f.request();
  for (let i = 0; i < 200 && !f.calls.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await f.request();
  assert.equal(second.status, 409);
  assert.equal(f.calls.length, 1);
  release();
  assert.equal((await first).status, 200);
  await f.ctx.db.update(nativeSessionStates).set({ inFlight: 'req-interrupted-process' });
  assert.equal((await f.request(continued('responses'))).status, 409);
  assert.equal(f.calls.length, 1);
});

test('truncated, failed and canceled native streams retain reserves and prohibit context continuation', async (t) => {
  for (const format of ['responses', 'anthropic'] as const)
    for (const end of ['truncated', 'error', 'cancel']) {
      const f = await fixture(t, format);
      f.mode.end = end;
      let release!: () => void;
      if (end === 'cancel') {
        f.mode.end = 'complete';
        f.mode.gate = new Promise((resolve) => {
          release = resolve;
        });
      }
      const response = await f.request({ ...body(format), stream: true });
      if (end === 'cancel') {
        const reader = response.body!.getReader();
        await reader.read();
        await reader.cancel();
        release();
      } else if (response.status === 200) await assert.rejects(response.text());
      else assert.equal(response.status, 502, await response.text());
      const recorded = await log(f, response);
      assert.equal(recorded.costKnown, false);
      const state = (await f.ctx.db.select().from(nativeSessionStates))[0]!;
      assert.equal(state.interrupted, true);
      assert.equal(state.headHash, null);
      assert.equal((await f.request()).status, 409);
      assert.equal(f.calls.length, 1);
      assert.ok((await f.ctx.db.select().from(budgetReservations))[0]!.heldUsd > 0);
    }
});

test('missing native usage remains uncertain and failed JSON does not advance a response head', async (t) => {
  const f = await fixture(t, 'responses');
  f.mode.missingUsage = true;
  const first = await f.request();
  assert.equal(first.status, 200);
  assert.equal((await log(f, first)).costKnown, false);
  f.mode.missingUsage = false;
  f.mode.failedJSON = true;
  const second = await f.request(continued('responses'));
  assert.equal(second.status, 502);
  const state = (await f.ctx.db.select().from(nativeSessionStates))[0]!;
  assert.equal(state.revision, 1);
  assert.equal(state.interrupted, true);
  assert.equal((await log(f, second)).costKnown, false);
});

test('native first-turn races make one provider call and release losing budget reservations', async (t) => {
  const f = await fixture(t, 'responses');
  let release!: () => void;
  f.mode.gate = new Promise((resolve) => {
    release = resolve;
  });
  const turns = Array.from({ length: 6 }, () => f.request());
  for (let i = 0; i < 200 && !f.calls.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  const responses = await Promise.all(turns);
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.status === 409).length, 5);
  assert.equal(f.calls.length, 1);
  const reservations = await f.ctx.db.select().from(budgetReservations);
  assert.equal(reservations.filter((row) => row.state === 'settled').length, 1);
  assert.ok(
    reservations.every(
      (row) => row.state === 'settled' || (row.state === 'released' && row.heldUsd === 0),
    ),
  );
  const blockedLogs = (await f.ctx.db.select().from(requestLogs)).filter(
    (row) => row.status === 409,
  );
  assert.ok(blockedLogs.every((row) => row.costKnown && row.usageKnown && row.costUsd === 0));
});

test('visible thinking and hidden Responses history obey changed privacy rules without modifying opaque blocks', async (t) => {
  const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop';
  for (const format of ['responses', 'anthropic'] as const) {
    const f = await fixture(t, format);
    const settings = await f.ctx.settings.get();
    await f.ctx.settings.update({
      rules: { ...settings.rules, piiGuard: { enabled: false } },
      storePrompts: false,
    });
    const firstBody =
      format === 'responses'
        ? { ...body(format), input: secret }
        : { ...body(format), messages: [{ role: 'user', content: secret }] };
    assert.equal((await f.request(firstBody)).status, 200);
    await f.ctx.settings.update({ rules: { ...settings.rules, piiGuard: { enabled: true } } });
    const secondBody = continued(format);
    if (format === 'anthropic') (secondBody.messages as Obj[])[0]!.content = secret;
    const state = (await f.ctx.db.select().from(nativeSessionStates))[0]!;
    const blocked = await f.request(secondBody);
    assert.equal(blocked.headers.get('x-spillway-result'), 'blocked_pii');
    assert.equal(f.calls.length, 1);
    assert.deepEqual((await f.ctx.db.select().from(nativeSessionStates))[0], state);
    assert.equal(
      JSON.stringify(await f.ctx.db.select().from(nativeSessionStates)).includes(secret),
      false,
    );
    assert.equal((await log(f, blocked)).promptPreview, null);
  }
  const f = await fixture(t, 'anthropic');
  f.mode.outputPII = true;
  const first = await f.request();
  assert.equal(first.status, 200);
  const next = continued('anthropic');
  ((next.messages as Obj[])[1]!.content as Obj[])[0]!.thinking = 'alice@example.com';
  const second = await f.request(next);
  assert.equal(second.status, 200);
  assert.ok((await log(f, second)).pii?.email);
  assert.equal(
    (f.calls[1]!.messages as Obj[])[1]!.content &&
      ((f.calls[1]!.messages as Obj[])[1]!.content as Obj[])[0]!.signature,
    'signature-one',
  );
});

test('native configurations accept bounded adaptive thinking and forbid changing API mode mid-session', async (t) => {
  const f = await fixture(t, 'anthropic');
  const adaptive = { type: 'adaptive', display: 'omitted' };
  f.mode.omitted = true;
  const first = await f.request({ ...body('anthropic'), thinking: adaptive, max_tokens: 16000 });
  assert.equal(first.status, 200, await first.clone().text());
  const next: Obj = { ...continued('anthropic'), thinking: adaptive, max_tokens: 16000 };
  ((next.messages as Obj[])[1]!.content as Obj[])[0]!.thinking = '';
  const state = (await f.ctx.db.select().from(nativeSessionStates))[0]!;
  assert.equal(state.contextTokens, 16000);
  assert.equal((await f.request(next)).status, 200);
  const target = (await routingTarget(f.ctx, f.model.id))!;
  const reservations = await f.ctx.db.select().from(budgetReservations);
  assert.equal(
    reservations[1]!.estimatedUsd,
    estimateRequest(target, 'anthropic', next, state.contextTokens),
  );
  assert.ok(reservations[1]!.estimatedUsd! > estimateRequest(target, 'anthropic', next)!);
  assert.equal((await f.request({ ...body('anthropic'), thinking: undefined })).status, 409);
  assert.equal(
    (await f.request({ ...body('anthropic'), max_tokens: 32769 }, 'invalid-native-session-01'))
      .status,
    400,
  );
  const r = await fixture(t, 'responses');
  assert.equal((await r.request()).status, 200);
  const resume = { ...continued('responses'), store: undefined };
  assert.equal((await r.request(resume)).status, 200);
  assert.equal(
    (await r.request({ ...body('responses'), store: false, reasoning: undefined })).status,
    409,
  );
});

test('Messages signed history survives SQLite reopening and retains session expiry', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spillway-thinking-'));
  const file = join(dir, 'context.db');
  const f = await fixture(t, 'anthropic', file);
  assert.equal((await f.request()).status, 200);
  const reopened = await openDb(file);
  f.ctx.db = reopened.db;
  t.after(reopened.close);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const second = await f.request(continued('anthropic'));
  assert.equal(second.status, 200, await second.clone().text());
  await f.ctx.db.update(routingSessions).set({ expiresAt: new Date(Date.now() - 1) });
  const next = {
    ...continued('anthropic'),
    messages: [
      ...(continued('anthropic').messages as Obj[]),
      { role: 'assistant', content: [{ type: 'text', text: 'paid' }] },
      { role: 'user', content: 'Continue' },
    ],
  };
  assert.equal((await f.request(next)).status, 410);
  assert.equal(f.calls.length, 2);
});

test('native provider HTTP failures keep the pinned model, uncertain spend and unchanged context head', async (t) => {
  for (const format of ['responses', 'anthropic'] as const) {
    const f = await fixture(t, format);
    assert.equal((await f.request()).status, 200);
    const before = (await f.ctx.db.select().from(nativeSessionStates))[0]!;
    f.mode.httpError = true;
    const failed = await f.request(continued(format));
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('x-spillway-model'), 'native');
    assert.equal((await log(f, failed)).costKnown, false);
    const after = (await f.ctx.db.select().from(nativeSessionStates))[0]!;
    assert.equal(after.headHash, before.headHash);
    assert.equal(after.revision, before.revision);
    assert.equal(after.interrupted, true);
    assert.equal((await f.request(continued(format))).status, 409);
    assert.equal(f.calls.length, 2);
  }
});

test('an unsigned Messages thinking response cannot become a completed session head', async (t) => {
  const f = await fixture(t, 'anthropic');
  f.mode.unsigned = true;
  const failed = await f.request();
  assert.equal(failed.status, 502);
  const state = (await f.ctx.db.select().from(nativeSessionStates))[0]!;
  assert.equal(state.revision, 0);
  assert.equal(state.headHash, null);
  assert.equal(state.interrupted, true);
  assert.equal((await log(f, failed)).costKnown, false);
});
