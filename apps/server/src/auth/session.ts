import { and, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { AppContext } from '../context.ts';
import { sessions, type User, users } from '../db/schema.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';

export type AuthEnv = { Variables: { user: User } };

const COOKIE = 'gatehouse_session';
const TTL_MS = 7 * 86_400_000;

const secure = (ctx: AppContext) => ctx.env.PUBLIC_URL.startsWith('https://');

export async function startSession(ctx: AppContext, c: Context, user: User): Promise<void> {
  const token = randomToken();
  await ctx.db.insert(sessions).values({
    id: sha256(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  await ctx.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: secure(ctx),
    path: '/',
    maxAge: TTL_MS / 1000,
  });
}

export async function endSession(ctx: AppContext, c: Context): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await ctx.db.delete(sessions).where(eq(sessions.id, sha256(token)));
  deleteCookie(c, COOKIE, { path: '/', secure: secure(ctx) });
}

export function requireUser(ctx: AppContext) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const token = getCookie(c, COOKIE);
    const row = token
      ? await ctx.db
          .select({ user: users })
          .from(sessions)
          .innerJoin(users, eq(sessions.userId, users.id))
          .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
          .get()
      : undefined;
    if (!row || row.user.disabledAt) return c.json({ error: 'Sign in to continue' }, 401);
    c.set('user', row.user);
    await next();
  });
}

export const adminOnly = createMiddleware<AuthEnv>(async (c, next) => {
  if (c.get('user').role !== 'admin') return c.json({ error: 'Only admins can do this' }, 403);
  await next();
});
