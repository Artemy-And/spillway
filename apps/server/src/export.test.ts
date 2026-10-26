import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { apiKeys, requestLogs, teams } from './db/schema.ts';
import { newGatewayKey } from './lib/crypto.ts';
import { testApp } from './testing.ts';

type NewRequestLog = typeof requestLogs.$inferInsert;

let t: Awaited<ReturnType<typeof testApp>>;
let admin: string;
let anna: { id: string; cookie: string };

before(async () => {
  t = await testApp();
  admin = await t.setupAdmin();
  await t.ctx.settings.update({ timeZone: 'UTC' });
  const [sales, ops] = await t.ctx.db
    .insert(teams)
    .values([{ name: 'Sales' }, { name: 'Ops' }])
    .returning();
  anna = await t.addMember(admin, 'anna@acme.test', sales!.id);
  const key = (name: string, values: Partial<typeof apiKeys.$inferInsert> = {}) => {
    const { prefix, hash } = newGatewayKey();
    return { name, kind: 'person' as const, prefix, hash, ...values };
  };
  const [annas, opsBot, loose] = await t.ctx.db
    .insert(apiKeys)
    .values([
      key('anna-macbook', { userId: anna.id, teamId: sales!.id }),
      key('=cmd|calc', { kind: 'agent', teamId: ops!.id }),
      key('spare'),
    ])
    .returning();
  const log = (keyId: string, at: string, values: Partial<NewRequestLog> = {}): NewRequestLog => ({
    id: `req-${Math.random()}`,
    createdAt: new Date(at),
    keyId,
    format: 'openai',
    requestedModel: 'gpt',
    servedModel: 'GPT-5',
    status: 200,
    result: 'ok',
    trace: [],
    inputTokens: 1000,
    outputTokens: 100,
    costUsd: 0.10001,
    ...values,
  });
  await t.ctx.db.insert(requestLogs).values([
    log(annas!.id, '2026-09-01T00:00:00Z'),
    log(annas!.id, '2026-09-30T23:59:59Z'),
    log(annas!.id, '2026-09-15T12:00:00Z', {
      servedModel: 'Qwen Coder',
      servedLocal: true,
      costUsd: 0,
      savedUsd: 0.5,
    }),
    log(annas!.id, '2026-10-01T00:00:00Z', { costUsd: 99 }),
    log(annas!.id, '2026-08-31T23:59:59Z', { costUsd: 99 }),
    log(opsBot!.id, '2026-09-10T00:00:00Z', { costUsd: 3 }),
    log(opsBot!.id, '2026-09-10T00:00:01Z', { servedModel: null, result: 'blocked_budget' }),
    log(loose!.id, '2026-09-20T00:00:00Z', { costUsd: 1 }),
  ]);
});

test('the month report adds up each key’s spend per model, with names, for the books', async () => {
  const res = await t.get('/admin/export/month.csv?month=2026-09', admin);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /spillway-2026-09\.csv/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'Excel reads it as UTF-8');
  assert.deepEqual(new TextDecoder().decode(bytes).split('\n'), [
    'Month,Team,Person,Key,Key type,Model,Local,Requests,Input tokens,Output tokens,Cost USD,Saved USD',
    "2026-09,Ops,,'=cmd|calc,agent,GPT-5,no,1,1000,100,3,0",
    '2026-09,Sales,anna,anna-macbook,person,GPT-5,no,2,2000,200,0.2,0',
    '2026-09,Sales,anna,anna-macbook,person,Qwen Coder,yes,1,1000,100,0,0.5',
    '2026-09,,,spare,person,GPT-5,no,1,1000,100,1,0',
  ]);
});

test('people get their own keys in the month report, and a month has to be a month', async () => {
  const own = await (await t.get('/admin/export/month.csv?month=2026-09', anna.cookie)).text();
  assert.deepEqual(
    own.split('\n').map((line) => line.split(',')[3]),
    ['Key', 'anna-macbook', 'anna-macbook'],
  );
  assert.equal((await t.get('/admin/export/month.csv?month=2026-13', admin)).status, 400);
  assert.equal((await t.get('/admin/export/month.csv', admin)).status, 400);
  assert.equal((await t.get('/admin/export/month.csv?month=2026-09')).status, 401);
});
