import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiKeys, models, providers, teams } from '../db/schema.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { testApp } from '../testing.ts';
import { writeLog } from './handler.ts';

/** What Claude Code passes to the status command, trimmed to what matters here. */
const session = (model: string) =>
  JSON.stringify({
    hook_event_name: 'Status',
    session_id: 'f3a1',
    cwd: '/home/dana/shop',
    model: { id: model, display_name: model },
    workspace: { current_dir: '/home/dana/shop', project_dir: '/home/dana/shop' },
    version: '2.1.0',
    cost: { total_cost_usd: 0.42 },
  });

/** The line without its colours. */
const plain = (line: string) =>
  ['\x1b[33m', '\x1b[31m', '\x1b[0m'].reduce((text, code) => text.replaceAll(code, ''), line);

async function setup(key: Partial<typeof apiKeys.$inferInsert> = {}) {
  const f = await testApp();
  const db = f.ctx.db;
  const [cloud] = await db
    .insert(providers)
    .values({ name: 'Anthropic', kind: 'anthropic', baseUrl: 'http://127.0.0.1:9' })
    .returning();
  const [ollama] = await db
    .insert(providers)
    .values({ name: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:9', isLocal: true })
    .returning();
  await db.insert(models).values({
    name: 'claude-sonnet',
    label: 'Claude Sonnet',
    providerId: cloud!.id,
    upstreamModel: 'claude-sonnet-4-5',
    inputPrice: 3,
    outputPrice: 15,
  });
  const [qwen] = await db
    .insert(models)
    .values({
      name: 'qwen-coder',
      label: 'Qwen Coder',
      providerId: ollama!.id,
      upstreamModel: 'qwen3:1.7b',
      inputPrice: 0,
      outputPrice: 0,
    })
    .returning();
  await f.ctx.settings.update({ localModelId: qwen!.id });
  const [team] = await db
    .insert(teams)
    .values({ name: 'Engineering', monthlyBudgetUsd: 600 })
    .returning();
  const token = newGatewayKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: 'dana-laptop',
      kind: 'person',
      hash: token.hash,
      prefix: token.prefix,
      teamId: team!.id,
      dailyLimitUsd: 10,
      ...key,
    })
    .returning();
  const status = (body?: string, secret = token.key) =>
    f.app.request('/v1/spillway/status', {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${secret}` },
      body,
    });
  /** A finished request, logged as the gateway logs it. */
  const spend = (costUsd: number) =>
    writeLog(
      f.ctx,
      {
        id: crypto.randomUUID(),
        keyId: row!.id,
        teamId: team!.id,
        format: 'anthropic',
        requestedModel: 'claude-sonnet',
        status: 200,
        result: 'ok',
        costUsd,
        trace: [],
      },
      row!.id,
    );
  return { ...f, key: row!, status, spend };
}

test("Claude Code's status bar shows the day's spending and the model that answers", async () => {
  const s = await setup();
  await s.spend(3.2);
  const res = await s.status(session('claude-sonnet'));
  assert.equal(res.status, 200);
  assert.equal(
    await res.text(),
    'Spillway · $3.20 of $10.00 today · Engineering at 1% · Claude Sonnet',
  );
});

test('when the daily limit is used up, the line says where requests go now, right after the request', async () => {
  const s = await setup();
  await s.spend(9);
  assert.match(await (await s.status(session('claude-sonnet'))).text(), /\$9\.00 of \$10\.00/);
  await s.spend(1.5);
  const line = await (await s.status(session('claude-sonnet'))).text();
  assert.equal(
    plain(line),
    'Spillway · $10.50 of $10.00 today · Engineering at 2% · → Qwen Coder, local (daily limit reached)',
  );
  assert.ok(line.includes('\x1b[33m'), 'a reroute stands out in yellow');
});

test('a key that blocks instead says so, and a key with a monthly limit counts the month', async () => {
  const blocking = await setup({ fallbackToLocal: false });
  await blocking.spend(12);
  assert.equal(
    plain(await (await blocking.status(session('claude-sonnet'))).text()),
    'Spillway · $12.00 of $10.00 today · Engineering at 2% · blocked (daily limit reached)',
  );

  const monthly = await setup({ dailyLimitUsd: null, monthlyLimitUsd: 100, teamId: null });
  await monthly.spend(41.3);
  assert.equal(
    await (await monthly.status(session('claude-sonnet'))).text(),
    'Spillway · $41.30 of $100.00 this month · Claude Sonnet',
  );
});

test('without a model only the spending is shown, a model the gateway lacks is named, a wrong key is refused', async () => {
  const s = await setup({ dailyLimitUsd: null, teamId: null });
  assert.equal(await (await s.status()).text(), 'Spillway · $0.00 today');
  assert.equal(await (await s.status('not json')).text(), 'Spillway · $0.00 today');
  assert.equal(
    plain(await (await s.status(session('claude-opus-4-1'))).text()),
    'Spillway · $0.00 today · Model "claude-opus-4-1" is not available on this gateway',
  );
  const refused = await s.status(session('claude-sonnet'), 'sw-wrong');
  assert.equal(refused.status, 401);
  assert.equal(await refused.text(), 'Spillway · key not accepted');
});

test('the status bar does not count against the agent rate limit', async () => {
  const s = await setup({ kind: 'agent', dailyLimitUsd: null, teamId: null });
  await s.ctx.settings.update({
    rules: { ...(await s.ctx.settings.get()).rules, agentRateLimit: { enabled: true, rpm: 1 } },
  });
  for (const model of ['claude-sonnet', 'qwen-coder', 'claude-sonnet']) {
    assert.doesNotMatch(await (await s.status(session(model))).text(), /requests per minute/);
  }
  assert.equal(
    s.ctx.rateLimiter.hit(s.key.id, 1),
    true,
    'the first real request still goes through',
  );
});
