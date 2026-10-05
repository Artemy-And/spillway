import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { teamSpend } from './admin/stats.ts';
import { apiKeys, requestLogs, teams, users } from './db/schema.ts';
import { DEMO_EMAIL, READ_ONLY, seedDemo } from './demo.ts';
import { calendar } from './lib/time.ts';
import { json, testApp } from './testing.ts';

let t: Awaited<ReturnType<typeof testApp>>;
// Mid-month on a Wednesday afternoon in New York.
const now = new Date('2026-10-14T19:30:00Z');

before(async () => {
  t = await testApp({ DEMO: 'true' });
  await seedDemo(t.ctx, now);
});

const count = async (where?: ReturnType<typeof eq>) =>
  (await t.ctx.db.select({ n: sql<number>`count(*)` }).from(requestLogs).where(where).get())!.n;

test('the demo company has two weeks of traffic and every feature in it', async () => {
  assert.ok((await count()) > 1000);
  const results = await t.ctx.db
    .select({ ruleId: requestLogs.ruleId, n: sql<number>`count(*)` })
    .from(requestLogs)
    .groupBy(requestLogs.ruleId)
    .all();
  const by = Object.fromEntries(results.map((row) => [row.ruleId ?? 'none', row.n]));
  for (const rule of ['budgetThreshold', 'outage', 'cache', 'piiGuard']) {
    assert.ok((by[rule] ?? 0) > 0, `${rule} shows up`);
  }
  const newest = await t.ctx.db
    .select({ at: sql<number>`max(${requestLogs.createdAt})` })
    .from(requestLogs)
    .get();
  assert.ok(newest!.at <= now.getTime() && newest!.at > now.getTime() - 15 * 60_000, 'fresh');
});

test('Marketing went past its budget and its agent now runs on the local model', async () => {
  const marketing = await t.ctx.db.query.teams.findFirst({ where: eq(teams.name, 'Marketing') });
  const spend = await teamSpend(t.ctx.db, calendar('America/New_York'), now);
  const spent = spend.get(marketing!.id) ?? 0;
  assert.ok(spent >= 60 * 1.04 - 0.1 && spent < 60 * 1.1, `${spent}`);
  const bot = await t.ctx.db.query.apiKeys.findFirst({ where: eq(apiKeys.name, 'marketing-bot') });
  const [latest] = await t.ctx.db
    .select()
    .from(requestLogs)
    .where(eq(requestLogs.keyId, bot!.id))
    .orderBy(sql`${requestLogs.createdAt} desc`)
    .limit(1)
    .all();
  assert.equal(latest!.result, 'rerouted');
  assert.equal(latest!.servedModel, 'Qwen Coder · local');
  assert.deepEqual(
    latest!.trace.map((step) => step.code),
    ['keyValid', 'teamBudget', 'sentToLocal', 'noPii'],
  );
});

test('a new hour replaces the history instead of adding to it', async () => {
  const before = await count();
  const people = (await t.ctx.db.select().from(users).all()).length;
  await seedDemo(t.ctx, new Date(now.getTime() + 3_600_000));
  const after = await count();
  assert.ok(Math.abs(after - before) < before * 0.3, `${before} → ${after}`);
  assert.equal((await t.ctx.db.select().from(users).all()).length, people);
});

test('visitors see the admin UI without signing in, and nothing can change', async () => {
  const me = await json(await t.get('/admin/api/me'));
  assert.equal(me.user.email, DEMO_EMAIL);
  assert.equal(me.gateway.demo, true);
  assert.equal((await t.get('/admin/api/overview')).status, 200);
  for (const [method, path, body] of [
    ['POST', '/admin/api/teams', { name: 'Mine' }],
    ['PUT', '/admin/api/settings', { storePrompts: false }],
    ['DELETE', '/admin/api/cache', undefined],
    ['POST', '/auth/login', { email: DEMO_EMAIL, password: 'x' }],
    ['POST', '/v1/chat/completions', { model: 'gpt-mini', messages: [] }],
  ] as const) {
    const res = await t.send(path, body, '', method);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await json(res)).error, READ_ONLY);
  }
  const providers = await json(await t.get('/admin/api/providers'));
  const res = await t.get(`/admin/api/providers/${providers[0].id}/available`);
  assert.equal(res.status, 403, 'no calls out to real providers');
});

test('outside the demo, nobody is signed in by default', async () => {
  const plain = await testApp();
  await seedDemo(plain.ctx, now);
  assert.equal((await plain.get('/admin/api/me')).status, 401);
});
