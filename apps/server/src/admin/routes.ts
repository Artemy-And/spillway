import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { createInvite } from '../auth/invites.ts';
import { passwordSchema } from '../auth/routes.ts';
import { type AuthEnv, adminOnly, requireUser } from '../auth/session.ts';
import { BudgetError, usage as budgetUsage, listHolds, reconcile } from '../budget/ledger.ts';
import { comparisonRoutes } from '../comparison/routes.ts';
import { taskSetRoutes } from '../comparison/task-set-routes.ts';
import { forgetTaskSets } from '../comparison/task-sets.ts';
import { type AppContext, SOURCE_URL, VERSION } from '../context.ts';
import {
  apiKeys,
  KEY_KINDS,
  models,
  PROVIDER_KINDS,
  providers,
  RESULTS,
  ROLES,
  requestLogs,
  responseCache,
  sessions,
  teams,
  type User,
  users,
} from '../db/schema.ts';
import { listPrice, PRICE_LIST_DATE, type Price } from '../gateway/prices.ts';
import { DEFAULT_BASE_URLS, listUpstreamModels } from '../gateway/upstream.ts';
import { hashPassword, newGatewayKey, verifyPassword } from '../lib/crypto.ts';
import { SERVER_ZONE } from '../lib/time.ts';
import { mailFrom, send } from '../notify.ts';
import { routingProfileRoutes } from '../routing/routes.ts';
import {
  calendarOf,
  notificationsPatch,
  RULE_IDS,
  rulesSchema,
  settingsPatch,
} from '../settings.ts';
import { failingProviders, keySpend, overview, type Period } from './stats.ts';

const money = z.number().min(0).max(1_000_000).nullable();
/** USD per million tokens */
const usdPerMillion = z.number().min(0).max(10_000).nullable();
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
  // null = not set: the model counts as free and is flagged until someone sets it
  inputPrice: usdPerMillion.optional(),
  outputPrice: usdPerMillion.optional(),
  cacheReadPrice: usdPerMillion.optional(),
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
            hasPassword: !!user.passwordHash,
            welcomed: !!user.welcomedAt,
            checklistHidden: !!user.checklistHiddenAt,
            /** With single sign-on, members cannot change their own email */
            emailLocked: !!ctx.oidc && user.role !== 'admin',
          },
          gateway: {
            host: new URL(ctx.env.PUBLIC_URL).host,
            version: VERSION,
            source: SOURCE_URL,
            providers: counts?.providers ?? 0,
            localProviders: counts?.local ?? 0,
            demo: ctx.env.DEMO,
          },
        });
      })

      /** Polled by the sidebar: answering at all means the gateway is up. */
      .get('/status', async (c) => c.json({ failing: await failingProviders(db) }))

      // ── Own account ─────────────────────────────────────────────────────────
      .patch(
        '/me',
        zValidator(
          'json',
          z.object({
            name: z.string().trim().min(1).max(128).optional(),
            email: z
              .email()
              .transform((email) => email.toLowerCase())
              .optional(),
            welcomed: z.boolean().optional(),
            checklistHidden: z.boolean().optional(),
          }),
        ),
        async (c) => {
          const user = c.get('user');
          const { name, email, welcomed, checklistHidden } = c.req.valid('json');
          // Single sign-on finds people by email. A member who took the address of a colleague
          // who has not signed in yet would get that colleague, and their prompts, on first SSO.
          if (email && email !== user.email && ctx.oidc && user.role !== 'admin') {
            return c.json(
              { error: 'Your email comes from single sign-on and cannot be changed here' },
              403,
            );
          }
          if (email && email !== user.email) {
            const taken = await db.query.users.findFirst({ where: eq(users.email, email) });
            if (taken) return c.json({ error: 'Someone already uses this email' }, 409);
          }
          const patch = {
            ...(name === undefined ? {} : { name }),
            ...(email === undefined ? {} : { email }),
            ...(welcomed === undefined ? {} : { welcomedAt: welcomed ? new Date() : null }),
            ...(checklistHidden === undefined
              ? {}
              : { checklistHiddenAt: checklistHidden ? new Date() : null }),
          };
          // Unknown fields (a role, say) are dropped, which can leave nothing to save.
          if (Object.keys(patch).length) {
            await db.update(users).set(patch).where(eq(users.id, user.id));
          }
          return c.json({ ok: true });
        },
      )

      .post(
        '/me/password',
        zValidator('json', z.object({ current: z.string().optional(), password: passwordSchema })),
        async (c) => {
          const user = c.get('user');
          const { current, password } = c.req.valid('json');
          // People who only ever used SSO have no password yet and may set one.
          if (
            user.passwordHash &&
            !(current && (await verifyPassword(current, user.passwordHash)))
          ) {
            return c.json({ error: 'The current password is wrong' }, 400);
          }
          await db
            .update(users)
            .set({ passwordHash: await hashPassword(password) })
            .where(eq(users.id, user.id));
          // Other browsers signed in as this person have to sign in again.
          await db.delete(sessions).where(eq(sessions.userId, user.id));
          return c.json({ ok: true });
        },
      )

      /** What the getting-started checklist ticks off, from the real state of the gateway. */
      .get('/onboarding', async (c) => {
        const user = c.get('user');
        const keyIds = await ownKeyIds(ctx, user);
        const count = async (query: Promise<{ count: number } | undefined>) =>
          (await query)?.count ?? 0;
        const settings = await ctx.settings.get();
        return c.json({
          providers: await count(db.select({ count: sql<number>`count(*)` }).from(providers).get()),
          models: await count(db.select({ count: sql<number>`count(*)` }).from(models).get()),
          localModel: settings.localModelId !== null,
          keys: await count(
            db
              .select({ count: sql<number>`count(*)` })
              .from(apiKeys)
              .where(
                and(isNull(apiKeys.revokedAt), keyIds ? inArray(apiKeys.id, keyIds) : undefined),
              )
              .get(),
          ),
          requests: await count(
            db
              .select({ count: sql<number>`count(*)` })
              .from(requestLogs)
              .where(keyIds ? inArray(requestLogs.keyId, keyIds) : undefined)
              .get(),
          ),
        });
      })

      .get(
        '/overview',
        zValidator('query', z.object({ period: z.enum(['7d', '30d', 'month']).default('month') })),
        async (c) => {
          const keyIds = await ownKeyIds(ctx, c.get('user'));
          const cal = calendarOf(await ctx.settings.get());
          return c.json(await overview(db, c.req.valid('query').period as Period, keyIds, cal));
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
        const spend = await keySpend(db, keyIds, calendarOf(await ctx.settings.get()));
        return c.json(
          await Promise.all(
            rows.map(async ({ key, owner, ownerEmail, team }) => {
              const { hash: _hash, ...safe } = key;
              const usage = spend.get(key.id);
              const cal = calendarOf(await ctx.settings.get());
              const today = await budgetUsage(db, 'key', key.id, cal.startOfDay());
              const month = await budgetUsage(db, 'key', key.id, cal.startOfMonth());
              return {
                ...safe,
                owner: owner ?? ownerEmail ?? null,
                team,
                spentToday: today.spentUsd,
                spentMonth: month.spentUsd,
                activeToday: today.activeUsd,
                activeMonth: month.activeUsd,
                uncertainToday: today.uncertainUsd,
                uncertainMonth: month.uncertainUsd,
                remainingToday:
                  key.dailyLimitUsd === null
                    ? null
                    : Math.max(0, key.dailyLimitUsd - today.committedUsd),
                remainingMonth:
                  key.monthlyLimitUsd === null
                    ? null
                    : Math.max(0, key.monthlyLimitUsd - month.committedUsd),
                requestsMonth: usage?.requests ?? 0,
              };
            }),
          ),
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
        const cal = calendarOf(await ctx.settings.get());
        const rows = await db.select().from(teams).orderBy(teams.name).all();
        const keyCounts = await db
          .select({ teamId: apiKeys.teamId, count: sql<number>`count(*)` })
          .from(apiKeys)
          .where(isNull(apiKeys.revokedAt))
          .groupBy(apiKeys.teamId)
          .all();
        const monthStart = cal.startOfMonth(now).getTime();
        const monthLength = cal.startOfNextMonth(now).getTime() - monthStart;
        const elapsed = Math.max(now.getTime() - monthStart, 3_600_000);
        return c.json(
          await Promise.all(
            rows.map(async (team) => {
              const usage = await budgetUsage(db, 'team', team.id, cal.startOfMonth(now));
              const spent = usage.spentUsd;
              return {
                ...team,
                spentMonth: spent,
                activeMonth: usage.activeUsd,
                uncertainMonth: usage.uncertainUsd,
                remainingMonth:
                  team.monthlyBudgetUsd === null
                    ? null
                    : Math.max(0, team.monthlyBudgetUsd - usage.committedUsd),
                forecast: (spent / elapsed) * monthLength,
                keys: keyCounts.find((row) => row.teamId === team.id)?.count ?? 0,
              };
            }),
          ),
        );
      })

      .post('/teams', adminOnly, zValidator('json', teamInput), async (c) => {
        const [team] = await db
          .insert(teams)
          .values(c.req.valid('json'))
          .onConflictDoNothing()
          .returning();
        if (!team) return c.json({ error: 'A team with this name already exists' }, 409);
        return c.json(team, 201);
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
            and(
              gte(requestLogs.createdAt, calendarOf(settings).startOfMonth()),
              sql`${requestLogs.ruleId} is not null`,
            ),
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
          timeZone: calendarOf(settings).zone,
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
            // Raw names: in a single-table select Drizzle leaves columns unqualified.
            invited: sql<boolean>`exists (select 1 from invites i where i.user_id = users.id and i.expires_at > ${Date.now()})`,
            lastLoginAt: users.lastLoginAt,
            disabledAt: users.disabledAt,
          })
          .from(users)
          .orderBy(users.email)
          .all();
        return c.json(
          rows.map((row) => ({ ...row, hasPassword: !!row.hasPassword, invited: !!row.invited })),
        );
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
          // Without SSO the link is the only way in, so every new person gets one.
          return c.json({ id: user.id, invite: await createInvite(db, user.id) }, 201);
        },
      )

      .post('/users/:id/invite', adminOnly, idParam, async (c) => {
        const { id } = c.req.valid('param');
        const user = await db.query.users.findFirst({ where: eq(users.id, id) });
        if (!user) return c.json({ error: 'Person not found' }, 404);
        if (user.disabledAt) return c.json({ error: 'This account is disabled' }, 400);
        return c.json(await createInvite(db, id));
      })

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
        // `baseUrl: null` resets it to the kind's default; `apiKey: ''` drops the saved key.
        zValidator(
          'json',
          providerInput.partial().extend({ baseUrl: z.url().nullable().optional() }),
        ),
        async (c) => {
          const { id } = c.req.valid('param');
          const { apiKey, baseUrl, ...input } = c.req.valid('json');
          const provider = await db.query.providers.findFirst({ where: eq(providers.id, id) });
          if (!provider) return c.json({ error: 'Provider not found' }, 404);
          const patch = {
            ...input,
            ...(baseUrl === undefined
              ? {}
              : { baseUrl: baseUrl ?? DEFAULT_BASE_URLS[input.kind ?? provider.kind] }),
            ...(apiKey === undefined
              ? {}
              : { apiKeyEnc: apiKey ? ctx.vault.encrypt(apiKey) : null }),
          };
          await db.update(providers).set(patch).where(eq(providers.id, id));
          return c.json({ ok: true });
        },
      )

      .delete('/providers/:id', adminOnly, idParam, async (c) => {
        await db.delete(providers).where(eq(providers.id, c.req.valid('param').id));
        return c.json({ ok: true });
      })

      .get('/provider-defaults', adminOnly, (c) => c.json(DEFAULT_BASE_URLS))

      .get('/providers/:id/available', adminOnly, idParam, async (c) => {
        const provider = await db.query.providers.findFirst({
          where: eq(providers.id, c.req.valid('param').id),
        });
        if (!provider) return c.json({ error: 'Provider not found' }, 404);
        try {
          const listed = await listUpstreamModels(ctx, provider);
          // Prices the provider publishes beat the built-in list; local models cost nothing.
          const prices: Record<string, Price> = {};
          if (!provider.isLocal) {
            for (const model of listed) {
              const known = model.price ?? listPrice(model.id);
              if (known) prices[model.id] = known;
            }
          }
          return c.json({ models: listed.map((model) => model.id), prices });
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
        return c.json(
          rows.map(({ model, ...rest }) => ({
            ...model,
            ...rest,
            /** Offered when a cloud model has no price yet */
            listPrice: rest.isLocal ? null : listPrice(model.upstreamModel),
          })),
        );
      })

      .get('/price-list', adminOnly, (c) => c.json({ date: PRICE_LIST_DATE }))

      .post('/models', adminOnly, zValidator('json', modelInput), async (c) => {
        const input = c.req.valid('json');
        const provider = await db.query.providers.findFirst({
          where: eq(providers.id, input.providerId),
        });
        if (!provider) return c.json({ error: 'Provider not found' }, 404);
        // No price given: a cloud model on the list gets its list price, so budgets count it.
        const known =
          provider.isLocal || input.inputPrice !== undefined || input.outputPrice !== undefined
            ? null
            : listPrice(input.upstreamModel);
        const [model] = await db
          .insert(models)
          .values({
            ...input,
            ...(known
              ? {
                  inputPrice: known.input,
                  outputPrice: known.output,
                  cacheReadPrice: known.cacheRead,
                }
              : {}),
          })
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
          const { id } = c.req.valid('param');
          const input = c.req.valid('json');
          if (input.name) {
            const taken = await db.query.models.findFirst({
              where: and(eq(models.name, input.name), ne(models.id, id)),
            });
            if (taken) return c.json({ error: 'A model with this name already exists' }, 409);
          }
          await db.update(models).set(input).where(eq(models.id, id));
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
                // A model shows up both where it was asked for and where it answered.
                query.model
                  ? or(
                      eq(requestLogs.requestedModel, query.model),
                      inArray(
                        requestLogs.servedModelId,
                        db
                          .select({ id: models.id })
                          .from(models)
                          .where(eq(models.name, query.model)),
                      ),
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
          timeZone: settings.timeZone,
          /** Used while no zone is chosen: TZ of the container */
          serverZone: SERVER_ZONE,
          storePrompts: settings.storePrompts,
          retentionDays: settings.retentionDays,
          localModelId: settings.localModelId,
          rerouteOnFailure: settings.rerouteOnFailure,
          cache: settings.cache,
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

      .put('/settings', adminOnly, zValidator('json', settingsPatch), async (c) => {
        const settings = await ctx.settings.update(c.req.valid('json'));
        await forgetTaskSets(ctx);
        return c.json({ ok: true, localModelId: settings.localModelId });
      })

      // ── Notifications ───────────────────────────────────────────────────────
      // Webhook URLs are secrets: they go in, but only "set or not" comes back out.
      .get('/notifications', adminOnly, async (c) => {
        const { slackUrl, teamsUrl, ...rest } = (await ctx.settings.get()).notifications;
        return c.json({
          ...rest,
          slack: slackUrl !== null,
          teams: teamsUrl !== null,
          /** Email needs SMTP_URL in the environment */
          mailFrom: ctx.env.SMTP_URL ? mailFrom(ctx) : null,
        });
      })

      .put('/notifications', adminOnly, zValidator('json', notificationsPatch), async (c) => {
        const { slackUrl, teamsUrl, ...rest } = c.req.valid('json');
        const saved = (await ctx.settings.get()).notifications;
        const seal = (url: string | null | undefined, current: string | null) =>
          url === undefined ? current : url ? ctx.vault.encrypt(url) : null;
        await ctx.settings.update({
          notifications: {
            ...saved,
            ...rest,
            slackUrl: seal(slackUrl, saved.slackUrl),
            teamsUrl: seal(teamsUrl, saved.teamsUrl),
          },
        });
        return c.json({ ok: true });
      })

      .post('/notifications/test', adminOnly, async (c) => {
        const deliveries = await send(ctx, {
          title: 'Test from Spillway',
          lines: [
            'Alerts about budgets, provider outages and the Monday summary will arrive here.',
          ],
          path: '/settings',
        });
        return c.json({ deliveries });
      })

      // ── Response cache ──────────────────────────────────────────────────────
      .get('/cache', adminOnly, async (c) => {
        const row = await db
          .select({
            entries: sql<number>`count(*)`,
            hits: sql<number>`coalesce(sum(${responseCache.hits}), 0)`,
          })
          .from(responseCache)
          .where(gt(responseCache.expiresAt, new Date()))
          .get();
        return c.json({ entries: row?.entries ?? 0, hits: row?.hits ?? 0 });
      })

      .delete('/cache', adminOnly, async (c) => {
        await db.delete(responseCache);
        return c.json({ ok: true });
      })
      .route('/comparisons', comparisonRoutes(ctx))
      .route('/task-sets', taskSetRoutes(ctx))
      .route('/routing-profiles', routingProfileRoutes(ctx))
      .get('/budget-holds', async (c) =>
        c.json(await listHolds(db, await ownKeyIds(ctx, c.get('user')))),
      )
      .patch(
        '/budget-holds/:id',
        adminOnly,
        idParam,
        zValidator('json', z.object({ chargedUsd: z.number().min(0).max(1_000_000) })),
        async (c) => {
          try {
            return c.json(
              await reconcile(ctx, c.req.valid('param').id, c.req.valid('json').chargedUsd),
            );
          } catch (error) {
            if (error instanceof BudgetError) return c.json({ error: error.message }, 409);
            throw error;
          }
        },
      )
  );
}
