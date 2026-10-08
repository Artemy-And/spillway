import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { type TestContext, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createApp } from '../app.ts';
import {
  apiKeys,
  comparisons,
  models,
  providers,
  requestLogs,
  responseCache,
  taskSets,
} from '../db/schema.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { testApp } from '../testing.ts';
import { checkAnswer, jsonMatches } from './checks.ts';
import { comparisonInput } from './routes.ts';
import { comparisonRunner, forgetComparisons } from './runner.ts';
import { forgetTaskSets, taskFingerprint } from './task-sets.ts';
import type { ComparisonInput, ComparisonReport } from './types.ts';

interface StubRequest {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  stream: boolean;
}
interface StubOptions {
  local?: boolean;
  missingUsage?: boolean;
  delay?: number;
  hugeUsage?: boolean;
  finishReason?: string;
  output?: string;
  fail?: boolean;
}
async function fixture(t: TestContext, options: StubOptions = {}) {
  const calls: StubRequest[] = [];
  const upstream = new Hono().post('/v1/chat/completions', async (c) => {
    const body = await c.req.json<StubRequest>();
    calls.push(body);
    if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
    if (options.fail) return c.json({ error: { message: 'Provider unavailable' } }, 503);
    const answer =
      body.messages.at(-1)?.content === 'manual'
        ? 'A useful summary'
        : '{"orderId":"A-17","status":"paid","extra":true}';
    return c.json({
      id: 'completion',
      model: body.model,
      object: 'chat.completion',
      created: 0,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: options.output ?? answer },
          finish_reason: options.finishReason ?? 'stop',
        },
      ],
      ...(!options.missingUsage
        ? { usage: { prompt_tokens: options.hugeUsage ? 1_000_000 : 100, completion_tokens: 10 } }
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
  const [cloud] = await f.ctx.db
    .insert(providers)
    .values({
      name: 'Test cloud',
      kind: 'openai',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    })
    .returning();
  const [local] = await f.ctx.db
    .insert(providers)
    .values({
      name: 'Test local',
      kind: 'openai',
      baseUrl: cloud!.baseUrl,
      isLocal: true,
    })
    .returning();
  const added = await f.ctx.db
    .insert(models)
    .values([
      {
        name: 'baseline',
        providerId: cloud!.id,
        upstreamModel: 'baseline-wire',
        inputPrice: 10,
        outputPrice: 20,
      },
      {
        name: 'candidate',
        providerId: options.local ? local!.id : cloud!.id,
        upstreamModel: 'candidate-wire',
        inputPrice: options.local ? 0 : 1,
        outputPrice: options.local ? 0 : 2,
      },
    ])
    .returning();
  const key = newGatewayKey();
  const [chargedKey] = await f.ctx.db
    .insert(apiKeys)
    .values({
      name: 'Evaluation key',
      kind: 'agent',
      hash: key.hash,
      prefix: key.prefix,
    })
    .returning();
  const input: ComparisonInput = {
    name: 'My comparison',
    keyId: chargedKey!.id,
    modelIds: added.map((model) => model.id),
    system: 'Be precise',
    maxSpendUsd: 0.1,
    maxOutputTokens: 256,
    cases: [
      {
        name: 'Order',
        prompt: 'Extract order',
        check: 'json',
        expected: '{"orderId":"A-17","status":"paid"}',
      },
    ],
  };
  const create = async (value = input) => {
    const response = await f.send('/admin/api/comparisons', value, admin);
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()) as ComparisonReport;
  };
  const finish = async (id: string) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const report = (await (
        await f.get(`/admin/api/comparisons/${id}`, admin)
      ).json()) as ComparisonReport;
      if (report.status !== 'running') return report;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Comparison did not finish');
  };
  return { ...f, admin, calls, input, added, create, finish, chargedKey: chargedKey!, key };
}

test('checks use user criteria; JSON subsets are safe and arrays match exactly', () => {
  assert.equal(jsonMatches({ a: 1, b: 2 }, { a: 1 }), true);
  assert.equal(jsonMatches({ a: [1, 2] }, { a: [1] }), false);
  assert.equal(jsonMatches({}, { toString: 'anything' }), false);
  assert.equal(checkAnswer('exact', 'OK', '  OK\n').status, 'passed');
  assert.equal(checkAnswer('contains', 'OK', 'ok').status, 'failed');
  assert.equal(checkAnswer('json', '{}', '```json\n{}\n```').reason, 'invalidJson');
  assert.equal(checkAnswer('manual', '', 'anything').status, 'review');
});

test('inputs reject duplicate models, blank criteria and malformed expected JSON', () => {
  const value = {
    name: 'Test',
    keyId: 'key',
    modelIds: ['a', 'a'],
    maxSpendUsd: 0.1,
    maxOutputTokens: 256,
    cases: [{ name: 'task', prompt: 'answer', check: 'exact' }],
  };
  assert.equal(comparisonInput.safeParse(value).success, false);
  assert.equal(
    comparisonInput.safeParse({
      ...value,
      modelIds: ['a', 'b'],
      cases: [{ name: 'task', prompt: 'answer', check: 'json', expected: '{' }],
    }).success,
    false,
  );
});

test('comparison access is admin-only, including listing and quote; quotes never call a provider', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get('/admin/api/comparisons')).status, 401);
  const member = await f.addMember(f.admin, 'member@acme.test');
  assert.equal((await f.get('/admin/api/comparisons', member.cookie)).status, 403);
  assert.equal((await f.send('/admin/api/comparisons/quote', f.input, member.cookie)).status, 403);
  const quote = await f.send('/admin/api/comparisons/quote', f.input, f.admin);
  assert.equal(quote.status, 200);
  assert.equal(f.calls.length, 0);
});

test('same tasks reach both models, real costs are logged, cache is bypassed and manual verdicts are saved', async (t) => {
  const f = await fixture(t);
  await f.ctx.settings.update({ cache: { enabled: true, ttlHours: 24 } });
  const created = await f.create({
    ...f.input,
    cases: [...f.input.cases, { name: 'Summary', prompt: 'manual', check: 'manual', expected: '' }],
  });
  const report = await f.finish(created.id);
  assert.equal(report.status, 'completed');
  assert.deepEqual(
    report.cells.map((cell) => cell.status),
    ['passed', 'passed', 'review', 'review'],
  );
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls[0]!.messages, f.calls[1]!.messages);
  assert.equal(f.calls[0]!.max_tokens, 256);
  assert.equal(f.calls[0]!.stream, false);
  assert.ok(Math.abs(report.spentUsd - 0.00264) < 1e-12);
  const logs = await f.ctx.db.select().from(requestLogs);
  assert.equal(logs.length, 4);
  assert.ok(logs.every((log) => log.keyId === f.chargedKey.id && log.result === 'ok'));
  assert.equal((await f.ctx.db.select().from(responseCache)).length, 0);
  assert.ok(report.cells.every((cell) => cell.requestId && cell.latencyMs !== null));
  const reviewed = await f.send(
    `/admin/api/comparisons/${created.id}/review`,
    { caseIndex: 1, modelId: f.added[1]!.id, status: 'passed' },
    f.admin,
    'PATCH',
  );
  assert.equal(reviewed.status, 200);
  assert.equal(((await reviewed.json()) as ComparisonReport).cells[3]!.status, 'passed');
  const wrong = await f.send(
    `/admin/api/comparisons/${created.id}/review`,
    { caseIndex: 0, modelId: f.added[0]!.id, status: 'passed' },
    f.admin,
    'PATCH',
  );
  assert.equal(wrong.status, 400);
});

test('zero comparison budget skips cloud calls and still permits local models', async (t) => {
  const f = await fixture(t, { local: true });
  const report = await f.finish((await f.create({ ...f.input, maxSpendUsd: 0 })).id);
  assert.deepEqual(
    report.cells.map((cell) => [cell.status, cell.reason]),
    [
      ['skipped', 'budget'],
      ['passed', 'matched'],
    ],
  );
  assert.equal(f.calls.length, 1);
  assert.equal(report.spentUsd, 0);
});

test('usage above the estimate stops subsequent cloud calls', async (t) => {
  const f = await fixture(t, { hugeUsage: true });
  const report = await f.finish((await f.create()).id);
  assert.equal(f.calls.length, 1);
  assert.ok(report.spentUsd > report.maxSpendUsd);
  assert.equal(report.cells[1]!.reason, 'budget');
});

test('missing usage is unknown, not free; subsequent cloud calls stop', async (t) => {
  const f = await fixture(t, { missingUsage: true });
  const report = await f.finish((await f.create()).id);
  assert.equal(f.calls.length, 1);
  assert.equal(report.cells[0]!.costUsd, null);
  assert.equal(report.unknownCosts, true);
  assert.equal(report.cells[1]!.reason, 'unknownCost');
});

test('missing cloud prices and key allowlists prevent starting a run', async (t) => {
  const f = await fixture(t);
  await f.ctx.db.update(models).set({ inputPrice: null }).where(eq(models.id, f.added[0]!.id));
  assert.equal((await f.send('/admin/api/comparisons', f.input, f.admin)).status, 400);
  await f.ctx.db.update(models).set({ inputPrice: 10 }).where(eq(models.id, f.added[0]!.id));
  await f.ctx.db
    .update(apiKeys)
    .set({ allowedModelIds: [f.added[0]!.id] })
    .where(eq(apiKeys.id, f.chargedKey.id));
  assert.equal((await f.send('/admin/api/comparisons/quote', f.input, f.admin)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('real gateway key limits apply and policy refusals cost zero', async (t) => {
  const f = await fixture(t);
  await f.ctx.db
    .update(apiKeys)
    .set({ dailyLimitUsd: 0, fallbackToLocal: false })
    .where(eq(apiKeys.id, f.chargedKey.id));
  const report = await f.finish((await f.create()).id);
  assert.equal(f.calls.length, 0);
  assert.ok(
    report.cells.every(
      (cell) => cell.status === 'skipped' && cell.reason === 'policy' && cell.costUsd === 0,
    ),
  );
  assert.equal(report.unknownCosts, false);
});

test('sensitive data is blocked for cloud models and may still be processed locally', async (t) => {
  const f = await fixture(t, { local: true });
  await f.ctx.settings.update({ localModelId: f.added[1]!.id });
  const report = await f.finish(
    (
      await f.create({
        ...f.input,
        cases: [
          {
            name: 'Protected task',
            prompt: 'Card 4111 1111 1111 1111; extract order',
            check: 'json',
            expected: '{}',
          },
        ],
      })
    ).id,
  );
  assert.equal(report.cells[0]!.status, 'skipped');
  assert.equal(report.cells[0]!.reason, 'policy');
  assert.equal(report.cells[0]!.servedModel, null);
  assert.equal(report.cells[0]!.costUsd, 0);
  assert.ok(f.calls.every((call) => call.model === 'candidate-wire'));
});

test('outputs are masked and task prompts/expected answers are absent from stored reports', async (t) => {
  const f = await fixture(t, { output: 'Contact alice@example.com' });
  const report = await f.finish(
    (
      await f.create({
        ...f.input,
        cases: [
          {
            name: 'Privacy',
            prompt: 'private-prompt-xyz',
            check: 'contains',
            expected: 'alice@example.com',
          },
        ],
      })
    ).id,
  );
  assert.equal(report.cells[0]!.status, 'passed');
  assert.ok(!report.cells[0]!.output?.includes('alice@example.com'));
  const stored = await f.ctx.db.query.comparisons.findFirst({
    where: eq(comparisons.id, report.id),
  });
  const raw = JSON.stringify(stored!.report);
  assert.ok(!raw.includes('private-prompt-xyz'));
  assert.ok(!raw.includes('alice@example.com'));
  await f.ctx.settings.update({ storePrompts: false });
  const hidden = await comparisonRunner(f.ctx).get(report.id);
  assert.ok(hidden!.cells.every((cell) => cell.output === null));
});

test('disabled text storage retains numeric checks and cost, with no response output', async (t) => {
  const f = await fixture(t);
  await f.ctx.settings.update({ storePrompts: false });
  const report = await f.finish((await f.create()).id);
  assert.equal(report.storesOutputs, false);
  assert.ok(report.cells.every((cell) => cell.output === null && cell.status === 'passed'));
  assert.ok(report.spentUsd > 0);
});

test('truncated answers fail even when their contents satisfy the check', async (t) => {
  const f = await fixture(t, { finishReason: 'length' });
  const report = await f.finish((await f.create()).id);
  assert.ok(report.cells.every((cell) => cell.status === 'failed' && cell.reason === 'truncated'));
});

test('cancel aborts a running request, skips remaining calls and releases the run lock', async (t) => {
  const f = await fixture(t, { delay: 400 });
  const created = await f.create();
  assert.equal((await f.send('/admin/api/comparisons', f.input, f.admin)).status, 400);
  const enteredBy = Date.now() + 2000;
  while (!f.calls.length && Date.now() < enteredBy)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(f.calls.length > 0, 'The provider received the running request');
  assert.equal(
    (await f.send(`/admin/api/comparisons/${created.id}/cancel`, undefined, f.admin)).status,
    200,
  );
  const report = await f.finish(created.id);
  assert.equal(report.status, 'cancelled');
  assert.equal(f.calls.length, 1);
  assert.equal(report.cells[1]!.reason, 'cancelled');
  assert.equal(report.unknownCosts, true);
  const next = await f.create({ ...f.input, maxSpendUsd: 0 });
  await f.finish(next.id);
});

test('restart marks an unfinished report interrupted; retention removes expired completed reports', async (t) => {
  const f = await fixture(t);
  const report = await f.finish((await f.create()).id);
  report.status = 'running';
  report.cells[0]!.status = 'running';
  await f.ctx.db.update(comparisons).set({ report }).where(eq(comparisons.id, report.id));
  const recovered = await comparisonRunner({ ...f.ctx }).get(report.id);
  assert.equal(recovered!.status, 'interrupted');
  assert.equal(recovered!.cells[0]!.costUsd, null);
  assert.equal(recovered!.unknownCosts, true);
  await f.ctx.db
    .update(comparisons)
    .set({ expiresAt: new Date(Date.now() - 1) })
    .where(eq(comparisons.id, report.id));
  await forgetComparisons(f.ctx);
  assert.equal(await comparisonRunner(f.ctx).get(report.id), null);
});

test('a budget reroute never counts the replacement as the requested cloud model passing', async (t) => {
  const f = await fixture(t, { local: true });
  await f.ctx.settings.update({ localModelId: f.added[1]!.id });
  await f.ctx.db.update(apiKeys).set({ dailyLimitUsd: 0 }).where(eq(apiKeys.id, f.chargedKey.id));
  const report = await f.finish((await f.create()).id);
  assert.equal(report.cells[0]!.status, 'skipped');
  assert.equal(report.cells[0]!.reason, 'rerouted');
  assert.equal(report.cells[0]!.servedModel, 'candidate');
  assert.equal(report.cells[1]!.status, 'passed');
  assert.equal(report.spentUsd, 0);
});

test('simultaneous manual reviews retain both administrators verdicts', async (t) => {
  const f = await fixture(t);
  const report = await f.finish(
    (
      await f.create({
        ...f.input,
        cases: [{ name: 'Summary', prompt: 'manual', check: 'manual', expected: '' }],
      })
    ).id,
  );
  const responses = await Promise.all(
    f.added.map((model) =>
      f.send(
        `/admin/api/comparisons/${report.id}/review`,
        { caseIndex: 0, modelId: model.id, status: 'passed' },
        f.admin,
        'PATCH',
      ),
    ),
  );
  assert.ok(responses.every((response) => response.status === 200));
  const updated = await f.finish(report.id);
  assert.ok(updated.cells.every((cell) => cell.status === 'passed'));
});

test('changing a selected upstream model during a run skips that model instead of mislabelling it', async (t) => {
  const f = await fixture(t, { delay: 150 });
  const report = await f.create();
  const enteredBy = Date.now() + 2000;
  while (!f.calls.length && Date.now() < enteredBy)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(f.calls.length > 0);
  await f.ctx.db
    .update(models)
    .set({ upstreamModel: 'replacement-wire' })
    .where(eq(models.id, f.added[1]!.id));
  const finished = await f.finish(report.id);
  assert.equal(f.calls.length, 1);
  assert.equal(finished.cells[1]!.reason, 'unavailable');
});

test('an unpriced cloud replacement cannot bypass an exhausted budget as the configured local model', async (t) => {
  const f = await fixture(t);
  const [replacement] = await f.ctx.db
    .insert(models)
    .values({
      name: 'unpriced-replacement',
      providerId: f.added[0]!.providerId,
      upstreamModel: 'replacement-wire',
    })
    .returning();
  await f.ctx.settings.update({ localModelId: replacement!.id });
  await f.ctx.db.update(apiKeys).set({ dailyLimitUsd: 0 }).where(eq(apiKeys.id, f.chargedKey.id));
  const report = await f.finish((await f.create()).id);
  assert.ok(report.cells.every((cell) => cell.reason === 'policy' && cell.costUsd === 0));
  assert.equal(report.unknownCosts, false);
  assert.equal(f.calls.length, 0);
});

async function savedSet(f: Awaited<ReturnType<typeof fixture>>, input = f.input) {
  const response = await f.send('/admin/api/task-sets', input, f.admin);
  assert.equal(response.status, 201, await response.clone().text());
  const set = (await response.json()) as typeof taskSets.$inferSelect;
  return { set, input: { ...input, taskSet: { id: set.id, revision: set.revision } } };
}
async function pinRun(
  f: Awaited<ReturnType<typeof fixture>>,
  set: typeof taskSets.$inferSelect,
  report: ComparisonReport,
) {
  const response = await f.send(
    `/admin/api/task-sets/${set.id}/reference`,
    { revision: set.revision, reportId: report.id },
    f.admin,
  );
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as typeof taskSets.$inferSelect;
}

test('task sets are admin-only; saving and loading never calls a provider', async (t) => {
  const f = await fixture(t);
  const { set } = await savedSet(f);
  const member = await f.addMember(f.admin, 'reader@acme.test');
  for (const path of ['/admin/api/task-sets', `/admin/api/task-sets/${set.id}`]) {
    assert.equal((await f.get(path)).status, 401);
    assert.equal((await f.get(path, member.cookie)).status, 403);
  }
  assert.equal((await f.send('/admin/api/task-sets', f.input, member.cookie)).status, 403);
  assert.equal(
    (
      await f.send(
        `/admin/api/task-sets/${set.id}/reference`,
        { revision: 1, reportId: null },
        member.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.send(
        `/admin/api/task-sets/${set.id}`,
        { ...f.input, revision: 1 },
        member.cookie,
        'PUT',
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.send(`/admin/api/task-sets/${set.id}`, { revision: 1 }, member.cookie, 'DELETE'))
      .status,
    403,
  );
  const list = (await (await f.get('/admin/api/task-sets', f.admin)).json()) as Record<
    string,
    unknown
  >[];
  assert.equal(list.length, 1);
  assert.equal('content' in list[0]!, false);
  assert.equal((await f.get(`/admin/api/task-sets/${set.id}`, f.admin)).status, 200);
  assert.equal(f.calls.length, 0);
});

test('saved tasks replay identically; reports retain evidence without prompt or expected-answer texts', async (t) => {
  const f = await fixture(t);
  const { set, input } = await savedSet(f);
  const report = await f.finish((await f.create(input)).id);
  assert.equal(report.evaluation!.fingerprint, set.fingerprint);
  assert.equal(report.evaluation!.revision, 1);
  assert.equal(report.evaluation!.reference, null);
  assert.ok(
    f.calls.every(
      (call) =>
        call.messages[0]!.content === input.system &&
        call.messages[1]!.content === input.cases[0]!.prompt,
    ),
  );
  const stored = await f.ctx.db.query.comparisons.findFirst({
    where: eq(comparisons.id, report.id),
  });
  assert.equal(JSON.stringify(stored).includes(input.cases[0]!.prompt), false);
  assert.equal(
    (await f.get(`/admin/api/comparisons/${report.id}/regressions`, f.admin)).status,
    200,
  );
  assert.equal(
    await (await f.get(`/admin/api/comparisons/${report.id}/regressions`, f.admin)).json(),
    null,
  );
});

test('repeated evaluations identify previously passing tasks that fail and compare matching costs', async (t) => {
  const options: StubOptions = {};
  const f = await fixture(t, options);
  const { set, input } = await savedSet(f);
  const first = await f.finish((await f.create(input)).id);
  await pinRun(f, set, first);
  options.output = '{"status":"wrong"}';
  const second = await f.finish((await f.create(input)).id);
  const changes = (await (
    await f.get(`/admin/api/comparisons/${second.id}/regressions`, f.admin)
  ).json()) as ReturnType<typeof import('./regressions.ts').regressionReport>;
  assert.equal(changes!.reference.id, first.id);
  assert.ok(
    changes!.models.every(
      (model) => model.compared === 1 && model.regressions.length === 1 && model.inconclusive === 0,
    ),
  );
  assert.ok(
    changes!.models.every(
      (model) => model.cost!.pairs === 1 && model.cost!.previousUsd === model.cost!.currentUsd,
    ),
  );
  assert.ok(changes!.models.every((model) => model.regressions[0]!.name === 'Order'));
});

test('reference snapshots survive report deletion and later replacement cannot rewrite earlier evidence', async (t) => {
  const f = await fixture(t);
  const { set, input } = await savedSet(f);
  const first = await f.finish((await f.create(input)).id);
  await pinRun(f, set, first);
  const second = await f.finish((await f.create(input)).id);
  await pinRun(f, set, second);
  const third = await f.finish((await f.create(input)).id);
  assert.equal(second.evaluation!.reference!.id, first.id);
  assert.equal(third.evaluation!.reference!.id, second.id);
  assert.ok(second.evaluation!.reference!.cells.every((cell) => !('output' in cell)));
  await f.send(`/admin/api/comparisons/${first.id}`, undefined, f.admin, 'DELETE');
  await f.send(`/admin/api/task-sets/${set.id}`, { revision: 1 }, f.admin, 'DELETE');
  const changes = (await (
    await f.get(`/admin/api/comparisons/${second.id}/regressions`, f.admin)
  ).json()) as { reference: { id: string } };
  assert.equal(changes.reference.id, first.id);
});

test('provider failures and budget-skipped answers are inconclusive rather than quality regressions', async (t) => {
  const options: StubOptions = {};
  const f = await fixture(t, options);
  const { set, input } = await savedSet(f);
  await pinRun(f, set, await f.finish((await f.create(input)).id));
  options.fail = true;
  const report = await f.finish((await f.create(input)).id);
  const changes = (await (
    await f.get(`/admin/api/comparisons/${report.id}/regressions`, f.admin)
  ).json()) as ReturnType<typeof import('./regressions.ts').regressionReport>;
  assert.ok(
    changes!.models.every(
      (model) =>
        model.regressions.length === 0 &&
        model.compared === 0 &&
        model.inconclusive === 1 &&
        model.cost === null,
    ),
  );
  assert.equal(changes!.models[0]!.operationalFailures, 1);
  assert.equal(report.cells[1]!.reason, 'unknownCost');
});

test('manual reviews must finish before pinning; a new review updates regression results while the reference stays frozen', async (t) => {
  const f = await fixture(t);
  const { set, input } = await savedSet(f, {
    ...f.input,
    cases: [{ name: 'Summary', prompt: 'manual', check: 'manual', expected: '' }],
  });
  let first = await f.finish((await f.create(input)).id);
  assert.equal(
    (
      await f.send(
        `/admin/api/task-sets/${set.id}/reference`,
        { revision: 1, reportId: first.id },
        f.admin,
      )
    ).status,
    400,
  );
  for (const model of f.added)
    await f.send(
      `/admin/api/comparisons/${first.id}/review`,
      { caseIndex: 0, modelId: model.id, status: 'passed' },
      f.admin,
      'PATCH',
    );
  first = await f.finish(first.id);
  await pinRun(f, set, first);
  const second = await f.finish((await f.create(input)).id);
  await f.send(
    `/admin/api/comparisons/${second.id}/review`,
    { caseIndex: 0, modelId: f.added[0]!.id, status: 'failed' },
    f.admin,
    'PATCH',
  );
  await f.send(
    `/admin/api/comparisons/${first.id}/review`,
    { caseIndex: 0, modelId: f.added[0]!.id, status: 'failed' },
    f.admin,
    'PATCH',
  );
  const changes = (await (
    await f.get(`/admin/api/comparisons/${second.id}/regressions`, f.admin)
  ).json()) as ReturnType<typeof import('./regressions.ts').regressionReport>;
  assert.equal(changes!.models[0]!.regressions.length, 1);
  assert.equal(changes!.models[1]!.inconclusive, 1);
});

test('changed tasks and stale revisions cannot quote or replay with misleading task-set evidence', async (t) => {
  const f = await fixture(t);
  const { set, input } = await savedSet(f);
  const changed = { ...input, cases: [{ ...input.cases[0]!, expected: '{}' }] };
  assert.equal((await f.send('/admin/api/comparisons/quote', changed, f.admin)).status, 409);
  assert.equal((await f.send('/admin/api/comparisons', changed, f.admin)).status, 409);
  assert.equal(
    (
      await f.send(
        '/admin/api/comparisons',
        { ...input, taskSet: { id: 'absent', revision: 1 } },
        f.admin,
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.send(`/admin/api/task-sets/${set.id}`, { ...f.input, revision: 1 }, f.admin, 'PUT'))
      .status,
    200,
  );
  assert.equal((await f.send('/admin/api/comparisons', input, f.admin)).status, 409);
  assert.equal(f.calls.length, 0);
});

test('concurrent task-set edits reject a stale writer; changing checks or output limits resets the reference', async (t) => {
  const f = await fixture(t);
  const { set, input } = await savedSet(f);
  await pinRun(f, set, await f.finish((await f.create(input)).id));
  const responses = await Promise.all(
    ['Renamed A', 'Renamed B'].map((name) =>
      f.send(`/admin/api/task-sets/${set.id}`, { ...f.input, name, revision: 1 }, f.admin, 'PUT'),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const renamed = (await (
    await f.get(`/admin/api/task-sets/${set.id}`, f.admin)
  ).json()) as typeof taskSets.$inferSelect;
  assert.ok(renamed.reference);
  assert.equal(renamed.revision, 2);
  const updated = await f.send(
    `/admin/api/task-sets/${set.id}`,
    { ...f.input, maxOutputTokens: 128, revision: 2 },
    f.admin,
    'PUT',
  );
  assert.equal(updated.status, 200);
  assert.equal(((await updated.json()) as typeof taskSets.$inferSelect).reference, null);
  assert.equal(
    (await f.send(`/admin/api/task-sets/${set.id}`, { revision: 2 }, f.admin, 'DELETE')).status,
    409,
  );
});

test('reference selection rejects unrelated sets and edited criteria even if task names match', async (t) => {
  const f = await fixture(t);
  const { set, input } = await savedSet(f);
  const report = await f.finish((await f.create(input)).id);
  const other = await savedSet(f);
  assert.equal(
    (
      await f.send(
        `/admin/api/task-sets/${other.set.id}/reference`,
        { revision: 1, reportId: report.id },
        f.admin,
      )
    ).status,
    400,
  );
  await f.send(
    `/admin/api/task-sets/${set.id}`,
    { ...f.input, system: 'Different instructions', revision: 1 },
    f.admin,
    'PUT',
  );
  assert.equal(
    (
      await f.send(
        `/admin/api/task-sets/${set.id}/reference`,
        { revision: 2, reportId: report.id },
        f.admin,
      )
    ).status,
    400,
  );
});

test('disabling text storage deletes templates immediately and blocks reuse without disabling unsaved comparisons', async (t) => {
  const f = await fixture(t);
  const { set, input } = await savedSet(f);
  assert.equal(
    (await f.send('/admin/api/settings', { storePrompts: false }, f.admin, 'PUT')).status,
    200,
  );
  assert.equal((await f.ctx.db.select().from(taskSets)).length, 0);
  assert.equal((await f.get(`/admin/api/task-sets/${set.id}`, f.admin)).status, 403);
  assert.equal((await f.send('/admin/api/task-sets', f.input, f.admin)).status, 403);
  assert.equal((await f.send('/admin/api/comparisons', input, f.admin)).status, 403);
  assert.deepEqual(await (await f.get('/admin/api/task-sets', f.admin)).json(), []);
  const report = await f.finish((await f.create()).id);
  assert.equal(report.storesOutputs, false);
  assert.equal(report.evaluation, undefined);
});

test('expired templates cannot be loaded or replayed; shorter retention applies to existing sets', async (t) => {
  const f = await fixture(t);
  const { set, input } = await savedSet(f);
  await f.ctx.db
    .update(taskSets)
    .set({ expiresAt: new Date(Date.now() - 1) })
    .where(eq(taskSets.id, set.id));
  assert.equal((await f.get(`/admin/api/task-sets/${set.id}`, f.admin)).status, 404);
  assert.equal((await f.send('/admin/api/comparisons', input, f.admin)).status, 404);
  await forgetTaskSets(f.ctx);
  assert.equal((await f.ctx.db.select().from(taskSets)).length, 0);
  const newer = await savedSet(f);
  await f.ctx.db
    .update(taskSets)
    .set({ updatedAt: new Date(Date.now() - 3 * 86_400_000) })
    .where(eq(taskSets.id, newer.set.id));
  await f.send('/admin/api/settings', { retentionDays: 1 }, f.admin, 'PUT');
  assert.equal((await f.ctx.db.select().from(taskSets)).length, 0);
  assert.equal(f.calls.length, 0);
});

test('saved templates reject personal data and secrets without silently changing check semantics', async (t) => {
  const f = await fixture(t);
  for (const value of [
    { ...f.input, system: 'Email person@example.com' },
    { ...f.input, cases: [{ ...f.input.cases[0]!, expected: '{"email":"person@example.com"}' }] },
    { ...f.input, cases: [{ ...f.input.cases[0]!, prompt: 'Card 4111 1111 1111 1111' }] },
  ])
    assert.equal((await f.send('/admin/api/task-sets', value, f.admin)).status, 400);
  assert.equal((await f.ctx.db.select().from(taskSets)).length, 0);
  assert.equal(taskFingerprint(f.input), taskFingerprint({ ...f.input, name: 'Different title' }));
  assert.notEqual(
    taskFingerprint(f.input),
    taskFingerprint({ ...f.input, cases: [{ ...f.input.cases[0]!, check: 'manual' }] }),
  );
});

test('configuration changes are disclosed and newly selected models are not reported as regressions', async (t) => {
  const f = await fixture(t);
  const { set, input } = await savedSet(f);
  await pinRun(f, set, await f.finish((await f.create(input)).id));
  await f.ctx.db.update(models).set({ inputPrice: 15 }).where(eq(models.id, f.added[0]!.id));
  const [newModel] = await f.ctx.db
    .insert(models)
    .values({
      name: 'new-choice',
      upstreamModel: 'new-wire',
      providerId: f.added[0]!.providerId,
      inputPrice: 1,
      outputPrice: 2,
    })
    .returning();
  const report = await f.finish(
    (await f.create({ ...input, modelIds: [f.added[0]!.id, newModel!.id] })).id,
  );
  const changes = (await (
    await f.get(`/admin/api/comparisons/${report.id}/regressions`, f.admin)
  ).json()) as ReturnType<typeof import('./regressions.ts').regressionReport>;
  assert.equal(changes!.models[0]!.configurationChanged, true);
  assert.equal(changes!.models[1]!.newModel, true);
  assert.equal(changes!.models[1]!.compared, 0);
  assert.equal(changes!.models[1]!.regressions.length, 0);
  assert.equal(changes!.models[1]!.cost, null);
});

test('a previously failed task that now passes is an improvement rather than a regression', async (t) => {
  const options: StubOptions = { output: 'Wrong answer' };
  const f = await fixture(t, options);
  const { set, input } = await savedSet(f);
  await pinRun(f, set, await f.finish((await f.create(input)).id));
  options.output = undefined;
  const report = await f.finish((await f.create(input)).id);
  const changes = (await (
    await f.get(`/admin/api/comparisons/${report.id}/regressions`, f.admin)
  ).json()) as ReturnType<typeof import('./regressions.ts').regressionReport>;
  assert.ok(
    changes!.models.every((model) => model.improved === 1 && model.regressions.length === 0),
  );
});

test('unknown reference charges are excluded from cost comparisons rather than reported as zero', async (t) => {
  const options: StubOptions = { local: true, missingUsage: true };
  const f = await fixture(t, options);
  const { set, input } = await savedSet(f);
  await pinRun(f, set, await f.finish((await f.create(input)).id));
  options.missingUsage = false;
  const report = await f.finish((await f.create(input)).id);
  const changes = (await (
    await f.get(`/admin/api/comparisons/${report.id}/regressions`, f.admin)
  ).json()) as ReturnType<typeof import('./regressions.ts').regressionReport>;
  assert.equal(changes!.models[0]!.compared, 1);
  assert.equal(changes!.models[0]!.cost, null);
  assert.equal(changes!.models[1]!.cost!.currentUsd, 0);
});

test('demo refuses task-set writes, and malformed saved criteria fail before any storage', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.send(
        '/admin/api/task-sets',
        { ...f.input, cases: [{ ...f.input.cases[0]!, expected: '{' }] },
        f.admin,
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.send('/admin/api/task-sets', { ...f.input, maxOutputTokens: 0 }, f.admin)).status,
    400,
  );
  assert.equal((await f.ctx.db.select().from(taskSets)).length, 0);
  const demo = createApp({ ...f.ctx, env: { ...f.ctx.env, DEMO: true } });
  assert.equal(
    (
      await demo.request('/admin/api/task-sets', {
        method: 'POST',
        headers: { cookie: f.admin, 'content-type': 'application/json' },
        body: JSON.stringify(f.input),
      })
    ).status,
    403,
  );
  assert.equal(f.calls.length, 0);
});

test('a save admitted before text storage is disabled cannot persist templates after the setting changes', async (t) => {
  const f = await fixture(t);
  const get = f.ctx.settings.get.bind(f.ctx.settings);
  let held = true;
  let entered!: () => void;
  let release!: () => void;
  const read = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.ctx.settings.get = async () => {
    const value = await get();
    if (held) {
      held = false;
      entered();
      await gate;
    }
    return value;
  };
  const saving = f.send('/admin/api/task-sets', f.input, f.admin);
  await read;
  await f.ctx.settings.update({ storePrompts: false });
  release();
  assert.equal((await saving).status, 403);
  assert.equal((await f.ctx.db.select().from(taskSets)).length, 0);
});
