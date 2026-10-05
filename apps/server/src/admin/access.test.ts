// What a member can and cannot see or change. Members get their own keys and requests; everything
// that affects other people, money or providers is for admins.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { apiKeys, requestLogs, teams } from '../db/schema.ts';
import { json, testApp } from '../testing.ts';

let t: Awaited<ReturnType<typeof testApp>>;
let admin: string;
let anna: { id: string; cookie: string; keyId: string; key: string };
let ben: { id: string; cookie: string; keyId: string; key: string };

async function memberWithKey(email: string, teamId: string) {
  const member = await t.addMember(admin, email, teamId);
  const created = await json(
    await t.send('/admin/api/keys', { name: `${email}-cli`, kind: 'person' }, member.cookie),
  );
  return { ...member, keyId: created.id as string, key: created.key as string };
}

/** A request on the key's behalf; the model does not exist, so it is logged as blocked. */
const request = (key: string) =>
  t.app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
  });

before(async () => {
  t = await testApp();
  admin = await t.setupAdmin();
  const [sales, ops] = await t.ctx.db
    .insert(teams)
    .values([{ name: 'Sales' }, { name: 'Ops' }])
    .returning();
  anna = await memberWithKey('anna@acme.test', sales!.id);
  ben = await memberWithKey('ben@acme.test', ops!.id);
  await request(anna.key);
  await request(ben.key);
  await t.ctx.db.update(requestLogs).set({ costUsd: 2 }).where(eq(requestLogs.keyId, anna.keyId));
  await t.ctx.db.update(requestLogs).set({ costUsd: 5 }).where(eq(requestLogs.keyId, ben.keyId));
});

test('signed-out callers get nothing', async () => {
  for (const path of ['/admin/api/me', '/admin/api/keys', '/admin/api/logs', '/admin/api/users']) {
    assert.equal((await t.get(path)).status, 401, path);
  }
});

test('a member sees only their own keys', async () => {
  const keys = await json(await t.get('/admin/api/keys', anna.cookie));
  assert.deepEqual(
    keys.map((key: { id: string }) => key.id),
    [anna.keyId],
  );
  assert.equal(keys[0].hash, undefined, 'key hashes never leave the server');
  assert.equal((await json(await t.get('/admin/api/keys', admin))).length, 2);
});

test('a member sees only their own requests, also by id or key filter', async () => {
  const own = await json(await t.get('/admin/api/logs', anna.cookie));
  assert.equal(own.length, 1);
  assert.equal(own[0].keyId, anna.keyId);
  const filtered = await json(await t.get(`/admin/api/logs?keyId=${ben.keyId}`, anna.cookie));
  assert.equal(filtered.length, 0);
  const [bens] = await json(await t.get(`/admin/api/logs?keyId=${ben.keyId}`, admin));
  assert.equal((await t.get(`/admin/api/logs/${bens.id}`, anna.cookie)).status, 404);
  assert.equal((await t.get(`/admin/api/logs/${bens.id}`, admin)).status, 200);
});

test('a member’s overview counts only their own spend', async () => {
  const mine = await json(await t.get('/admin/api/overview', anna.cookie));
  assert.equal(mine.spend, 2);
  assert.equal(mine.requests, 1);
  assert.deepEqual(
    mine.spenders.map((row: { keyId: string }) => row.keyId),
    [anna.keyId],
  );
  assert.equal((await json(await t.get('/admin/api/overview', admin))).spend, 7);
});

test('a member cannot revoke someone else’s key', async () => {
  await t.send(`/admin/api/keys/${ben.keyId}/revoke`, {}, anna.cookie);
  const key = await t.ctx.db.query.apiKeys.findFirst({ where: eq(apiKeys.id, ben.keyId) });
  assert.equal(key?.revokedAt, null);
});

test('a member’s new key is theirs, in their team, whatever the request says', async () => {
  const created = await json(
    await t.send(
      '/admin/api/keys',
      {
        name: 'sneaky',
        kind: 'agent',
        userId: ben.id,
        teamId: null,
        dailyLimitUsd: 10_000,
        allowedModelIds: null,
      },
      anna.cookie,
    ),
  );
  const key = await t.ctx.db.query.apiKeys.findFirst({ where: eq(apiKeys.id, created.id) });
  const annaKey = await t.ctx.db.query.apiKeys.findFirst({ where: eq(apiKeys.id, anna.keyId) });
  assert.equal(key?.userId, anna.id);
  assert.equal(key?.teamId, annaKey?.teamId);
  assert.equal(key?.dailyLimitUsd, null);
});

test('a member cannot make themselves an admin', async () => {
  const own = await t.send('/admin/api/me', { role: 'admin' }, anna.cookie, 'PATCH');
  assert.equal(own.status, 200, 'the role is ignored, not an error');
  assert.equal((await json(await t.get('/admin/api/me', anna.cookie))).user.role, 'member');
  const res = await t.send(`/admin/api/users/${anna.id}`, { role: 'admin' }, anna.cookie, 'PATCH');
  assert.equal(res.status, 403);
});

test('everything that changes money, people, providers or rules is admin-only', async () => {
  const id = 'any-id';
  const calls: [string, string, unknown?][] = [
    ['PATCH', `/admin/api/keys/${anna.keyId}`, { dailyLimitUsd: 10_000 }],
    ['POST', '/admin/api/teams', { name: 'Mine' }],
    ['PATCH', `/admin/api/teams/${id}`, { monthlyBudgetUsd: 10_000 }],
    ['DELETE', `/admin/api/teams/${id}`],
    ['PUT', '/admin/api/rules', {}],
    ['GET', '/admin/api/users'],
    ['POST', '/admin/api/users', { email: 'x@acme.test' }],
    ['POST', `/admin/api/users/${ben.id}/invite`, {}],
    ['PATCH', `/admin/api/users/${ben.id}`, { disabled: true }],
    ['GET', '/admin/api/providers'],
    ['POST', '/admin/api/providers', { name: 'Mine', kind: 'openai' }],
    ['PATCH', `/admin/api/providers/${id}`, { baseUrl: 'https://evil.test/v1' }],
    ['DELETE', `/admin/api/providers/${id}`],
    ['GET', `/admin/api/providers/${id}/available`],
    ['GET', '/admin/api/provider-defaults'],
    ['POST', '/admin/api/models', { providerId: id, name: 'm', upstreamModel: 'm' }],
    ['PATCH', `/admin/api/models/${id}`, { inputPrice: 0 }],
    ['DELETE', `/admin/api/models/${id}`],
    ['GET', '/admin/api/price-list'],
    ['GET', '/admin/api/settings'],
    ['PUT', '/admin/api/settings', { storePrompts: true }],
  ];
  for (const [method, path, body] of calls) {
    const res = await t.send(path, body, anna.cookie, method);
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  const key = await t.ctx.db.query.apiKeys.findFirst({ where: eq(apiKeys.id, anna.keyId) });
  assert.equal(key?.dailyLimitUsd, null, 'the limit did not change');
});

test('disabling a person ends their session and stops their keys', async () => {
  await t.send(`/admin/api/users/${ben.id}`, { disabled: true }, admin, 'PATCH');
  assert.equal((await t.get('/admin/api/me', ben.cookie)).status, 401);
  assert.equal((await request(ben.key)).status, 401);
  await t.send(`/admin/api/users/${ben.id}`, { disabled: false }, admin, 'PATCH');
  assert.equal((await t.get('/admin/api/me', ben.cookie)).status, 200);
});
