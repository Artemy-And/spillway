import { and, desc, eq, gte, inArray, isNull, lt, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { apiKeys, requestLogs, teams } from '../db/schema.ts';
import { daysAgo, startOfDay, startOfMonth, startOfNextMonth } from '../lib/time.ts';

export type Period = '7d' | '30d' | 'month';

const DAY = 86_400_000;

export function periodStart(period: Period, now = new Date()): Date {
  if (period === '7d') return daysAgo(6, now);
  if (period === '30d') return daysAgo(29, now);
  return startOfMonth(now);
}

const BLOCKED = ['blocked_pii', 'blocked_budget', 'blocked_model', 'rate_limited'] as const;
const sum = (expr: SQL) => sql<number>`coalesce(sum(${expr}), 0)`;
const day = sql<string>`date(${requestLogs.createdAt} / 1000, 'unixepoch', 'localtime')`;

/** Spend per key for today and this month. */
export async function keySpend(db: Db, keyIds: string[] | null, now = new Date()) {
  const rows = await db
    .select({
      keyId: requestLogs.keyId,
      today: sum(
        sql`case when ${requestLogs.createdAt} >= ${startOfDay(now).getTime()} then ${requestLogs.costUsd} end`,
      ),
      month: sum(sql`${requestLogs.costUsd}`),
      requests: sql<number>`count(*)`,
    })
    .from(requestLogs)
    .where(
      and(
        gte(requestLogs.createdAt, startOfMonth(now)),
        keyIds ? inArray(requestLogs.keyId, keyIds) : undefined,
      ),
    )
    .groupBy(requestLogs.keyId)
    .all();
  return new Map(rows.map((row) => [row.keyId, row]));
}

export async function teamSpend(db: Db, now = new Date()) {
  const rows = await db
    .select({ teamId: requestLogs.teamId, month: sum(sql`${requestLogs.costUsd}`) })
    .from(requestLogs)
    .where(gte(requestLogs.createdAt, startOfMonth(now)))
    .groupBy(requestLogs.teamId)
    .all();
  return new Map(rows.map((row) => [row.teamId, row.month]));
}

/** Everything the Overview screen shows. `keyIds` narrows it to one person's keys. */
export async function overview(db: Db, period: Period, keyIds: string[] | null, now = new Date()) {
  const since = periodStart(period, now);
  const previousSince = new Date(since.getTime() - (now.getTime() - since.getTime()));
  const scope = keyIds ? inArray(requestLogs.keyId, keyIds) : undefined;
  const inPeriod = and(gte(requestLogs.createdAt, since), scope);

  const totals = await db
    .select({
      spend: sum(sql`${requestLogs.costUsd}`),
      saved: sum(sql`${requestLogs.savedUsd}`),
      requests: sql<number>`count(*)`,
      local: sum(
        sql`case when ${requestLogs.servedLocal} and ${requestLogs.status} = 200 then 1 else 0 end`,
      ),
      blocked: sum(sql`case when ${inArray(requestLogs.result, [...BLOCKED])} then 1 else 0 end`),
      blockedPii: sum(sql`case when ${requestLogs.result} = 'blocked_pii' then 1 else 0 end`),
    })
    .from(requestLogs)
    .where(inPeriod)
    .get();

  const previous = await db
    .select({ requests: sql<number>`count(*)` })
    .from(requestLogs)
    .where(and(gte(requestLogs.createdAt, previousSince), lt(requestLogs.createdAt, since), scope))
    .get();

  const activeKeys = await db
    .select({ kind: apiKeys.kind, count: sql<number>`count(distinct ${apiKeys.id})` })
    .from(requestLogs)
    .innerJoin(apiKeys, eq(requestLogs.keyId, apiKeys.id))
    .where(inPeriod)
    .groupBy(apiKeys.kind)
    .all();

  const dailyRows = await db
    .select({
      day,
      cloud: sum(
        sql`case when not ${requestLogs.servedLocal} and ${requestLogs.servedModelId} is not null then 1 else 0 end`,
      ),
      local: sum(sql`case when ${requestLogs.servedLocal} then 1 else 0 end`),
    })
    .from(requestLogs)
    .where(and(gte(requestLogs.createdAt, daysAgo(13, now)), scope))
    .groupBy(day)
    .all();
  const byDay = new Map(dailyRows.map((row) => [row.day, row]));
  const daily = Array.from({ length: 14 }, (_, i) => {
    const date = daysAgo(13 - i, now);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const row = byDay.get(key);
    return { date: key, cloud: row?.cloud ?? 0, local: row?.local ?? 0 };
  });

  const spenders = await db
    .select({
      keyId: apiKeys.id,
      name: apiKeys.name,
      kind: apiKeys.kind,
      team: teams.name,
      requests: sql<number>`count(*)`,
      spend: sum(sql`${requestLogs.costUsd}`),
    })
    .from(requestLogs)
    .innerJoin(apiKeys, eq(requestLogs.keyId, apiKeys.id))
    .leftJoin(teams, eq(apiKeys.teamId, teams.id))
    .where(inPeriod)
    .groupBy(apiKeys.id)
    .orderBy(desc(sql`sum(${requestLogs.costUsd})`), desc(sql`count(*)`))
    .limit(5)
    .all();

  const byModel = await db
    .select({
      model: requestLogs.servedModel,
      local: requestLogs.servedLocal,
      requests: sql<number>`count(*)`,
      spend: sum(sql`${requestLogs.costUsd}`),
    })
    .from(requestLogs)
    .where(and(inPeriod, sql`${requestLogs.servedModel} is not null`))
    .groupBy(requestLogs.servedModel, requestLogs.servedLocal)
    .orderBy(desc(sql`sum(${requestLogs.costUsd})`))
    .all();

  const budget = keyIds
    ? null
    : await db
        .select({ total: sql<number | null>`sum(${teams.monthlyBudgetUsd})` })
        .from(teams)
        .get();

  return {
    period,
    since: since.toISOString(),
    resetsAt: startOfNextMonth(now).toISOString(),
    spend: totals?.spend ?? 0,
    saved: totals?.saved ?? 0,
    budget: budget?.total ?? null,
    requests: totals?.requests ?? 0,
    previousRequests: previous?.requests ?? 0,
    local: totals?.local ?? 0,
    blocked: totals?.blocked ?? 0,
    blockedPii: totals?.blockedPii ?? 0,
    activeKeys: Object.fromEntries(activeKeys.map((row) => [row.kind, row.count])) as Record<
      string,
      number
    >,
    daily,
    spenders,
    models: byModel.filter((row) => !row.local).slice(0, 5),
    localModels: byModel.filter((row) => row.local),
    alerts: await alerts(db, keyIds, now),
  };
}

type Alert = { tone: 'warn' | 'block' | 'muted'; text: string; meta: string; at: number };

async function alerts(db: Db, keyIds: string[] | null, now: Date): Promise<Alert[]> {
  const out: Alert[] = [];
  const keyScope = keyIds ? inArray(apiKeys.id, keyIds) : undefined;

  const keys = await db
    .select({ key: apiKeys, team: teams.name })
    .from(apiKeys)
    .leftJoin(teams, eq(apiKeys.teamId, teams.id))
    .where(and(isNull(apiKeys.revokedAt), keyScope))
    .all();
  const spend = await keySpend(db, keyIds, now);

  for (const { key, team } of keys) {
    const today = spend.get(key.id)?.today ?? 0;
    if (key.dailyLimitUsd && today >= key.dailyLimitUsd * 0.8) {
      const percent = Math.round((today / key.dailyLimitUsd) * 100);
      out.push({
        tone: percent >= 100 ? 'block' : 'warn',
        text: `${key.name} is at ${percent}% of its $${key.dailyLimitUsd} daily limit`,
        meta: team ?? 'No team',
        at: now.getTime(),
      });
    }
    const lastUsed = key.lastUsedAt ?? key.createdAt;
    if (now.getTime() - lastUsed.getTime() > 30 * DAY) {
      out.push({
        tone: 'muted',
        text: `Key ${key.name} has not been used for ${Math.floor((now.getTime() - lastUsed.getTime()) / DAY)} days`,
        meta: 'Consider revoking it',
        at: 0,
      });
    }
  }

  const piiBlocks = await db
    .select({
      name: apiKeys.name,
      count: sql<number>`count(*)`,
      last: sql<number>`max(${requestLogs.createdAt})`,
    })
    .from(requestLogs)
    .innerJoin(apiKeys, eq(requestLogs.keyId, apiKeys.id))
    .where(
      and(
        eq(requestLogs.result, 'blocked_pii'),
        gte(requestLogs.createdAt, new Date(now.getTime() - DAY)),
        keyIds ? inArray(requestLogs.keyId, keyIds) : undefined,
      ),
    )
    .groupBy(apiKeys.id)
    .all();
  for (const row of piiBlocks) {
    out.push({
      tone: 'block',
      text: `${row.count} prompt${row.count === 1 ? '' : 's'} to cloud models blocked: sensitive data found`,
      meta: row.name,
      at: row.last,
    });
  }

  if (!keyIds) {
    const spentByTeam = await teamSpend(db, now);
    for (const team of await db.select().from(teams).all()) {
      const spent = spentByTeam.get(team.id) ?? 0;
      if (team.monthlyBudgetUsd != null && spent >= team.monthlyBudgetUsd) {
        out.push({
          tone: 'block',
          text: `${team.name} is over its monthly budget; requests go to local models`,
          meta: `$${spent.toFixed(2)} of $${team.monthlyBudgetUsd}`,
          at: now.getTime(),
        });
      }
    }
  }

  const rank = { block: 0, warn: 1, muted: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone] || b.at - a.at).slice(0, 5);
}
