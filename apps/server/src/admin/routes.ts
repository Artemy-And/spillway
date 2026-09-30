import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthEnv, adminOnly, requireUser } from '../auth/session.ts';
import { type AppContext, VERSION } from '../context.ts';
import {
  apiKeys,
  KEY_KINDS,
  models,
  PROVIDER_KINDS,
  providers,
  RESULTS,
  ROLES,
  requestLogs,
  teams,
  type User,
  users,
} from '../db/schema.ts';
import { DEFAULT_BASE_URLS, listUpstreamModels } from '../gateway/upstream.ts';
import { newGatewayKey } from '../lib/crypto.ts';
import { startOfMonth, startOfNextMonth } from '../lib/time.ts';
import { RULE_IDS, rulesSchema, settingsSchema } from '../settings.ts';
import { keySpend, overview, type Period, teamSpend } from './stats.ts';

const money = z.number().min(0).max(1_000_000).nullable();
const idList = z.array(z.string()).nullable();

const keyInput = z.object({
  name: z.string().trim().min(1).max(64),
  kind: z.enum(KEY_KINDS),
  userId: z.string().nullable().optional(),
  teamId: z.string().nullable().optional(),
  dailyLimitUsd: money.optional(),
  monthlyLimitUsd: money.optional(),
  fallbackToLocal: z.boolean().optional(),
  allowedModelIds: idList.optional(),
});

const teamInput = z.object({
  name: z.string().trim().min(1).max(64),
  monthlyBudgetUsd: money.optional(),
  allowedModelIds: idList.optional(),
});

const providerInput = z.object({
  name: z.string().trim().min(1).max(64),
  kind: z.enum(PROVIDER_KINDS),
  baseUrl: z.url().optional(),
  apiKey: z.string().trim().optional(),
  isLocal: z.boolean().optional(),
});

const modelInput = z.object({
  providerId: z.string(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[\w.:/@-]+$/, 'Use letters, digits and . : / @ - _'),
  label: z.string().trim().max(64).nullable().optional(),
  upstreamModel: z.string().trim().min(1).max(256),
  inputPrice: z.number().min(0).max(10_000).optional(),
  outputPrice: z.number().min(0).max(10_000).optional(),
  enabled: z.boolean().optional(),
});

const idParam = zValidator('param', z.object({ id: z.string() }));

/** null = everything (admins); otherwise the ids of the person's own keys. */
async function ownKeyIds(ctx: AppContext, user: User): Promise<string[] | null> {
  if (user.role === 'admin') return null;
  const rows = await ctx.db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.userId, user.id))
    .all();
  return rows.map((row) => row.id);
}

export function adminRoutes(ctx: AppContext) {
  const { db } = ctx;

  return (
    new Hono<AuthEnv>()
      .use(requireUser(ctx))

      .get('/me', async (c) => {
        const user = c.get('user');
        const counts = await db
          .select({
            providers: sql<number>`count(*)`,
            local: sql<number>`coalesce(sum(${providers.isLocal}), 0)`,
          })
          .from(providers)
          .get();
        return c.json({
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            teamId: user.teamId,
          },
          gateway: {
            host: new URL(ctx.env.PUBLIC_URL).host,
            version: VERSION,
            providers: counts?.providers ?? 0,
            localProviders: counts?.local ?? 0,
          },
        });
      })

      .get(
        '/overview',
        zValidator('query', z.object({ period: z.enum(['7d', '30d', 'month']).default('month') })),
        async (c) => {
          const keyIds = await ownKeyIds(ctx, c.get('user'));
          return c.json(await overview(db, c.req.valid('query').period as Period, keyIds));
        },
      )

      // ── Keys ────────────────────────────────────────────────────────────────
      .get('/keys', async (c) => {
        const keyIds = await ownKeyIds(ctx, c.get('user'));
        const rows = await db
          .select({ key: apiKeys, owner: users.name, ownerEmail: users.email, team: teams.name })
          .from(apiKeys)
          .leftJoin(users, eq(apiKeys.userId, users.id))
          .leftJoin(teams, eq(apiKeys.teamId, teams.id))
          .where(keyIds ? inArray(apiKeys.id, keyIds) : undefined)
          .orderBy(
            sql`${apiKeys.revokedAt} is not null`,
            desc(apiKeys.lastUsedAt),
            desc(apiKeys.createdAt),
          )
          .all();
        const spend = await keySpend(db, keyIds);
        return c.json(
          rows.map(({ key, owner, ownerEmail, team }) => {
            const { hash: _hash, ...safe } = key;
            const usage = spend.get(key.id);
            return {
              ...safe,
              owner: owner ?? ownerEmail ?? null,
              team,
              spentToday: usage?.today ?? 0,
              spentMonth: usage?.month ?? 0,
              requestsMonth: usage?.requests ?? 0,
            };
          }),
        );
      })

      .post('/keys', zValidator('json', keyInput), async (c) => {
        const user = c.get('user');
        const input = c.req.valid('json');
        const isAdmin = user.role === 'admin';
        // People manage their own keys; limits and ownership are for admins.
        const values = isAdmin
          ? { ...input, userId: input.userId ?? null, teamId: input.teamId ?? null }
          : { name: input.name, kind: input.kind, userId: user.id, teamId: user.teamId };
        if (isAdmin && values.userId && values.teamId === null) {
          const owner = await db.query.users.findFirst({ where: eq(users.id, values.userId) });
          values.teamId = owner?.teamId ?? null;
        }
        const { key, prefix, hash } = newGatewayKey();
        const [created] = await db
          .insert(apiKeys)
          .values({ ...values, prefix, hash })
          .returning({ id: apiKeys.id });
        return c.json({ id: created!.id, key }, 201);
      })

      .patch('/keys/:id', adminOnly, idParam, zValidator('json', keyInput.partial()), async (c) => {
        await db
          .update(apiKeys)
          .set(c.req.valid('json'))
          .where(eq(apiKeys.id, c.req.valid('param').id));
        return c.json({ ok: true });
      })

      .post('/keys/:id/revoke', idParam, async (c) => {
        const user = c.get('user');
        const { id } = c.req.valid('param');
        const owned = user.role === 'admin' ? undefined : eq(apiKeys.userId, user.id);
        await db
          .update(apiKeys)
          .set({ revokedAt: new Date() })
          .where(and(eq(apiKeys.id, id), owned));
        return c.json({ ok: true });
      })

      // ── Teams, budgets and rules ────────────────────────────────────────────
      .get('/teams', async (c) => {
        const now = new Date();
        const rows = await db.select().from(teams).orderBy(teams.name).all();
        const spend = await teamSpend(db, now);
        const keyCounts = await db
          .select({ teamId: apiKeys.teamId, count: sql<number>`count(*)` })
          .from(apiKeys)
          .where(isNull(apiKeys.revokedAt))
          .groupBy(apiKeys.teamId)
          .all();
        const monthStart = startOfMonth(now).getTime();
        const monthLength = startOfNextMonth(now).getTime() - monthStart;
        const elapsed = Math.max(now.getTime() - monthStart, 3_600_000);
        return c.json(
          rows.map((team) => {
            const spent = spend.get(team.id) ?? 0;
            return {
              ...team,
              spentMonth: spent,
              forecast: (spent / elapsed) * monthLength,
              keys: keyCounts.find((row) => row.teamId === team.id)?.count ?? 0,
            };
          }),
        );
      })

      .post('/teams', adminOnly, zValidator('json', teamInput), async (c) => {
        const [team] = await db.insert(teams).values(c.req.valid('json')).returning();
        return c.json(team!, 201);
      })

      .patch(
        '/teams/:id',
        adminOnly,
        idParam,
        zValidator('json', teamInput.partial()),
        async (c) => {
          await db
            .update(teams)
            .set(c.req.valid('json'))
            .where(eq(teams.id, c.req.valid('param').id));
          return c.json({ ok: true });
        },
      )

      .delete('/teams/:id', adminOnly, idParam, async (c) => {
        await db.delete(teams).where(eq(teams.id, c.req.valid('param').id));
        return c.json({ ok: true });
      })

      .get('/rules', async (c) => {
        const settings = await ctx.settings.get();
        const hits = await db
          .select({ ruleId: requestLogs.ruleId, count: sql<number>`count(*)` })
          .from(requestLogs)
          .where(
            and(gte(requestLogs.createdAt, startOfMonth()), sql`${requestLogs.ruleId} is not null`),
          )
          .groupBy(requestLogs.ruleId)
          .all();
        return c.json({
          rules: settings.rules,
          order: RULE_IDS,
          hits: Object.fromEntries(hits.map((row) => [row.ruleId, row.count])) as Record<
            string,
            number
          >,
          localModelId: settings.localModelId,
        });
      })

      .put('/rules', adminOnly, zValidator('json', rulesSchema), async (c) => {
        const settings = await ctx.settings.update({ rules: c.req.valid('json') });
        return c.json(settings.rules);
      })

      // ── People ──────────────────────────────────────────────────────────────
      .get('/users', adminOnly, async (c) => {
        const rows = await db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            teamId: users.teamId,
            hasPassword: sql<boolean>`${users.passwordHash} is not null`,
            lastLoginAt: users.lastLoginAt,
            disabledAt: users.disabledAt,
          })
          .from(users)
          .orderBy(users.email)
          .all();
        return c.json(rows.map((row) => ({ ...row, hasPassword: !!row.hasPassword })));
      })

      .post(
        '/users',
        adminOnly,
        zValidator(
          'json',
          z.object({
            email: z.email().transform((email) => email.toLowerCase()),
            name: z.string().trim().max(128).nullable().optional(),
            role: z.enum(ROLES).default('member'),
            teamId: z.string().nullable().optional(),
          }),
        ),
        async (c) => {
          const [user] = await db
            .insert(users)
            .values(c.req.valid('json'))
            .onConflictDoNothing()
            .returning();
          if (!user) return c.json({ error: 'This person is already added' }, 409);
          return c.json({ id: user.id }, 201);
        },
      )

      .patch(
        '/users/:id',
        adminOnly,
        idParam,
        zValidator(
          'json',
          z.object({
            role: z.enum(ROLES).optional(),
            teamId: z.string().nullable().optional(),
            name: z.string().trim().max(128).nullable().optional(),
            disabled: z.boolean().optional(),
          }),
        ),
        async (c) => {
          const { id } = c.req.valid('param');
          const { disabled, ...rest } = c.req.valid('json');
          if (id === c.get('user').id && (disabled || rest.role === 'member')) {
            return c.json({ error: 'You cannot demote or disable yourself' }, 400);
          }
          const patch = {
            ...rest,
            ...(disabled === undefined ? {} : { disabledAt: disabled ? new Date() : null }),
          };
          await db.update(users).set(patch).where(eq(users.id, id));
          return c.json({ ok: true });
        },
      )

      // ── Providers and models ────────────────────────────────────────────────
      .get('/providers', adminOnly, async (c) => {
        const rows = await db.select().from(providers).orderBy(providers.createdAt).all();
        return c.json(
          rows.map(({ apiKeyEnc, ...provider }) => ({ ...provider, hasApiKey: !!apiKeyEnc })),
        );
      })

      .post('/providers', adminOnly, zValidator('json', providerInput), async (c) => {
        const { apiKey, ...input } = c.req.valid('json');
        const [provider] = await db
          .insert(providers)
          .values({
            ...input,
            baseUrl: input.baseUrl ?? DEFAULT_BASE_URLS[input.kind],
            isLocal: input.isLocal ?? input.kind === 'ollama',
            apiKeyEnc: apiKey ? ctx.vault.encrypt(apiKey) : null,
          })
          .returning({ id: providers.id });
        return c.json({ id: provider!.id }, 201);
      })

      .patch(
        '/providers/:id',
        adminOnly,
        idParam,
        zValidator('json', providerInput.partial()),
        async (c) => {
          const { apiKey, ...input } = c.req.valid('json');
          const patch = {
            ...input,
            ...(apiKey === undefined
              ? {}
              : { apiKeyEnc: apiKey ? ctx.vault.encrypt(apiKey) : null }),
          };
          await db
            .update(providers)
            .set(patch)
            .where(eq(providers.id, c.req.valid('param').id));
          return c.json({ ok: true });
        },
      )

      .delete('/providers/:id', adminOnly, idParam, async (c) => {
        await db.delete(providers).where(eq(providers.id, c.req.valid('param').id));
        return c.json({ ok: true });
      })

      .get('/providers/:id/available', adminOnly, idParam, async (c) => {
        const provider = await db.query.providers.findFirst({
          where: eq(providers.id, c.req.valid('param').id),
        });
        if (!provider) return c.json({ error: 'Provider not found' }, 404);
        try {
          return c.json({ models: await listUpstreamModels(ctx, provider) });
        } catch (error) {
          return c.json(
            { error: error instanceof Error ? error.message : 'Could not list models' },
            502,
          );
        }
      })

      .get('/models', async (c) => {
        const rows = await db
          .select({
            model: models,
            provider: providers.name,
            providerKind: providers.kind,
            isLocal: providers.isLocal,
          })
          .from(models)
          .innerJoin(providers, eq(models.providerId, providers.id))
          .orderBy(providers.isLocal, models.name)
          .all();
        return c.json(rows.map(({ model, ...rest }) => ({ ...model, ...rest })));
      })

      .post('/models', adminOnly, zValidator('json', modelInput), async (c) => {
        const [model] = await db
          .insert(models)
          .values(c.req.valid('json'))
          .onConflictDoNothing()
          .returning({ id: models.id });
        if (!model) return c.json({ error: 'A model with this name already exists' }, 409);
        return c.json({ id: model.id }, 201);
      })

      .patch(
        '/models/:id',
        adminOnly,
        idParam,
        zValidator('json', modelInput.partial()),
        async (c) => {
          await db
            .update(models)
            .set(c.req.valid('json'))
            .where(eq(models.id, c.req.valid('param').id));
          return c.json({ ok: true });
        },
      )

      .delete('/models/:id', adminOnly, idParam, async (c) => {
        await db.delete(models).where(eq(models.id, c.req.valid('param').id));
        return c.json({ ok: true });
      })

      // ── Request log ─────────────────────────────────────────────────────────
      .get(
        '/logs',
        zValidator(
          'query',
          z.object({
            keyId: z.string().optional(),
            model: z.string().optional(),
            result: z.enum(RESULTS).optional(),
            period: z.enum(['24h', '7d', '30d']).default('24h'),
            before: z.string().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
        ),
        async (c) => {
          const query = c.req.valid('query');
          const keyIds = await ownKeyIds(ctx, c.get('user'));
          const hours = { '24h': 24, '7d': 168, '30d': 720 }[query.period];
          const rows = await db
            .select({
              id: requestLogs.id,
              createdAt: requestLogs.createdAt,
              keyId: requestLogs.keyId,
              keyName: apiKeys.name,
              requestedModel: requestLogs.requestedModel,
              requestedLabel: models.label,
              servedModel: requestLogs.servedModel,
              result: requestLogs.result,
              status: requestLogs.status,
              inputTokens: requestLogs.inputTokens,
              outputTokens: requestLogs.outputTokens,
              costUsd: requestLogs.costUsd,
            })
            .from(requestLogs)
            .leftJoin(apiKeys, eq(requestLogs.keyId, apiKeys.id))
            .leftJoin(models, eq(requestLogs.requestedModelId, models.id))
            .where(
              and(
                gte(requestLogs.createdAt, new Date(Date.now() - hours * 3_600_000)),
                keyIds ? inArray(requestLogs.keyId, keyIds) : undefined,
                query.keyId ? eq(requestLogs.keyId, query.keyId) : undefined,
                query.model
                  ? or(
                      eq(requestLogs.requestedModel, query.model),
                      eq(requestLogs.servedModelId, query.model),
                    )
                  : undefined,
                query.result ? eq(requestLogs.result, query.result) : undefined,
                query.before ? lt(requestLogs.createdAt, new Date(query.before)) : undefined,
              ),
            )
            .orderBy(desc(requestLogs.createdAt))
            .limit(query.limit)
            .all();
          return c.json(rows);
        },
      )

      .get('/logs/:id', idParam, async (c) => {
        const keyIds = await ownKeyIds(ctx, c.get('user'));
        const row = await db
          .select({
            log: requestLogs,
            keyName: apiKeys.name,
            team: teams.name,
            requestedLabel: models.label,
          })
          .from(requestLogs)
          .leftJoin(apiKeys, eq(requestLogs.keyId, apiKeys.id))
          .leftJoin(teams, eq(requestLogs.teamId, teams.id))
          .leftJoin(models, eq(requestLogs.requestedModelId, models.id))
          .where(
            and(
              eq(requestLogs.id, c.req.valid('param').id),
              keyIds ? inArray(requestLogs.keyId, keyIds) : undefined,
            ),
          )
          .get();
        if (!row) return c.json({ error: 'Request not found' }, 404);
        const settings = await ctx.settings.get();
        return c.json({
          ...row.log,
          keyName: row.keyName,
          team: row.team,
          requestedLabel: row.requestedLabel,
          retentionDays: settings.retentionDays,
        });
      })

      // ── Settings ────────────────────────────────────────────────────────────
      .get('/settings', adminOnly, async (c) => {
        const settings = await ctx.settings.get();
        return c.json({
          storePrompts: settings.storePrompts,
          retentionDays: settings.retentionDays,
          localModelId: settings.localModelId,
          sso: ctx.oidc
            ? {
                issuer: ctx.oidc.issuer,
                allowedDomains: ctx.env.OIDC_ALLOWED_DOMAINS,
                adminEmails: ctx.env.ADMIN_EMAILS,
              }
            : null,
          publicUrl: ctx.env.PUBLIC_URL,
        });
      })

      .put(
        '/settings',
        adminOnly,
        zValidator(
          'json',
          settingsSchema
            .pick({ storePrompts: true, retentionDays: true, localModelId: true })
            .partial(),
        ),
        async (c) => {
          const settings = await ctx.settings.update(c.req.valid('json'));
          return c.json({ ok: true, localModelId: settings.localModelId });
        },
      )
  );
}
