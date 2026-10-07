// Shared setup for tests: an app on an in-memory database, and signed-in people.
import { createApp } from './app.ts';
import { type AppContext, RateLimiter } from './context.ts';
import { openDb } from './db/client.ts';
import { loadEnv } from './env.ts';
import { Vault } from './lib/crypto.ts';
import { SettingsStore } from './settings.ts';

export async function testApp(env: Record<string, string> = {}) {
  const { db } = await openDb(':memory:');
  const ctx: AppContext = {
    db,
    env: loadEnv({ PUBLIC_URL: 'http://localhost:8080', ...env }),
    secret: 'x'.repeat(40),
    vault: new Vault('x'.repeat(40)),
    settings: new SettingsStore(db),
    oidc: null,
    rateLimiter: new RateLimiter(),
    setupCode: 'TEST-SETUP-CODE',
    publicDir: null,
  };
  const app = createApp(ctx);

  const send = (path: string, body?: unknown, cookie = '', method = 'POST') =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const get = (path: string, cookie = '') => app.request(path, { headers: { cookie } });
  const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';

  /** Creates the first admin and returns their session cookie. */
  const setupAdmin = async () =>
    cookieOf(
      await send('/auth/setup', {
        name: 'Admin',
        email: 'admin@acme.test',
        password: 'admin pass 1',
        code: ctx.setupCode,
      }),
    );

  /** Adds a member through an invite link and returns their id and session cookie. */
  const addMember = async (admin: string, email: string, teamId: string | null = null) => {
    const added = (await (await send('/admin/api/users', { email, teamId }, admin)).json()) as {
      id: string;
      invite: { token: string };
    };
    const accepted = await send(`/auth/invite/${added.invite.token}`, {
      name: email.split('@')[0],
      password: 'member pass 1',
    });
    return { id: added.id, cookie: cookieOf(accepted) };
  };

  return { ctx, app, send, get, setupAdmin, addMember };
}

// biome-ignore lint/suspicious/noExplicitAny: tests assert on response fields directly
export const json = (res: Response): Promise<any> => res.json();
