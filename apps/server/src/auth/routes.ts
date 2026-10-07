import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { invites, sessions, users } from '../db/schema.ts';
import { hashPassword, sameCode, verifyPassword } from '../lib/crypto.ts';
import { isTimeZone } from '../lib/time.ts';
import { findInvite } from './invites.ts';
import type { OidcChecks } from './oidc.ts';
import { endSession, startSession } from './session.ts';

const INVALID_INVITE = 'This invite link is invalid or has expired';

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

function recordFailure(email: string, count: number) {
  const now = Date.now();
  // Guesses at made-up emails would otherwise pile up here forever.
  if (failures.size > 10_000) {
    for (const [key, entry] of failures) if (entry.until < now) failures.delete(key);
  }
  failures.set(email, { count, until: now + LOCK_MS });
}

/** Checked against when the email is unknown, so the answer takes as long as for a real one. */
let decoy: Promise<string> | null = null;

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
          /** From the setup link the server prints to its logs */
          code: z.string().max(64).optional(),
          /** The admin's browser zone, so budgets reset on the team's midnight from day one */
          timeZone: z.string().optional(),
        }),
      ),
      async (c) => {
        if (!(await needsSetup(ctx))) {
          return c.json({ error: 'Spillway is already set up. Sign in instead.' }, 409);
        }
        const { name, email, password, timeZone, code } = c.req.valid('json');
        if (!sameCode(code, ctx.setupCode)) {
          return c.json(
            { error: 'Wrong setup code. Spillway prints the setup link in its logs.' },
            403,
          );
        }
        const [user] = await ctx.db
          .insert(users)
          .values({ email, name, role: 'admin', passwordHash: await hashPassword(password) })
          .returning();
        if (timeZone && isTimeZone(timeZone) && !(await ctx.settings.get()).timeZone) {
          await ctx.settings.update({ timeZone });
        }
        await startSession(ctx, c, user!);
        return c.json({ ok: true }, 201);
      },
    )

    .get('/invite/:token', async (c) => {
      const user = await findInvite(ctx.db, c.req.param('token'));
      if (!user) return c.json({ error: INVALID_INVITE }, 404);
      return c.json({ email: user.email, name: user.name, hasPassword: !!user.passwordHash });
    })

    .post(
      '/invite/:token',
      zValidator(
        'json',
        z.object({ name: z.string().trim().min(1).max(128), password: passwordSchema }),
      ),
      async (c) => {
        const user = await findInvite(ctx.db, c.req.param('token'));
        if (!user) return c.json({ error: INVALID_INVITE }, 404);
        const { name, password } = c.req.valid('json');
        await ctx.db
          .update(users)
          .set({ name, passwordHash: await hashPassword(password) })
          .where(eq(users.id, user.id));
        // The link is single-use, and an old password stops working everywhere.
        await ctx.db.delete(invites).where(eq(invites.userId, user.id));
        await ctx.db.delete(sessions).where(eq(sessions.userId, user.id));
        await startSession(ctx, c, user);
        return c.json({ ok: true });
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
        decoy ??= hashPassword('decoy password');
        const matches = await verifyPassword(password, user?.passwordHash ?? (await decoy));
        const ok = matches && !!user?.passwordHash && !user.disabledAt;
        if (!ok || !user) {
          recordFailure(email, (record?.count ?? 0) + 1);
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
        // Like the setup page: on an empty gateway the first person in becomes the admin.
        const first = await needsSetup(ctx);
        [user] = await ctx.db
          .insert(users)
          .values({ email, name, role: isAdmin || first ? 'admin' : 'member' })
          .returning();
      }
      if (!user || user.disabledAt) return c.redirect(loginError('This account is disabled'));
      if (!user.name && name) await ctx.db.update(users).set({ name }).where(eq(users.id, user.id));
      await startSession(ctx, c, user);
      return c.redirect('/');
    });
}
