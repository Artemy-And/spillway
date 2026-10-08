import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { comparisonRunner } from '../comparison/runner.ts';
import type { ComparisonModel } from '../comparison/types.ts';
import type { AppContext } from '../context.ts';
import { apiKeys, requestLogs, routingProfiles } from '../db/schema.ts';
import { callerForKey } from '../gateway/handler.ts';
import type { Target } from '../gateway/policy.ts';
import { maskPii } from '../lib/pii.ts';
import { calendarOf } from '../settings.ts';
import { allowed, fingerprint, matchesFingerprint, routingTarget } from './resolve.ts';
import type { RoutingEvidence } from './types.ts';

export class RoutingError extends Error {}

export interface ProfileInput {
  name: string;
  keyId: string;
  comparisonId: string;
  baselineModelId: string;
  candidateModelId: string;
  fallbackOnError: boolean;
}

function matchesReport(target: Target, saved: ComparisonModel): boolean {
  return (
    target.model.id === saved.id &&
    target.model.name === saved.name &&
    target.model.providerId === saved.providerId &&
    target.model.upstreamModel === saved.upstreamModel &&
    target.provider.isLocal === saved.isLocal &&
    target.model.inputPrice === saved.inputPrice &&
    target.model.outputPrice === saved.outputPrice &&
    target.provider.kind === saved.providerKind &&
    fingerprint(target).providerUrlHash === saved.providerUrlHash &&
    target.model.cacheReadPrice === saved.cacheReadPrice
  );
}

export async function createProfile(ctx: AppContext, input: ProfileInput, createdBy: string) {
  const report = await comparisonRunner(ctx).get(input.comparisonId);
  if (report?.status !== 'completed') throw new RoutingError('Choose a completed comparison');
  if (input.baselineModelId === input.candidateModelId)
    throw new RoutingError('Choose different baseline and candidate models');
  const baselineSaved = report.models.find((model) => model.id === input.baselineModelId);
  const candidateSaved = report.models.find((model) => model.id === input.candidateModelId);
  if (!baselineSaved || !candidateSaved)
    throw new RoutingError('Choose models from this comparison');
  const baselineCells = report.cells.filter((cell) => cell.modelId === input.baselineModelId);
  const candidateCells = report.cells.filter((cell) => cell.modelId === input.candidateModelId);
  if (
    !report.cases.length ||
    baselineCells.length !== report.cases.length ||
    candidateCells.length !== report.cases.length ||
    [...baselineCells, ...candidateCells].some(
      (cell) => cell.status !== 'passed' || cell.costUsd === null,
    )
  ) {
    throw new RoutingError('Both models must pass every task with known costs');
  }
  const baselineCostUsd = baselineCells.reduce((sum, cell) => sum + cell.costUsd!, 0);
  const candidateCostUsd = candidateCells.reduce((sum, cell) => sum + cell.costUsd!, 0);
  if (candidateCostUsd >= baselineCostUsd)
    throw new RoutingError('The candidate must cost less on the tested tasks');
  const caller = await callerForKey(ctx, input.keyId);
  if (!caller) throw new RoutingError('Choose an active gateway key');
  if (!allowed(caller, input.baselineModelId) || !allowed(caller, input.candidateModelId)) {
    throw new RoutingError('The selected key must allow both models');
  }
  const baseline = await routingTarget(ctx, input.baselineModelId);
  const candidate = await routingTarget(ctx, input.candidateModelId);
  if (
    !baseline ||
    !candidate ||
    !matchesReport(baseline, baselineSaved) ||
    !matchesReport(candidate, candidateSaved)
  ) {
    throw new RoutingError('Model configuration changed; run a new comparison');
  }
  if (
    await ctx.db.query.routingProfiles.findFirst({ where: eq(routingProfiles.keyId, input.keyId) })
  ) {
    throw new RoutingError('This key already has a profile; remove it before applying a new one');
  }
  const evidence: RoutingEvidence = {
    comparisonName: report.name,
    caseCount: report.cases.length,
    baselineLabel: baselineSaved.label,
    candidateLabel: candidateSaved.label,
    baselineCostUsd,
    candidateCostUsd,
    baseline: fingerprint(baseline),
    candidate: fingerprint(candidate),
  };
  const [profile] = await ctx.db
    .insert(routingProfiles)
    .values({
      name: maskPii(input.name).text,
      keyId: input.keyId,
      comparisonId: report.id,
      baselineModelId: input.baselineModelId,
      candidateModelId: input.candidateModelId,
      fallbackOnError: input.fallbackOnError,
      evidence,
      createdBy,
    })
    .onConflictDoNothing({ target: routingProfiles.keyId })
    .returning();
  if (!profile)
    throw new RoutingError('This key already has a profile; remove it before applying a new one');
  return profile;
}

export async function updateProfile(
  ctx: AppContext,
  id: string,
  patch: { enabled?: boolean; fallbackOnError?: boolean },
) {
  const profile = await ctx.db.query.routingProfiles.findFirst({
    where: eq(routingProfiles.id, id),
  });
  if (!profile) throw new RoutingError('Routing profile not found');
  if (patch.enabled === true) {
    const caller = await callerForKey(ctx, profile.keyId);
    const baseline = await routingTarget(ctx, profile.baselineModelId);
    const candidate = await routingTarget(ctx, profile.candidateModelId);
    if (
      !caller ||
      !allowed(caller, profile.baselineModelId) ||
      !allowed(caller, profile.candidateModelId)
    ) {
      throw new RoutingError('The selected key must allow both models');
    }
    if (
      !baseline ||
      !candidate ||
      !matchesFingerprint(baseline, profile.evidence.baseline) ||
      !matchesFingerprint(candidate, profile.evidence.candidate)
    ) {
      throw new RoutingError('Model configuration changed; run a new comparison');
    }
  }
  const [updated] = await ctx.db
    .update(routingProfiles)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(routingProfiles.id, id))
    .returning();
  return updated!;
}

export async function listProfiles(ctx: AppContext) {
  const rows = await ctx.db
    .select({ profile: routingProfiles, keyName: apiKeys.name, revokedAt: apiKeys.revokedAt })
    .from(routingProfiles)
    .innerJoin(apiKeys, eq(routingProfiles.keyId, apiKeys.id))
    .orderBy(desc(routingProfiles.createdAt));
  const since = calendarOf(await ctx.settings.get()).daysAgo(29);
  const metrics = rows.length
    ? await ctx.db
        .select({
          id: requestLogs.routingProfileId,
          requests: sql<number>`count(*)`,
          selected: sql<number>`sum(case when ${requestLogs.routingOutcome} = 'selected' and ${requestLogs.status} = 200 and ${requestLogs.error} is null then 1 else 0 end)`,
          fallbacks: sql<number>`sum(case when ${requestLogs.routingOutcome} = 'fallback' then 1 else 0 end)`,
          skipped: sql<number>`sum(case when ${requestLogs.routingOutcome} = 'skipped' then 1 else 0 end)`,
          errors: sql<number>`sum(case when ${requestLogs.status} >= 400 or ${requestLogs.error} is not null then 1 else 0 end)`,
          recordedSpendUsd: sql<number>`coalesce(sum(${requestLogs.costUsd}), 0)`,
          estimatedBaselineUsd: sql<number>`coalesce(sum(${requestLogs.baselineCostUsd}), 0)`,
          estimatedSavingsUsd: sql<number>`coalesce(sum(${requestLogs.routingSavingsUsd}), 0)`,
          eligibleRequests: sql<number>`sum(case when ${requestLogs.routingSavingsUsd} is not null then 1 else 0 end)`,
          unknownCostRequests: sql<number>`sum(case when ${requestLogs.routingCostKnown} = 0 then 1 else 0 end)`,
        })
        .from(requestLogs)
        .where(
          and(
            gte(requestLogs.createdAt, since),
            inArray(
              requestLogs.routingProfileId,
              rows.map((row) => row.profile.id),
            ),
          ),
        )
        .groupBy(requestLogs.routingProfileId)
    : [];
  return rows.map(({ profile, ...key }) => ({
    ...profile,
    ...key,
    since: since.toISOString(),
    metrics: metrics.find((metric) => metric.id === profile.id) ?? {
      requests: 0,
      selected: 0,
      fallbacks: 0,
      skipped: 0,
      errors: 0,
      recordedSpendUsd: 0,
      estimatedBaselineUsd: 0,
      estimatedSavingsUsd: 0,
      eligibleRequests: 0,
      unknownCostRequests: 0,
    },
  }));
}
