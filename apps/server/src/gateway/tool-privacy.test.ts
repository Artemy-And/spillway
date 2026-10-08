import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { type TestContext, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { apiKeys, models, providers, requestLogs } from '../db/schema.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { testApp } from '../testing.ts';
import { callerForKey, handleGateway } from './handler.ts';

const card = '4242424242424242';
const cardJson = JSON.stringify({ card });
const tool = {
  type: 'function',
  function: { name: 'lookup', parameters: { type: 'object' } },
};

function chat(argumentsText = cardJson) {
  return {
    messages: [
      { role: 'user', content: 'Synthetic lookup' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: argumentsText },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      { role: 'user', content: 'Continue' },
    ],
  };
}

async function fixture(t: TestContext) {
  const calls: Record<string, unknown>[] = [];
  const mode = { missingUsage: false };
  const upstream = new Hono().post('/v1/chat/completions', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    calls.push(body);
    return c.json({
      id: 'chat_1',
      object: 'chat.completion',
      model: body.model,
      choices: [
        { index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' },
      ],
      ...(!mode.missingUsage ? { usage: { prompt_tokens: 10, completion_tokens: 2 } } : {}),
    });
  });
  const server = serve({ fetch: upstream.fetch, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    server.close();
  });
  const f = await testApp();
  const [cloud, local] = await f.ctx.db
    .insert(providers)
    .values([
      {
        name: 'Cloud',
        kind: 'openai' as const,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      },
      {
        name: 'Local',
        kind: 'openai' as const,
        isLocal: true,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      },
    ])
    .returning();
  await f.ctx.db.insert(models).values([
    {
      name: 'cloud',
      providerId: cloud!.id,
      upstreamModel: 'cloud-wire',
      inputPrice: 1,
      outputPrice: 2,
    },
    { name: 'local', providerId: local!.id, upstreamModel: 'local-wire' },
  ]);
  const token = newGatewayKey();
  const [key] = await f.ctx.db
    .insert(apiKeys)
    .values({
      name: 'App',
      kind: 'person',
      hash: token.hash,
      prefix: token.prefix,
      fallbackToLocal: false,
    })
    .returning();
  const request = (body: Record<string, unknown>, path = '/v1/chat/completions') =>
    f.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.key}` },
      body: JSON.stringify({ model: 'cloud', stream: false, max_tokens: 128, ...body }),
    });
  const log = async (response: Response) => {
    const id = response.headers.get('x-spillway-request-id');
    assert.ok(id);
    const row = await f.ctx.db.query.requestLogs.findFirst({ where: eq(requestLogs.id, id) });
    assert.ok(row);
    return row;
  };
  const internal = async (body: Record<string, unknown>) => {
    const caller = await callerForKey(f.ctx, key!.id);
    assert.ok(caller);
    return new Hono()
      .post('/call', (c) => handleGateway(f.ctx, c, 'openai', caller))
      .request('/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'local', stream: false, max_tokens: 128, ...body }),
      });
  };
  return { ...f, calls, mode, request, log, internal };
}

test('tool arguments are screened before any cloud dispatch in every supported client format', async (t) => {
  const f = await fixture(t);
  const cases: [string, Record<string, unknown>][] = [
    ['/v1/chat/completions', chat()],
    [
      '/v1/messages',
      {
        messages: [
          { role: 'user', content: 'Synthetic lookup' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { card } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
          },
        ],
      },
    ],
    [
      '/v1/responses',
      {
        input: [
          { role: 'user', content: 'Synthetic lookup' },
          { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: cardJson },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
        ],
        max_output_tokens: 128,
      },
    ],
    [
      '/api/chat',
      {
        messages: [
          { role: 'user', content: 'Synthetic lookup' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'lookup', arguments: { card } } }],
          },
          { role: 'tool', content: 'ok' },
        ],
        options: { num_predict: 128 },
      },
    ],
  ];
  for (const [path, body] of cases) {
    const response = await f.request(body, path);
    assert.ok(response.status >= 400, path);
    const log = await f.log(response);
    assert.equal(log.result, 'blocked_pii', path);
    assert.equal(log.costUsd, 0);
    assert.ok(log.trace.some((step) => step.code === 'piiBlocked'));
  }
  assert.equal(f.calls.length, 0);
});

test('unicode-escaped card arguments cannot bypass screening and local processing preserves the latest user preview', async (t) => {
  const f = await fixture(t);
  const escaped = `{"card":"${[...card].map((digit) => `\\u${digit.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"}`;
  const blocked = await f.request(chat(escaped));
  assert.equal(blocked.status, 403);
  assert.equal((await f.log(blocked)).result, 'blocked_pii');
  assert.equal(f.calls.length, 0);
  const local = await f.request({ ...chat(escaped), model: 'local' });
  assert.equal(local.status, 200);
  const log = await f.log(local);
  assert.equal(log.servedLocal, true);
  assert.equal(log.promptPreview, 'Continue');
  assert.ok(log.trace.some((step) => step.code === 'piiMasked'));
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(f.calls[0]).includes('\\\\u0034'), true);
});

test('escaped JSON array and scalar tool results are screened in every client format', async (t) => {
  const f = await fixture(t);
  const encoded = [...card]
    .map((digit) => `\\u${digit.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
  for (const result of [`["${encoded}"]`, `"${encoded}"`]) {
    const cases: [string, Record<string, unknown>][] = [
      [
        '/v1/chat/completions',
        {
          messages: [
            { role: 'user', content: 'Synthetic lookup' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: result },
          ],
        },
      ],
      [
        '/v1/messages',
        {
          messages: [
            { role: 'user', content: 'Synthetic lookup' },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: {} }],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_1',
                  content: [{ type: 'text', text: result }],
                },
              ],
            },
          ],
        },
      ],
      [
        '/v1/responses',
        {
          input: [
            { role: 'user', content: 'Synthetic lookup' },
            { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_1', output: result },
          ],
          max_output_tokens: 128,
        },
      ],
      [
        '/api/chat',
        {
          messages: [
            { role: 'user', content: 'Synthetic lookup' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'lookup', arguments: {} } }],
            },
            { role: 'tool', content: result },
          ],
          options: { num_predict: 128 },
        },
      ],
    ];
    for (const [path, body] of cases) {
      const response = await f.request(body, path);
      assert.ok(response.status >= 400, path);
      const log = await f.log(response);
      assert.equal(log.result, 'blocked_pii', path);
      assert.equal(JSON.stringify(log).includes('\\u0034'), false, path);
    }
  }
  assert.equal(f.calls.length, 0);
});

test('secrets in tool descriptions or JSON schemas are screened before dispatch', async (t) => {
  const f = await fixture(t);
  const secret = `sk-${'a'.repeat(30)}`;
  for (const definition of [
    { ...tool, function: { ...tool.function, description: secret } },
    {
      ...tool,
      function: {
        ...tool.function,
        parameters: { type: 'object', properties: { token: { type: 'string', enum: [secret] } } },
      },
    },
  ]) {
    const response = await f.request({
      messages: [{ role: 'user', content: 'Synthetic lookup' }],
      tools: [definition],
    });
    assert.equal(response.status, 403);
    const log = await f.log(response);
    assert.equal(log.result, 'blocked_pii');
    assert.equal(JSON.stringify(log).includes(secret), false);
  }
  assert.equal(f.calls.length, 0);
});

test('internal non-stream calls distinguish missing usage from reported zero-cost local usage', async (t) => {
  const f = await fixture(t);
  const body = { messages: [{ role: 'user', content: 'Synthetic lookup' }] };
  f.mode.missingUsage = true;
  const unknown = await f.internal(body);
  assert.equal(unknown.status, 200);
  assert.equal(unknown.headers.get('x-spillway-usage-known'), 'false');
  assert.equal((await f.log(unknown)).costKnown, true);
  f.mode.missingUsage = false;
  const known = await f.internal(body);
  assert.equal(known.headers.get('x-spillway-usage-known'), 'true');
  const ordinary = await f.request({ ...body, model: 'local' });
  assert.equal(ordinary.headers.get('x-spillway-usage-known'), null);
});
