import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { apiKeys, requestLogs } from '../db/schema.ts';
import { calendar } from '../lib/time.ts';
import { watch } from '../notify.ts';
import { json, testApp } from '../testing.ts';
import { overview } from './stats.ts';

const DAY = 86_400_000;
const utc = calendar('UTC');
/** "2026-10-27": today on the gateway's calendar, moved by whole days */
const day = (offset: number) => utc.dayKey(new Date(Date.now() + offset * DAY));

let t: Awaited<ReturnType<typeof testApp>>;
let admin: string;
let anna: { id: string; cookie: string };
let ben: { id: string; cookie: string };

// A Slack webhook that records what it gets.
const slack: { text: string }[] = [];
let server: ReturnType<typeof serve>;
let hookUrl = '';

/** Ollama's model list: answers any accepted key with 200, anything else with 401. */
const tags = (key: string) =>
  t.app.request('/api/tags', { headers: { authorization: `Bearer ${key}` } });

/** A request on the key's behalf; the model does not exist, so it is logged as blocked. */
const chat = (key: string) =>
  t.app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
  });

const statusLine = async (key: string) =>
  (
    await (
      await t.app.request('/v1/spillway/status', { headers: { authorization: `Bearer ${key}` } })
    ).text()
  )
    .replaceAll('\x1b[33m', '')
    .replaceAll('\x1b[0m', '');

const newKey = async (cookie: string, body: Record<string, unknown> = {}) =>
  json(await t.send('/admin/api/keys', { name: 'laptop', kind: 'person', ...body }, cookie));

const listed = async (id: string, cookie = admin) =>
  (await json(await t.get('/admin/api/keys', cookie))).find((key: { id: string }) => key.id === id);

before(async () => {
  server = serve({
    fetch: new Hono().post('/slack', async (c) => {
      slack.push(await c.req.json());
      return c.text('ok');
    }).fetch,
    port: 0,
  });
  await new Promise((resolve) => server.once('listening', resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slack`;

  t = await testApp();
  admin = await t.setupAdmin();
  anna = await t.addMember(admin, 'anna@acme.test');
  ben = await t.addMember(admin, 'ben@acme.test');
  await t.ctx.settings.update({ timeZone: 'UTC' });
});
after(() => server.close());

test('replacing a key stops the old value and keeps limits and history', async () => {
  const created = await newKey(admin, { userId: anna.id, dailyLimitUsd: 5 });
  await chat(created.key);

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

test('a key works through its last day, then its apps are told why it stopped', async () => {
  const created = await newKey(admin, { expiresOn: day(0) });
  assert.equal((await tags(created.key)).status, 200, 'it still works today');
  assert.equal((await listed(created.id)).expired, false);

  await t.send(`/admin/api/keys/${created.id}`, { expiresOn: day(-1) }, admin, 'PATCH');
  assert.equal((await tags(created.key)).status, 401);
  const refused = await chat(created.key);
  assert.equal(refused.status, 401);
  assert.match((await json(refused)).error.message, /passed its end date/);
  assert.equal(await statusLine(created.key), 'Spillway · key past its end date');
  const row = await listed(created.id);
  assert.equal(row.expiresOn, day(-1));
  assert.equal(row.expired, true);

  await t.send(`/admin/api/keys/${created.id}`, { expiresOn: null }, admin, 'PATCH');
  assert.equal((await tags(created.key)).status, 200, 'no end date, no end');
  assert.equal((await listed(created.id)).expiresOn, null);
});

test('people may give their own new key an end date', async () => {
  const created = await newKey(ben.cookie, { expiresOn: day(30), dailyLimitUsd: 1000 });
  const row = await listed(created.id, ben.cookie);
  assert.equal(row.expiresOn, day(30));
  assert.equal(row.dailyLimitUsd, null, 'limits are still for admins');
  const res = await t.send(
    `/admin/api/keys/${created.id}`,
    { expiresOn: null },
    ben.cookie,
    'PATCH',
  );
  assert.equal(res.status, 403);
});

test('a key in use that ends soon says so in the status line, on Overview and in one notice', async () => {
  const used = await newKey(admin, { name: 'contractor-laptop', expiresOn: day(1) });
  const idle = await newKey(admin, { name: 'spare-laptop', expiresOn: day(1) });
  await chat(used.key);
  const last = utc.shortDate(new Date(Date.now() + DAY));

  assert.equal(await statusLine(used.key), `Spillway · $0.00 today · key works until ${last}`);
  assert.equal(await statusLine(idle.key), 'Spillway · $0.00 today', 'it may never be used');

  const { alerts } = await overview(t.ctx.db, 'month', null, utc);
  const ending = alerts.filter((alert) => alert.code === 'keyEnding');
  assert.deepEqual(
    ending.map((alert) => ('until' in alert ? [alert.key, alert.until] : [])),
    [['contractor-laptop', day(1)]],
  );

  await t.send('/admin/api/notifications', { slackUrl: hookUrl }, admin, 'PUT');
  slack.length = 0;
  await watch(t.ctx);
  await watch(t.ctx);
  const about = slack.filter((message) => message.text.includes('stops working'));
  assert.equal(about.length, 1);
  assert.match(about[0]!.text, new RegExp(`Key contractor-laptop stops working after ${last}`));
});
