import assert from 'node:assert/strict';
import { test } from 'node:test';
import { models, providers, requestLogs, teams } from '../db/schema.ts';
import { calendar } from '../lib/time.ts';
import { testApp } from '../testing.ts';
import { overview, whatIf } from './stats.ts';

test('the daily chart counts requests on the gateway’s own calendar days', async () => {
  const { ctx } = await testApp();
  const [cloud, local] = await ctx.db
    .insert(providers)
    .values([
      { name: 'OpenAI', kind: 'openai' as const, baseUrl: 'https://api.openai.com/v1' },
      { name: 'Ollama', kind: 'ollama' as const, baseUrl: 'http://ollama:11434', isLocal: true },
    ])
    .returning();
  const [gpt, qwen] = await ctx.db
    .insert(models)
    .values([
      { name: 'gpt', providerId: cloud!.id, upstreamModel: 'gpt', inputPrice: 1, outputPrice: 2 },
      { name: 'qwen', providerId: local!.id, upstreamModel: 'qwen', inputPrice: 0, outputPrice: 0 },
    ])
    .returning();
  const log = (id: string, at: string, local: boolean) => ({
    id,
    createdAt: new Date(at),
    format: 'openai' as const,
    requestedModel: 'gpt',
    servedModelId: local ? qwen!.id : gpt!.id,
    servedLocal: local,
    status: 200,
    result: 'ok' as const,
    latencyMs: 1,
    trace: [],
  });
  // India is UTC+5:30: 18:20 UTC is 23:50 on the 8th there, 18:40 UTC is 00:10 on the 9th.
  await ctx.db
    .insert(requestLogs)
    .values([
      log('r1', '2026-10-08T18:20:00Z', false),
      log('r2', '2026-10-08T18:40:00Z', true),
      log('r3', '2026-10-09T06:00:00Z', false),
    ]);

  const data = await overview(
    ctx.db,
    '7d',
    null,
    calendar('Asia/Kolkata'),
    new Date('2026-10-09T12:00:00Z'),
  );
  const day = (date: string) => data.daily.find((row) => row.date === date);
  assert.deepEqual(day('2026-10-08'), { date: '2026-10-08', cloud: 1, local: 0 });
  assert.deepEqual(day('2026-10-09'), { date: '2026-10-09', cloud: 1, local: 1 });
  assert.equal(data.daily.length, 14);
});

test('requests by app leave out requests from before apps were told apart', async () => {
  const { ctx } = await testApp();
  const log = (id: string, app: 'claude-code' | 'codex' | 'other' | null, cost: number) => ({
    id,
    createdAt: new Date('2026-10-09T10:00:00Z'),
    format: 'anthropic' as const,
    app,
    requestedModel: 'claude',
    status: 200,
    result: 'ok' as const,
    costUsd: cost,
    latencyMs: 1,
    trace: [],
  });
  await ctx.db
    .insert(requestLogs)
    .values([
      log('r1', 'other', 0),
      log('r2', 'other', 0),
      log('r3', 'other', 0),
      log('r4', 'claude-code', 0.5),
      log('r5', 'claude-code', 0.25),
      log('r6', 'codex', 0.1),
      log('r7', null, 9),
    ]);

  const data = await overview(
    ctx.db,
    '7d',
    null,
    calendar('UTC'),
    new Date('2026-10-09T12:00:00Z'),
  );
  assert.deepEqual(data.apps, [
    { app: 'claude-code', requests: 2, spend: 0.75 },
    { app: 'codex', requests: 1, spend: 0.1 },
    { app: 'other', requests: 3, spend: 0 },
  ]);
  assert.equal(data.requests, 7);
});

test('another model’s cost keeps the prompts that were cached as cached', async () => {
  const { ctx, get, setupAdmin } = await testApp();
  const [cloud, other, local] = await ctx.db
    .insert(providers)
    .values([
      { name: 'Anthropic', kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com' },
      { name: 'OpenAI', kind: 'openai' as const, baseUrl: 'https://api.openai.com/v1' },
      { name: 'Ollama', kind: 'ollama' as const, baseUrl: 'http://ollama:11434', isLocal: true },
    ])
    .returning();
  const [sonnet, mini, unpriced, qwen] = await ctx.db
    .insert(models)
    .values([
      { name: 'sonnet', providerId: cloud!.id, upstreamModel: 's', inputPrice: 3, outputPrice: 15 },
      { name: 'mini', providerId: other!.id, upstreamModel: 'm', inputPrice: 0.25, outputPrice: 2 },
      { name: 'new-model', providerId: other!.id, upstreamModel: 'n' },
      { name: 'qwen', providerId: local!.id, upstreamModel: 'q', inputPrice: 0, outputPrice: 0 },
    ])
    .returning();
  // A Claude Code turn: 100,000 prompt tokens, 90,000 of them read from the cache at a tenth of
  // the price, and 1,000 output tokens: 0.03 + 0.027 + 0.015 = $0.072.
  const log = (id: string, model: string, cost: number, extra = {}) => ({
    id,
    createdAt: new Date('2026-10-09T10:00:00Z'),
    format: 'anthropic' as const,
    requestedModel: 'sonnet',
    servedModelId: model,
    inputTokens: 100_000,
    outputTokens: 1000,
    costUsd: cost,
    status: 200,
    result: 'ok' as const,
    latencyMs: 1,
    trace: [],
    ...extra,
  });
  await ctx.db
    .insert(requestLogs)
    .values([
      log('r1', sonnet!.id, 0.072),
      log('r2', sonnet!.id, 0.072),
      log('r3', unpriced!.id, 0),
      log('r4', qwen!.id, 0, { servedLocal: true, result: 'rerouted' }),
      log('r5', sonnet!.id, 0, { status: 403, result: 'blocked_pii' }),
    ]);

  const result = await whatIf(
    ctx.db,
    '7d',
    null,
    calendar('UTC'),
    { inputPrice: 0.25, outputPrice: 2 },
    new Date('2026-10-09T12:00:00Z'),
  );
  // On mini with the same caching: 0.0025 + 0.00225 + 0.002 = $0.00675 a turn.
  assert.equal(result.requests, 2);
  assert.equal(result.unpriced, 1);
  assert.ok(Math.abs(result.actual - 0.144) < 1e-9);
  assert.ok(Math.abs(result.cost - 0.0135) < 1e-9);

  // Only cloud models with a price can be picked.
  const admin = await setupAdmin();
  const ask = (model: string) => get(`/admin/api/what-if?period=7d&model=${model}`, admin);
  assert.equal((await ask(qwen!.id)).status, 400);
  assert.equal((await ask(unpriced!.id)).status, 400);
  assert.equal((await ask(mini!.id)).status, 200);
});

test('the month is carried to its end at the last 7 days’ pace, and teams that run out are named', async () => {
  const { ctx } = await testApp();
  const [fast, slow, over] = await ctx.db
    .insert(teams)
    .values([
      { name: 'Marketing', monthlyBudgetUsd: 100 },
      { name: 'Sales', monthlyBudgetUsd: 100 },
      { name: 'Support', monthlyBudgetUsd: 10 },
    ])
    .returning();
  const log = (id: string, teamId: string, at: string, cost: number) => ({
    id,
    teamId,
    createdAt: new Date(at),
    format: 'openai' as const,
    requestedModel: 'gpt',
    costUsd: cost,
    status: 200,
    result: 'ok' as const,
    latencyMs: 1,
    trace: [],
  });
  await ctx.db.insert(requestLogs).values([
    // Marketing: $25 early in the month, then $35 in the last 7 days, $5 a day
    log('m1', fast!.id, '2026-10-02T10:00:00Z', 25),
    log('m2', fast!.id, '2026-10-12T10:00:00Z', 35),
    // Sales: $7 in the last 7 days, $1 a day, far from its budget
    log('s1', slow!.id, '2026-10-12T10:00:00Z', 7),
    // Support is already over its budget
    log('o1', over!.id, '2026-10-12T10:00:00Z', 12),
  ]);

  const now = new Date('2026-10-15T00:00:00Z');
  const data = await overview(ctx.db, 'month', null, calendar('UTC'), now);
  // $79 so far and $54 in the last 7 days, carried over the 17 days left in October
  assert.ok(Math.abs((data.forecast ?? 0) - (79 + (54 / 7) * 17)) < 1e-9);

  const pace = data.alerts.filter((a) => a.code === 'teamBudgetPace');
  // Marketing has $40 left at $5 a day: 8 days, October 23
  assert.deepEqual(
    pace.map((a) => a.code === 'teamBudgetPace' && [a.team, new Date(a.reachesAt).toISOString()]),
    [['Marketing', '2026-10-23T00:00:00.000Z']],
  );
  assert.ok(data.alerts.some((a) => a.code === 'teamOverBudget' && a.team === 'Support'));

  // Other periods have no forecast
  assert.equal((await overview(ctx.db, '7d', null, calendar('UTC'), now)).forecast, null);
});
