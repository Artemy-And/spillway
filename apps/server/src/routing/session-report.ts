import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { apiKeys, budgetReservations, requestLogs, routingSessions } from '../db/schema.ts';

/** Retained session metadata and aggregate measurements only; no conversation content. */
export async function sessionReports(ctx: AppContext) {
  const bindings = await ctx.db
    .select({ session: routingSessions, keyName: apiKeys.name })
    .from(routingSessions)
    .innerJoin(apiKeys, eq(apiKeys.id, routingSessions.keyId))
    .orderBy(desc(routingSessions.createdAt))
    .limit(50);
  if (!bindings.length) return [];
  const ids = bindings.map(({ session }) => session.id);
  const logs = await ctx.db
    .select({
      id: requestLogs.sessionId,
      requests: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${requestLogs.status} >= 400 or ${requestLogs.error} is not null then 1 else 0 end)`,
      inputTokens: sql<number>`sum(${requestLogs.inputTokens})`,
      outputTokens: sql<number>`sum(${requestLogs.outputTokens})`,
      unknownUsage: sql<number>`sum(case when ${requestLogs.usageKnown} is not 1 then 1 else 0 end)`,
      slowRequests: sql<number>`sum(case when ${requestLogs.latencyMs} >= 5000 then 1 else 0 end)`,
      averageLatencyMs: sql<number>`avg(${requestLogs.latencyMs})`,
      maxLatencyMs: sql<number>`max(${requestLogs.latencyMs})`,
      // A raw qualifier keeps Drizzle's single-table mapper from stripping the correlated table name.
      legacyCostUsd: sql<number>`sum(case when not exists(select 1 from budget_reservations b where b.request_id = ${sql.raw('request_logs.id')}) then ${requestLogs.costUsd} else 0 end)`,
      legacyUnknown: sql<number>`sum(case when ${requestLogs.costKnown} = 0 and not exists(select 1 from budget_reservations b where b.request_id = ${sql.raw('request_logs.id')}) then 1 else 0 end)`,
    })
    .from(requestLogs)
    .where(inArray(requestLogs.sessionId, ids))
    .groupBy(requestLogs.sessionId);
  const charges = await ctx.db
    .select({
      id: budgetReservations.sessionId,
      recordedSpendUsd: sql<number>`sum(${budgetReservations.chargedUsd})`,
      activeReserveUsd: sql<number>`sum(case when ${budgetReservations.state} = 'active' then ${budgetReservations.heldUsd} else 0 end)`,
      uncertainReserveUsd: sql<number>`sum(case when ${budgetReservations.state} = 'unknown' then ${budgetReservations.heldUsd} else 0 end)`,
      activeRequests: sql<number>`sum(case when ${budgetReservations.state} = 'active' then 1 else 0 end)`,
      unknownCosts: sql<number>`sum(case when ${budgetReservations.state} = 'unknown' then 1 else 0 end)`,
    })
    .from(budgetReservations)
    .where(inArray(budgetReservations.sessionId, ids))
    .groupBy(budgetReservations.sessionId);
  return bindings.map(({ session, keyName }) => {
    const log = logs.find((row) => row.id === session.id);
    const ledger = charges.find((row) => row.id === session.id);
    return {
      id: session.id,
      keyName,
      selector: session.selector ?? session.baseline.name,
      model: session.target.name,
      profileId: session.profileId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      requests: log?.requests ?? 0,
      errors: log?.errors ?? 0,
      inputTokens: log?.inputTokens ?? 0,
      outputTokens: log?.outputTokens ?? 0,
      unknownUsage: log?.unknownUsage ?? 0,
      slowRequests: log?.slowRequests ?? 0,
      averageLatencyMs: log?.averageLatencyMs ?? 0,
      maxLatencyMs: log?.maxLatencyMs ?? 0,
      recordedSpendUsd: (ledger?.recordedSpendUsd ?? 0) + (log?.legacyCostUsd ?? 0),
      activeReserveUsd: ledger?.activeReserveUsd ?? 0,
      uncertainReserveUsd: ledger?.uncertainReserveUsd ?? 0,
      activeRequests: ledger?.activeRequests ?? 0,
      unknownCosts: (ledger?.unknownCosts ?? 0) + (log?.legacyUnknown ?? 0),
    };
  });
}
