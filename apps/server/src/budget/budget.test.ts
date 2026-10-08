import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { openDb } from '../db/client.ts';
import {
  apiKeys,
  budgetReservations,
  models,
  providers,
  requestLogs,
  routingProfiles,
  teams,
} from '../db/schema.ts';
import { callerForKey } from '../gateway/handler.ts';
import { Meter } from '../gateway/meter.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { calendar } from '../lib/time.ts';
import { fingerprint } from '../routing/resolve.ts';
import { testApp } from '../testing.ts';
import { cappedBody, estimateRequest } from './estimate.ts';
import { attemptTotals, reconcile, recoverReservations, reserve, settle, usage } from './ledger.ts';

async function fixture(t: TestContext) {
  const calls: Record<string, unknown>[] = [];
  const mode = { gate: Promise.resolve(), missingUsage: false, failure: false, partial: false };
  const upstream = new Hono()
    .post('/v1/chat/completions', async (c) => {
      const body = await c.req.json<Record<string, unknown>>();
      calls.push(body);
      await mode.gate;
      if (mode.failure && body.model === 'cloud-wire')
        return c.json({ error: { message: 'Unavailable' } }, 503);
      const reported = mode.missingUsage
        ? undefined
        : { prompt_tokens: 100, completion_tokens: 10 };
      if (body.stream) {
        const first = {
          id: 'c',
          choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
          ...(mode.partial ? { usage: { prompt_tokens: 100, completion_tokens: 0 } } : {}),
        };
        const end = { id: 'c', choices: [], usage: reported };
        const encoder = new TextEncoder();
        return c.body(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(first)}\n\n`));
              setTimeout(
                () => {
                  try {
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`),
                    );
                    controller.close();
                  } catch {}
                },
                mode.partial ? 80 : 1,
              );
            },
          }),
          200,
          { 'content-type': 'text/event-stream' },
        );
      }
      return c.json({
        id: 'c',
        object: 'chat.completion',
        model: body.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
        ],
        usage: reported,
      });
    })
    .post('/v1/embeddings', async (c) => {
      const body = await c.req.json<Record<string, unknown>>();
      calls.push(body);
      await mode.gate;
      return c.json({
        object: 'list',
        data: [{ index: 0, object: 'embedding', embedding: [0.1] }],
        model: body.model,
        ...(!mode.missingUsage ? { usage: { prompt_tokens: 100, total_tokens: 100 } } : {}),
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
  const [cloud, local] = await f.ctx.db
    .insert(providers)
    .values([
      {
        name: 'Cloud',
        kind: 'openai' as const,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      },
      {
        name: 'Local',
        kind: 'openai' as const,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        isLocal: true,
      },
    ])
    .returning();
  const [model, localModel, baseline] = await f.ctx.db
    .insert(models)
    .values([
      {
        name: 'cloud',
        providerId: cloud!.id,
        upstreamModel: 'cloud-wire',
        inputPrice: 1,
        outputPrice: 2,
      },
      {
        name: 'local',
        providerId: local!.id,
        upstreamModel: 'local-wire',
        inputPrice: 0,
        outputPrice: 0,
      },
      {
        name: 'baseline',
        providerId: cloud!.id,
        upstreamModel: 'baseline-wire',
        inputPrice: 2,
        outputPrice: 4,
      },
    ])
    .returning();
  const token = newGatewayKey();
  const [key] = await f.ctx.db
    .insert(apiKeys)
    .values({
      name: 'App',
      kind: 'person',
      hash: token.hash,
      prefix: token.prefix,
      fallbackToLocal: false,
    })
    .returning();
  const body = { model: 'cloud', messages: [{ role: 'user', content: 'hi' }], max_tokens: 128 };
  const target = { model: model!, provider: cloud! };
  const estimate = estimateRequest(target, 'openai', body)!;
  const request = async (
    patch: Record<string, unknown> = {},
    keyToken = token.key,
    path = '/v1/chat/completions',
  ) =>
    f.app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${keyToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...patch }),
    });
  const log = async (res: Response) => {
    const id = res.headers.get('x-spillway-request-id');
    assert.ok(id);
    for (let i = 0; i < 200; i++) {
      const row = await f.ctx.db.query.requestLogs.findFirst({ where: eq(requestLogs.id, id) });
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Log missing');
  };
  const pause = () => {
    const gate = Promise.withResolvers<void>();
    mode.gate = gate.promise;
    t.after(() => gate.resolve());
    return gate.resolve;
  };
  const waitCall = async () => {
    for (let i = 0; i < 200 && !calls.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(calls.length);
  };
  return {
    ...f,
    admin,
    calls,
    mode,
    model: model!,
    baseline: baseline!,
    localModel: localModel!,
    cloud: cloud!,
    key: key!,
    token,
    body,
    target,
    estimate,
    request,
    log,
    pause,
    waitCall,
  };
}

test('concurrent requests on one key cannot spend the same available budget', async (t) => {
  const f = await fixture(t);
  await f.ctx.db
    .update(apiKeys)
    .set({ dailyLimitUsd: f.estimate * 1.5 })
    .where(eq(apiKeys.id, f.key.id));
  const resume = f.pause();
  const first = f.request();
  await f.waitCall();
  const second = await f.request();
  assert.equal(second.status, 429);
  assert.equal(f.calls.length, 1);
  const held = await usage(f.ctx.db, 'key', f.key.id, calendar('UTC').startOfDay());
  assert.equal(held.activeUsd, f.estimate);
  assert.equal(held.spentUsd, 0);
  const rows = (await (await f.get('/admin/api/keys', f.admin)).json()) as {
    activeToday: number;
    remainingToday: number;
  }[];
  assert.equal(rows[0]!.activeToday, f.estimate);
  assert.ok(rows[0]!.remainingToday < f.estimate);
  resume();
  assert.equal((await first).status, 200);
  const settled = await usage(f.ctx.db, 'key', f.key.id, calendar('UTC').startOfDay());
  assert.equal(settled.activeUsd, 0);
  assert.equal(settled.spentUsd, 0.00012);
  const summary = (await (await f.get('/admin/api/keys', f.admin)).json()) as {
    spentToday: number;
    requestsMonth: number;
  }[];
  assert.equal(summary[0]!.spentToday, 0.00012);
  assert.equal(summary[0]!.requestsMonth, 2);
  assert.equal((await f.request()).status, 200);
});

test('different keys share atomic reservations against the team budget', async (t) => {
  const f = await fixture(t);
  const [team] = await f.ctx.db
    .insert(teams)
    .values({ name: 'Team', monthlyBudgetUsd: f.estimate * 1.5 })
    .returning();
  await f.ctx.db.update(apiKeys).set({ teamId: team!.id }).where(eq(apiKeys.id, f.key.id));
  const token = newGatewayKey();
  await f.ctx.db.insert(apiKeys).values({
    name: 'Second',
    kind: 'person',
    teamId: team!.id,
    hash: token.hash,
    prefix: token.prefix,
    fallbackToLocal: false,
  });
  const resume = f.pause();
  const first = f.request();
  await f.waitCall();
  assert.equal((await f.request({}, token.key)).status, 429);
  assert.equal(f.calls.length, 1);
  const row = await usage(f.ctx.db, 'team', team!.id, calendar('UTC').startOfMonth());
  assert.equal(row.activeUsd, f.estimate);
  resume();
  await first;
  assert.equal((await f.request({}, token.key)).status, 200);
});

test('all key and team limits are checked together, including zero monthly limits', async (t) => {
  const f = await fixture(t);
  const [team] = await f.ctx.db
    .insert(teams)
    .values({ name: 'Team', monthlyBudgetUsd: 0 })
    .returning();
  await f.ctx.db
    .update(apiKeys)
    .set({ dailyLimitUsd: 1, monthlyLimitUsd: 1, teamId: team!.id })
    .where(eq(apiKeys.id, f.key.id));
  assert.equal((await f.request()).status, 429);
  await f.ctx.db.update(teams).set({ monthlyBudgetUsd: 1 }).where(eq(teams.id, team!.id));
  await f.ctx.db.update(apiKeys).set({ monthlyLimitUsd: 0 }).where(eq(apiKeys.id, f.key.id));
  assert.equal((await f.request()).status, 429);
  assert.equal(f.calls.length, 0);
});

test('missing usage retains a reserve until an admin reconciles the verified charge', async (t) => {
  const f = await fixture(t);
  await f.ctx.db
    .update(apiKeys)
    .set({ dailyLimitUsd: f.estimate * 1.5 })
    .where(eq(apiKeys.id, f.key.id));
  f.mode.missingUsage = true;
  const res = await f.request();
  const row = await f.log(res);
  assert.equal(row.costKnown, false);
  assert.equal(row.costUsd, 0);
  const hold = await f.ctx.db.query.budgetReservations.findFirst();
  assert.equal(hold!.state, 'unknown');
  assert.equal(hold!.heldUsd, f.estimate);
  assert.equal((await f.request()).status, 429);
  const verified = await f.send(
    `/admin/api/budget-holds/${hold!.id}`,
    { chargedUsd: 0.00012 },
    f.admin,
    'PATCH',
  );
  assert.equal(verified.status, 200);
  assert.equal(
    (await f.ctx.db.query.requestLogs.findFirst({ where: eq(requestLogs.id, row.id) }))!.costKnown,
    true,
  );
  const totals = await usage(f.ctx.db, 'key', f.key.id, calendar('UTC').startOfDay());
  assert.equal(totals.uncertainUsd, 0);
  assert.equal(totals.spentUsd, 0.00012);
  f.mode.missingUsage = false;
  assert.equal((await f.request()).status, 200);
});

test('failed cloud calls retain a hold even when a local model answers', async (t) => {
  const f = await fixture(t);
  await f.ctx.db
    .update(apiKeys)
    .set({ dailyLimitUsd: f.estimate * 1.5, fallbackToLocal: true })
    .where(eq(apiKeys.id, f.key.id));
  await f.ctx.settings.update({ localModelId: f.localModel.id });
  f.mode.failure = true;
  const res = await f.request();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-spillway-model'), 'local');
  assert.equal((await f.log(res)).costKnown, false);
  const total = await usage(f.ctx.db, 'key', f.key.id, calendar('UTC').startOfDay());
  assert.equal(total.uncertainUsd, f.estimate);
  assert.equal(total.spentUsd, 0);
  assert.equal((await f.request()).headers.get('x-spillway-model'), 'local');
  assert.equal(f.calls.filter((call) => call.model === 'cloud-wire').length, 1);
});

test('cloud baseline fallback reserves its own cost in addition to the uncertain first attempt', async (t) => {
  const f = await fixture(t);
  const baseline = { model: f.baseline, provider: f.cloud };
  await f.ctx.db.insert(routingProfiles).values({
    name: 'Test profile',
    keyId: f.key.id,
    comparisonId: 'saved-proof',
    baselineModelId: f.baseline.id,
    candidateModelId: f.model.id,
    evidence: {
      comparisonName: 'Proof',
      caseCount: 1,
      baselineLabel: 'baseline',
      candidateLabel: 'cloud',
      baselineCostUsd: 0.00024,
      candidateCostUsd: 0.00012,
      baseline: fingerprint(baseline),
      candidate: fingerprint(f.target),
    },
  });
  f.mode.failure = true;
  const res = await f.request({ model: 'baseline' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-spillway-model'), 'baseline');
  const rows = await f.ctx.db.select().from(budgetReservations);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.state),
    ['unknown', 'settled'],
  );
  assert.equal((await f.log(res)).costUsd, 0.00024);
  assert.equal(
    (await usage(f.ctx.db, 'key', f.key.id, calendar('UTC').startOfDay())).spentUsd,
    0.00024,
  );
  assert.equal((await f.log(res)).routingSavingsUsd, null);
});

test('cache hits and local calls do not create paid reservations', async (t) => {
  const f = await fixture(t);
  await f.ctx.settings.update({ cache: { enabled: true, ttlHours: 24 } });
  await f.request();
  assert.equal((await f.request()).headers.get('x-spillway-cache'), 'hit');
  assert.equal((await f.ctx.db.select().from(budgetReservations)).length, 1);
  await f.request({ model: 'local' });
  assert.equal((await f.ctx.db.select().from(budgetReservations)).length, 1);
});

test('embeddings share budget reservations and distinguish missing input usage', async (t) => {
  const f = await fixture(t);
  await f.ctx.db
    .update(apiKeys)
    .set({ dailyLimitUsd: f.estimate * 1.5 })
    .where(eq(apiKeys.id, f.key.id));
  const resume = f.pause();
  const first = f.request({ input: 'text' }, f.token.key, '/v1/embeddings');
  await f.waitCall();
  assert.equal((await f.request()).status, 429);
  resume();
  assert.equal((await first).status, 200);
  f.mode.missingUsage = true;
  const res = await f.request({ input: 'text' }, f.token.key, '/v1/embeddings');
  assert.equal((await f.log(res)).costKnown, false);
  assert.equal((await f.ctx.db.select().from(budgetReservations)).at(-1)!.state, 'unknown');
});

test('partial streaming usage records a charge and keeps the remaining reserve on disconnect', async (t) => {
  const f = await fixture(t);
  f.mode.partial = true;
  const res = await f.request({ stream: true });
  const reader = res.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  const log = await f.log(res);
  assert.equal(log.costKnown, false);
  assert.equal(log.costUsd, 0.0001);
  const hold = await f.ctx.db.query.budgetReservations.findFirst();
  assert.equal(hold!.state, 'unknown');
  assert.ok(Math.abs(hold!.heldUsd + hold!.chargedUsd - hold!.estimatedUsd) < 1e-12);
});

test('interrupted reservations survive startup recovery and still occupy budget', async (t) => {
  const f = await fixture(t);
  await f.ctx.db
    .update(apiKeys)
    .set({ dailyLimitUsd: f.estimate * 1.5 })
    .where(eq(apiKeys.id, f.key.id));
  const caller = await callerForKey(f.ctx, f.key.id);
  const row = await reserve(f.ctx.db, {
    caller: caller!,
    target: f.target,
    requestedModelId: f.model.id,
    requestId: 'before-restart',
    estimate: f.estimate,
    cal: calendar('UTC'),
  });
  assert.ok(row);
  await recoverReservations(f.ctx.db);
  const recovered = await f.ctx.db.query.budgetReservations.findFirst();
  assert.equal(recovered!.state, 'unknown');
  assert.equal(recovered!.reason, 'restart');
  assert.equal(recovered!.heldUsd, f.estimate);
  assert.equal((await f.request()).status, 429);
  await reconcile(f.ctx, recovered!.id, 0);
  assert.equal((await f.request()).status, 200);
});

test('known charge above its estimate releases the hold but blocks future calls', async (t) => {
  const f = await fixture(t);
  await f.ctx.db
    .update(apiKeys)
    .set({ dailyLimitUsd: f.estimate * 1.5 })
    .where(eq(apiKeys.id, f.key.id));
  const caller = await callerForKey(f.ctx, f.key.id);
  const row = await reserve(f.ctx.db, {
    caller: caller!,
    target: f.target,
    requestedModelId: f.model.id,
    requestId: 'large',
    estimate: f.estimate,
    cal: calendar('UTC'),
  });
  await settle(f.ctx.db, row!, f.estimate * 2, true);
  const total = await usage(f.ctx.db, 'key', f.key.id, calendar('UTC').startOfDay());
  assert.equal(total.activeUsd, 0);
  assert.equal(total.spentUsd, f.estimate * 2);
  assert.equal((await f.request()).status, 429);
});

test('reservations honor calendar boundaries and preserve legacy recorded spend', async (t) => {
  const f = await fixture(t);
  const cal = calendar('Asia/Kolkata');
  const now = new Date('2026-10-08T00:00:00Z');
  const caller = await callerForKey(f.ctx, f.key.id);
  const row = await reserve(f.ctx.db, {
    caller: caller!,
    target: f.target,
    requestedModelId: f.model.id,
    requestId: 'calendar',
    estimate: f.estimate,
    cal,
    now,
  });
  await settle(f.ctx.db, row!, 0.00012, true);
  await f.ctx.db.insert(requestLogs).values({
    id: 'calendar',
    keyId: f.key.id,
    createdAt: now,
    format: 'openai',
    requestedModel: 'cloud',
    status: 200,
    result: 'ok',
    costUsd: 0.00012,
    trace: [],
  });
  await f.ctx.db.insert(requestLogs).values({
    id: 'legacy',
    keyId: f.key.id,
    createdAt: now,
    format: 'openai',
    requestedModel: 'cloud',
    status: 200,
    result: 'ok',
    costUsd: 0.0002,
    trace: [],
  });
  const total = await usage(f.ctx.db, 'key', f.key.id, cal.startOfDay(now));
  assert.ok(Math.abs(total.spentUsd - 0.00032) < 1e-12);
  assert.equal(
    (await usage(f.ctx.db, 'key', f.key.id, cal.startOfDay(new Date('2026-10-09T00:00:00Z'))))
      .spentUsd,
    0,
  );
  await f.ctx.db.delete(requestLogs).where(eq(requestLogs.id, 'calendar'));
  assert.equal((await attemptTotals(f.ctx.db, 'calendar')).costUsd, 0.00012);
});

test('hold visibility follows key ownership; only admins can reconcile uncertain charges', async (t) => {
  const f = await fixture(t);
  const member = await f.addMember(f.admin, 'member@acme.test');
  f.mode.missingUsage = true;
  await f.request();
  const row = await f.ctx.db.query.budgetReservations.findFirst();
  assert.equal((await f.get('/admin/api/budget-holds')).status, 401);
  assert.deepEqual(await (await f.get('/admin/api/budget-holds', member.cookie)).json(), []);
  assert.equal(
    (await f.send(`/admin/api/budget-holds/${row!.id}`, { chargedUsd: 0 }, member.cookie, 'PATCH'))
      .status,
    403,
  );
  assert.equal(
    (await f.send(`/admin/api/budget-holds/${row!.id}`, { chargedUsd: -1 }, f.admin, 'PATCH'))
      .status,
    400,
  );
  assert.equal(
    (await f.send(`/admin/api/budget-holds/${row!.id}`, { chargedUsd: 0 }, f.admin, 'PATCH'))
      .status,
    200,
  );
  assert.equal(
    (await f.send(`/admin/api/budget-holds/${row!.id}`, { chargedUsd: 0 }, f.admin, 'PATCH'))
      .status,
    409,
  );
  await f.ctx.db.update(apiKeys).set({ userId: member.id }).where(eq(apiKeys.id, f.key.id));
  await f.request();
  assert.equal(
    ((await (await f.get('/admin/api/budget-holds', member.cookie)).json()) as unknown[]).length,
    1,
  );
});

test('price-less or unbounded cloud calls cannot bypass a configured limit', async (t) => {
  const f = await fixture(t);
  await f.ctx.db.update(apiKeys).set({ dailyLimitUsd: 1 }).where(eq(apiKeys.id, f.key.id));
  await f.ctx.db.update(models).set({ inputPrice: null }).where(eq(models.id, f.model.id));
  assert.equal((await f.request()).status, 429);
  await f.ctx.db.update(models).set({ inputPrice: 1 }).where(eq(models.id, f.model.id));
  assert.equal(
    (
      await f.request({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }],
          },
        ],
      })
    ).status,
    429,
  );
  assert.equal(f.calls.length, 0);
});

test('a burst admits only the number of estimates that fit before any responses arrive', async (t) => {
  const f = await fixture(t);
  await f.ctx.db
    .update(apiKeys)
    .set({ dailyLimitUsd: f.estimate * 5.1 })
    .where(eq(apiKeys.id, f.key.id));
  const resume = f.pause();
  let refusals = 0;
  const pending = Array.from({ length: 40 }, () =>
    f.request().then((res) => {
      if (res.status === 429) refusals++;
      return res;
    }),
  );
  for (let i = 0; i < 300 && refusals < 35; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(refusals, 35);
  for (let i = 0; i < 200 && f.calls.length < 5; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 5);
  assert.ok(
    (await usage(f.ctx.db, 'key', f.key.id, calendar('UTC').startOfDay())).committedUsd <=
      f.estimate * 5.1,
  );
  resume();
  const responses = await Promise.all(pending);
  assert.equal(responses.filter((res) => res.status === 200).length, 5);
});

test('independent SQLite connections admit atomically and interrupted holds survive reopening the database', async (t) => {
  const file = join(tmpdir(), `spillway-budget-${crypto.randomUUID()}.sqlite`);
  const first = await openDb(file);
  const second = await openDb(file);
  const open = new Set([first.close, second.close]);
  t.after(() => {
    for (const close of open) close();
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(file + suffix)) unlinkSync(file + suffix);
  });
  const [provider] = await first.db
    .insert(providers)
    .values({ name: 'Cloud', kind: 'openai', baseUrl: 'http://127.0.0.1/v1' })
    .returning();
  const [model] = await first.db
    .insert(models)
    .values({
      name: 'cloud',
      providerId: provider!.id,
      upstreamModel: 'cloud',
      inputPrice: 1,
      outputPrice: 2,
    })
    .returning();
  const token = newGatewayKey();
  const [key] = await first.db
    .insert(apiKeys)
    .values({
      name: 'Shared',
      kind: 'person',
      hash: token.hash,
      prefix: token.prefix,
      dailyLimitUsd: 1,
    })
    .returning();
  const input = {
    caller: { key: key!, team: null, user: null },
    target: { model: model!, provider: provider! },
    requestedModelId: model!.id,
    estimate: 0.6,
    cal: calendar('UTC'),
  };
  const admissions = await Promise.all([
    reserve(first.db, { ...input, requestId: 'one' }),
    reserve(second.db, { ...input, requestId: 'two' }),
  ]);
  assert.equal(admissions.filter(Boolean).length, 1);
  first.close();
  second.close();
  open.clear();
  const reopened = await openDb(file);
  open.add(reopened.close);
  await recoverReservations(reopened.db);
  const row = await reopened.db.query.budgetReservations.findFirst();
  assert.equal(row!.state, 'unknown');
  assert.equal(row!.heldUsd, 0.6);
  assert.equal(await reserve(reopened.db, { ...input, requestId: 'three' }), null);
});

test('text estimates include output limits and multiple choices, while meter distinguishes absent embeddings usage', async (t) => {
  const f = await fixture(t);
  assert.equal(
    estimateRequest(f.target, 'openai', { ...f.body, n: 2 }),
    f.estimate * 2 + 24 / 1_000_000,
  );
  assert.equal(
    estimateRequest(f.target, 'responses', {
      model: 'cloud',
      input: 'hi',
      previous_response_id: 'x',
    }),
    null,
  );
  assert.equal(
    cappedBody('responses', { model: 'cloud', input: 'hi' }, true).max_output_tokens,
    32000,
  );
  assert.equal(
    cappedBody('openai', { ...f.body, max_completion_tokens: 20 }, true).max_completion_tokens,
    20,
  );
  assert.equal(
    cappedBody('openai', { model: 'cloud', messages: [] }, true, true).max_completion_tokens,
    4096,
  );
  assert.deepEqual(cappedBody('openai', f.body, true, true), f.body);
  assert.ok(
    estimateRequest(f.target, 'openai', {
      ...f.body,
      tools: [
        {
          type: 'function',
          function: {
            name: 'source',
            parameters: { type: 'object', properties: { source: { type: 'string' } } },
          },
        },
      ],
    }) !== null,
  );
  const meter = new Meter();
  meter.embeddingsResponse({});
  assert.equal(meter.usageKnown, false);
  meter.embeddingsResponse({ usage: { prompt_tokens: 0 } });
  assert.equal(meter.usageKnown, true);
});
