import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
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
  const text = value instanceof Date ? value.toISOString() : String(value ?? '');
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
  app.use('/auth/*', secureHeaders());
  app.use('/admin/*', secureHeaders());
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
    console.error(error);
    return c.json({ error: 'Internal error' }, 500);
  });

  return app;
}
