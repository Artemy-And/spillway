import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { apiKeys, models, providers } from '../db/schema.ts';
import { writeLog } from '../gateway/handler.ts';
import { dailyLimit, decide } from '../gateway/policy.ts';
import { newGatewayKey, shortId } from '../lib/crypto.ts';
import { calendar } from '../lib/time.ts';
import { watch } from '../notify.ts';
import { json, testApp } from '../testing.ts';
import { overview } from './stats.ts';

// A Slack webhook that records what it gets.
const slack: { text: string }[] = [];
let server: ReturnType<typeof serve>;
let hookUrl = '';
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
});
after(() => server.close());

const plain = (line: string) =>
  ['\x1b[33m', '\x1b[31m', '\x1b[0m'].reduce((text, code) => text.replaceAll(code, ''), line);

/** Ben has a laptop key with a $10 daily limit; Claude Sonnet is in the cloud, Qwen at home. */
async function setup() {
  const f = await testApp();
  const admin = await f.setupAdmin();
  const ben = await f.addMember(admin, 'ben@acme.test');
  const { db } = f.ctx;
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
    .values({ name: 'qwen-coder', label: 'Qwen Coder', providerId: ollama!.id, upstreamModel: 'q' })
    .returning();
  await f.ctx.settings.update({ localModelId: qwen!.id });
  const token = newGatewayKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: 'ben-laptop',
      kind: 'person',
      userId: ben.id,
      hash: token.hash,
      prefix: token.prefix,
      dailyLimitUsd: 10,
    })
    .returning();
  const id = row!.id;

  const spend = (costUsd: number) =>
    writeLog(
      f.ctx,
      {
        id: shortId('req'),
        keyId: id,
        format: 'anthropic',
        requestedModel: 'claude-sonnet',
        status: 200,
        result: 'ok',
        costUsd,
        trace: [],
      },
      id,
    );
  const current = async () => (await db.query.apiKeys.findFirst({ where: eq(apiKeys.id, id) }))!;
  const ask = async (now = new Date()) =>
    decide(f.ctx, {
      caller: { key: await current(), team: null, user: null },
      requestedName: 'claude-sonnet',
      pii: {},
      settings: await f.ctx.settings.get(),
      now,
    });
  const status = async () =>
    plain(
      await (
        await f.app.request('/v1/spillway/status', {
          method: 'POST',
          headers: { authorization: `Bearer ${token.key}` },
          body: JSON.stringify({ model: { id: 'claude-sonnet' } }),
        })
      ).text(),
    );
  return { ...f, admin, ben, id, spend, current, ask, status };
}

test('someone who used up the daily limit is told where to ask for more', async () => {
  const s = await setup();
  await s.spend(10.5);
  assert.equal(
    await s.status(),
    'Spillway · $10.50 of $10.00 today · → Qwen Coder, local (daily limit reached) · ask for more: http://localhost:8080/keys',
  );

  await s.ctx.db.update(apiKeys).set({ fallbackToLocal: false }).where(eq(apiKeys.id, s.id));
  const refused = await s.ask();
  assert.equal(refused.status, 429);
  assert.equal(
    refused.message,
    'Key ben-laptop reached its $10.00 daily limit ($10.50 spent). Request blocked: this key blocks instead of switching to a local model. Ask an admin for more: http://localhost:8080/keys',
  );

  // A key nobody owns has nobody to ask as.
  await s.ctx.db.update(apiKeys).set({ userId: null }).where(eq(apiKeys.id, s.id));
  assert.equal(
    (await s.ask()).message,
    'Request blocked: this key blocks instead of switching to a local model',
  );
});

test('an approved ask raises the limit for today, and an admin hears about it once', async () => {
  const s = await setup();
  await s.spend(10.5);
  const body = { keyId: s.id, usd: 15, reason: 'release prep' };

  const asked = await s.send('/admin/api/asks', body, s.ben.cookie);
  assert.equal(asked.status, 201);
  const askId = (await json(asked)).id as string;
  assert.equal((await s.send('/admin/api/asks', body, s.ben.cookie)).status, 409, 'one at a time');
  assert.equal(
    (await s.send('/admin/api/asks', body, s.admin)).status,
    404,
    'only on your own keys',
  );

  const waiting = await json(await s.get('/admin/api/asks', s.admin));
  assert.deepEqual(
    waiting.map(({ key, person, usd, reason }: Record<string, unknown>) => ({
      key,
      person,
      usd,
      reason,
    })),
    [{ key: 'ben-laptop', person: 'ben', usd: 15, reason: 'release prep' }],
  );
  const { alerts } = await overview(s.ctx.db, 'month', null, calendar('UTC'));
  assert.ok(alerts.some((alert) => alert.code === 'limitAsk' && alert.person === 'ben'));

  await s.send('/admin/api/notifications', { slackUrl: hookUrl }, s.admin, 'PUT');
  slack.length = 0;
  await watch(s.ctx);
  await watch(s.ctx);
  const about = slack.filter((message) => message.text.includes('asks for'));
  assert.equal(about.length, 1);
  assert.match(about[0]!.text, /\*ben asks for \$15\.00 more today on ben-laptop\*/);
  assert.match(about[0]!.text, /\$10\.50 of \$10\.00 spent today\.\nWhy: release prep/);

  assert.equal((await s.send(`/admin/api/asks/${askId}/approve`, {}, s.ben.cookie)).status, 403);
  assert.equal((await s.send(`/admin/api/asks/${askId}/approve`, {}, s.admin)).status, 200);
  assert.equal((await s.send(`/admin/api/asks/${askId}/approve`, {}, s.admin)).status, 409);

  const decision = await s.ask();
  assert.equal(decision.result, 'ok');
  assert.match(
    decision.trace.find((step) => step.code === 'withinBudget')!.text,
    /of \$25\.00 today/,
  );
  assert.equal(await s.status(), 'Spillway · $10.50 of $25.00 today · Claude Sonnet');
  const keys = await json(await s.get('/admin/api/keys', s.ben.cookie));
  assert.equal(keys[0].dailyLimitToday, 25);
  const mine = await json(await s.get('/admin/api/asks', s.ben.cookie));
  assert.equal(mine[0].approved, true, 'Ben sees the answer');

  const key = await s.current();
  const cal = calendar('UTC');
  assert.equal(dailyLimit(key, cal), 25);
  assert.equal(dailyLimit(key, cal, new Date(Date.now() + 86_400_000)), 10, 'back tomorrow');
});

test('a declined ask leaves the limit as it was', async () => {
  const s = await setup();
  await s.spend(10.5);
  const asked = await json(await s.send('/admin/api/asks', { keyId: s.id, usd: 5 }, s.ben.cookie));
  assert.equal((await s.send(`/admin/api/asks/${asked.id}/decline`, {}, s.admin)).status, 200);
  assert.equal((await s.current()).extra, null);
  assert.equal((await s.ask()).result, 'rerouted');
  assert.equal((await json(await s.get('/admin/api/asks', s.admin))).length, 0, 'nothing waits');
});

test('a raised limit that runs out again is news again', async () => {
  const s = await setup();
  await s.send('/admin/api/notifications', { slackUrl: hookUrl }, s.admin, 'PUT');
  await s.spend(10.5);
  slack.length = 0;
  await watch(s.ctx);
  const asked = await json(await s.send('/admin/api/asks', { keyId: s.id, usd: 5 }, s.ben.cookie));
  await s.send(`/admin/api/asks/${asked.id}/approve`, {}, s.admin);
  await s.spend(5);
  await watch(s.ctx);
  const reached = slack.filter((message) => message.text.includes('reached its daily limit'));
  assert.deepEqual(
    reached.map((message) => /\$[\d.]+ of \$[\d.]+ spent today/.exec(message.text)?.[0]),
    ['$10.50 of $10.00 spent today', '$15.50 of $15.00 spent today'],
  );
});
