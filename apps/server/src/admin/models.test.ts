import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { before, test } from 'node:test';
import { openDb } from '../db/client.ts';
import { json, testApp } from '../testing.ts';

let t: Awaited<ReturnType<typeof testApp>>;
let admin = '';
let cloudId = '';
let localId = '';

before(async () => {
  t = await testApp();
  admin = await t.setupAdmin();
  cloudId = (
    await json(await t.send('/admin/api/providers', { name: 'OpenAI', kind: 'openai' }, admin))
  ).id;
  localId = (
    await json(await t.send('/admin/api/providers', { name: 'Ollama', kind: 'ollama' }, admin))
  ).id;
});

const addModel = async (body: Record<string, unknown>) =>
  json(await t.send('/admin/api/models', body, admin));
const model = async (id: string) =>
  (await json(await t.get('/admin/api/models', admin))).find(
    (row: { id: string }) => row.id === id,
  );

test('a cloud model on the price list gets its list price when added', async () => {
  const { id } = await addModel({
    providerId: cloudId,
    name: 'gpt-mini',
    upstreamModel: 'gpt-5-mini-2025-08-07',
  });
  const row = await model(id);
  assert.equal(row.inputPrice, 0.25);
  assert.equal(row.outputPrice, 2);
  assert.equal(row.cacheReadPrice, 0.025);
});

test('prices sent with the model win over the list, and unknown models stay unset', async () => {
  const sent = await addModel({
    providerId: cloudId,
    name: 'gpt-4o-custom',
    upstreamModel: 'gpt-4o',
    inputPrice: 2,
    outputPrice: 9,
  });
  assert.equal((await model(sent.id)).inputPrice, 2);

  const unknown = await addModel({
    providerId: cloudId,
    name: 'house-model',
    upstreamModel: 'acme-7b',
  });
  const row = await model(unknown.id);
  assert.equal(row.inputPrice, null);
  assert.equal(row.listPrice, null);

  const local = await addModel({ providerId: localId, name: 'qwen', upstreamModel: 'qwen3:8b' });
  assert.equal((await model(local.id)).inputPrice, null, 'local models need no price');
});

test('unpriced cloud models are flagged on the Overview and offer a list price', async () => {
  const { id } = await addModel({
    providerId: cloudId,
    name: 'sonnet',
    upstreamModel: 'claude-sonnet-4-5',
  });
  await t.send(`/admin/api/models/${id}`, { inputPrice: null, outputPrice: null }, admin, 'PATCH');
  const row = await model(id);
  assert.equal(row.inputPrice, null);
  assert.deepEqual(row.listPrice, { input: 3, output: 15, cacheRead: null });

  const overview = await json(await t.get('/admin/api/overview', admin));
  const alert = overview.alerts.find((a: { code: string }) => a.code === 'modelNoPrice');
  assert.deepEqual(alert.models, ['house-model', 'sonnet']);

  // Setting a price, even 0 for a free model, clears the flag.
  await t.send(`/admin/api/models/${id}`, { inputPrice: 0, outputPrice: 0 }, admin, 'PATCH');
  const after = await json(await t.get('/admin/api/overview', admin));
  const still = after.alerts.find((a: { code: string }) => a.code === 'modelNoPrice');
  assert.deepEqual(still.models, ['house-model']);
});

test('upgrading turns old 0/0 prices of cloud models into "not set"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spillway-'));
  const source = join(import.meta.dirname, '../../drizzle');
  // The migrations as they were before prices could be empty.
  const old = join(dir, 'old');
  mkdirSync(join(old, 'meta'), { recursive: true });
  const journal = JSON.parse(readFileSync(join(source, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag < '0003');
  writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries) {
    copyFileSync(join(source, `${entry.tag}.sql`), join(old, `${entry.tag}.sql`));
  }

  const file = join(dir, 'spillway.db');
  (await openDb(file, old)).close();
  const sqlite = new DatabaseSync(file);
  const now = Date.now();
  sqlite.exec(`insert into providers (id, name, kind, base_url, is_local, created_at) values
    ('p-cloud', 'OpenAI', 'openai', 'https://api.openai.com/v1', 0, ${now}),
    ('p-local', 'Ollama', 'ollama', 'http://localhost:11434', 1, ${now})`);
  sqlite.exec(`insert into models (id, name, provider_id, upstream_model, input_price, output_price, created_at) values
    ('m-unset', 'unset', 'p-cloud', 'x', 0, 0, ${now}),
    ('m-priced', 'priced', 'p-cloud', 'y', 1, 2, ${now}),
    ('m-local', 'local', 'p-local', 'z', 0, 0, ${now})`);
  sqlite.close();

  const { db, close } = await openDb(file);
  const rows = await db.query.models.findMany();
  const price = (id: string) => rows.find((row) => row.id === id);
  assert.equal(price('m-unset')?.inputPrice, null);
  assert.equal(price('m-priced')?.inputPrice, 1);
  assert.equal(price('m-local')?.inputPrice, 0, 'local models keep their price');
  close();
  rmSync(dir, { recursive: true, force: true });
});
