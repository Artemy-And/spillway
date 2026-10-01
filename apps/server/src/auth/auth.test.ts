import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createApp } from '../app.ts';
import { type AppContext, RateLimiter } from '../context.ts';
import { openDb } from '../db/client.ts';
import { loadEnv } from '../env.ts';
import { Vault } from '../lib/crypto.ts';
import { SettingsStore } from '../settings.ts';

let app: ReturnType<typeof createApp>;

before(async () => {
  const { db } = await openDb(':memory:');
  const ctx: AppContext = {
    db,
    env: loadEnv({ PUBLIC_URL: 'http://localhost:8080' }),
    secret: 'x'.repeat(40),
    vault: new Vault('x'.repeat(40)),
    settings: new SettingsStore(db),
    oidc: null,
    rateLimiter: new RateLimiter(),
    publicDir: null,
  };
  app = createApp(ctx);
});

// biome-ignore lint/suspicious/noExplicitAny: tests assert on response fields directly
const json = (res: Response): Promise<any> => res.json();

const send = (path: string, body: unknown, cookie = '', method = 'POST') =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';

let cookie = '';

test('a fresh gateway asks for the first account', async () => {
  assert.equal((await json(await app.request('/auth/config'))).setup, true);
  const res = await send('/auth/setup', {
    name: 'Artemy',
    email: 'Me@Company.com',
    password: 'correct horse',
  });
  assert.equal(res.status, 201);
  cookie = cookieOf(res);
  const me = await json(await app.request('/admin/api/me', { headers: { cookie } }));
  assert.equal(me.user.email, 'me@company.com');
  assert.equal(me.user.role, 'admin');
  assert.equal(me.user.welcomed, false);
});

test('setup runs only once', async () => {
  assert.equal((await json(await app.request('/auth/config'))).setup, false);
  const res = await send('/auth/setup', {
    name: 'X',
    email: 'x@example.com',
    password: '12345678',
  });
  assert.equal(res.status, 409);
});

test('the welcome tour and checklist are remembered per person', async () => {
  await send('/admin/api/me', { welcomed: true, checklistHidden: true }, cookie, 'PATCH');
  const me = await json(await app.request('/admin/api/me', { headers: { cookie } }));
  assert.equal(me.user.welcomed, true);
  assert.equal(me.user.checklistHidden, true);
});

test('changing the password needs the current one and signs out other sessions', async () => {
  const wrong = await send(
    '/admin/api/me/password',
    { current: 'nope', password: 'new pass 1' },
    cookie,
  );
  assert.equal(wrong.status, 400);
  const ok = await send(
    '/admin/api/me/password',
    { current: 'correct horse', password: 'new pass 1' },
    cookie,
  );
  assert.equal(ok.status, 200);
  assert.equal((await app.request('/admin/api/me', { headers: { cookie } })).status, 401);
  const login = await send('/auth/login', { email: 'me@company.com', password: 'new pass 1' });
  assert.equal(login.status, 200);
});
