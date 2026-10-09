import { and, eq, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { apiKeys, models, routingProfiles, routingSessions } from '../db/schema.ts';
import type { Format } from '../gateway/handler.ts';
import { type Caller, findModel } from '../gateway/policy.ts';
import { speaksResponses } from '../gateway/upstream.ts';
import { sha256 } from '../lib/crypto.ts';
import { aliasTarget } from './aliases.ts';
import { nativeContextRequested, sessionContractFor } from './native-contract.ts';
import {
  allowed,
  chooseProfile,
  fingerprint,
  matchesFingerprint,
  routingTarget,
} from './resolve.ts';

export class RoutingSessionError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

/** First writer wins in SQLite, including across processes. A later turn never makes a new choice. */
export async function resolveSession(
  ctx: AppContext,
  caller: Caller,
  body: Record<string, unknown>,
  format: Format,
  token: string,
) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token))
    throw new RoutingSessionError(
      'Use a random session ID of 16–128 letters, digits, underscores or hyphens',
      400,
    );
  const contract = sessionContractFor(format, body);
  if (!contract)
    throw new RoutingSessionError(
      'Session routing requires supported Chat, Responses or Messages function calls with parallel tools disabled and bounded output',
      400,
    );
  const id = sha256(`${caller.key.id}\0${token}`);
  const nativeFormat = nativeContextRequested(format, body)
    ? (format as 'responses' | 'anthropic')
    : null;
  let row = await ctx.db.query.routingSessions.findFirst({ where: eq(routingSessions.id, id) });
  const selector = body.model as string;
  const baseline = row
    ? await routingTarget(ctx, row.requestedModelId)
    : ((await aliasTarget(ctx, caller, selector, id)) ??
      (await findModel(ctx.db, eq(models.name, selector))));
  if (!baseline || !allowed(caller, baseline.model.id))
    throw new RoutingSessionError(
      'The requested session model is unavailable or no longer allowed',
      403,
    );
  const now = new Date();
  if (!row) {
    if (!contract.initial)
      throw new RoutingSessionError('Start a new session before assistant or tool history exists');
    const choice = await chooseProfile(ctx, caller, baseline, body, format, contract.hash);
    const bucket = choice
      ? (Number.parseInt(sha256(`${id}\0${choice.profile.id}`).slice(0, 8), 16) / 0x1_0000_0000) *
        100
      : 100;
    const target =
      choice?.target && bucket < choice.profile.rolloutPercent ? choice.target : baseline;
    if (
      nativeContextRequested(format, body) &&
      ((format === 'responses' && !speaksResponses(target.provider)) ||
        (format === 'anthropic' && target.provider.kind !== 'anthropic'))
    )
      throw new RoutingSessionError(
        'Native context requires a provider speaking the same API; start with a compatible model',
        400,
      );
    // Bound the metadata per key without evicting active sessions or racing concurrent inserts.
    await ctx.db
      .insert(routingSessions)
      .select(
        ctx.db
          .select({
            id: sql<string>`${id}`.as('id'),
            keyId: apiKeys.id,
            profileId: sql<string | null>`${choice?.target ? choice.profile.id : null}`.as(
              'profile_id',
            ),
            requestedModelId: sql<string>`${baseline.model.id}`.as('requested_model_id'),
            selector: sql<string>`${selector}`.as('selector'),
            targetModelId: sql<string>`${target.model.id}`.as('target_model_id'),
            contractHash: sql<string>`${contract.hash}`.as('contract_hash'),
            baseline: sql<
              typeof routingSessions.$inferSelect.baseline
            >`${JSON.stringify(fingerprint(baseline))}`.as('baseline'),
            target: sql<
              typeof routingSessions.$inferSelect.target
            >`${JSON.stringify(fingerprint(target))}`.as('target'),
            createdAt: sql<Date>`${now.getTime()}`.as('created_at'),
            expiresAt: sql<Date>`${now.getTime() + 86_400_000}`.as('expires_at'),
            nativeFormat: sql<string | null>`${nativeFormat}`.as('native_format'),
          })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.id, caller.key.id),
              sql`(select count(*) from routing_sessions s where s.key_id = ${caller.key.id} and s.expires_at > ${now.getTime()}) < 1000`,
            ),
          ),
      )
      .onConflictDoNothing({ target: routingSessions.id });
    row = await ctx.db.query.routingSessions.findFirst({ where: eq(routingSessions.id, id) });
    if (!row) throw new RoutingSessionError('Too many active sessions for this key', 429);
  }
  if (row.expiresAt <= now)
    throw new RoutingSessionError(
      'Session expired; start a fresh conversation with a new session ID',
      410,
    );
  if (
    (row.selector ?? baseline.model.name) !== selector ||
    row.requestedModelId !== baseline.model.id ||
    row.contractHash !== contract.hash ||
    row.nativeFormat !== nativeFormat
  )
    throw new RoutingSessionError(
      'The requested model, tool definitions or native context mode changed within this session',
    );
  const target = await routingTarget(ctx, row.targetModelId);
  if (
    !target ||
    !matchesFingerprint(baseline, row.baseline) ||
    !matchesFingerprint(target, row.target)
  )
    throw new RoutingSessionError(
      'Session model configuration changed; start a fresh evaluated session',
    );
  if (!allowed(caller, target.model.id))
    throw new RoutingSessionError(
      'The pinned model is no longer allowed for this key or team',
      403,
    );
  const profile = row.profileId
    ? await ctx.db.query.routingProfiles.findFirst({ where: eq(routingProfiles.id, row.profileId) })
    : null;
  if (
    row.profileId &&
    (!profile?.enabled ||
      profile.keyId !== caller.key.id ||
      profile.evidence.mode !== 'tools' ||
      (profile.candidateModelId !== target.model.id &&
        profile.baselineModelId !== target.model.id) ||
      profile.baselineModelId !== baseline.model.id ||
      !profile.evidence.toolContracts?.includes(contract.hash) ||
      !matchesFingerprint(baseline, profile.evidence.baseline) ||
      !matchesFingerprint(
        target,
        target.model.id === profile.candidateModelId
          ? profile.evidence.candidate
          : profile.evidence.baseline,
      ))
  )
    throw new RoutingSessionError('The session routing profile was disabled, removed or changed');
  return { row, target, baseline, profile: profile ?? null };
}

export async function forgetRoutingSessions(ctx: AppContext) {
  // Keep expired IDs briefly so the caller receives an explicit expiry response.
  await ctx.db
    .delete(routingSessions)
    .where(lt(routingSessions.expiresAt, new Date(Date.now() - 7 * 86_400_000)));
}
