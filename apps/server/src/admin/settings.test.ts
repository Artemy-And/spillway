import assert from 'node:assert/strict';
import { test } from 'node:test';
import { models, providers } from '../db/schema.ts';
import { decide } from '../gateway/policy.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { json, testApp } from '../testing.ts';

test('the first admin’s browser zone becomes the gateway’s', async () => {
  const t = await testApp();
  await t.send('/auth/setup', {
    name: 'Maya',
    email: 'maya@acme.test',
    password: 'admin pass 1',
    timeZone: 'America/Chicago',
    code: t.ctx.setupCode,
  });
  assert.equal((await t.ctx.settings.get()).timeZone, 'America/Chicago');
});

test('saving one setting leaves the others alone', async () => {
  const t = await testApp();
  const admin = await t.setupAdmin();
  const put = (body: unknown) => t.send('/admin/api/settings', body, admin, 'PUT');

  await put({ storePrompts: false, retentionDays: 7 });
  await put({ localModelId: null });
  await put({ rerouteOnFailure: false });
  const settings = await json(await t.get('/admin/api/settings', admin));
  assert.equal(settings.storePrompts, false, 'prompt storage stays off');
  assert.equal(settings.retentionDays, 7);
  assert.equal(settings.rerouteOnFailure, false);
});

test('the time zone can be set, cleared and must be real', async () => {
  const t = await testApp();
  const admin = await t.setupAdmin();
  const put = (body: unknown) => t.send('/admin/api/settings', body, admin, 'PUT');

  assert.equal((await put({ timeZone: 'Mars/Olympus_Mons' })).status, 400);
  assert.equal((await put({ timeZone: 'Asia/Tokyo' })).status, 200);
  assert.equal((await json(await t.get('/admin/api/settings', admin))).timeZone, 'Asia/Tokyo');
  assert.equal((await json(await t.get('/admin/api/rules', admin))).timeZone, 'Asia/Tokyo');

  await put({ timeZone: null });
  const cleared = await json(await t.get('/admin/api/settings', admin));
  assert.equal(cleared.timeZone, null);
  assert.equal((await json(await t.get('/admin/api/rules', admin))).timeZone, cleared.serverZone);
});

test('working hours follow the gateway’s zone, not the server’s', async () => {
  const t = await testApp();
  const { db } = t.ctx;
  const [cloud] = await db
    .insert(providers)
    .values({ name: 'Cloud', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1' })
    .returning();
  const [local] = await db
    .insert(providers)
    .values({ name: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:9', isLocal: true })
    .returning();
  await db.insert(models).values({
    name: 'gpt',
    providerId: cloud!.id,
    upstreamModel: 'gpt-5-mini',
    inputPrice: 0.25,
    outputPrice: 2,
  });
  const [qwen] = await db
    .insert(models)
    .values({ name: 'qwen', providerId: local!.id, upstreamModel: 'qwen3:8b' })
    .returning();
  const settings = await t.ctx.settings.update({
    timeZone: 'Asia/Tokyo',
    localModelId: qwen!.id,
    rules: {
      budgetThreshold: { enabled: false, percent: 80 },
      piiGuard: { enabled: true },
      agentRateLimit: { enabled: false, rpm: 60 },
      offHours: { enabled: true, from: '09:00', to: '18:00' },
    },
  });
  const { hash, prefix } = newGatewayKey();
  const key = {
    id: 'key-1',
    name: 'anna',
    kind: 'person' as const,
    userId: null,
    teamId: null,
    prefix,
    hash,
    dailyLimitUsd: null,
    monthlyLimitUsd: null,
    fallbackToLocal: true,
    allowedModelIds: null,
    createdAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
  };
  const ask = (iso: string) =>
    decide(t.ctx, {
      caller: { key, team: null, user: null },
      requestedName: 'gpt',
      pii: {},
      settings,
      now: new Date(iso),
    });

  const morning = await ask('2026-10-05T02:00:00Z'); // 11:00 in Tokyo
  assert.equal(morning.result, 'ok');
  const evening = await ask('2026-10-05T12:00:00Z'); // 21:00 in Tokyo
  assert.equal(evening.result, 'rerouted');
  assert.equal(evening.ruleId, 'offHours');
  assert.equal(evening.target?.model.name, 'qwen');
});
