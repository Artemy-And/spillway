import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { apiKeys, models, providers, requestLogs, settings, teams } from './db/schema.ts';
import { newGatewayKey, shortId } from './lib/crypto.ts';
import { calendar } from './lib/time.ts';
import { watch, weeklyNotice } from './notify.ts';
import { json, testApp } from './testing.ts';

// Slack and Teams webhooks that record what they get.
const slack: { text: string }[] = [];
// biome-ignore lint/suspicious/noExplicitAny: the card is checked field by field
const teamsCards: any[] = [];
const hooks = new Hono()
  .post('/slack', async (c) => {
    slack.push(await c.req.json());
    return c.text('ok');
  })
  .post('/teams', async (c) => {
    teamsCards.push(await c.req.json());
    return c.body(null, 202);
  });

let server: ReturnType<typeof serve>;
let hookUrl = '';
let t: Awaited<ReturnType<typeof testApp>>;
let admin = '';
let modelId = '';
let keyId = '';
let teamId = '';

before(async () => {
  server = serve({ fetch: hooks.fetch, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t = await testApp();
  admin = await t.setupAdmin();
  const { db } = t.ctx;
  const [provider] = await db
    .insert(providers)
    .values({ name: 'OpenAI', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1' })
    .returning();
  const [model] = await db
    .insert(models)
    .values({ name: 'gpt', providerId: provider!.id, upstreamModel: 'gpt-5-mini' })
    .returning();
  const [team] = await db
    .insert(teams)
    .values({ name: 'Marketing', monthlyBudgetUsd: 60 })
    .returning();
  const created = newGatewayKey();
  const [key] = await db
    .insert(apiKeys)
    .values({
      name: 'n8n',
      kind: 'agent',
      teamId: team!.id,
      prefix: created.prefix,
      hash: created.hash,
    })
    .returning();
  modelId = model!.id;
  keyId = key!.id;
  teamId = team!.id;
});

after(() => server.close());

beforeEach(async () => {
  slack.length = 0;
  teamsCards.length = 0;
  await t.ctx.db.delete(requestLogs);
  await t.ctx.db.delete(settings).where(eq(settings.key, 'notices'));
});

/** A logged request; `failed` is what an outage looks like. */
const log = (values: Partial<typeof requestLogs.$inferInsert> = {}, at = new Date()) =>
  t.ctx.db.insert(requestLogs).values({
    id: shortId('req'),
    createdAt: at,
    keyId,
    teamId,
    format: 'openai',
    requestedModel: 'gpt',
    requestedModelId: modelId,
    status: 200,
    result: 'ok',
    trace: [],
    ...values,
  });

const put = (body: unknown) => t.send('/admin/api/notifications', body, admin, 'PUT');

test('webhook URLs are kept sealed and only reported as set', async () => {
  await put({ slackUrl: `${hookUrl}/slack`, teamsUrl: `${hookUrl}/teams` });
  const shown = await json(await t.get('/admin/api/notifications', admin));
  assert.equal(shown.slack, true);
  assert.equal(shown.teams, true);
  assert.equal(shown.slackUrl, undefined);
  assert.equal(shown.mailFrom, null, 'no SMTP_URL, no email');
  const stored = JSON.stringify((await t.ctx.settings.get()).notifications);
  assert.ok(!stored.includes(hookUrl), 'the plain URL is not stored');
  assert.equal((await put({ slackUrl: 'not a url' })).status, 400);
});

test('a test message reaches Slack and Teams in their own formats', async () => {
  const res = await json(await t.send('/admin/api/notifications/test', {}, admin));
  assert.deepEqual(
    res.deliveries.map((d: { channel: string; ok: boolean }) => [d.channel, d.ok]),
    [
      ['slack', true],
      ['teams', true],
    ],
  );
  assert.match(slack[0]!.text, /^\*Test from Spillway\*/);
  assert.match(slack[0]!.text, /<http:\/\/localhost:8080\/settings\|Open Spillway>/);
  const card = teamsCards[0].attachments[0].content;
  assert.equal(card.type, 'AdaptiveCard');
  assert.equal(card.body[0].text, 'Test from Spillway');
});

test('members cannot read or change notifications', async () => {
  const member = await t.addMember(admin, 'mia@acme.test');
  assert.equal((await t.get('/admin/api/notifications', member.cookie)).status, 403);
  assert.equal(
    (await t.send('/admin/api/notifications', { slackUrl: null }, member.cookie, 'PUT')).status,
    403,
  );
});

test('a team over its budget is announced once', async () => {
  await log({ costUsd: 61 });
  assert.equal(await watch(t.ctx), 1);
  assert.equal(slack.length, 1);
  assert.match(slack[0]!.text, /Marketing is over its budget/);
  assert.match(slack[0]!.text, /\$61\.00 of \$60\.00/);
  assert.match(slack[0]!.text, /blocked until the budget resets/, 'no local model is set');
  await watch(t.ctx);
  assert.equal(slack.length, 1, 'not again');
});

test('the threshold comes first, then the budget', async () => {
  await log({ costUsd: 50 });
  await watch(t.ctx);
  assert.match(slack.at(-1)!.text, /Marketing is at 83% of its budget/);
  await log({ costUsd: 20 });
  await watch(t.ctx);
  assert.match(slack.at(-1)!.text, /over its budget/);
  assert.equal(slack.length, 2);
});

test('an outage is announced when it starts and when the provider answers again', async () => {
  const minute = 60_000;
  await log(
    { result: 'error', status: 503, error: 'OpenAI returned 503: Bad gateway' },
    new Date(Date.now() - minute),
  );
  await watch(t.ctx);
  assert.match(slack.at(-1)!.text, /OpenAI is failing/);
  assert.match(slack.at(-1)!.text, /Bad gateway/);
  await watch(t.ctx);
  assert.equal(slack.length, 1);

  await log({ costUsd: 0.01 });
  await watch(t.ctx);
  assert.match(slack.at(-1)!.text, /OpenAI answers again/);
  await watch(t.ctx);
  assert.equal(slack.length, 2);
});

test('the Monday summary covers the week before, from 9:00 in the gateway’s zone', async () => {
  const cal = calendar('Europe/Berlin');
  const monday = cal.at(2026, 10, 5, 9, 30);
  await log({ costUsd: 12.5, savedUsd: 3 }, cal.at(2026, 10, 1, 12));
  await log({ servedLocal: true }, cal.at(2026, 10, 4, 23, 59));
  await log({ costUsd: 100 }, cal.at(2026, 10, 5, 8)); // this week, not counted

  assert.equal(await weeklyNotice(t.ctx, cal, cal.at(2026, 10, 5, 8, 59)), null, 'too early');
  assert.equal(await weeklyNotice(t.ctx, cal, cal.at(2026, 10, 6, 10)), null, 'not Monday');
  const [key, notice] = (await weeklyNotice(t.ctx, cal, monday))!;
  assert.equal(key, 'weekly:2026-10-05');
  assert.equal(notice.title, 'Last week on Spillway: $12.50 spent');
  assert.match(notice.lines[0]!, /^Sep 28 – Oct 4: 2 requests, 50% answered by local models/);
  assert.match(notice.lines[1]!, /saved \$3\.00/);
  assert.match(notice.lines[2]!, /n8n \$12\.50/);
});

test('nothing is sent while no channel is set up', async () => {
  await put({ slackUrl: '', teamsUrl: null });
  await log({ costUsd: 61 });
  assert.equal(await watch(t.ctx), 0);
  assert.equal(slack.length, 0);
});
