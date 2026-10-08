import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { comparisonRunner } from '../comparison/runner.ts';
import type { ComparisonInput, ComparisonReport } from '../comparison/types.ts';
import { openDb } from '../db/client.ts';
import {
  apiKeys,
  comparisons,
  models,
  providers,
  requestLogs,
  type routingProfiles,
  routingSessions,
  teams,
} from '../db/schema.ts';
import { callerForKey } from '../gateway/handler.ts';
import { sse } from '../gateway/sse.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { testApp } from '../testing.ts';
import { listProfiles } from './service.ts';
import { resolveSession } from './sessions.ts';

const session = 'session-DEMO-0001';
const parameters = {
  type: 'object',
  properties: { orderId: { type: 'string' } },
  required: ['orderId'],
  additionalProperties: false,
};
const tool = {
  type: 'function',
  function: { name: 'get_order', description: 'Read the status of an order.', parameters },
};
const initial = [{ role: 'user', content: 'Find the status of DEMO-A.' }];
const assistant = {
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'call-demo',
      type: 'function',
      function: { name: 'get_order', arguments: '{"orderId":"DEMO-A"}' },
    },
  ],
};
const history = [
  ...initial,
  assistant,
  { role: 'tool', tool_call_id: 'call-demo', content: '{"status":"paid"}' },
];

async function fixture(
  t: TestContext,
  local = false,
  file?: string,
  kind: 'openai' | 'anthropic' | 'ollama' = 'openai',
) {
  const calls: Record<string, unknown>[] = [];
  const mode = {
    fail: false,
    missingUsage: false,
    streamEnd: 'complete' as 'complete' | 'truncated' | 'error',
    gate: undefined as Promise<void> | undefined,
  };
  const streamed = (events: string[]) => {
    const encoder = new TextEncoder();
    const gate = mode.gate;
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for (let i = 0; i < events.length; i++) {
              if (i === 1 && gate) await gate;
              const bytes = encoder.encode(events[i]!);
              // Exercise split SSE lines and JSON/argument deltas, rather than one event per read.
              controller.enqueue(bytes.slice(0, 13));
              controller.enqueue(bytes.slice(13));
            }
            controller.close();
          } catch {
            /* The client may cancel while the fixture is paused. */
          }
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const upstream = new Hono().post('/v1/chat/completions', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    calls.push(body);
    if (mode.fail && body.model === 'candidate-wire')
      return c.json({ error: { message: 'Synthetic failure' } }, 503);
    const messages = body.messages as { role: string }[];
    const final = messages.some((message) => message.role === 'tool');
    if (body.stream) {
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        sse({
          id: 'completion',
          object: 'chat.completion.chunk',
          created: 0,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }],
        });
      const events = [
        chunk({
          role: 'assistant',
          ...(final
            ? { content: 'pa' }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-demo',
                    type: 'function',
                    function: { name: 'get_order', arguments: '{"orderId":' },
                  },
                ],
              }),
        }),
      ];
      if (mode.streamEnd === 'error')
        events.push(sse({ error: { message: 'Synthetic stream failure' } }));
      else {
        events.push(
          chunk(
            final
              ? { content: 'id' }
              : { tool_calls: [{ index: 0, function: { arguments: '"DEMO-A"}' } }] },
            final ? 'stop' : 'tool_calls',
          ),
        );
        if (!mode.missingUsage)
          events.push(
            sse({
              id: 'completion',
              choices: [],
              usage: { prompt_tokens: 100, completion_tokens: 10 },
            }),
          );
        if (mode.streamEnd === 'complete') events.push('data: [DONE]\n\n');
      }
      return streamed(events);
    }
    return c.json({
      id: 'completion',
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [
        {
          index: 0,
          message: final ? { role: 'assistant', content: 'paid' } : assistant,
          finish_reason: final ? 'stop' : 'tool_calls',
        },
      ],
      ...(!mode.missingUsage ? { usage: { prompt_tokens: 100, completion_tokens: 10 } } : {}),
    });
  });
  upstream.post('/v1/messages', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    calls.push(body);
    const messages = body.messages as { content: { type: string }[] }[];
    const final = messages.some((message) =>
      message.content.some((block) => block.type === 'tool_result'),
    );
    if (body.stream) {
      const events = [
        sse(
          {
            type: 'message_start',
            message: {
              id: 'message',
              model: body.model,
              ...(!mode.missingUsage ? { usage: { input_tokens: 100, output_tokens: 0 } } : {}),
            },
          },
          'message_start',
        ),
      ];
      events.push(
        sse(
          {
            type: 'content_block_start',
            index: 0,
            content_block: final
              ? { type: 'text', text: '' }
              : { type: 'tool_use', id: 'call-demo', name: 'get_order', input: {} },
          },
          'content_block_start',
        ),
      );
      events.push(
        sse(
          {
            type: 'content_block_delta',
            index: 0,
            delta: final
              ? { type: 'text_delta', text: 'paid' }
              : { type: 'input_json_delta', partial_json: '{"orderId":"DEMO-A"}' },
          },
          'content_block_delta',
        ),
      );
      events.push(sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'));
      if (mode.streamEnd === 'error')
        events.push(
          sse(
            { type: 'error', error: { type: 'api_error', message: 'Synthetic stream failure' } },
            'error',
          ),
        );
      else {
        events.push(
          sse(
            {
              type: 'message_delta',
              delta: { stop_reason: final ? 'end_turn' : 'tool_use' },
              ...(!mode.missingUsage ? { usage: { output_tokens: 10 } } : {}),
            },
            'message_delta',
          ),
        );
        if (mode.streamEnd === 'complete')
          events.push(sse({ type: 'message_stop' }, 'message_stop'));
      }
      return streamed(events);
    }
    return c.json({
      id: 'message',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: final
        ? [{ type: 'text', text: 'paid' }]
        : [{ type: 'tool_use', id: 'call-demo', name: 'get_order', input: { orderId: 'DEMO-A' } }],
      stop_reason: final ? 'end_turn' : 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
    });
  });
  const server = serve({ fetch: upstream.fetch, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    server.close();
  });
  const f = await testApp();
  if (file) {
    const opened = await openDb(file);
    f.ctx.db = opened.db;
    t.after(opened.close);
  }
  const admin = await f.setupAdmin();
  const [provider] = await f.ctx.db
    .insert(providers)
    .values({
      name: 'Tool cloud',
      kind: 'openai',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    })
    .returning();
  const [candidateProvider] = await f.ctx.db
    .insert(providers)
    .values({
      name: 'Candidate',
      kind,
      baseUrl: kind === 'openai' ? provider!.baseUrl : provider!.baseUrl.replace(/\/v1$/, ''),
      isLocal: local,
    })
    .returning();
  const [baseline, candidate] = await f.ctx.db
    .insert(models)
    .values([
      {
        name: 'baseline',
        providerId: provider!.id,
        upstreamModel: 'baseline-wire',
        inputPrice: 10,
        outputPrice: 20,
      },
      {
        name: 'candidate',
        providerId: candidateProvider!.id,
        upstreamModel: 'candidate-wire',
        inputPrice: 1,
        outputPrice: 2,
      },
    ])
    .returning();
  const token = newGatewayKey();
  const [key] = await f.ctx.db
    .insert(apiKeys)
    .values({ name: 'Tools', kind: 'agent', hash: token.hash, prefix: token.prefix })
    .returning();
  const input: ComparisonInput = {
    name: 'Complete loop',
    keyId: key!.id,
    modelIds: [baseline!.id, candidate!.id],
    system: '',
    maxSpendUsd: 1,
    maxOutputTokens: 64,
    cases: [
      {
        name: 'Find order',
        prompt: initial[0]!.content,
        check: 'exact',
        expected: 'paid',
        tools: {
          mode: 'loop',
          definitions: [
            {
              name: tool.function.name,
              description: tool.function.description,
              parameters: JSON.stringify(parameters),
            },
          ],
          steps: [
            { name: 'get_order', arguments: '{"orderId":"DEMO-A"}', result: '{"status":"paid"}' },
          ],
        },
      },
    ],
  };
  const created = await f.send('/admin/api/comparisons', input, admin);
  assert.equal(created.status, 201, await created.clone().text());
  const id = ((await created.json()) as ComparisonReport).id;
  let report: ComparisonReport | undefined;
  for (let i = 0; i < 500; i++) {
    report = (await comparisonRunner(f.ctx).get(id))!;
    if (report.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(report!.status, 'completed');
  assert.ok(report!.cells.every((cell) => cell.status === 'passed'));
  const profileInput = {
    name: 'Tested agent',
    keyId: key!.id,
    comparisonId: id,
    baselineModelId: baseline!.id,
    candidateModelId: candidate!.id,
    fallbackOnError: false,
    mode: 'tools' as const,
  };
  const activate = async () => {
    const response = await f.send('/admin/api/routing-profiles', profileInput, admin);
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()) as typeof routingProfiles.$inferSelect;
  };
  const body = {
    model: 'baseline',
    messages: initial,
    tools: [tool],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    stream: false,
    max_tokens: 64,
  };
  const request = (
    sessionId: string | undefined = session,
    patch: Record<string, unknown> = {},
    keyToken = token.key,
    path = '/v1/chat/completions',
  ) =>
    f.app.request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${keyToken}`,
        'content-type': 'application/json',
        ...(sessionId === undefined ? {} : { 'x-spillway-session': sessionId }),
      },
      body: JSON.stringify({ ...body, ...patch }),
    });
  calls.length = 0;
  return {
    ...f,
    admin,
    calls,
    mode,
    baseline: baseline!,
    candidate: candidate!,
    candidateProvider: candidateProvider!,
    key: key!,
    token,
    report: report!,
    profileInput,
    activate,
    request,
    body,
  };
}

test('a passed complete tool-loop comparison activates a separate tool profile and pins all turns', async (t) => {
  const f = await fixture(t);
  const profile = await f.activate();
  assert.equal(profile.evidence.mode, 'tools');
  assert.equal(profile.evidence.toolContracts?.length, 1);
  assert.equal(JSON.stringify(profile).includes('orderId'), false);
  assert.equal(JSON.stringify(profile).includes('Find the status'), false);
  await f.ctx.db.delete(comparisons).where(eq(comparisons.id, f.report.id));
  const first = await f.request();
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(first.headers.get('x-spillway-model'), 'candidate');
  assert.equal(first.headers.get('x-spillway-session-status'), 'pinned');
  assert.ok(first.headers.get('x-spillway-session-expires-at'));
  const final = await f.request(session, { messages: history });
  assert.equal(final.status, 200, await final.clone().text());
  assert.equal(final.headers.get('x-spillway-model'), 'candidate');
  assert.deepEqual(
    f.calls.map((body) => body.model),
    ['candidate-wire', 'candidate-wire'],
  );
  assert.deepEqual(f.calls[1]!.messages, history);
  const logs = await f.ctx.db.select().from(requestLogs);
  const routed = logs.filter((log) => log.routingProfileId === profile.id);
  assert.equal(routed.length, 2);
  assert.ok(
    routed.every(
      (log) =>
        log.trace.some((step) => step.code === 'sessionPinned') && log.routingSavingsUsd! > 0,
    ),
  );
  const rows = await f.ctx.db.select().from(routingSessions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id.includes(session), false);
  assert.equal(JSON.stringify(rows).includes('orderId'), false);
  assert.equal((await listProfiles(f.ctx))[0]!.activeSessions, 1);
});

async function finishedLog(f: Awaited<ReturnType<typeof fixture>>, response: Response) {
  const id = response.headers.get('x-spillway-request-id')!;
  for (let i = 0; i < 200; i++) {
    const row = await f.ctx.db.query.requestLogs.findFirst({ where: eq(requestLogs.id, id) });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Stream accounting did not finish');
}

test('streamed tool arguments and final text arrive incrementally and keep the durable model', async (t) => {
  const f = await fixture(t);
  await f.activate();
  let resume = () => {};
  f.mode.gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const response = await f.request(session, {
    stream: true,
    stream_options: { include_usage: false },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-spillway-model'), 'candidate');
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(
    await f.ctx.db.query.requestLogs.findFirst({
      where: eq(requestLogs.id, response.headers.get('x-spillway-request-id')!),
    }),
    undefined,
  );
  resume();
  let output = new TextDecoder().decode(first.value);
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    output += new TextDecoder().decode(next.value);
  }
  assert.ok(output.includes('call-demo') && output.includes('[DONE]'));
  assert.deepEqual(f.calls[0]!.stream_options, { include_usage: true });
  const row = await finishedLog(f, response);
  assert.equal(row.costKnown, true);
  assert.equal(row.inputTokens, 100);
  assert.ok(row.routingSavingsUsd! > 0);
  const final = await f.request(session, { messages: history, stream: true });
  assert.ok((await final.text()).includes('[DONE]'));
  assert.equal(final.headers.get('x-spillway-model'), 'candidate');
  assert.equal((await finishedLog(f, final)).costKnown, true);
  assert.deepEqual(
    f.calls.map((call) => call.model),
    ['candidate-wire', 'candidate-wire'],
  );
});

test('interrupted or failed streams preserve uncertain charges and never fail over the session', async (t) => {
  for (const streamEnd of ['truncated', 'error'] as const) {
    const f = await fixture(t);
    await f.activate();
    f.mode.streamEnd = streamEnd;
    const response = await f.request(session, { stream: true });
    let output = '';
    try {
      output = await response.text();
    } catch {
      /* Transport may close after an error event. */
    }
    assert.equal(output.includes('[DONE]'), false);
    const row = await finishedLog(f, response);
    assert.equal(row.costKnown, false);
    assert.ok(row.error);
    assert.equal(f.calls.length, 1);
    f.mode.streamEnd = 'complete';
    assert.equal((await f.request()).headers.get('x-spillway-model'), 'candidate');
  }
});

test('canceling a paused tool stream aborts it and records uncertain charges without changing the binding', async (t) => {
  const f = await fixture(t);
  await f.activate();
  let resume = () => {};
  f.mode.gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  t.after(() => resume());
  const response = await f.request(session, { stream: true });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  const row = await finishedLog(f, response);
  assert.equal(row.costKnown, false);
  assert.match(row.error!, /disconnect/i);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.ctx.db.select().from(routingSessions))[0]!.targetModelId, f.candidate.id);
  resume();
});

test('translated Anthropic and Ollama tool streams preserve IDs, usage and failure accounting', async (t) => {
  for (const kind of ['anthropic', 'ollama'] as const) {
    const f = await fixture(t, false, undefined, kind);
    await f.activate();
    const response = await f.request(session, { stream: true });
    const text = await response.text();
    assert.ok(text.includes('call-demo') && text.includes('[DONE]'));
    assert.equal((await finishedLog(f, response)).costKnown, true);
    f.mode.missingUsage = true;
    const missing = await f.request(session, { stream: true, messages: history });
    await missing.text();
    assert.equal((await finishedLog(f, missing)).costKnown, false);
    f.mode.missingUsage = false;
    f.mode.streamEnd = 'truncated';
    const truncated = await f.request(session, { stream: true, messages: history });
    try {
      await truncated.text();
    } catch {
      /* Expected stream interruption. */
    }
    assert.equal((await finishedLog(f, truncated)).costKnown, false);
    assert.ok(f.calls.every((call) => call.model === 'candidate-wire'));
  }
});

test('tool profile requires explicit loop mode, full evidence, and provider fallback disabled', async (t) => {
  const f = await fixture(t);
  for (const patch of [{ mode: 'text' }, { fallbackOnError: true }]) {
    const response = await f.send(
      '/admin/api/routing-profiles',
      { ...f.profileInput, ...patch },
      f.admin,
    );
    assert.equal(response.status, 400);
  }
  const old = structuredClone(f.report);
  delete old.cases[0]!.toolContractHash;
  await f.ctx.db.update(comparisons).set({ report: old }).where(eq(comparisons.id, old.id));
  assert.equal((await f.send('/admin/api/routing-profiles', f.profileInput, f.admin)).status, 400);
  await f.ctx.db.update(comparisons).set({ report: f.report }).where(eq(comparisons.id, old.id));
  const profile = await f.activate();
  assert.equal(
    (
      await f.send(
        `/admin/api/routing-profiles/${profile.id}`,
        { fallbackOnError: true },
        f.admin,
        'PATCH',
      )
    ).status,
    400,
  );
});

test('tool traffic without a session keeps the original model and a pre-existing original binding never upgrades', async (t) => {
  const f = await fixture(t);
  const before = await f.request();
  assert.equal(before.headers.get('x-spillway-model'), 'baseline');
  await f.activate();
  const noHeader = await f.app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${f.token.key}`, 'content-type': 'application/json' },
    body: JSON.stringify(f.body),
  });
  assert.equal(noHeader.headers.get('x-spillway-model'), 'baseline');
  const continuation = await f.request(session, { messages: history });
  assert.equal(continuation.headers.get('x-spillway-model'), 'baseline');
  assert.equal((await f.request('new-session-00002')).headers.get('x-spillway-model'), 'candidate');
});

test('only evaluated definitions qualify, canonical object order is stable, and a bound contract cannot change', async (t) => {
  const f = await fixture(t);
  await f.activate();
  const reordered = {
    type: 'function',
    function: {
      parameters: {
        additionalProperties: false,
        required: ['orderId'],
        properties: { orderId: { type: 'string' } },
        type: 'object',
      },
      description: tool.function.description,
      name: 'get_order',
    },
  };
  assert.equal(
    (await f.request(session, { tools: [reordered] })).headers.get('x-spillway-model'),
    'candidate',
  );
  const changed = {
    ...tool,
    function: { ...tool.function, description: 'A different definition' },
  };
  const rejected = await f.request(session, { tools: [changed], messages: history });
  assert.equal(rejected.status, 409);
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.request('changed-session-0001', { tools: [changed] })).headers.get('x-spillway-model'),
    'baseline',
  );
});

test('an unknown session cannot adopt prior assistant/tool history, and malformed history is rejected', async (t) => {
  const f = await fixture(t);
  await f.activate();
  for (const messages of [history, [...initial, { role: 'assistant', content: 'Old context' }]]) {
    assert.equal((await f.request(session, { messages })).status, 409);
  }
  for (const messages of [
    [...initial, assistant],
    [...history, assistant, history.at(-1)!],
    [...initial, { role: 'tool', tool_call_id: 'unknown', content: 'paid' }],
  ])
    assert.equal((await f.request(session, { messages })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('unsupported image, native protocol, strict tools, and output caps cannot enter a pinned session', async (t) => {
  const f = await fixture(t);
  await f.activate();
  for (const patch of [
    { stream: 'true' },
    { stream: true, stream_options: { unexpected: true } },
    { parallel_tool_calls: true },
    { max_tokens: 3000 },
    { tools: [{ ...tool, function: { ...tool.function, strict: true } }] },
    {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:example' } }] },
      ],
    },
  ])
    assert.equal((await f.request(session, patch)).status, 400);
  assert.equal(
    (await f.request(session, { input: 'Hello' }, f.token.key, '/v1/responses')).status,
    400,
  );
  assert.equal((await f.request('tiny')).status, 400);
  assert.equal(f.calls.length, 0);
});

test('disabling or removing a profile blocks its established sessions instead of silently changing models', async (t) => {
  const f = await fixture(t);
  const profile = await f.activate();
  await f.request();
  await f.send(`/admin/api/routing-profiles/${profile.id}`, { enabled: false }, f.admin, 'PATCH');
  assert.equal((await f.request(session, { messages: history })).status, 409);
  await f.send(`/admin/api/routing-profiles/${profile.id}`, { enabled: true }, f.admin, 'PATCH');
  assert.equal(
    (await f.request(session, { messages: history })).headers.get('x-spillway-model'),
    'candidate',
  );
  await f.send(`/admin/api/routing-profiles/${profile.id}`, undefined, f.admin, 'DELETE');
  assert.equal((await f.request(session, { messages: history })).status, 409);
  assert.equal((await f.ctx.db.select().from(routingSessions)).length, 1);
  assert.equal(f.calls.length, 2);
});

test('changed model configuration or candidate permissions cannot switch a session to baseline', async (t) => {
  for (const change of ['configuration', 'permission', 'disabled']) {
    const f = await fixture(t);
    await f.activate();
    await f.request();
    if (change === 'configuration')
      await f.ctx.db.update(models).set({ outputPrice: 3 }).where(eq(models.id, f.candidate.id));
    if (change === 'permission')
      await f.ctx.db
        .update(apiKeys)
        .set({ allowedModelIds: [f.baseline.id] })
        .where(eq(apiKeys.id, f.key.id));
    if (change === 'disabled')
      await f.ctx.db.update(models).set({ enabled: false }).where(eq(models.id, f.candidate.id));
    assert.equal(
      (await f.request(session, { messages: history })).status,
      change === 'permission' ? 403 : 409,
    );
    assert.equal(f.calls.length, 1);
  }
});

test('key and team budgets stop pinned paid turns despite a configured local fallback', async (t) => {
  for (const level of ['key', 'team']) {
    const f = await fixture(t);
    await f.activate();
    await f.request();
    const [localProvider] = await f.ctx.db
      .insert(providers)
      .values({
        name: 'Local fallback',
        kind: 'openai',
        isLocal: true,
        baseUrl: f.candidateProvider.baseUrl,
      })
      .returning();
    const [local] = await f.ctx.db
      .insert(models)
      .values({ name: 'local', providerId: localProvider!.id, upstreamModel: 'local-wire' })
      .returning();
    await f.ctx.settings.update({ localModelId: local!.id });
    if (level === 'key')
      await f.ctx.db
        .update(apiKeys)
        .set({ dailyLimitUsd: 0.00013 })
        .where(eq(apiKeys.id, f.key.id));
    else {
      const [team] = await f.ctx.db
        .insert(teams)
        .values({ name: 'Tiny budget', monthlyBudgetUsd: 0.00001 })
        .returning();
      await f.ctx.db.update(apiKeys).set({ teamId: team!.id }).where(eq(apiKeys.id, f.key.id));
    }
    assert.equal((await f.request(session, { messages: history })).status, 429);
    assert.equal(f.calls.length, 1);
  }
});

test('provider failure stays on the pinned model and records uncertain charges without any fallback', async (t) => {
  const f = await fixture(t);
  await f.activate();
  await f.request();
  await f.ctx.settings.update({ localModelId: f.baseline.id, rerouteOnFailure: true });
  f.mode.fail = true;
  const failed = await f.request(session, { messages: history });
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('x-spillway-model'), 'candidate');
  const log = await f.ctx.db.query.requestLogs.findFirst({
    where: eq(requestLogs.id, failed.headers.get('x-spillway-request-id')!),
  });
  assert.equal(log!.costKnown, false);
  assert.deepEqual(
    f.calls.map((body) => body.model),
    ['candidate-wire', 'candidate-wire'],
  );
  f.mode.fail = false;
  assert.equal(
    (await f.request(session, { messages: history })).headers.get('x-spillway-model'),
    'candidate',
  );
});

test('cloud privacy checks apply to every pinned turn and sessions bypass response caching', async (t) => {
  const f = await fixture(t);
  await f.activate();
  await f.ctx.settings.update({ cache: { enabled: true, ttlHours: 1 } });
  await f.request();
  await f.request();
  assert.equal(f.calls.length, 2);
  const privateHistory = structuredClone(history);
  privateHistory[1] = {
    ...assistant,
    tool_calls: [
      {
        ...assistant.tool_calls[0]!,
        function: { name: 'get_order', arguments: '{"orderId":"4111 1111 1111 1111"}' },
      },
    ],
  };
  assert.equal((await f.request(session, { messages: privateHistory })).status, 403);
  assert.equal(f.calls.length, 2);
});

test('session IDs are scoped to keys and concurrent first turns have one durable model choice', async (t) => {
  const f = await fixture(t);
  await f.activate();
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.request()));
  assert.ok(
    responses.every(
      (response) =>
        response.status === 200 && response.headers.get('x-spillway-model') === 'candidate',
    ),
  );
  assert.equal((await f.ctx.db.select().from(routingSessions)).length, 1);
  const other = newGatewayKey();
  await f.ctx.db
    .insert(apiKeys)
    .values({ name: 'Other', kind: 'agent', hash: other.hash, prefix: other.prefix });
  assert.equal(
    (await f.request(session, {}, other.key)).headers.get('x-spillway-model'),
    'baseline',
  );
  assert.equal((await f.ctx.db.select().from(routingSessions)).length, 2);
});

test('session affinity survives reopening SQLite and expired sessions fail without adopting old tool history', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'spillway-affinity-'));
  const file = join(folder, 'session.sqlite');
  const f = await fixture(t, false, file);
  await f.activate();
  await f.request();
  const reopened = await openDb(file);
  t.after(reopened.close);
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const caller = await callerForKey({ ...f.ctx, db: reopened.db }, f.key.id);
  assert.ok(caller);
  const binding = await resolveSession(
    { ...f.ctx, db: reopened.db },
    caller,
    { ...f.body, messages: history },
    'openai',
    session,
  );
  assert.equal(binding.target.model.id, f.candidate.id);
  await reopened.db.update(routingSessions).set({ expiresAt: new Date(0) });
  assert.equal((await f.request(session, { messages: history })).status, 410);
  assert.equal(f.calls.length, 1);
});

test('session capacity rejects new bindings without evicting existing conversations', async (t) => {
  const f = await fixture(t);
  await f.activate();
  await f.request();
  const [saved] = await f.ctx.db.select().from(routingSessions);
  await f.ctx.db
    .insert(routingSessions)
    .values(Array.from({ length: 999 }, (_, index) => ({ ...saved!, id: `capacity-${index}` })));
  assert.equal((await f.request('new-over-capacity-001')).status, 429);
  assert.equal(
    (await f.request(session, { messages: history })).headers.get('x-spillway-model'),
    'candidate',
  );
  assert.equal((await f.ctx.db.select().from(routingSessions)).length, 1000);
  assert.equal(f.calls.length, 2);
});

test('soft budget thresholds and off-hours rules preserve the session model while hard admission still applies', async (t) => {
  for (const rule of ['threshold', 'schedule']) {
    const f = await fixture(t);
    await f.activate();
    const settings = await f.ctx.settings.get();
    if (rule === 'threshold') {
      const [team] = await f.ctx.db
        .insert(teams)
        .values({ name: 'Threshold team', monthlyBudgetUsd: 0.01 })
        .returning();
      await f.ctx.db.update(apiKeys).set({ teamId: team!.id }).where(eq(apiKeys.id, f.key.id));
      await f.ctx.settings.update({
        rules: { ...settings.rules, budgetThreshold: { enabled: true, percent: 1 } },
      });
    } else
      await f.ctx.settings.update({
        rules: { ...settings.rules, offHours: { enabled: true, from: '00:00', to: '00:00' } },
      });
    await f.request();
    const continued = await f.request(session, { messages: history });
    assert.equal(continued.status, 200, await continued.clone().text());
    assert.equal(continued.headers.get('x-spillway-model'), 'candidate');
    const log = await f.ctx.db.query.requestLogs.findFirst({
      where: eq(requestLogs.id, continued.headers.get('x-spillway-request-id')!),
    });
    assert.ok(log!.trace.some((step) => step.code === 'sessionKept'));
    assert.ok(f.calls.every((body) => body.model === 'candidate-wire'));
  }
});

test('pinned Chat tool sessions preserve call IDs through Anthropic and Ollama provider translations', async (t) => {
  for (const kind of ['anthropic', 'ollama'] as const) {
    const f = await fixture(t, kind === 'ollama', undefined, kind);
    await f.activate();
    const first = await f.request();
    assert.equal(first.status, 200, await first.clone().text());
    const second = await f.request(session, { messages: history });
    assert.equal(second.status, 200, await second.clone().text());
    assert.equal(second.headers.get('x-spillway-model'), 'candidate');
    assert.ok(f.calls.every((body) => body.model === 'candidate-wire'));
    if (kind === 'anthropic') {
      assert.deepEqual(f.calls[0]!.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
      assert.deepEqual((f.calls[1]!.messages as { content: unknown }[]).at(-1)!.content, [
        { type: 'tool_result', tool_use_id: 'call-demo', content: '{"status":"paid"}' },
      ]);
    } else assert.deepEqual(f.calls[1]!.messages, history);
  }
});
