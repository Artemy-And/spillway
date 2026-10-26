import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { apiKeys, requestLogs } from '../db/schema.ts';
import { json, testApp } from '../testing.ts';

let t: Awaited<ReturnType<typeof testApp>>;
let admin: string;
let anna: { id: string; cookie: string };
let ben: { id: string; cookie: string };

/** Ollama's model list: answers any accepted key with 200, anything else with 401. */
const tags = (key: string) =>
  t.app.request('/api/tags', { headers: { authorization: `Bearer ${key}` } });

const newKey = async (cookie: string, body: Record<string, unknown> = {}) =>
  json(await t.send('/admin/api/keys', { name: 'laptop', kind: 'person', ...body }, cookie));

before(async () => {
  t = await testApp();
  admin = await t.setupAdmin();
  anna = await t.addMember(admin, 'anna@acme.test');
  ben = await t.addMember(admin, 'ben@acme.test');
});

test('replacing a key stops the old value and keeps limits and history', async () => {
  const created = await newKey(admin, { userId: anna.id, dailyLimitUsd: 5 });
  await t.app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${created.key}` },
    body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
  });

  const res = await t.send(`/admin/api/keys/${created.id}/replace`, {}, anna.cookie);
  assert.equal(res.status, 200);
  const replaced = await json(res);
  assert.equal(replaced.id, created.id);
  assert.notEqual(replaced.key, created.key);

  assert.equal((await tags(created.key)).status, 401, 'the old value stops working');
  assert.equal((await tags(replaced.key)).status, 200);
  const key = await t.ctx.db.query.apiKeys.findFirst({ where: eq(apiKeys.id, created.id) });
  assert.equal(key?.dailyLimitUsd, 5);
  assert.equal(key?.prefix, replaced.key.slice(0, 9), 'the list shows the new value’s start');
  const logs = await t.ctx.db.select().from(requestLogs).where(eq(requestLogs.keyId, created.id));
  assert.equal(logs.length, 1, 'the history stays with the key');
});

test('people replace only their own keys, admins any key, nobody a revoked one', async () => {
  const annas = await newKey(anna.cookie);
  assert.equal((await t.send(`/admin/api/keys/${annas.id}/replace`, {}, ben.cookie)).status, 404);
  assert.equal((await tags(annas.key)).status, 200, 'Ben did not touch it');
  assert.equal((await t.send(`/admin/api/keys/${annas.id}/replace`, {}, admin)).status, 200);

  const bens = await newKey(ben.cookie);
  await t.send(`/admin/api/keys/${bens.id}/revoke`, {}, ben.cookie);
  assert.equal((await t.send(`/admin/api/keys/${bens.id}/replace`, {}, ben.cookie)).status, 404);
  assert.equal((await tags(bens.key)).status, 401);
});
