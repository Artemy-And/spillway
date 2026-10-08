import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { type TestContext, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  apiKeys,
  comparisons,
  models,
  providers,
  requestLogs,
  taskSets,
  users,
} from '../db/schema.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { testApp } from '../testing.ts';
import type { ComparisonInput, ComparisonReport, ToolScenario } from './types.ts';

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: unknown };
}
interface Message {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface StubRequest {
  model: string;
  messages: Message[];
  tools: { type: string; function: { name: string; parameters: unknown } }[];
  tool_choice: string;
  parallel_tool_calls: boolean;
  max_tokens: number;
  stream: boolean;
}
interface Options {
  local?: boolean;
  scenario?: ToolScenario;
  reply?: (body: StubRequest, index: number) => Message;
  beforeResponse?: (body: StubRequest, index: number) => Promise<void>;
  missingUsage?: boolean;
  promptTokens?: number;
  finishReason?: string;
  delay?: number;
}

const lookupArguments = '{"order":"SYNTHETIC-17"}';
const lookupResult = '{"status":"paid","marker":"fixed-fixture-result"}';
const call = (
  name = 'lookup_order',
  args: unknown = lookupArguments,
  id = 'lookup-1',
): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});
const toolMessage = (...calls: ToolCall[]): Message => ({
  role: 'assistant',
  content: null,
  tool_calls: calls,
});
const finalMessage = (content = 'Order is paid'): Message => ({ role: 'assistant', content });

function scenario(mode: ToolScenario['mode'] = 'loop', twoSteps = false): ToolScenario {
  return {
    mode,
    definitions: [
      {
        name: 'lookup_order',
        description: 'Read an order from the synthetic fixture',
        parameters:
          '{"type":"object","properties":{"order":{"type":"string"}},"required":["order"]}',
      },
      ...(twoSteps
        ? [
            {
              name: 'mark_seen',
              description: 'Mark the synthetic order seen',
              parameters: '{"type":"object"}',
            },
          ]
        : []),
    ],
    steps: [
      { name: 'lookup_order', arguments: lookupArguments, result: lookupResult },
      ...(twoSteps
        ? [{ name: 'mark_seen', arguments: '{"seen":true}', result: 'marked-seen' }]
        : []),
    ],
  };
}

async function fixture(t: TestContext, options: Options = {}) {
  const calls: StubRequest[] = [];
  const tools = options.scenario ?? scenario();
  const upstream = new Hono().post('/v1/chat/completions', async (c) => {
    const body = await c.req.json<StubRequest>();
    const index = calls.length;
    calls.push(body);
    const stepIndex = body.messages.filter((message) => message.role === 'tool').length;
    const step = tools.steps[stepIndex];
    const message = options.reply
      ? options.reply(body, index)
      : step
        ? toolMessage(call(step.name, step.arguments, `step-${stepIndex + 1}`))
        : finalMessage();
    if (options.beforeResponse) await options.beforeResponse(body, index);
    if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
    return c.json({
      id: `completion-${index}`,
      object: 'chat.completion',
      created: 0,
      model: body.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason:
            options.finishReason ?? (message.tool_calls?.length ? 'tool_calls' : 'stop'),
        },
      ],
      ...(!options.missingUsage
        ? { usage: { prompt_tokens: options.promptTokens ?? 100, completion_tokens: 10 } }
        : {}),
    });
  });
  const server = serve({ fetch: upstream.fetch, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    server.close();
  });
  const f = await testApp();
  const admin = await f.setupAdmin();
  const [provider] = await f.ctx.db
    .insert(providers)
    .values({
      name: 'Synthetic tool provider',
      kind: 'openai',
      isLocal: options.local ?? false,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    })
    .returning();
  const added = await f.ctx.db
    .insert(models)
    .values([
      {
        name: 'tool-baseline',
        providerId: provider!.id,
        upstreamModel: 'baseline-wire',
        inputPrice: 10,
        outputPrice: 20,
      },
      {
        name: 'tool-candidate',
        providerId: provider!.id,
        upstreamModel: 'candidate-wire',
        inputPrice: 1,
        outputPrice: 2,
      },
    ])
    .returning();
  const key = newGatewayKey();
  const [chargedKey] = await f.ctx.db
    .insert(apiKeys)
    .values({
      name: 'Tool evaluation key',
      kind: 'agent',
      hash: key.hash,
      prefix: key.prefix,
      fallbackToLocal: false,
    })
    .returning();
  const input: ComparisonInput = {
    name: 'Synthetic tool comparison',
    keyId: chargedKey!.id,
    modelIds: added.map((model) => model.id),
    system: 'Use the supplied functions to look up the synthetic order.',
    maxSpendUsd: 0.5,
    maxOutputTokens: 64,
    cases: [
      {
        name: 'Order lookup',
        prompt: 'Read SYNTHETIC-17',
        check: 'exact',
        expected: 'Order is paid',
        tools,
      },
    ],
  };
  const create = async (value = input) => {
    const response = await f.send('/admin/api/comparisons', value, admin);
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()) as ComparisonReport;
  };
  const finish = async (id: string) => {
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      const response = await f.get(`/admin/api/comparisons/${id}`, admin);
      assert.equal(response.status, 200, await response.clone().text());
      const report = (await response.json()) as ComparisonReport;
      if (report.status !== 'running') return report;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Tool comparison did not finish');
  };
  const waitForCalls = async (number: number) => {
    const until = Date.now() + 3000;
    while (calls.length < number && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, number, 'Expected the provider to receive the active request');
  };
  return {
    ...f,
    admin,
    calls,
    input,
    added,
    create,
    finish,
    waitForCalls,
    chargedKey: chargedKey!,
  };
}

test('tool-call checks pass exact structured arguments without executing a fixture or checking final text', async (t) => {
  const f = await fixture(t, {
    scenario: scenario('call'),
    reply: () => toolMessage(call('lookup_order', '{ "order" : "SYNTHETIC-17" }')),
  });
  f.input.cases[0]!.expected = '';
  const report = await f.finish((await f.create()).id);
  assert.ok(report.cells.every((cell) => cell.status === 'passed' && cell.reason === 'matched'));
  assert.equal(report.cases[0]!.toolMode, 'call');
  assert.equal(f.calls.length, 2);
  assert.ok(
    f.calls.every(
      (body) =>
        body.tool_choice === 'auto' && body.parallel_tool_calls === false && body.stream === false,
    ),
  );
  assert.ok(f.calls.every((body) => body.messages.every((message) => message.role !== 'tool')));
  assert.ok(
    report.cells.every(
      (cell) =>
        cell.toolSteps?.length === 1 &&
        cell.toolSteps[0]!.phase === 'call' &&
        cell.toolSteps[0]!.requestId,
    ),
  );
  assert.ok(Math.abs(report.spentUsd - 0.00132) < 1e-12);
});

test('two fixture steps preserve call IDs and order, check final text, and sum every request cost and token count', async (t) => {
  const f = await fixture(t, { scenario: scenario('loop', true) });
  const quote = await f.send('/admin/api/comparisons/quote', f.input, f.admin);
  assert.equal(quote.status, 200);
  assert.equal(((await quote.json()) as { calls: number }).calls, 6);
  assert.equal(f.calls.length, 0);
  const report = await f.finish((await f.create()).id);
  assert.equal(f.calls.length, 6);
  assert.ok(
    report.cells.every(
      (cell) => cell.status === 'passed' && cell.output?.includes('Order is paid'),
    ),
  );
  assert.ok(report.cells.every((cell) => cell.inputTokens === 300 && cell.outputTokens === 30));
  assert.ok(Math.abs(report.spentUsd - 0.00396) < 1e-12);
  for (const model of ['baseline-wire', 'candidate-wire']) {
    const sequence = f.calls.filter((body) => body.model === model);
    assert.deepEqual(sequence[1]!.messages.slice(-2), [
      toolMessage(call('lookup_order', lookupArguments, 'step-1')),
      { role: 'tool', content: lookupResult, tool_call_id: 'step-1' },
    ]);
    assert.deepEqual(sequence[2]!.messages.slice(-2), [
      toolMessage(call('mark_seen', '{"seen":true}', 'step-2')),
      { role: 'tool', content: 'marked-seen', tool_call_id: 'step-2' },
    ]);
  }
  assert.ok(report.cells.every((cell) => cell.toolSteps?.length === 3));
  assert.deepEqual(
    report.cells[0]!.toolSteps!.map((step) => [step.phase, step.status]),
    [
      ['call', 'passed'],
      ['call', 'passed'],
      ['final', 'passed'],
    ],
  );
  assert.equal((await f.ctx.db.select().from(requestLogs)).length, 6);
});

test('wrong function names fail before any fixture result reaches the provider', async (t) => {
  const f = await fixture(t, {
    reply: () => toolMessage(call('run_shell', '{"command":"arbitrary-execution"}')),
  });
  const report = await f.finish((await f.create()).id);
  assert.ok(
    report.cells.every((cell) => cell.status === 'failed' && cell.reason === 'toolUnexpected'),
  );
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((body) => !JSON.stringify(body).includes('fixed-fixture-result')));
});

test('wrong, extra, malformed, and non-object tool arguments fail with no follow-up request', async (t) => {
  for (const argumentsValue of [
    '{"order":"OTHER"}',
    '{"order":"SYNTHETIC-17","extra":true}',
    '{',
    '["SYNTHETIC-17"]',
    { order: 'SYNTHETIC-17' },
  ]) {
    const f = await fixture(t, { reply: () => toolMessage(call('lookup_order', argumentsValue)) });
    const report = await f.finish((await f.create()).id);
    assert.ok(
      report.cells.every((cell) => cell.status === 'failed' && cell.reason === 'toolArguments'),
      JSON.stringify(argumentsValue),
    );
    assert.equal(f.calls.length, 2);
  }
});

test('parallel tool calls and missing tool calls fail before consuming fixture data', async (t) => {
  for (const reply of [
    () => toolMessage(call(), call('lookup_order', lookupArguments, 'second')),
    () => finalMessage('Order is paid'),
  ]) {
    const f = await fixture(t, { reply });
    const report = await f.finish((await f.create()).id);
    assert.ok(report.cells.every((cell) => cell.status === 'failed'));
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every((body) => body.messages.every((message) => message.role !== 'tool')));
  }
});

test('unexpected tool calls in the final turn fail and never extend the bounded loop', async (t) => {
  const f = await fixture(t, {
    reply: (body) =>
      toolMessage(call('lookup_order', lookupArguments, `call-${body.messages.length}`)),
  });
  const report = await f.finish((await f.create()).id);
  assert.ok(
    report.cells.every((cell) => cell.status === 'failed' && cell.reason === 'toolSequence'),
  );
  assert.equal(f.calls.length, 4);
  assert.ok(report.cells.every((cell) => cell.toolSteps?.length === 2));
});

test('repeated tool-call IDs stop a multi-step scenario before injecting the second result', async (t) => {
  const tools = scenario('loop', true);
  const f = await fixture(t, {
    scenario: tools,
    reply: (body) => {
      const index = body.messages.filter((message) => message.role === 'tool').length;
      const step = tools.steps[index]!;
      return toolMessage(call(step.name, step.arguments, 'same-id'));
    },
  });
  const report = await f.finish((await f.create()).id);
  assert.ok(
    report.cells.every((cell) => cell.status === 'failed' && cell.reason === 'toolSequence'),
  );
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every((body) => !JSON.stringify(body).includes('marked-seen')));
});

test('truncated function arguments fail even when the returned JSON matches exactly', async (t) => {
  const f = await fixture(t, { finishReason: 'length' });
  const report = await f.finish((await f.create()).id);
  assert.ok(report.cells.every((cell) => cell.status === 'failed' && cell.reason === 'truncated'));
  assert.equal(f.calls.length, 2);
});

test('actual spend beyond the run allowance stops in the middle of a tool loop', async (t) => {
  const f = await fixture(t, { promptTokens: 100_000 });
  const report = await f.finish((await f.create()).id);
  assert.equal(f.calls.length, 1);
  assert.ok(report.spentUsd > report.maxSpendUsd);
  assert.equal(report.cells[0]!.reason, 'budget');
  assert.equal(report.cells[1]!.reason, 'budget');
  assert.ok(report.cells[0]!.costUsd! > 0);
});

test('unknown cost stops cloud follow-up calls within the same scenario', async (t) => {
  const f = await fixture(t, { missingUsage: true });
  const report = await f.finish((await f.create()).id);
  assert.equal(f.calls.length, 1);
  assert.equal(report.unknownCosts, true);
  assert.equal(report.cells[0]!.costUsd, null);
  assert.equal(report.cells[0]!.reason, 'unknownCost');
  assert.equal(report.cells[1]!.reason, 'unknownCost');
});

test('changed key budgets are checked again before the next paid tool turn', async (t) => {
  const options: Options = {};
  const f = await fixture(t, options);
  options.beforeResponse = async (_body, index) => {
    if (index === 0)
      await f.ctx.db
        .update(apiKeys)
        .set({ dailyLimitUsd: 0 })
        .where(eq(apiKeys.id, f.chargedKey.id));
  };
  const report = await f.finish((await f.create()).id);
  assert.equal(f.calls.length, 1);
  assert.equal(report.cells[0]!.reason, 'policy');
  assert.equal(report.cells[1]!.reason, 'policy');
  assert.ok(Math.abs(report.spentUsd - 0.0012) < 1e-12);
});

test('PII in tool definitions, fixture results, or returned arguments is blocked before leaving the gateway', async (t) => {
  for (const location of ['result', 'arguments', 'description', 'parameters']) {
    const tools = scenario();
    if (location === 'arguments') tools.steps[0]!.arguments = '{"order":"4111 1111 1111 1111"}';
    if (location === 'result') tools.steps[0]!.result = 'Card 4111 1111 1111 1111';
    if (location === 'description') tools.definitions[0]!.description = 'Card 4111 1111 1111 1111';
    if (location === 'parameters')
      tools.definitions[0]!.parameters =
        '{"type":"object","description":"Card 4111 1111 1111 1111"}';
    const f = await fixture(t, { scenario: tools });
    const report = await f.finish((await f.create()).id);
    assert.ok(
      report.cells.every((cell) => cell.reason === 'policy'),
      JSON.stringify({ location, cells: report.cells, calls: f.calls }),
    );
    assert.equal(f.calls.length, location === 'result' || location === 'arguments' ? 2 : 0);
    assert.ok(f.calls.every((body) => body.messages.every((message) => message.role !== 'tool')));
  }
});

test('saved tool task fingerprints include definitions and fixture results', async (t) => {
  const f = await fixture(t);
  const savedResponse = await f.send('/admin/api/task-sets', f.input, f.admin);
  assert.equal(savedResponse.status, 201, await savedResponse.clone().text());
  const saved = (await savedResponse.json()) as typeof taskSets.$inferSelect;
  for (const change of ['definition', 'result']) {
    const changed = structuredClone(f.input);
    changed.taskSet = { id: saved.id, revision: saved.revision };
    if (change === 'definition') changed.cases[0]!.tools!.definitions[0]!.description += ' changed';
    else changed.cases[0]!.tools!.steps[0]!.result = 'different-fixture';
    assert.equal((await f.send('/admin/api/comparisons', changed, f.admin)).status, 409);
  }
  assert.equal(f.calls.length, 0);
  const replay = await f.finish(
    (await f.create({ ...f.input, taskSet: { id: saved.id, revision: saved.revision } })).id,
  );
  assert.ok(replay.cells.every((cell) => cell.status === 'passed'));
  assert.equal(replay.evaluation!.fingerprint, saved.fingerprint);
});

test('saving tool templates rejects PII in descriptions, parameter schemas, expected arguments, and fixture results', async (t) => {
  const f = await fixture(t);
  for (const location of ['description', 'parameters', 'arguments', 'result']) {
    const input = structuredClone(f.input);
    const tools = input.cases[0]!.tools!;
    if (location === 'description') tools.definitions[0]!.description = 'Contact alice@example.com';
    if (location === 'parameters')
      tools.definitions[0]!.parameters = '{"type":"object","description":"alice@example.com"}';
    if (location === 'arguments') tools.steps[0]!.arguments = '{"order":"alice@example.com"}';
    if (location === 'result') tools.steps[0]!.result = 'alice@example.com';
    assert.equal((await f.send('/admin/api/task-sets', input, f.admin)).status, 400, location);
  }
  assert.equal((await f.ctx.db.select().from(taskSets)).length, 0);
  assert.equal(f.calls.length, 0);
});

test('tool reports mask model output and omit fixture configuration and prompt texts from stored evidence', async (t) => {
  const f = await fixture(t, {
    reply: (body) =>
      body.messages.some((message) => message.role === 'tool')
        ? finalMessage('Contact alice@example.com')
        : toolMessage(call()),
  });
  f.input.cases[0]!.check = 'contains';
  f.input.cases[0]!.expected = 'alice@example.com';
  const report = await f.finish((await f.create()).id);
  assert.ok(
    report.cells.every(
      (cell) => cell.status === 'passed' && !cell.output?.includes('alice@example.com'),
    ),
  );
  const stored = await f.ctx.db.query.comparisons.findFirst({
    where: eq(comparisons.id, report.id),
  });
  const raw = JSON.stringify(stored!.report);
  assert.ok(!raw.includes('fixed-fixture-result'));
  assert.ok(!raw.includes(f.input.cases[0]!.prompt));
  assert.ok(
    report.cells.every((cell) =>
      cell.toolSteps?.every(
        (step) => !('arguments' in step) && !('result' in step) && !('parameters' in step),
      ),
    ),
  );
  assert.ok(!raw.includes('Read an order from the synthetic fixture'));
  assert.ok(!raw.includes('alice@example.com'));
  await f.ctx.settings.update({ storePrompts: false });
  const hidden = await f.finish((await f.create()).id);
  assert.equal(hidden.storesOutputs, false);
  assert.ok(
    hidden.cells.every(
      (cell) => cell.output === null && cell.status === 'passed' && cell.toolSteps?.length === 2,
    ),
  );
  assert.ok(hidden.spentUsd > 0);
  for (const args of [
    '"alice\\u0040example.com"',
    '["alice\\u0040example.com"]',
    '["\\u0034\\u0031\\u0031\\u0031 1111 1111 1111"]',
    `{"email":"alice\\u0040example.com","padding":"${'x'.repeat(8100)}"}`,
  ]) {
    const malformed = await fixture(t, {
      scenario: scenario('call'),
      reply: () => toolMessage(call('lookup_order', args)),
    });
    const rejected = await malformed.finish((await malformed.create()).id);
    assert.ok(
      rejected.cells.every((cell) => cell.status === 'failed' && cell.reason === 'toolArguments'),
    );
    assert.ok(rejected.cells.every((cell) => cell.output !== null));
    assert.ok(
      rejected.cells.every(
        (cell) => !cell.output?.includes('alice') && !cell.output?.includes('1111'),
      ),
    );
    assert.ok(
      rejected.cells.every(
        (cell) => !cell.output?.includes('\\u0040') && !cell.output?.includes('\\u0034'),
      ),
    );
    assert.equal(malformed.calls.length, 2);
    const storedFailure = await malformed.ctx.db.query.comparisons.findFirst({
      where: eq(comparisons.id, rejected.id),
    });
    assert.ok(!JSON.stringify(storedFailure!.report).includes('alice'));
  }
});

test('cancelling a dispatched tool scenario aborts it without injecting fixtures or starting the next model', async (t) => {
  const f = await fixture(t, { delay: 300 });
  const created = await f.create();
  await f.waitForCalls(1);
  assert.equal(
    (await f.send(`/admin/api/comparisons/${created.id}/cancel`, undefined, f.admin)).status,
    200,
  );
  const report = await f.finish(created.id);
  assert.equal(report.status, 'cancelled');
  assert.equal(f.calls.length, 1);
  assert.equal(report.cells[1]!.reason, 'cancelled');
  assert.equal(report.unknownCosts, true);
});

test('revoking an administrator or key, or changing the selected model, halts the next tool turn', async (t) => {
  for (const change of ['admin', 'key', 'model']) {
    const options: Options = {};
    const f = await fixture(t, options);
    options.beforeResponse = async (_body, index) => {
      if (index !== 0) return;
      if (change === 'admin') await f.ctx.db.update(users).set({ disabledAt: new Date() });
      else if (change === 'key')
        await f.ctx.db
          .update(apiKeys)
          .set({ revokedAt: new Date() })
          .where(eq(apiKeys.id, f.chargedKey.id));
      else
        await f.ctx.db
          .update(models)
          .set({ upstreamModel: 'replacement-wire' })
          .where(eq(models.id, f.added[0]!.id));
    };
    const created = await f.create();
    // Read the stored report after revocation; the old admin cookie correctly loses API access.
    const until = Date.now() + 6000;
    let report: ComparisonReport | undefined;
    while (Date.now() < until) {
      report = (
        await f.ctx.db.query.comparisons.findFirst({ where: eq(comparisons.id, created.id) })
      )?.report;
      if (report?.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(report!.status, 'completed');
    assert.equal(report!.cells[0]!.reason, 'unavailable');
    assert.ok(Math.abs(report!.cells[0]!.costUsd! - 0.0012) < 1e-12);
    if (change === 'admin' || change === 'key') assert.equal(f.calls.length, 1);
    else assert.ok(f.calls.filter((body) => body.model === 'baseline-wire').length === 1);
    assert.ok(f.calls.every((body) => body.model !== 'replacement-wire'));
  }
});

test('passing tool evaluations cannot create text-routing profiles', async (t) => {
  const f = await fixture(t, { scenario: scenario('call') });
  const report = await f.finish((await f.create()).id);
  assert.ok(report.cells.every((cell) => cell.status === 'passed'));
  const response = await f.send(
    '/admin/api/routing-profiles',
    {
      name: 'Invalid tool profile',
      keyId: f.chargedKey.id,
      comparisonId: report.id,
      baselineModelId: f.added[0]!.id,
      candidateModelId: f.added[1]!.id,
      fallbackOnError: true,
    },
    f.admin,
  );
  assert.equal(response.status, 400);
  assert.equal(f.calls.length, 2);
});

test('manual review cannot override function checks and updates only a valid loop final verdict', async (t) => {
  for (const variant of ['callPassed', 'callFailed', 'loopFailed']) {
    const f = await fixture(t, {
      scenario: scenario(variant === 'loopFailed' ? 'loop' : 'call'),
      ...(variant !== 'callPassed'
        ? { reply: () => toolMessage(call('lookup_order', '{"order":"WRONG"}')) }
        : {}),
    });
    f.input.cases[0]!.check = 'manual';
    f.input.cases[0]!.expected = '';
    const report = await f.finish((await f.create()).id);
    assert.equal(report.cells[0]!.status, variant === 'callPassed' ? 'passed' : 'failed');
    const response = await f.send(
      `/admin/api/comparisons/${report.id}/review`,
      {
        caseIndex: 0,
        modelId: f.added[0]!.id,
        status: variant === 'callPassed' ? 'failed' : 'passed',
      },
      f.admin,
      'PATCH',
    );
    assert.equal(response.status, 400, variant);
    const unchanged = await f.finish(report.id);
    assert.equal(unchanged.cells[0]!.status, report.cells[0]!.status);
    assert.equal(unchanged.cells[0]!.toolSteps![0]!.status, report.cells[0]!.toolSteps![0]!.status);
  }
  const f = await fixture(t);
  f.input.cases[0]!.check = 'manual';
  f.input.cases[0]!.expected = '';
  const report = await f.finish((await f.create()).id);
  assert.ok(report.cells.every((cell) => cell.status === 'review' && cell.reason === 'manual'));
  for (const status of ['failed', 'passed'] as const) {
    const response = await f.send(
      `/admin/api/comparisons/${report.id}/review`,
      {
        caseIndex: 0,
        modelId: f.added[0]!.id,
        status,
      },
      f.admin,
      'PATCH',
    );
    assert.equal(response.status, 200, await response.clone().text());
    const reviewed = (await response.json()) as ComparisonReport;
    assert.equal(reviewed.cells[0]!.status, status);
    assert.equal(reviewed.cells[0]!.reason, 'manual');
    assert.equal(reviewed.cells[0]!.toolSteps![0]!.status, 'passed');
    assert.equal(reviewed.cells[0]!.toolSteps!.at(-1)!.status, status);
    assert.equal(reviewed.cells[0]!.toolSteps!.at(-1)!.reason, 'manual');
    assert.equal(reviewed.cells[1]!.status, 'review');
  }
});

test('missing local usage keeps zero known costs and leaves token totals unknown throughout the loop', async (t) => {
  const f = await fixture(t, { local: true, missingUsage: true });
  const report = await f.finish((await f.create({ ...f.input, maxSpendUsd: 0 })).id);
  assert.equal(f.calls.length, 4);
  assert.equal(report.spentUsd, 0);
  assert.equal(report.unknownCosts, false);
  assert.ok(report.cells.every((cell) => cell.status === 'passed' && cell.costUsd === 0));
  assert.ok(report.cells.every((cell) => cell.inputTokens === null && cell.outputTokens === null));
  assert.ok(
    report.cells.every((cell) =>
      cell.toolSteps?.every(
        (step) => step.costUsd === 0 && step.inputTokens === null && step.outputTokens === null,
      ),
    ),
  );
  const logs = await f.ctx.db.select().from(requestLogs);
  assert.equal(logs.length, 4);
  assert.ok(logs.every((log) => log.servedLocal && log.costKnown === true && log.costUsd === 0));
});

test('long model transcripts retain the truncation flag and mask PII across the storage cutoff', async (t) => {
  const firstOutput = JSON.stringify([call('lookup_order', lookupArguments, 'step-1')]);
  const header = 'completed\n';
  const paddingLength = 7990 - firstOutput.length - 2 - header.length;
  const padding = 'x '.repeat(Math.floor(paddingLength / 2)) + (paddingLength % 2 ? ' ' : '');
  const answer = `${header}${padding}alice@example.com\n${'tail '.repeat(300)}`;
  const f = await fixture(t, {
    reply: (body) =>
      body.messages.some((message) => message.role === 'tool')
        ? finalMessage(answer)
        : toolMessage(call('lookup_order', lookupArguments, 'step-1')),
  });
  f.input.cases[0]!.check = 'contains';
  f.input.cases[0]!.expected = 'completed';
  const report = await f.finish((await f.create()).id);
  assert.ok(report.cells.every((cell) => cell.status === 'passed'));
  assert.ok(report.cells.every((cell) => cell.outputTruncated && cell.output?.length === 8000));
  assert.ok(report.cells.every((cell) => !cell.output?.includes('alice')));
  assert.equal(f.calls.length, 4);
});

test('saving tool schemas, arguments, and scalar or array fixture results rejects unicode-escaped personal data', async (t) => {
  const f = await fixture(t);
  for (const location of ['parameters', 'arguments', 'resultScalar', 'resultArray']) {
    const input = structuredClone(f.input);
    if (location === 'parameters')
      input.cases[0]!.tools!.definitions[0]!.parameters =
        '{"type":"object","description":"alice\\u0040example.com"}';
    else if (location === 'arguments')
      input.cases[0]!.tools!.steps[0]!.arguments = '{"order":"alice\\u0040example.com"}';
    else
      input.cases[0]!.tools!.steps[0]!.result =
        location === 'resultScalar' ? '"alice\\u0040example.com"' : '["alice\\u0040example.com"]';
    const response = await f.send('/admin/api/task-sets', input, f.admin);
    assert.equal(response.status, 400, location);
  }
  assert.equal((await f.ctx.db.select().from(taskSets)).length, 0);
  assert.equal(f.calls.length, 0);
});
