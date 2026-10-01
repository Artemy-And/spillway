import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createApp } from '../app.ts';
import { type AppContext, RateLimiter } from '../context.ts';
import { openDb } from '../db/client.ts';
import { loadEnv } from '../env.ts';
import { Vault } from '../lib/crypto.ts';
import { SettingsStore } from '../settings.ts';
import { Oidc } from './oidc.ts';

// A small OpenID Connect provider: discovery, keys, and a token endpoint that checks PKCE and
// signs real RS256 ID tokens. The browser's trip to /authorize is played by the test itself.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
const codes = new Map<string, { email: string; nonce: string; challenge: string }>();
let issuer = '';

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(claims: Record<string, unknown>) {
  const body = `${b64({ alg: 'RS256', kid: 'test', typ: 'JWT' })}.${b64(claims)}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}

const provider = new Hono()
  .get('/.well-known/openid-configuration', (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    }),
  )
  .get('/jwks', (c) => c.json({ keys: [jwk] }))
  .post('/token', async (c) => {
    const form = await c.req.parseBody();
    const grant = codes.get(String(form.code));
    const verifier = String(form.code_verifier ?? '');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (!grant || challenge !== grant.challenge || form.client_secret !== 'shh') {
      return c.json({ error: 'invalid_grant' }, 400);
    }
    codes.delete(String(form.code));
    const now = Math.floor(Date.now() / 1000);
    return c.json({
      access_token: 'at',
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken({
        iss: issuer,
        aud: 'spillway',
        sub: grant.email,
        email: grant.email,
        email_verified: true,
        name: grant.email.split('@')[0],
        nonce: grant.nonce,
        iat: now,
        exp: now + 300,
      }),
    });
  });

let server: ReturnType<typeof serve>;
let app: ReturnType<typeof createApp>;

before(async () => {
  server = serve({ fetch: provider.fetch, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { db } = await openDb(':memory:');
  const env = loadEnv({
    PUBLIC_URL: 'http://localhost:8080',
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: 'spillway',
    OIDC_CLIENT_SECRET: 'shh',
    OIDC_ALLOWED_DOMAINS: 'company.com',
  });
  const ctx: AppContext = {
    db,
    env,
    secret: 'x'.repeat(40),
    vault: new Vault('x'.repeat(40)),
    settings: new SettingsStore(db),
    oidc: Oidc.fromEnv(env),
    rateLimiter: new RateLimiter(),
    publicDir: null,
  };
  app = createApp(ctx);
});

after(() => server.close());

/** The named cookie a response sets, as a Cookie header value. */
const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split(';')[0] ?? '';

/** Starts a sign-in, lets the provider "approve" it for `email`, and returns the callback. */
async function signIn(email: string, tamper = false) {
  const start = await app.request('/auth/oidc/start');
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location')!);
  assert.equal(authorize.origin + authorize.pathname, `${issuer}/authorize`);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    authorize.searchParams.get('redirect_uri'),
    'http://localhost:8080/auth/oidc/callback',
  );
  const code = `code-${email}`;
  codes.set(code, {
    email,
    nonce: authorize.searchParams.get('nonce')!,
    challenge: authorize.searchParams.get('code_challenge')!,
  });
  const state = tamper ? 'forged' : authorize.searchParams.get('state')!;
  return app.request(`/auth/oidc/callback?code=${code}&state=${state}`, {
    headers: { cookie: cookieOf(start, 'spillway_oidc') },
  });
}

async function me(res: Response) {
  const cookie = cookieOf(res, 'spillway_session');
  const reply = await app.request('/admin/api/me', { headers: { cookie } });
  return (await reply.json()) as { user: { email: string; role: string } };
}

test('the first person to sign in with SSO on an empty gateway becomes the admin', async () => {
  const res = await signIn('boss@company.com');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const { user } = await me(res);
  assert.equal(user.email, 'boss@company.com');
  assert.equal(user.role, 'admin');
});

test('people from an allowed domain join as members', async () => {
  const { user } = await me(await signIn('anna@company.com'));
  assert.equal(user.role, 'member');
});

test('other domains are turned away', async () => {
  const res = await signIn('mallory@elsewhere.com');
  assert.match(res.headers.get('location') ?? '', /^\/login\?error=.*has%20no%20access/);
});

test('a callback whose state does not match is refused', async () => {
  const res = await signIn('anna@company.com', true);
  assert.match(res.headers.get('location') ?? '', /^\/login\?error=/);
  assert.equal(cookieOf(res, 'spillway_session'), '');
});
