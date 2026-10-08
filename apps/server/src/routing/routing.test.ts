import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { type TestContext, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { failingProviders } from '../admin/stats.ts';
import { comparisonRunner } from '../comparison/runner.ts';
import type { ComparisonInput, ComparisonReport } from '../comparison/types.ts';
import {
  apiKeys,
  comparisons,
  models,
  providers,
  requestLogs,
  routingProfiles,
  teams,
} from '../db/schema.ts';
import { Meter } from '../gateway/meter.ts';
import type { OAIChatResponse } from '../gateway/types.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { testApp } from '../testing.ts';
import { supportsProfileRequest } from './resolve.ts';
import { listProfiles } from './service.ts';

async function fixture(t: TestContext, local = false) {
  const calls: Record<string, unknown>[] = [];
  const mode = {
    fail: false,
    missingUsage: false,
    cachedTokens: 0,
    partial: false,
    onFail: async () => {},
  };
  const upstream = new Hono()
    .post('/v1/chat/completions', async (c) => {
      const body = await c.req.json<Record<string, unknown>>();
      calls.push(body);
      if (mode.fail && body.model === 'candidate-wire') {
        await mode.onFail();
        return c.json({ error: { message: 'Candidate unavailable' } }, 503);
      }
      const usage = mode.missingUsage
        ? undefined
        : {
            prompt_tokens: 100,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: mode.cachedTokens },
          };
      if (body.stream) {
        const chunks = [
          {
            id: 'stream',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }],
          },
          {
            id: 'stream',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage,
          },
        ];
        if (mode.partial) {
          const encoder = new TextEncoder();
          return c.body(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[0])}\n\n`));
                setTimeout(() => {
                  try {
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(chunks[1])}\n\ndata: [DONE]\n\n`),
                    );
                    controller.close();
                  } catch {
                    /* The client may already have cancelled the stream. */
                  }
                }, 80);
              },
            }),
            200,
            { 'content-type': 'text/event-stream' },
          );
        }
        return c.body(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
          200,
          { 'content-type': 'text/event-stream' },
        );
      }
      return c.json({
        id: 'answer',
        model: body.model,
        object: 'chat.completion',
        created: 0,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
        ],
        usage,
      });
    })
    .post('/v1/embeddings', async (c) => {
      const body = await c.req.json<Record<string, unknown>>();
      calls.push(body);
      return c.json({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
        model: body.model,
        usage: { prompt_tokens: 1, total_tokens: 1 },
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
  const [baselineProvider, candidateProvider] = await f.ctx.db
    .insert(providers)
    .values([
      {
        name: 'Baseline cloud',
        kind: 'openai' as const,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      },
      {
        name: 'Candidate provider',
        kind: 'openai' as const,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        isLocal: local,
      },
    ])
    .returning();
  const [baseline, candidate] = await f.ctx.db
    .insert(models)
    .values([
      {
        name: 'baseline',
        providerId: baselineProvider!.id,
        upstreamModel: 'baseline-wire',
        inputPrice: 10,
        outputPrice: 20,
      },
      {
        name: 'candidate',
        providerId: candidateProvider!.id,
        upstreamModel: 'candidate-wire',
        inputPrice: local ? 0 : 1,
        outputPrice: local ? 0 : 2,
      },
    ])
    .returning();
  const token = newGatewayKey();
  const [key] = await f.ctx.db
    .insert(apiKeys)
    .values({ name: 'Application', kind: 'agent', hash: token.hash, prefix: token.prefix })
    .returning();
  const input: ComparisonInput = {
    name: 'Task evidence',
    keyId: key!.id,
    modelIds: [baseline!.id, candidate!.id],
    system: '',
    maxSpendUsd: 0.1,
    maxOutputTokens: 256,
    cases: [{ name: 'Answer', prompt: 'Reply OK', check: 'exact', expected: 'OK' }],
  };
  const compare = async (value = input) => {
    const created = await f.send('/admin/api/comparisons', value, admin);
    assert.equal(created.status, 201, await created.clone().text());
    const report = (await created.json()) as ComparisonReport;
    for (let i = 0; i < 500; i++) {
      const current = await comparisonRunner(f.ctx).get(report.id);
      if (current?.status !== 'running') return current!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Comparison did not complete');
  };
  const report = await compare();
  const profileInput = {
    name: 'Cheaper answers',
    keyId: key!.id,
    comparisonId: report.id,
    baselineModelId: baseline!.id,
    candidateModelId: candidate!.id,
    fallbackOnError: true,
  };
  const activate = async () => {
    const res = await f.send('/admin/api/routing-profiles', profileInput, admin);
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()) as typeof routingProfiles.$inferSelect;
  };
  const request = (
    patch: Record<string, unknown> = {},
    keyToken = token.key,
    path = '/v1/chat/completions',
  ) =>
    f.app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${keyToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'baseline',
        messages: [{ role: 'user', content: 'A real task' }],
        max_tokens: 256,
        ...patch,
      }),
    });
  const log = async (res: Response) => {
    const id = res.headers.get('x-spillway-request-id');
    assert.ok(id);
    for (let i = 0; i < 100; i++) {
      const row = await f.ctx.db.query.requestLogs.findFirst({ where: eq(requestLogs.id, id) });
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Request not logged');
  };
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
    input,
    report,
    compare,
    profileInput,
    activate,
    request,
    log,
  };
}

test('profiles route only the chosen key and baseline; costs are explicit estimates', async (t) => {
  const f = await fixture(t);
  const profile = await f.activate();
  const res = await f.request();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-spillway-model'), 'candidate');
  assert.equal(res.headers.get('x-spillway-routing-profile'), profile.id);
  assert.equal(f.calls[0]!.model, 'candidate-wire');
  const row = await f.log(res);
  assert.equal(row.requestedModelId, f.baseline.id);
  assert.equal(row.attemptedModelId, f.candidate.id);
  assert.equal(row.servedModelId, f.candidate.id);
  assert.equal(row.routingOutcome, 'selected');
  assert.equal(row.routingCostKnown, true);
  assert.equal(row.costUsd, 0.00012);
  assert.equal(row.baselineCostUsd, 0.0012);
  assert.ok(Math.abs(row.routingSavingsUsd! - 0.00108) < 1e-12);
  assert.equal(row.savedUsd, 0);
  assert.ok(row.trace.some((step) => step.code === 'profileApplied'));
  const [listed] = await listProfiles(f.ctx);
  assert.equal(listed!.metrics.eligibleRequests, 1);
  assert.equal(listed!.metrics.recordedSpendUsd, row.costUsd);
  const another = newGatewayKey();
  await f.ctx.db
    .insert(apiKeys)
    .values({ name: 'Other', kind: 'agent', hash: another.hash, prefix: another.prefix });
  assert.equal((await f.request({}, another.key)).headers.get('x-spillway-model'), 'baseline');
  assert.equal(
    (await f.request({ model: 'candidate' })).headers.get('x-spillway-routing-profile'),
    null,
  );
});

test('comparisons bypass live profiles and source report removal preserves routing evidence', async (t) => {
  const f = await fixture(t);
  const profile = await f.activate();
  const next = await f.compare();
  assert.deepEqual(
    f.calls.map((call) => call.model),
    ['baseline-wire', 'candidate-wire'],
  );
  assert.ok(next.cells.every((cell) => cell.status === 'passed'));
  await f.ctx.db.delete(comparisons).where(eq(comparisons.id, f.report.id));
  assert.equal((await f.request()).headers.get('x-spillway-model'), 'candidate');
  const saved = await f.ctx.db.query.routingProfiles.findFirst({
    where: eq(routingProfiles.id, profile.id),
  });
  assert.equal(saved!.evidence.caseCount, 1);
  assert.equal(JSON.stringify(saved).includes('Reply OK'), false);
});

test('routing API is admin-only and the demo blocks mutations', async (t) => {
  const f = await fixture(t);
  const member = await f.addMember(f.admin, 'member@acme.test');
  assert.equal((await f.get('/admin/api/routing-profiles')).status, 401);
  assert.equal((await f.get('/admin/api/routing-profiles', member.cookie)).status, 403);
  assert.equal(
    (await f.send('/admin/api/routing-profiles', f.profileInput, member.cookie)).status,
    403,
  );
  const profile = await f.activate();
  assert.equal(
    (
      await f.send(
        `/admin/api/routing-profiles/${profile.id}`,
        { enabled: false },
        member.cookie,
        'PATCH',
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.send(`/admin/api/routing-profiles/${profile.id}`, undefined, member.cookie, 'DELETE'))
      .status,
    403,
  );
  const demo = await testApp({ DEMO: 'true' });
  assert.equal((await demo.send('/admin/api/routing-profiles', f.profileInput)).status, 403);
});

test('activation requires a cheaper passing pair, current configuration, and both allowed models', async (t) => {
  const f = await fixture(t);
  const create = (patch: Record<string, unknown>) =>
    f.send('/admin/api/routing-profiles', { ...f.profileInput, ...patch }, f.admin);
  assert.equal((await create({ comparisonId: 'missing' })).status, 400);
  assert.equal((await create({ candidateModelId: f.baseline.id })).status, 400);
  assert.equal(
    (await create({ baselineModelId: f.candidate.id, candidateModelId: f.baseline.id })).status,
    400,
  );
  const manual = await f.compare({
    ...f.input,
    cases: [{ name: 'Manual', prompt: 'Reply OK', check: 'manual', expected: '' }],
  });
  assert.equal((await create({ comparisonId: manual.id })).status, 400);
  await f.ctx.db
    .update(apiKeys)
    .set({ allowedModelIds: [f.baseline.id] })
    .where(eq(apiKeys.id, f.key.id));
  assert.equal((await create({})).status, 400);
  await f.ctx.db.update(apiKeys).set({ allowedModelIds: null }).where(eq(apiKeys.id, f.key.id));
  await f.ctx.db.update(models).set({ inputPrice: 2 }).where(eq(models.id, f.candidate.id));
  assert.equal((await create({})).status, 400);
  await f.ctx.db.update(models).set({ inputPrice: 1 }).where(eq(models.id, f.candidate.id));
  await f.activate();
  assert.equal((await create({})).status, 400);
});

test('profiles can be disabled, enabled and deleted', async (t) => {
  const f = await fixture(t);
  const profile = await f.activate();
  const patch = (enabled: boolean) =>
    f.send(`/admin/api/routing-profiles/${profile.id}`, { enabled }, f.admin, 'PATCH');
  assert.equal((await patch(false)).status, 200);
  assert.equal((await f.request()).headers.get('x-spillway-model'), 'baseline');
  assert.equal((await patch(true)).status, 200);
  assert.equal((await f.request()).headers.get('x-spillway-model'), 'candidate');
  assert.equal(
    (await f.send(`/admin/api/routing-profiles/${profile.id}`, undefined, f.admin, 'DELETE'))
      .status,
    200,
  );
  assert.equal((await f.request()).headers.get('x-spillway-model'), 'baseline');
});

test('permissions and changed models keep the original model, including team restrictions', async (t) => {
  const f = await fixture(t);
  const profile = await f.activate();
  await f.ctx.db
    .update(apiKeys)
    .set({ allowedModelIds: [f.baseline.id] })
    .where(eq(apiKeys.id, f.key.id));
  let row = await f.log(await f.request());
  assert.equal(row.servedModelId, f.baseline.id);
  assert.equal(
    row.trace.find((step) => step.code === 'profileSkipped')!.params!.reason,
    'permission',
  );
  const [team] = await f.ctx.db
    .insert(teams)
    .values({ name: 'Restricted', allowedModelIds: [f.baseline.id] })
    .returning();
  await f.ctx.db
    .update(apiKeys)
    .set({ allowedModelIds: null, teamId: team!.id })
    .where(eq(apiKeys.id, f.key.id));
  assert.equal((await f.request()).headers.get('x-spillway-model'), 'baseline');
  await f.ctx.db.update(apiKeys).set({ teamId: null }).where(eq(apiKeys.id, f.key.id));
  await f.ctx.db
    .update(models)
    .set({ upstreamModel: 'changed' })
    .where(eq(models.id, f.candidate.id));
  row = await f.log(await f.request());
  assert.equal(row.trace.find((step) => step.code === 'profileSkipped')!.params!.reason, 'changed');
  assert.equal(
    (await f.send(`/admin/api/routing-profiles/${profile.id}`, { enabled: true }, f.admin, 'PATCH'))
      .status,
    400,
  );
  await f.ctx.db.update(models).set({ enabled: false }).where(eq(models.id, f.candidate.id));
  row = await f.log(await f.request());
  assert.equal(
    row.trace.find((step) => step.code === 'profileSkipped')!.params!.reason,
    'unavailable',
  );
  await f.ctx.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, f.key.id));
  assert.equal((await f.request()).status, 401);
});

test('tools, images, JSON mode, extra capabilities and embeddings keep the baseline', async (t) => {
  const f = await fixture(t);
  await f.activate();
  for (const patch of [
    { tools: [] },
    { response_format: { type: 'json_object' } },
    { reasoning_effort: 'high' },
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
        },
      ],
    },
    { future_capability: true },
  ]) {
    const res = await f.request(patch);
    assert.equal(res.headers.get('x-spillway-model'), 'baseline');
    const row = await f.log(res);
    assert.equal(row.routingOutcome, 'skipped');
    assert.equal(row.routingSavingsUsd, null);
  }
  const res = await f.request({ input: 'embed' }, f.token.key, '/v1/embeddings');
  assert.equal(res.status, 200);
  assert.equal(f.calls.at(-1)!.model, 'baseline-wire');
  assert.equal(res.headers.get('x-spillway-routing-profile'), null);
});

test('supported capabilities are conservative across API formats and reject stateful context', () => {
  assert.equal(
    supportsProfileRequest('openai', {
      model: 'a',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    }),
    true,
  );
  assert.equal(
    supportsProfileRequest('anthropic', {
      model: 'a',
      system: [{ type: 'text', text: 'hi' }],
      messages: [{ role: 'user', content: 'hi' }],
    }),
    true,
  );
  assert.equal(
    supportsProfileRequest('responses', { model: 'a', input: 'hi', store: false }),
    true,
  );
  assert.equal(
    supportsProfileRequest('responses', {
      model: 'a',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    }),
    true,
  );
  for (const patch of [
    { store: true },
    { previous_response_id: 'x' },
    { conversation: 'x' },
    { tools: [] },
    { input: [{ type: 'item_reference', id: 'x' }] },
  ]) {
    assert.equal(supportsProfileRequest('responses', { model: 'a', input: 'hi', ...patch }), false);
  }
  assert.equal(
    supportsProfileRequest('ollama-generate', { model: 'a', prompt: 'hi', stream: false }),
    true,
  );
  assert.equal(
    supportsProfileRequest('ollama-generate', { model: 'a', prompt: 'hi', context: [1] }),
    false,
  );
  assert.equal(
    supportsProfileRequest('ollama-chat', {
      model: 'a',
      messages: [{ role: 'user', content: 'hi' }],
      options: { num_ctx: 1024 },
    }),
    false,
  );
});

test('cloud candidates obey budgets and privacy, while local API costs remain zero', async (t) => {
  const f = await fixture(t);
  await f.activate();
  await f.ctx.db
    .update(apiKeys)
    .set({ dailyLimitUsd: 0, fallbackToLocal: false })
    .where(eq(apiKeys.id, f.key.id));
  let res = await f.request();
  assert.equal(res.status, 429);
  assert.equal((await f.log(res)).routingOutcome, 'policy');
  assert.equal(f.calls.length, 0);
  await f.ctx.db.update(apiKeys).set({ dailyLimitUsd: null }).where(eq(apiKeys.id, f.key.id));
  res = await f.request({ messages: [{ role: 'user', content: 'Card 4111111111111111' }] });
  assert.equal(res.status, 403);
  assert.equal(f.calls.length, 0);
  const l = await fixture(t, true);
  await l.activate();
  await l.ctx.db.update(apiKeys).set({ dailyLimitUsd: 0 }).where(eq(apiKeys.id, l.key.id));
  res = await l.request();
  assert.equal(res.status, 200);
  const row = await l.log(res);
  assert.equal(row.costUsd, 0);
  assert.equal(row.routingSavingsUsd, 0.0012);
});

test('provider fallback uses the baseline, flags unknown cloud charges and does not consume another rate-limit slot', async (t) => {
  const f = await fixture(t);
  await f.activate();
  const settings = await f.ctx.settings.get();
  await f.ctx.settings.update({
    rules: { ...settings.rules, agentRateLimit: { enabled: true, rpm: 1 } },
  });
  // Comparisons used two slots before this limit was configured.
  f.ctx.rateLimiter = new (f.ctx.rateLimiter.constructor as { new (): typeof f.ctx.rateLimiter })();
  f.mode.fail = true;
  const res = await f.request();
  assert.equal(res.status, 200);
  assert.deepEqual(
    f.calls.map((call) => call.model),
    ['candidate-wire', 'baseline-wire'],
  );
  const row = await f.log(res);
  assert.equal(row.routingOutcome, 'fallback');
  assert.equal(row.routingCostKnown, false);
  assert.equal(row.costUsd, 0.0012);
  assert.equal(row.routingSavingsUsd, null);
  assert.equal(row.savedUsd, 0);
  assert.ok(row.trace.some((step) => step.code === 'profileFallback'));
  assert.deepEqual(await failingProviders(f.ctx.db), ['Candidate provider']);
  const [listed] = await listProfiles(f.ctx);
  assert.equal(listed!.metrics.fallbacks, 1);
  assert.equal(listed!.metrics.unknownCostRequests, 1);
  assert.equal((await f.request()).status, 429);
});

test('baseline fallback can be disabled and never bypasses a revoked key or changed budget', async (t) => {
  const f = await fixture(t);
  const profile = await f.activate();
  await f.ctx.settings.update({ rerouteOnFailure: false });
  await f.send(
    `/admin/api/routing-profiles/${profile.id}`,
    { fallbackOnError: false },
    f.admin,
    'PATCH',
  );
  f.mode.fail = true;
  let res = await f.request();
  assert.equal(res.status, 503);
  assert.equal((await f.log(res)).routingCostKnown, false);
  await f.send(
    `/admin/api/routing-profiles/${profile.id}`,
    { fallbackOnError: true },
    f.admin,
    'PATCH',
  );
  f.mode.onFail = async () => {
    await f.ctx.db
      .update(apiKeys)
      .set({ dailyLimitUsd: 0, fallbackToLocal: false })
      .where(eq(apiKeys.id, f.key.id));
  };
  res = await f.request();
  assert.equal(res.status, 503);
  assert.ok(f.calls.every((call) => call.model === 'candidate-wire'));
  await f.ctx.db.update(apiKeys).set({ dailyLimitUsd: null }).where(eq(apiKeys.id, f.key.id));
  f.mode.onFail = async () => {
    await f.ctx.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, f.key.id));
  };
  assert.equal((await f.request()).status, 503);
  assert.ok(f.calls.every((call) => call.model === 'candidate-wire'));
});

test('local candidate fallback cannot send sensitive content to a cloud baseline', async (t) => {
  const f = await fixture(t, true);
  await f.activate();
  f.mode.fail = true;
  const res = await f.request({ messages: [{ role: 'user', content: 'Card 4111111111111111' }] });
  assert.equal(res.status, 503);
  assert.deepEqual(
    f.calls.map((call) => call.model),
    ['candidate-wire'],
  );
  assert.equal((await f.log(res)).routingCostKnown, true);
});

test('cache hits and unknown usage do not inflate profile savings', async (t) => {
  const f = await fixture(t);
  await f.activate();
  await f.ctx.settings.update({ cache: { enabled: true, ttlHours: 24 } });
  await f.request();
  const res = await f.request();
  assert.equal(res.headers.get('x-spillway-cache'), 'hit');
  const row = await f.log(res);
  assert.equal(row.costUsd, 0);
  assert.equal(row.baselineCostUsd, null);
  assert.equal(row.routingSavingsUsd, null);
  assert.equal(row.routingCostKnown, true);
  assert.equal(f.calls.length, 1);
  await f.ctx.settings.update({ cache: { enabled: false, ttlHours: 24 } });
  f.mode.missingUsage = true;
  const unknown = await f.log(await f.request());
  assert.equal(unknown.routingCostKnown, false);
  assert.equal(unknown.routingSavingsUsd, null);
  const [listed] = await listProfiles(f.ctx);
  assert.equal(listed!.metrics.eligibleRequests, 1);
  assert.equal(listed!.metrics.unknownCostRequests, 1);
});

test('streaming profile requests meter actual usage and fallback only before an answer', async (t) => {
  const f = await fixture(t);
  await f.activate();
  let res = await f.request({ stream: true });
  assert.equal(res.headers.get('x-spillway-model'), 'candidate');
  assert.ok((await res.text()).includes('OK'));
  let row = await f.log(res);
  assert.ok(Math.abs(row.routingSavingsUsd! - 0.00108) < 1e-12);
  f.mode.fail = true;
  res = await f.request({ stream: true });
  assert.equal(res.headers.get('x-spillway-model'), 'baseline');
  await res.text();
  row = await f.log(res);
  assert.equal(row.routingOutcome, 'fallback');
  assert.equal(row.routingSavingsUsd, null);
});

test('text routing works across client formats and leaves stateful Responses requests alone', async (t) => {
  const f = await fixture(t);
  await f.activate();
  const ask = (path: string, body: Record<string, unknown>) =>
    f.app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${f.token.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'baseline', stream: false, ...body }),
    });
  for (const [path, body] of [
    ['/v1/messages', { max_tokens: 128, messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/responses', { input: 'hi', store: false, max_output_tokens: 128 }],
    ['/api/chat', { messages: [{ role: 'user', content: 'hi' }] }],
    ['/api/generate', { prompt: 'hi' }],
  ] as const) {
    const res = await ask(path, body);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get('x-spillway-model'), 'candidate');
    assert.equal((await f.log(res)).routingCostKnown, true);
  }
  const stateful = await ask('/v1/responses', { input: 'hi', previous_response_id: 'previous' });
  assert.equal(stateful.headers.get('x-spillway-model'), 'baseline');
  assert.equal((await f.log(stateful)).routingOutcome, 'skipped');
});

test('provider URL and cache prices are pinned to the comparison and active profile', async (t) => {
  const f = await fixture(t);
  await f.ctx.db
    .update(providers)
    .set({ baseUrl: `${f.candidateProvider.baseUrl}/changed` })
    .where(eq(providers.id, f.candidateProvider.id));
  let res = await f.send('/admin/api/routing-profiles', f.profileInput, f.admin);
  assert.equal(res.status, 400);
  await f.ctx.db
    .update(providers)
    .set({ baseUrl: f.candidateProvider.baseUrl })
    .where(eq(providers.id, f.candidateProvider.id));
  await f.ctx.db.update(models).set({ cacheReadPrice: 0.5 }).where(eq(models.id, f.candidate.id));
  res = await f.send('/admin/api/routing-profiles', f.profileInput, f.admin);
  assert.equal(res.status, 400);
  await f.ctx.db.update(models).set({ cacheReadPrice: null }).where(eq(models.id, f.candidate.id));
  await f.activate();
  await f.ctx.db
    .update(providers)
    .set({ baseUrl: `${f.candidateProvider.baseUrl}/changed` })
    .where(eq(providers.id, f.candidateProvider.id));
  const row = await f.log(await f.request());
  assert.equal(row.servedModelId, f.baseline.id);
  assert.equal(row.trace.find((step) => step.code === 'profileSkipped')!.params!.reason, 'changed');
});

test('concurrent activation creates only one profile per key', async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all([
    f.send('/admin/api/routing-profiles', f.profileInput, f.admin),
    f.send('/admin/api/routing-profiles', f.profileInput, f.admin),
  ]);
  assert.deepEqual(responses.map((res) => res.status).sort(), [201, 400]);
  assert.equal((await listProfiles(f.ctx)).length, 1);
});

test('budget fallback never selects a model forbidden for the key', async (t) => {
  const f = await fixture(t);
  await f.activate();
  const [localProvider] = await f.ctx.db
    .insert(providers)
    .values({ name: 'Local', kind: 'openai', baseUrl: f.candidateProvider.baseUrl, isLocal: true })
    .returning();
  const [local] = await f.ctx.db
    .insert(models)
    .values({
      name: 'local',
      providerId: localProvider!.id,
      upstreamModel: 'local',
      inputPrice: 0,
      outputPrice: 0,
    })
    .returning();
  await f.ctx.settings.update({ localModelId: local!.id });
  await f.ctx.db
    .update(apiKeys)
    .set({ dailyLimitUsd: 0, allowedModelIds: [f.baseline.id, f.candidate.id] })
    .where(eq(apiKeys.id, f.key.id));
  assert.equal((await f.request()).status, 429);
  assert.equal(f.calls.length, 0);
});

test('estimated savings retain negative differences for different cache pricing', async (t) => {
  const f = await fixture(t);
  await f.ctx.db.update(models).set({ cacheReadPrice: 0 }).where(eq(models.id, f.baseline.id));
  await f.ctx.db.update(models).set({ cacheReadPrice: 5 }).where(eq(models.id, f.candidate.id));
  f.profileInput.comparisonId = (await f.compare()).id;
  await f.activate();
  f.mode.cachedTokens = 100;
  const row = await f.log(await f.request());
  assert.equal(row.routingCostKnown, true);
  assert.equal(row.costUsd, 0.00052);
  assert.equal(row.baselineCostUsd, 0.0002);
  assert.ok(row.routingSavingsUsd! < 0);
  assert.ok((await listProfiles(f.ctx))[0]!.metrics.estimatedSavingsUsd < 0);
});

test('a cancelled stream never falls back after an answer or claims successful savings', async (t) => {
  const f = await fixture(t);
  await f.activate();
  f.mode.partial = true;
  const res = await f.request({ stream: true });
  const reader = res.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  const row = await f.log(res);
  assert.equal(f.calls.length, 1);
  assert.equal(row.servedModelId, f.candidate.id);
  assert.equal(row.routingSavingsUsd, null);
  assert.equal(row.routingCostKnown, false);
  assert.equal(row.error, 'Client disconnected');
  const [listed] = await listProfiles(f.ctx);
  assert.equal(listed!.metrics.selected, 0);
  assert.equal(listed!.metrics.errors, 1);
});

test('unknown or invalid token usage is distinct from zero, and meter reset isolates attempts', () => {
  const meter = new Meter();
  const answer = { choices: [{ message: { content: 'OK' } }] } as OAIChatResponse;
  meter.openAIResponse(answer);
  assert.equal(meter.usageKnown, false);
  meter.openAIResponse({
    ...answer,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
  assert.equal(meter.usageKnown, true);
  meter.openAIResponse({
    ...answer,
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 101 },
    },
  });
  assert.equal(meter.usageKnown, false);
  meter.reset();
  assert.equal(meter.usageKnown, false);
  assert.equal(meter.totalInput, 0);
  assert.equal(meter.text, '');
});
