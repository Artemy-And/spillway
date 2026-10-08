import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { type TestContext, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { apiKeys, budgetReservations, models, providers, requestLogs } from '../db/schema.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { testApp } from '../testing.ts';
import { anthropicRequestToOpenAI, openAIRequestToAnthropic } from './translate/anthropic.ts';
import type { AUsage, OAIChatRequest } from './types.ts';

async function fixture(t: TestContext, usage?: Partial<AUsage>) {
  const seen: Record<string, unknown>[] = [];
  const upstream = new Hono().post('/v1/messages', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    seen.push(body);
    return c.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [
        { type: 'tool_use', id: 'call_1', name: 'lookup_stock', input: { sku: 'TEST-42' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      ...(usage ? { usage } : {}),
    });
  });
  const server = serve({ fetch: upstream.fetch, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    server.close();
  });
  const f = await testApp();
  const [provider] = await f.ctx.db
    .insert(providers)
    .values({
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    })
    .returning();
  await f.ctx.db.insert(models).values({
    name: 'claude-test',
    providerId: provider!.id,
    upstreamModel: 'claude-wire',
    inputPrice: 3,
    outputPrice: 15,
    cacheReadPrice: 0.3,
  });
  const token = newGatewayKey();
  await f.ctx.db.insert(apiKeys).values({
    name: 'App',
    kind: 'person',
    hash: token.hash,
    prefix: token.prefix,
    dailyLimitUsd: 1,
    fallbackToLocal: false,
  });
  const response = await f.app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token.key}` },
    body: JSON.stringify({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'Look up stock for TEST-42' }],
      max_tokens: 128,
      stream: false,
      tools: [
        { type: 'function', function: { name: 'lookup_stock', parameters: { type: 'object' } } },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
    }),
  });
  assert.equal(response.status, 200);
  const id = response.headers.get('x-spillway-request-id');
  assert.ok(id);
  const log = await f.ctx.db.query.requestLogs.findFirst({ where: eq(requestLogs.id, id) });
  const ledger = await f.ctx.db.query.budgetReservations.findFirst({
    where: eq(budgetReservations.requestId, id),
  });
  assert.ok(log);
  assert.ok(ledger);
  return { response, log, ledger, seen };
}

test('translated Anthropic tool calls retain unknown usage and their budget hold', async (t) => {
  const f = await fixture(t);
  const body = (await f.response.json()) as { choices: { message: { tool_calls: unknown[] } }[] };
  assert.equal(body.choices[0]!.message.tool_calls.length, 1);
  assert.equal(f.log.costKnown, false);
  assert.equal(f.log.costUsd, 0);
  assert.equal(f.ledger.state, 'unknown');
  assert.ok(f.ledger.heldUsd > 0);
  assert.equal(f.ledger.heldUsd, f.ledger.estimatedUsd);
  assert.deepEqual(f.seen[0]!.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
});

test('translated Anthropic usage bills native cached reads and both cache write lifetimes', async (t) => {
  const f = await fixture(t, {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 30,
    cache_creation: { ephemeral_1h_input_tokens: 10 },
  });
  const cost = (100 * 3 + 20 * 0.3 + 20 * 3 * 1.25 + 10 * 3 * 2 + 10 * 15) / 1_000_000;
  assert.equal(f.log.costKnown, true);
  assert.equal(f.log.inputTokens, 150);
  assert.equal(f.log.outputTokens, 10);
  assert.equal(f.log.costUsd, cost);
  assert.equal(f.ledger.state, 'settled');
  assert.equal(f.ledger.chargedUsd, cost);
  assert.equal(f.ledger.heldUsd, 0);
});

test('partial native Anthropic usage records its known charge and retains the remainder', async (t) => {
  const f = await fixture(t, { input_tokens: 100 });
  assert.equal(f.log.costKnown, false);
  assert.equal(f.log.costUsd, (100 * 3) / 1_000_000);
  assert.equal(f.ledger.state, 'unknown');
  assert.equal(f.ledger.chargedUsd, f.log.costUsd);
  assert.equal(f.ledger.heldUsd, f.ledger.estimatedUsd - f.ledger.chargedUsd);
});

test('single-call preference translates in both directions without forcing a function choice', () => {
  const request: OAIChatRequest = {
    model: 'claude-wire',
    messages: [{ role: 'user', content: 'Look up stock' }],
    tools: [
      { type: 'function', function: { name: 'lookup_stock', parameters: { type: 'object' } } },
    ],
    max_tokens: 128,
    parallel_tool_calls: false,
  };
  const translated = openAIRequestToAnthropic(request);
  assert.deepEqual(translated.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  const returned = anthropicRequestToOpenAI(translated);
  assert.equal(returned.parallel_tool_calls, false);
  assert.equal(returned.tool_choice, 'auto');
  assert.deepEqual(openAIRequestToAnthropic({ ...request, tool_choice: 'none' }).tool_choice, {
    type: 'none',
  });
  assert.equal(
    openAIRequestToAnthropic({ ...request, parallel_tool_calls: true }).tool_choice,
    undefined,
  );
});
