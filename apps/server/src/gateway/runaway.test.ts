import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { overview } from '../admin/stats.ts';
import { apiKeys, models, providers, requestLogs } from '../db/schema.ts';
import { newGatewayKey, shortId } from '../lib/crypto.ts';
import { calendar } from '../lib/time.ts';
import { watch } from '../notify.ts';
import { testApp } from '../testing.ts';
import { writeLog } from './handler.ts';
import { decide } from './policy.ts';
import { recordSpend } from './runaway.ts';

const HOUR = 3_600_000;

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

/** A gateway with Claude Sonnet in the cloud, Qwen Coder at home and one agent key. */
async function setup(key: Partial<typeof apiKeys.$inferInsert> = {}) {
  const f = await testApp();
  const admin = await f.setupAdmin();
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
    .values({ name: 'review-bot', kind: 'agent', hash: token.hash, prefix: token.prefix, ...key })
    .returning();
  const id = row!.id;

  /** A finished request, logged as the gateway logs it. */
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
  /** A request from days ago, already in the log before the gateway started. */
  const past = (costUsd: number, at: Date) =>
    db.insert(requestLogs).values({
      id: shortId('req'),
      createdAt: at,
      keyId: id,
      format: 'anthropic',
      requestedModel: 'claude-sonnet',
      status: 200,
      result: 'ok',
      costUsd,
      trace: [],
    });
  const current = async () => (await db.query.apiKeys.findFirst({ where: eq(apiKeys.id, id) }))!;
  const ask = async () =>
    decide(f.ctx, {
      caller: { key: await current(), team: null, user: null },
      requestedName: 'claude-sonnet',
      pii: {},
      settings: await f.ctx.settings.get(),
    });
  return { ...f, admin, id, token: token.key, spend, past, current, ask };
}

const daysAgo = (days: number, hour = 10) => {
  const at = new Date(Date.now() - days * 24 * HOUR);
  at.setUTCHours(hour, 15, 0, 0);
  return at;
};

test('an agent without a limit that suddenly spends far more than ever goes to the local model', async () => {
  const s = await setup();
  // Its busiest hour in the two weeks before: $4.
  await s.past(2.5, daysAgo(3));
  await s.past(1.5, daysAgo(3));
  await s.past(1, daysAgo(5));

  await s.spend(9);
  await s.spend(9);
  assert.equal((await s.current()).runaway, null, '$18 is still under the $20 minimum');
  await s.spend(3);
  const { runaway } = await s.current();
  assert.equal(runaway?.spent, 21);
  assert.equal(runaway?.usual, 4);

  const decision = await s.ask();
  assert.equal(decision.result, 'rerouted');
  assert.equal(decision.ruleId, 'runawayGuard');
  assert.equal(decision.target?.model.name, 'qwen-coder');
  assert.deepEqual(
    decision.trace.filter((step) => step.code === 'runaway' || step.code === 'sentToLocal'),
    [
      {
        tone: 'warn',
        text: 'Rule 5: key review-bot spent $21.00 in an hour; its busiest hour before was $4.00',
        code: 'runaway',
        params: { rule: 5, key: 'review-bot', spent: 21, usual: 4 },
      },
      {
        tone: 'info',
        text: 'Rule 5 matched → sent to Qwen Coder · local',
        code: 'sentToLocal',
        params: { rule: 5, model: 'Qwen Coder' },
      },
    ],
  );

  // Claude Code's status line says why its requests went local.
  const line = await (
    await s.app.request('/v1/spillway/status', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}` },
      body: JSON.stringify({ model: { id: 'claude-sonnet' } }),
    })
  ).text();
  assert.match(line, /Qwen Coder, local \(stopped: unusual spending\)/);
});

test('a key that has been this busy before, or has a limit of its own, is not stopped', async () => {
  const busy = await setup();
  await busy.past(10, daysAgo(2));
  await busy.spend(25);
  assert.equal((await busy.current()).runaway, null, 'within 3 times its busiest hour of $10');

  const limited = await setup({ monthlyLimitUsd: 500 });
  await limited.spend(60);
  assert.equal((await limited.current()).runaway, null, 'the admin chose its limit');

  // Today does not count as "before": an hour this morning does not raise the bar.
  const today = await setup();
  await today.past(30, new Date(Date.now() - 3 * HOUR));
  await today.spend(25);
  assert.ok((await today.current()).runaway);
});

test('only the last hour counts', async () => {
  const s = await setup();
  const start = Date.now();
  assert.equal(await recordSpend(s.ctx, s.id, 15, start), null);
  assert.equal(await recordSpend(s.ctx, s.id, 15, start + 61 * 60_000), null);
  const stopped = await recordSpend(s.ctx, s.id, 10, start + 70 * 60_000);
  assert.equal(stopped?.spent, 25);
});

test('with nowhere local to go, the refusal says the key was stopped and who can let it back', async () => {
  const s = await setup();
  await s.spend(30);
  await s.ctx.settings.update({ localModelId: null });
  const decision = await s.ask();
  assert.equal(decision.status, 429);
  assert.equal(decision.result, 'blocked_budget');
  assert.equal(
    decision.message,
    'Request blocked: Spillway stopped this key for unusual spending; an admin can let it back on the Keys page',
  );
});

test('an admin lets the key back, and the pace it was stopped at is fine for the day', async () => {
  const s = await setup();
  await s.spend(30);
  const member = await s.addMember(s.admin, 'ben@acme.test');
  const letBack = (cookie: string) => s.send(`/admin/api/keys/${s.id}/let-back`, undefined, cookie);

  assert.equal((await letBack(member.cookie)).status, 403);
  assert.equal((await letBack(s.admin)).status, 200);
  assert.equal((await s.current()).runaway, null);
  assert.equal((await s.ask()).result, 'ok');
  assert.equal((await letBack(s.admin)).status, 409, 'a key that is not stopped');

  await s.spend(30);
  await s.spend(30);
  assert.equal(
    (await s.current()).runaway,
    null,
    '$60 is under 3 times the $30 it was let back at',
  );
  await s.spend(40);
  assert.ok((await s.current()).runaway, '$100 is not');
});

test('turning the rule off lets every stopped key back and stops none', async () => {
  const s = await setup();
  await s.spend(30);
  assert.ok((await s.current()).runaway);
  const rules = (await s.ctx.settings.get()).rules;
  const off = await s.send(
    '/admin/api/rules',
    { ...rules, runawayGuard: { ...rules.runawayGuard, enabled: false } },
    s.admin,
    'PUT',
  );
  assert.equal(off.status, 200);
  assert.equal((await s.current()).runaway, null);
  await s.spend(300);
  assert.equal((await s.current()).runaway, null);

  const listed = (await (await s.get('/admin/api/rules', s.admin)).json()) as { order: string[] };
  assert.equal(listed.order.indexOf('runawayGuard'), 4, 'it is rule 5');
});

test('Overview and Slack tell the admin which key was stopped and why', async () => {
  const s = await setup();
  await s.spend(30);
  const cal = calendar('UTC');
  const { alerts } = await overview(s.ctx.db, 'month', null, cal);
  assert.deepEqual(
    alerts.flatMap((alert) =>
      alert.code === 'keyRunaway'
        ? [{ tone: alert.tone, key: alert.key, spent: alert.spent, usual: alert.usual }]
        : [],
    ),
    [{ tone: 'block', key: 'review-bot', spent: 30, usual: 0 }],
  );

  const set = await s.send('/admin/api/notifications', { slackUrl: hookUrl }, s.admin, 'PUT');
  assert.equal(set.status, 200);
  slack.length = 0;
  await watch(s.ctx);
  const sent = slack.find((message) => message.text.includes('review-bot'));
  assert.ok(sent, 'a message about the key');
  assert.match(sent.text, /\*Key review-bot was stopped: unusual spending\*/);
  assert.match(
    sent.text,
    /\$30\.00 in the last hour; its busiest hour in the two weeks before was \$0\.00\./,
  );
  assert.match(
    sent.text,
    /Its cloud requests go to Qwen Coder · local until an admin lets it back/,
  );
  await watch(s.ctx);
  assert.equal(slack.filter((message) => message.text.includes('review-bot')).length, 1, 'once');
});
