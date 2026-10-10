import { and, desc, eq, gte, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { apiKeys, models, providers, requestLogs, teams } from '../db/schema.ts';
import type { Calendar } from '../lib/time.ts';

export type Period = '7d' | '30d' | 'month';

const DAY = 86_400_000;

export function periodStart(period: Period, cal: Calendar, now = new Date()): Date {
  if (period === '7d') return cal.daysAgo(6, now);
  if (period === '30d') return cal.daysAgo(29, now);
  return cal.startOfMonth(now);
}

const BLOCKED = ['blocked_pii', 'blocked_budget', 'blocked_model', 'rate_limited'] as const;
const sum = (expr: SQL) => sql<number>`coalesce(sum(${expr}), 0)`;
/** Quarter hours: days are cut in JavaScript, in the gateway's zone, half-hour offsets included. */
const QUARTER = 900_000;
// A literal, not a parameter: node:sqlite binds numbers as REAL, and dividing by a REAL gave
// every log row its own group instead of one per quarter hour.
const quarter = sql<number>`${requestLogs.createdAt} / ${sql.raw(String(QUARTER))}`;

/** Spend per key for today and this month. */
export async function keySpend(db: Db, keyIds: string[] | null, cal: Calendar, now = new Date()) {
  const rows = await db
    .select({
      keyId: requestLogs.keyId,
      today: sum(
        sql`case when ${requestLogs.createdAt} >= ${cal.startOfDay(now).getTime()} then ${requestLogs.costUsd} end`,
      ),
      month: sum(sql`${requestLogs.costUsd}`),
      requests: sql<number>`count(*)`,
    })
    .from(requestLogs)
    .where(
      and(
        gte(requestLogs.createdAt, cal.startOfMonth(now)),
        keyIds ? inArray(requestLogs.keyId, keyIds) : undefined,
      ),
    )
    .groupBy(requestLogs.keyId)
    .all();
  return new Map(rows.map((row) => [row.keyId, row]));
}

export async function teamSpend(db: Db, cal: Calendar, now = new Date()) {
  const rows = await db
    .select({ teamId: requestLogs.teamId, month: sum(sql`${requestLogs.costUsd}`) })
    .from(requestLogs)
    .where(gte(requestLogs.createdAt, cal.startOfMonth(now)))
    .groupBy(requestLogs.teamId)
    .all();
  return new Map(rows.map((row) => [row.teamId, row.month]));
}

/** Everything the Overview screen shows. `keyIds` narrows it to one person's keys. */
/** How far back the sidebar looks when it asks whether providers are answering. */
const STATUS_WINDOW_MS = 10 * 60_000;

/**
 * Providers whose most recent request in the last ten minutes failed: an outage, a timeout or a
 * rate limit, whether or not the local model covered for it. One success clears it.
 */
export async function failingProviders(db: Db, now = new Date()) {
  const failed = sql`(${requestLogs.ruleId} = 'outage' or (${requestLogs.result} = 'error' and (${requestLogs.status} >= 500 or ${requestLogs.status} = 429)))`;
  const rows = await db
    .select({
      provider: providers.name,
      last: sql<number>`max(${requestLogs.createdAt})`,
      lastFailure: sql<number | null>`max(case when ${failed} then ${requestLogs.createdAt} end)`,
    })
    .from(requestLogs)
    .innerJoin(models, eq(requestLogs.requestedModelId, models.id))
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(gte(requestLogs.createdAt, new Date(now.getTime() - STATUS_WINDOW_MS)))
    .groupBy(providers.id)
    .all();
  return rows
    .filter((row) => row.lastFailure !== null && row.lastFailure === row.last)
    .map((row) => row.provider);
}

export async function overview(
  db: Db,
  period: Period,
  keyIds: string[] | null,
  cal: Calendar,
  now = new Date(),
) {
  const since = periodStart(period, cal, now);
  const previousSince = new Date(since.getTime() - (now.getTime() - since.getTime()));
  const scope = keyIds ? inArray(requestLogs.keyId, keyIds) : undefined;
  const inPeriod = and(gte(requestLogs.createdAt, since), scope);

  const totals = await db
    .select({
      spend: sum(sql`${requestLogs.costUsd}`),
      // What local models saved, and apart from it what answers from the cache saved
      saved: sum(
        sql`case when ${requestLogs.ruleId} = 'cache' then 0 else ${requestLogs.savedUsd} end`,
      ),
      savedCache: sum(
        sql`case when ${requestLogs.ruleId} = 'cache' then ${requestLogs.savedUsd} else 0 end`,
      ),
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

  // People are counted by key owner; a person key without an owner is a shared key.
  const activeRows = await db
    .select({
      kind: apiKeys.kind,
      keys: sql<number>`count(distinct ${apiKeys.id})`,
      owners: sql<number>`count(distinct ${apiKeys.userId})`,
      unowned: sql<number>`count(distinct case when ${apiKeys.userId} is null then ${apiKeys.id} end)`,
    })
    .from(requestLogs)
    .innerJoin(apiKeys, eq(requestLogs.keyId, apiKeys.id))
    .where(inPeriod)
    .groupBy(apiKeys.kind)
    .all();
  const byKind = (kind: string) => activeRows.find((row) => row.kind === kind);
  const activity = {
    keys: activeRows.reduce((total, row) => total + row.keys, 0),
    people: byKind('person')?.owners ?? 0,
    sharedKeys: byKind('person')?.unowned ?? 0,
    devices: byKind('device')?.keys ?? 0,
    agents: byKind('agent')?.keys ?? 0,
  };

  const quarterRows = await db
    .select({
      quarter,
      cloud: sum(
        sql`case when not ${requestLogs.servedLocal} and ${requestLogs.servedModelId} is not null then 1 else 0 end`,
      ),
      local: sum(sql`case when ${requestLogs.servedLocal} then 1 else 0 end`),
    })
    .from(requestLogs)
    .where(and(gte(requestLogs.createdAt, cal.daysAgo(13, now)), scope))
    .groupBy(quarter)
    .all();
  const byDay = new Map<string, { cloud: number; local: number }>();
  for (const row of quarterRows) {
    const key = cal.dayKey(new Date(row.quarter * QUARTER));
    const total = byDay.get(key) ?? { cloud: 0, local: 0 };
    byDay.set(key, { cloud: total.cloud + row.cloud, local: total.local + row.local });
  }
  const daily = Array.from({ length: 14 }, (_, i) => {
    const key = cal.dayKey(cal.daysAgo(13 - i, now));
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
    resetsAt: cal.startOfNextMonth(now).toISOString(),
    timeZone: cal.zone,
    spend: totals?.spend ?? 0,
    saved: totals?.saved ?? 0,
    savedCache: totals?.savedCache ?? 0,
    budget: budget?.total ?? null,
    requests: totals?.requests ?? 0,
    previousRequests: previous?.requests ?? 0,
    local: totals?.local ?? 0,
    blocked: totals?.blocked ?? 0,
    blockedPii: totals?.blockedPii ?? 0,
    activity,
    daily,
    spenders,
    models: byModel.filter((row) => !row.local).slice(0, 5),
    localModels: byModel.filter((row) => row.local),
    alerts: await alerts(db, keyIds, cal, now),
  };
}

/** Alerts carry a code and params; the admin UI turns them into text in the viewer's language. */
type Alert =
  | {
      tone: 'warn' | 'block';
      code: 'keyLimit';
      key: string;
      percent: number;
      limit: number;
      team: string | null;
      at: number;
    }
  | { tone: 'muted'; code: 'keyUnused'; key: string; days: number; at: number }
  | { tone: 'block'; code: 'piiBlocked'; key: string; count: number; at: number }
  | {
      tone: 'block';
      code: 'teamOverBudget';
      team: string;
      spent: number;
      budget: number;
      at: number;
    }
  | {
      tone: 'warn' | 'block';
      code: 'providerFailing';
      provider: string;
      failed: number;
      rescued: number;
      error: string | null;
      at: number;
    }
  | { tone: 'warn'; code: 'modelNoPrice'; models: string[]; at: number }
  | { tone: 'warn'; code: 'promptCut'; model: string; count: number; at: number };

async function alerts(db: Db, keyIds: string[] | null, cal: Calendar, now: Date): Promise<Alert[]> {
  const out: Alert[] = [];
  const keyScope = keyIds ? inArray(apiKeys.id, keyIds) : undefined;
  const lastDay = new Date(now.getTime() - DAY);

  const keys = await db
    .select({ key: apiKeys, team: teams.name })
    .from(apiKeys)
    .leftJoin(teams, eq(apiKeys.teamId, teams.id))
    .where(and(isNull(apiKeys.revokedAt), keyScope))
    .all();
  const spend = await keySpend(db, keyIds, cal, now);

  for (const { key, team } of keys) {
    const today = spend.get(key.id)?.today ?? 0;
    if (key.dailyLimitUsd && today >= key.dailyLimitUsd * 0.8) {
      const percent = Math.round((today / key.dailyLimitUsd) * 100);
      out.push({
        tone: percent >= 100 ? 'block' : 'warn',
        code: 'keyLimit',
        key: key.name,
        percent,
        limit: key.dailyLimitUsd,
        team,
        at: now.getTime(),
      });
    }
    const lastUsed = key.lastUsedAt ?? key.createdAt;
    if (now.getTime() - lastUsed.getTime() > 30 * DAY) {
      out.push({
        tone: 'muted',
        code: 'keyUnused',
        key: key.name,
        days: Math.floor((now.getTime() - lastUsed.getTime()) / DAY),
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
        gte(requestLogs.createdAt, lastDay),
        keyIds ? inArray(requestLogs.keyId, keyIds) : undefined,
      ),
    )
    .groupBy(apiKeys.id)
    .all();
  for (const row of piiBlocks) {
    out.push({ tone: 'block', code: 'piiBlocked', key: row.name, count: row.count, at: row.last });
  }

  // Cloud providers that failed in the last day: plain errors, and failovers to the local model.
  // Both rows point at the cloud model that was asked for, which leads to the failing provider.
  const failures = await db
    .select({
      provider: providers.name,
      failed: sql<number>`sum(case when ${requestLogs.result} = 'error' then 1 else 0 end)`,
      rescued: sql<number>`sum(case when ${requestLogs.ruleId} = 'outage' then 1 else 0 end)`,
      last: sql<number>`max(${requestLogs.createdAt})`,
      error: sql<
        string | null
      >`(select r.error from request_logs r join models m on m.id = r.requested_model_id where m.provider_id = ${providers.id} and r.error is not null order by r.created_at desc limit 1)`,
    })
    .from(requestLogs)
    .innerJoin(models, eq(requestLogs.requestedModelId, models.id))
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(
      and(
        gte(requestLogs.createdAt, lastDay),
        sql`(${requestLogs.result} = 'error' or ${requestLogs.ruleId} = 'outage')`,
        keyIds ? inArray(requestLogs.keyId, keyIds) : undefined,
      ),
    )
    .groupBy(providers.id)
    .all();
  for (const row of failures) {
    out.push({
      tone: row.failed > 0 ? 'block' : 'warn',
      code: 'providerFailing',
      provider: row.provider,
      failed: row.failed,
      rescued: row.rescued,
      error: row.error,
      at: row.last,
    });
  }

  if (!keyIds) {
    // A cloud model without a price counts as free, so budgets never see what it costs.
    const unpriced = await db
      .select({ name: models.name })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.enabled, true),
          eq(providers.isLocal, false),
          or(isNull(models.inputPrice), isNull(models.outputPrice)),
        ),
      )
      .orderBy(models.name)
      .all();
    if (unpriced.length) {
      out.push({
        tone: 'warn',
        code: 'modelNoPrice',
        models: unpriced.map((row) => row.name),
        at: now.getTime(),
      });
    }

    // Ollama dropped the start of long prompts because its context is too small (the gateway
    // marks such requests with a promptCut step); rerouted agents then lose their instructions.
    // The unary + keeps SQLite on the last day of logs: without it, SQLite builds a temporary
    // index over the whole log on every call to start from the few models instead.
    const cuts = await db
      .select({
        model: sql<string>`coalesce(${models.label}, ${models.name})`,
        count: sql<number>`count(*)`,
        last: sql<number>`max(${requestLogs.createdAt})`,
      })
      .from(requestLogs)
      .innerJoin(models, sql`+${requestLogs.servedModelId} = ${models.id}`)
      .where(
        and(
          gte(requestLogs.createdAt, lastDay),
          sql`+${requestLogs.servedLocal} = 1`,
          sql`exists (select 1 from json_each(${requestLogs.trace}) where json_extract(value, '$.code') = 'promptCut')`,
        ),
      )
      .groupBy(models.id)
      .all();
    for (const row of cuts) {
      out.push({
        tone: 'warn',
        code: 'promptCut',
        model: row.model,
        count: row.count,
        at: row.last,
      });
    }

    const spentByTeam = await teamSpend(db, cal, now);
    for (const team of await db.select().from(teams).all()) {
      const spent = spentByTeam.get(team.id) ?? 0;
      if (team.monthlyBudgetUsd != null && spent >= team.monthlyBudgetUsd) {
        out.push({
          tone: 'block',
          code: 'teamOverBudget',
          team: team.name,
          spent,
          budget: team.monthlyBudgetUsd,
          at: now.getTime(),
        });
      }
    }
  }

  const rank = { block: 0, warn: 1, muted: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone] || b.at - a.at).slice(0, 5);
}
