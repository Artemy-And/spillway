import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Oidc } from './auth/oidc.ts';
import { requestLogs } from './db/schema.ts';
import { newSetupCode } from './lib/crypto.ts';
import { json, testApp } from './testing.ts';

test('a form posted from another site cannot act with the session cookie', async () => {
  const t = await testApp();
  const admin = await t.setupAdmin();
  const { id } = await json(await t.send('/admin/api/keys', { name: 'ci', kind: 'agent' }, admin));
  const revoke = (headers: Record<string, string>) =>
    t.app.request(`/admin/api/keys/${id}/revoke`, {
      method: 'POST',
      headers: { cookie: admin, ...headers },
    });

  const forged = await revoke({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  assert.equal(forged.status, 403);
  const keys = await json(await t.get('/admin/api/keys', admin));
  assert.equal(keys[0].revokedAt, null);

  const own = await revoke({ origin: 'http://localhost:8080', 'sec-fetch-site': 'same-origin' });
  assert.equal(own.status, 200);
});

test('the admin UI cannot be framed by another site', async () => {
  const t = await testApp();
  const res = await t.get('/');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
});

test('with single sign-on, members cannot take over an email by renaming themselves', async () => {
  const t = await testApp();
  const admin = await t.setupAdmin();
  const member = await t.addMember(admin, 'bob@acme.test');
  t.ctx.oidc = { label: 'SSO' } as unknown as Oidc;

  const me = await json(await t.get('/admin/api/me', member.cookie));
  assert.equal(me.user.emailLocked, true);
  const taken = await t.send('/admin/api/me', { email: 'ceo@acme.test' }, member.cookie, 'PATCH');
  assert.equal(taken.status, 403);
  // Renaming still works, and admins keep their own email in hand.
  const renamed = await t.send('/admin/api/me', { name: 'Bob B.' }, member.cookie, 'PATCH');
  assert.equal(renamed.status, 200);
  const own = await t.send('/admin/api/me', { email: 'boss@acme.test' }, admin, 'PATCH');
  assert.equal(own.status, 200);
});

test('a model name cannot run as a spreadsheet formula in the CSV export', async () => {
  const t = await testApp();
  const admin = await t.setupAdmin();
  await t.ctx.db.insert(requestLogs).values({
    id: 'req_formula',
    format: 'openai',
    requestedModel: '=HYPERLINK("https://evil.example","open")',
    status: 404,
    result: 'blocked_model',
    trace: [],
  });
  const csv = await (await t.get('/admin/export/requests.csv', admin)).text();
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/evil\.example"",""open""\)"/);
});

test('an unknown email and a wrong password get the same answer', async () => {
  const t = await testApp();
  await t.setupAdmin();
  const login = (email: string) => t.send('/auth/login', { email, password: 'not the password' });
  const unknown = await login('nobody@acme.test');
  const wrong = await login('admin@acme.test');
  assert.equal(unknown.status, 401);
  assert.deepEqual(await json(unknown), await json(wrong));
});

test('only someone with the setup code from the logs can create the first admin', async () => {
  const t = await testApp();
  const setup = (code?: string) =>
    t.send('/auth/setup', {
      name: 'Eve',
      email: 'eve@evil.example',
      password: 'eve pass 12',
      code,
    });
  assert.equal((await setup()).status, 403);
  assert.equal((await setup('AAAA-BBBB-CCCC')).status, 403);
  assert.equal((await json(await t.get('/auth/config'))).setup, true);
  // Typed by hand: any case, without the dashes.
  assert.equal((await setup(t.ctx.setupCode.toLowerCase().replaceAll('-', ''))).status, 201);
});

test('setup codes are three groups of four easy-to-read characters', () => {
  const code = newSetupCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.notEqual(code, newSetupCode());
});
