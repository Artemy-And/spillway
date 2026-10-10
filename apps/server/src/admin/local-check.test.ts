import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { type TestContext, test } from 'node:test';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { models, providers } from '../db/schema.ts';
import { json, testApp } from '../testing.ts';
import { longerName } from './local-check.ts';

/** An Ollama that runs models with 4,096 tokens unless a model's own parameters say more. */
async function fakeOllama(t: TestContext) {
  const created = new Map<string, { from: string; num_ctx: number }>();
  const generated: Record<string, unknown>[] = [];
  let loaded = '';
  const info = (model: string) => {
    const base = created.get(model)?.from ?? model;
    return base === 'tiny:8k'
      ? { capabilities: ['completion'], model_info: { 'llama.context_length': 8192 } }
      : {
          capabilities: ['completion', 'tools', 'thinking'],
          model_info: { 'qwen3.context_length': 40960 },
        };
  };
  const app = new Hono()
    .post('/api/show', async (c) => c.json(info((await c.req.json()).model)))
    .post('/api/generate', async (c) => {
      const body = await c.req.json();
      generated.push(body);
      loaded = body.model;
      return c.json({ done: true, eval_count: 40, eval_duration: 2_000_000_000 });
    })
    .get('/api/ps', (c) =>
      c.json({
        models: [
          { name: loaded, model: loaded, context_length: created.get(loaded)?.num_ctx ?? 4096 },
        ],
      }),
    )
    .post('/api/create', async (c) => {
      const body = await c.req.json();
      created.set(body.model, { from: body.from, num_ctx: body.parameters.num_ctx });
      return c.json({ status: 'success' });
    });
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, created, generated };
}

async function setup(t: TestContext) {
  const f = await testApp();
  const admin = await f.setupAdmin();
  const ollama = await fakeOllama(t);
  const [provider] = await f.ctx.db
    .insert(providers)
    .values({ name: 'Ollama', kind: 'ollama', baseUrl: ollama.url, isLocal: true })
    .returning();
  const add = async (name: string, upstreamModel: string) =>
    (
      await f.ctx.db
        .insert(models)
        .values({ name, providerId: provider!.id, upstreamModel, inputPrice: 0, outputPrice: 0 })
        .returning()
    )[0]!;
  const check = async (id: string) => f.send(`/admin/api/models/${id}/check`, {}, admin);
  return { ...f, admin, ollama, add, check };
}

test('a local model with a short context is flagged, and one click gives it 32k tokens', async (t) => {
  const s = await setup(t);
  const qwen = await s.add('qwen-coder', 'qwen3:1.7b');

  const before = await json(await s.check(qwen.id));
  assert.deepEqual(before, {
    context: { inUse: 4096, max: 40960, needed: 32768 },
    tools: true,
    tokensPerSecond: 20,
    fix: { name: 'qwen3:1.7b-32k', context: 32768 },
  });
  // A thinking model is timed on plain output.
  assert.equal(s.ollama.generated[0]?.think, false);

  const fixed = await s.send(`/admin/api/models/${qwen.id}/longer-context`, {}, s.admin);
  assert.deepEqual(await json(fixed), { upstreamModel: 'qwen3:1.7b-32k', context: 32768 });
  assert.deepEqual(s.ollama.created.get('qwen3:1.7b-32k'), { from: 'qwen3:1.7b', num_ctx: 32768 });
  const row = await s.ctx.db.query.models.findFirst({ where: eq(models.id, qwen.id) });
  assert.equal(row?.upstreamModel, 'qwen3:1.7b-32k');
  assert.equal(row?.name, 'qwen-coder', 'clients keep the same model name');

  const after = await json(await s.check(qwen.id));
  assert.deepEqual(after.context, { inUse: 32768, max: 40960, needed: 32768 });
  assert.equal(after.fix, null);
});

test('a model that holds less than 32k gets its own maximum, and no tools are reported', async (t) => {
  const s = await setup(t);
  const tiny = await s.add('tiny', 'tiny:8k');
  const result = await json(await s.check(tiny.id));
  assert.deepEqual(result.context, { inUse: 4096, max: 8192, needed: 32768 });
  assert.equal(result.tools, false);
  assert.deepEqual(result.fix, { name: 'tiny:8k-8k', context: 8192 });
  assert.equal(
    s.ollama.generated[0]?.think,
    undefined,
    'only thinking models are asked not to think',
  );
});

test('an OpenAI-compatible local server is checked for tool calls and speed', async (t) => {
  const s = await setup(t);
  const lmstudio = new Hono().post('/v1/chat/completions', async (c) => {
    const body = await c.req.json();
    const message = body.tools
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        }
      : { role: 'assistant', content: '1 2 3' };
    return c.json({
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 30 },
    });
  });
  const server = serve({ fetch: lmstudio.fetch, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const [provider] = await s.ctx.db
    .insert(providers)
    .values({
      name: 'LM Studio',
      kind: 'openai',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      isLocal: true,
    })
    .returning();
  const [model] = await s.ctx.db
    .insert(models)
    .values({
      name: 'local-llama',
      providerId: provider!.id,
      upstreamModel: 'llama-3.1-8b',
      inputPrice: 0,
      outputPrice: 0,
    })
    .returning();

  const result = await json(await s.check(model!.id));
  assert.deepEqual(result.context, { inUse: null, max: null, needed: 32768 });
  assert.equal(result.tools, true);
  assert.ok(result.tokensPerSecond > 0);
  assert.equal(result.fix, null);
  const refused = await s.send(`/admin/api/models/${model!.id}/longer-context`, {}, s.admin);
  assert.equal(refused.status, 400);
});

test('cloud models are not checked, and members cannot run the check', async (t) => {
  const s = await setup(t);
  const [cloud] = await s.ctx.db
    .insert(providers)
    .values({ name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1' })
    .returning();
  const [gpt] = await s.ctx.db
    .insert(models)
    .values({
      name: 'gpt',
      providerId: cloud!.id,
      upstreamModel: 'gpt-5',
      inputPrice: 1,
      outputPrice: 2,
    })
    .returning();
  assert.equal((await s.check(gpt!.id)).status, 400);

  const qwen = await s.add('qwen-coder', 'qwen3:1.7b');
  const member = await s.addMember(s.admin, 'dana@acme.test');
  assert.equal((await s.send(`/admin/api/models/${qwen.id}/check`, {}, member.cookie)).status, 403);
});

test('copies of a model are named after its tag and context', () => {
  assert.equal(longerName('qwen3:1.7b', 32768), 'qwen3:1.7b-32k');
  assert.equal(longerName('llama3', 32768), 'llama3:latest-32k');
  assert.equal(
    longerName('registry.local:5000/team/coder', 16384),
    'registry.local:5000/team/coder:latest-16k',
  );
});
