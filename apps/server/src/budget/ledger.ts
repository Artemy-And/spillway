import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import type { Db } from '../db/client.ts';
import { apiKeys, budgetReservations, requestLogs, teams, users } from '../db/schema.ts';
import type { Caller, Target } from '../gateway/policy.ts';
import type { Calendar } from '../lib/time.ts';

type Scope = 'key' | 'team';
export type Reservation = typeof budgetReservations.$inferSelect;

export const chargedSql = (requestId: string) => sql<number>`coalesce((select sum(b.charged_usd)
  from budget_reservations b where b.request_id = ${requestId}), 0)`;
export const knownSql = (
  requestId: string,
) => sql<boolean>`not exists(select 1 from budget_reservations b
  where b.request_id = ${requestId} and b.state in ('active', 'unknown'))`;

/** A single INSERT ... SELECT uses these aggregates for atomic admission across connections. */
export function spentSql(scope: Scope, id: string | SQL, since: Date): SQL<number> {
  // Explicit aliases keep Drizzle's single-table SELECT mapper from stripping correlated qualifiers.
  const ledgerId = sql.raw(scope === 'key' ? 'b.key_id' : 'b.team_id');
  const logId = sql.raw(scope === 'key' ? 'l.key_id' : 'l.team_id');
  return sql<number>`(coalesce((select sum(b.charged_usd) from budget_reservations b
    where ${ledgerId} = ${id} and b.created_at >= ${since.getTime()}), 0)
    + coalesce((select sum(l.cost_usd) from request_logs l where ${logId} = ${id}
      and l.created_at >= ${since.getTime()} and not exists
      (select 1 from budget_reservations covered where covered.request_id = l.id)), 0))`;
}

export function holdSql(
  scope: Scope,
  id: string | SQL,
  since: Date,
  state?: 'active' | 'unknown',
): SQL<number> {
  const column = sql.raw(scope === 'key' ? 'h.key_id' : 'h.team_id');
  return sql<number>`coalesce((select sum(h.held_usd) from budget_reservations h
    where ${column} = ${id} and h.created_at >= ${since.getTime()}
    ${state ? sql`and h.state = ${state}` : sql``}), 0)`;
}

export async function usage(db: Db, scope: Scope, id: string, since: Date) {
  const [row] = await db
    .select({
      spentUsd: spentSql(scope, id, since),
      activeUsd: holdSql(scope, id, since, 'active'),
      uncertainUsd: holdSql(scope, id, since, 'unknown'),
    })
    .from(scope === 'key' ? apiKeys : teams)
    .where(eq(scope === 'key' ? apiKeys.id : teams.id, id));
  const value = row ?? { spentUsd: 0, activeUsd: 0, uncertainUsd: 0 };
  return { ...value, committedUsd: value.spentUsd + value.activeUsd + value.uncertainUsd };
}

export async function reserve(
  db: Db,
  input: {
    requestId: string;
    caller: Caller;
    target: Target;
    requestedModelId: string;
    estimate: number | null;
    cal: Calendar;
    now?: Date;
  },
): Promise<Reservation | null> {
  const { caller, target, cal, estimate } = input;
  if (target.provider.isLocal) return null;
  const now = input.now ?? new Date();
  const amount = estimate ?? 0;
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invalid reservation estimate');
  const day = spentSql('key', sql`${apiKeys.id}`, cal.startOfDay(now));
  const month = spentSql('key', sql`${apiKeys.id}`, cal.startOfMonth(now));
  const team = spentSql('team', sql`${teams.id}`, cal.startOfMonth(now));
  const dayHolds = holdSql('key', sql`${apiKeys.id}`, cal.startOfDay(now));
  const monthHolds = holdSql('key', sql`${apiKeys.id}`, cal.startOfMonth(now));
  const teamHolds = holdSql('team', sql`${teams.id}`, cal.startOfMonth(now));
  const permits = (column: typeof apiKeys.allowedModelIds | typeof teams.allowedModelIds) =>
    sql`${column} is null or (exists(select 1 from json_each(${column}) where value = ${target.model.id})
      and exists(select 1 from json_each(${column}) where value = ${input.requestedModelId}))`;
  const fits = (
    limit:
      | typeof apiKeys.dailyLimitUsd
      | typeof apiKeys.monthlyLimitUsd
      | typeof teams.monthlyBudgetUsd,
    spent: SQL,
    held: SQL,
  ) =>
    sql`(${limit} is null or (${estimate !== null ? 1 : 0} = 1 and ${limit} > 0
      and ${spent} + ${held} + ${amount} <= ${limit}))`;
  const [row] = await db
    .insert(budgetReservations)
    .select(
      db
        .select({
          id: sql<string>`${crypto.randomUUID()}`.as('id'),
          requestId: sql<string>`${input.requestId}`.as('request_id'),
          keyId: apiKeys.id,
          teamId: apiKeys.teamId,
          modelName: sql<string>`${target.model.name}`.as('model_name'),
          providerName: sql<string>`${target.provider.name}`.as('provider_name'),
          state: sql<'active'>`'active'`.as('state'),
          estimatedUsd: sql<number>`${amount}`.as('estimated_usd'),
          heldUsd: sql<number>`${amount}`.as('held_usd'),
          chargedUsd: sql<number>`0`.as('charged_usd'),
          reason: sql<string | null>`null`.as('reason'),
          createdAt: sql<Date>`${now.getTime()}`.as('created_at'),
          settledAt: sql<Date | null>`null`.as('settled_at'),
        })
        .from(apiKeys)
        .leftJoin(teams, eq(apiKeys.teamId, teams.id))
        .where(
          and(
            eq(apiKeys.id, caller.key.id),
            isNull(apiKeys.revokedAt),
            sql`not exists(select 1 from ${users} where ${users.id} = ${apiKeys.userId} and ${users.disabledAt} is not null)`,
            sql`(${permits(apiKeys.allowedModelIds)})`,
            sql`(${permits(teams.allowedModelIds)})`,
            fits(apiKeys.dailyLimitUsd, day, dayHolds),
            fits(apiKeys.monthlyLimitUsd, month, monthHolds),
            fits(teams.monthlyBudgetUsd, team, teamHolds),
          ),
        ),
    )
    .returning();
  return row ?? null;
}

/** Final usage settles the estimate. Partial/unknown charges retain the unconfirmed remainder. */
export async function settle(
  db: Db,
  reservation: Reservation,
  chargedUsd: number,
  known: boolean,
  reason: string | null = null,
) {
  const charge = Number.isFinite(chargedUsd) && chargedUsd >= 0 ? chargedUsd : 0;
  await db
    .update(budgetReservations)
    .set({
      state: known ? 'settled' : 'unknown',
      chargedUsd: charge,
      heldUsd: known ? 0 : Math.max(0, reservation.estimatedUsd - charge),
      reason: known ? null : (reason ?? 'missingUsage'),
      settledAt: new Date(),
    })
    .where(
      and(
        eq(budgetReservations.id, reservation.id),
        inArray(budgetReservations.state, ['active', 'unknown']),
      ),
    );
}

export async function release(db: Db, reservation: Reservation) {
  await db
    .update(budgetReservations)
    .set({ state: 'released', heldUsd: 0, reason: null, settledAt: new Date() })
    .where(and(eq(budgetReservations.id, reservation.id), eq(budgetReservations.state, 'active')));
}

export async function attemptTotals(db: Db, requestId: string) {
  const [row] = await db
    .select({
      costUsd: sql<number>`coalesce(sum(${budgetReservations.chargedUsd}), 0)`,
      heldUsd: sql<number>`coalesce(sum(${budgetReservations.heldUsd}), 0)`,
      unknown: sql<number>`sum(case when ${budgetReservations.state} in ('active', 'unknown') then 1 else 0 end)`,
    })
    .from(budgetReservations)
    .where(eq(budgetReservations.requestId, requestId));
  return { costUsd: row?.costUsd ?? 0, heldUsd: row?.heldUsd ?? 0, known: !row?.unknown };
}

/** Startup runs before accepting traffic. Interrupted cloud calls cannot be assumed free. */
export async function recoverReservations(db: Db) {
  await db
    .update(budgetReservations)
    .set({ state: 'unknown', reason: 'restart', settledAt: new Date() })
    .where(eq(budgetReservations.state, 'active'));
}

export async function listHolds(db: Db, keyIds: string[] | null) {
  return db
    .select({
      reservation: budgetReservations,
      keyName: apiKeys.name,
      teamName: teams.name,
      logId: requestLogs.id,
    })
    .from(budgetReservations)
    .leftJoin(apiKeys, eq(budgetReservations.keyId, apiKeys.id))
    .leftJoin(teams, eq(budgetReservations.teamId, teams.id))
    .leftJoin(requestLogs, eq(budgetReservations.requestId, requestLogs.id))
    .where(
      and(
        inArray(budgetReservations.state, ['active', 'unknown']),
        keyIds ? inArray(budgetReservations.keyId, keyIds) : undefined,
      ),
    )
    .orderBy(desc(budgetReservations.createdAt))
    .limit(200);
}

export class BudgetError extends Error {}
export async function reconcile(ctx: AppContext, id: string, chargedUsd: number) {
  const [row] = await ctx.db
    .update(budgetReservations)
    .set({ state: 'settled', heldUsd: 0, chargedUsd, reason: 'reconciled', settledAt: new Date() })
    .where(and(eq(budgetReservations.id, id), eq(budgetReservations.state, 'unknown')))
    .returning();
  if (!row) throw new BudgetError('Only an uncertain charge can be reconciled');
  await ctx.db
    .update(requestLogs)
    .set({
      costUsd: chargedSql(row.requestId),
      costKnown: knownSql(row.requestId),
      routingCostKnown: sql`case when ${requestLogs.routingProfileId} is not null then ${knownSql(row.requestId)} else null end`,
      trace: sql`json_insert(${requestLogs.trace}, '$[#]', json(${JSON.stringify({ tone: 'info', text: 'Administrator confirmed the provider charge', code: 'budgetReconciled', params: { amount: chargedUsd } })}))`,
    })
    .where(eq(requestLogs.id, row.requestId));
  return row;
}
