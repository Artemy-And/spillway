import assert from 'node:assert/strict';
import { test } from 'node:test';
import { models, providers, requestLogs } from '../db/schema.ts';
import { calendar } from '../lib/time.ts';
import { testApp } from '../testing.ts';
import { overview } from './stats.ts';

test('the daily chart counts requests on the gateway’s own calendar days', async () => {
  const { ctx } = await testApp();
  const [cloud, local] = await ctx.db
    .insert(providers)
    .values([
      { name: 'OpenAI', kind: 'openai' as const, baseUrl: 'https://api.openai.com/v1' },
      { name: 'Ollama', kind: 'ollama' as const, baseUrl: 'http://ollama:11434', isLocal: true },
    ])
    .returning();
  const [gpt, qwen] = await ctx.db
    .insert(models)
    .values([
      { name: 'gpt', providerId: cloud!.id, upstreamModel: 'gpt', inputPrice: 1, outputPrice: 2 },
      { name: 'qwen', providerId: local!.id, upstreamModel: 'qwen', inputPrice: 0, outputPrice: 0 },
    ])
    .returning();
  const log = (id: string, at: string, local: boolean) => ({
    id,
    createdAt: new Date(at),
    format: 'openai' as const,
    requestedModel: 'gpt',
    servedModelId: local ? qwen!.id : gpt!.id,
    servedLocal: local,
    status: 200,
    result: 'ok' as const,
    latencyMs: 1,
    trace: [],
  });
  // India is UTC+5:30: 18:20 UTC is 23:50 on the 8th there, 18:40 UTC is 00:10 on the 9th.
  await ctx.db
    .insert(requestLogs)
    .values([
      log('r1', '2026-10-08T18:20:00Z', false),
      log('r2', '2026-10-08T18:40:00Z', true),
      log('r3', '2026-10-09T06:00:00Z', false),
    ]);

  const data = await overview(
    ctx.db,
    '7d',
    null,
    calendar('Asia/Kolkata'),
    new Date('2026-10-09T12:00:00Z'),
  );
  const day = (date: string) => data.daily.find((row) => row.date === date);
  assert.deepEqual(day('2026-10-08'), { date: '2026-10-08', cloud: 1, local: 0 });
  assert.deepEqual(day('2026-10-09'), { date: '2026-10-09', cloud: 1, local: 1 });
  assert.equal(data.daily.length, 14);
});
