import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiKeys, requestLogs } from '../db/schema.ts';
import { testApp } from '../testing.ts';

test('the log filters by app, and each key shows the app of its latest request', async () => {
  const { ctx, get, setupAdmin } = await testApp();
  const admin = await setupAdmin();
  const [anna, bot] = await ctx.db
    .insert(apiKeys)
    .values([
      { name: 'anna-laptop', kind: 'person' as const, prefix: 'sw-a', hash: 'a' },
      { name: 'report-bot', kind: 'agent' as const, prefix: 'sw-b', hash: 'b' },
    ])
    .returning();
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const log = (id: string, keyId: string, app: 'claude-code' | 'codex' | null, at: Date) => ({
    id,
    keyId,
    app,
    createdAt: at,
    format: 'anthropic' as const,
    requestedModel: 'claude',
    status: 200,
    result: 'ok' as const,
    latencyMs: 1,
    trace: [],
  });
  await ctx.db
    .insert(requestLogs)
    .values([
      log('r1', anna!.id, 'codex', minutesAgo(30)),
      log('r2', anna!.id, 'claude-code', minutesAgo(5)),
      log('r3', bot!.id, null, minutesAgo(10)),
    ]);

  // biome-ignore lint/suspicious/noExplicitAny: tests assert on response fields directly
  const json = async (path: string): Promise<any> => (await get(path, admin)).json();
  const codex = await json('/admin/api/logs?app=codex');
  assert.deepEqual(
    codex.map((row: { id: string }) => row.id),
    ['r1'],
  );

  const keys = await json('/admin/api/keys');
  const lastApp = (name: string) => keys.find((key: { name: string }) => key.name === name).lastApp;
  assert.equal(lastApp('anna-laptop'), 'claude-code');
  assert.equal(lastApp('report-bot'), null);
});
