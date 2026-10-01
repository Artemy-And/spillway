import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { users } from '../db/schema.ts';
import { hashPassword, verifyPassword } from '../lib/crypto.ts';
import type { OidcChecks } from './oidc.ts';
import { endSession, startSession } from './session.ts';

const OIDC_COOKIE = 'spillway_oidc';
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60_000;

export const passwordSchema = z.string().min(8, 'Use at least 8 characters').max(256);

/** Nobody can sign in yet: the first visitor creates the admin account, like Faved does. */
async function needsSetup(ctx: AppContext): Promise<boolean> {
  const row = await ctx.db.select({ count: sql<number>`count(*)` }).from(users).get();
  return !row?.count;
}

/** Slows down password guessing: 10 failures lock an email for 15 minutes. */
const failures = new Map<string, { count: number; until: number }>();

export function authRoutes(ctx: AppContext) {
  const loginError = (message: string) => `/login?error=${encodeURIComponent(message)}`;

  return new Hono()
    .get('/config', async (c) =>
      c.json({
        sso: ctx.oidc ? { label: ctx.oidc.label } : null,
        setup: await needsSetup(ctx),
      }),
    )

    .post(
      '/setup',
      zValidator(
        'json',
        z.object({
          name: z.string().trim().min(1).max(128),
          email: z.email().transform((email) => email.toLowerCase()),
          password: passwordSchema,
        }),
      ),
      async (c) => {
        if (!(await needsSetup(ctx))) {
          return c.json({ error: 'Spillway is already set up. Sign in instead.' }, 409);
        }
        const { name, email, password } = c.req.valid('json');
        const [user] = await ctx.db
          .insert(users)
          .values({ email, name, role: 'admin', passwordHash: await hashPassword(password) })
          .returning();
        await startSession(ctx, c, user!);
        return c.json({ ok: true }, 201);
      },
    )

    .post(
      '/login',
      zValidator(
        'json',
        z.object({ email: z.string().trim().toLowerCase(), password: z.string().min(1) }),
      ),
      async (c) => {
        const { email, password } = c.req.valid('json');
        const record = failures.get(email);
        if (record && record.count >= MAX_FAILURES && record.until > Date.now()) {
          return c.json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
        }
        const user = await ctx.db.query.users.findFirst({ where: eq(users.email, email) });
        const ok =
          !!user?.passwordHash &&
          !user.disabledAt &&
          (await verifyPassword(password, user.passwordHash));
        if (!ok || !user) {
          failures.set(email, { count: (record?.count ?? 0) + 1, until: Date.now() + LOCK_MS });
          return c.json({ error: 'Wrong email or password' }, 401);
        }
        failures.delete(email);
        await startSession(ctx, c, user);
        return c.json({ ok: true });
      },
    )

    .post('/logout', async (c) => {
      await endSession(ctx, c);
      return c.json({ ok: true });
    })

    .get('/oidc/start', async (c) => {
      if (!ctx.oidc) return c.redirect(loginError('SSO is not configured'));
      try {
        const { url, checks } = await ctx.oidc.start();
        await setSignedCookie(c, OIDC_COOKIE, JSON.stringify(checks), ctx.secret, {
          httpOnly: true,
          sameSite: 'Lax',
          secure: ctx.env.PUBLIC_URL.startsWith('https://'),
          path: '/auth/oidc',
          maxAge: 600,
        });
        return c.redirect(url);
      } catch (error) {
        console.error('SSO discovery failed', error);
        return c.redirect(loginError('Could not reach the identity provider'));
      }
    })

    .get('/oidc/callback', async (c) => {
      if (!ctx.oidc) return c.redirect(loginError('SSO is not configured'));
      const saved = await getSignedCookie(c, ctx.secret, OIDC_COOKIE);
      deleteCookie(c, OIDC_COOKIE, { path: '/auth/oidc' });
      if (!saved) return c.redirect(loginError('Sign-in expired, try again'));

      let identity: { email: string; name: string | null };
      try {
        identity = await ctx.oidc.finish(
          new URL(c.req.url).search,
          JSON.parse(saved) as OidcChecks,
        );
      } catch (error) {
        console.error('SSO callback failed', error);
        return c.redirect(loginError(error instanceof Error ? error.message : 'Sign-in failed'));
      }

      const { email, name } = identity;
      let user = await ctx.db.query.users.findFirst({ where: eq(users.email, email) });
      if (!user) {
        const domain = email.split('@')[1] ?? '';
        const isAdmin = ctx.env.ADMIN_EMAILS.includes(email);
        if (!isAdmin && !ctx.env.OIDC_ALLOWED_DOMAINS.includes(domain)) {
          return c.redirect(loginError(`${email} has no access. Ask an admin to add you.`));
        }
        [user] = await ctx.db
          .insert(users)
          .values({ email, name, role: isAdmin ? 'admin' : 'member' })
          .returning();
      }
      if (!user || user.disabledAt) return c.redirect(loginError('This account is disabled'));
      if (!user.name && name) await ctx.db.update(users).set({ name }).where(eq(users.id, user.id));
      await startSession(ctx, c, user);
      return c.redirect('/');
    });
}
