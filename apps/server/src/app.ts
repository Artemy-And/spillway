import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { adminRoutes } from './admin/routes.ts';
import { authRoutes } from './auth/routes.ts';
import { type AuthEnv, requireUser } from './auth/session.ts';
import type { AppContext } from './context.ts';
import { apiKeys, requestLogs } from './db/schema.ts';
import { demoGuard } from './demo.ts';
import { gatewayRoutes } from './gateway/routes.ts';

/** The typed API the admin UI calls through the Hono RPC client. */
export function apiRoutes(ctx: AppContext) {
  return new Hono().route('/auth', authRoutes(ctx)).route('/admin/api', adminRoutes(ctx));
}

export type ApiType = ReturnType<typeof apiRoutes>;

const csvCell = (value: unknown) => {
  let text = value instanceof Date ? value.toISOString() : String(value ?? '');
  // A client picks the model name, and Excel runs a cell starting with = + - @ as a formula.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

function exportRoutes(ctx: AppContext) {
  return new Hono<AuthEnv>().use(requireUser(ctx)).get('/requests.csv', async (c) => {
    const user = c.get('user');
    const days = Math.min(Number(c.req.query('days') ?? 30) || 30, 366);
    const own =
      user.role === 'admin'
        ? null
        : (
            await ctx.db
              .select({ id: apiKeys.id })
              .from(apiKeys)
              .where(eq(apiKeys.userId, user.id))
              .all()
          ).map((row) => row.id);
    const rows = await ctx.db
      .select()
      .from(requestLogs)
      .where(
        and(
          gte(requestLogs.createdAt, new Date(Date.now() - days * 86_400_000)),
          own ? inArray(requestLogs.keyId, own) : undefined,
        ),
      )
      .orderBy(desc(requestLogs.createdAt))
      .all();
    const columns = [
      'id',
      'createdAt',
      'keyId',
      'teamId',
      'format',
      'requestedModel',
      'servedModel',
      'servedLocal',
      'providerName',
      'status',
      'result',
      'ruleId',
      'inputTokens',
      'outputTokens',
      'costUsd',
      'savedUsd',
      'latencyMs',
    ] as const;
    const csv = [
      columns.join(','),
      ...rows.map((row) => columns.map((col) => csvCell(row[col])).join(',')),
    ].join('\n');
    return c.body(csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="spillway-requests-${days}d.csv"`,
    });
  });
}

export function createApp(ctx: AppContext) {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));
  if (ctx.env.DEMO) app.use('*', demoGuard);
  app.route('/', gatewayRoutes(ctx));
  // The admin UI and its API: nothing from other origins, never inside another site's frame.
  app.use(
    '*',
    secureHeaders({
      xFrameOptions: 'DENY',
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );
  // The session cookie is SameSite=Lax, which still lets a sibling subdomain post forms with it,
  // and some changes (revoking a key, signing out) need no JSON body. Browsers say where a
  // request comes from; behind a reverse proxy the request URL is not the public one.
  const publicOrigin = new URL(ctx.env.PUBLIC_URL).origin;
  const sameOrigin = csrf({
    origin: (origin, c) => origin === publicOrigin || origin === new URL(c.req.url).origin,
  });
  const small = bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: 'Request body is too large' }, 413),
  });
  app.use('/auth/*', sameOrigin, small);
  app.use('/admin/*', sameOrigin, small);
  app.route('/', apiRoutes(ctx));
  app.route('/admin/export', exportRoutes(ctx));

  if (ctx.publicDir && existsSync(join(ctx.publicDir, 'index.html'))) {
    const indexHtml = readFileSync(join(ctx.publicDir, 'index.html'), 'utf8');
    app.use('/*', serveStatic({ root: ctx.publicDir }));
    // Client-side routes fall back to the SPA.
    app.get('*', (c) => c.html(indexHtml));
  } else {
    app.get('/', (c) =>
      c.text('Spillway gateway is running. The admin UI is not built; run `pnpm dev` for it.'),
    );
  }

  app.onError((error, c) => {
    // A refusal on purpose, like the CSRF check's 403, keeps its own answer.
    if (error instanceof HTTPException) return error.getResponse();
    console.error(error);
    return c.json({ error: 'Internal error' }, 500);
  });

  return app;
}
