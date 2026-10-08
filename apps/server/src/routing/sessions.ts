import { and, eq, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { apiKeys, models, routingProfiles, routingSessions } from '../db/schema.ts';
import type { Format } from '../gateway/handler.ts';
import { type Caller, findModel } from '../gateway/policy.ts';
import { sha256 } from '../lib/crypto.ts';
import {
  allowed,
  chooseProfile,
  fingerprint,
  matchesFingerprint,
  routingTarget,
} from './resolve.ts';
import { sessionContract } from './tool-contract.ts';

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
  const contract = format === 'openai' ? sessionContract(body) : null;
  if (!contract)
    throw new RoutingSessionError(
      'Session routing supports Chat function calls with parallel_tool_calls:false',
      400,
    );
  const id = sha256(`${caller.key.id}\0${token}`);
  let row = await ctx.db.query.routingSessions.findFirst({ where: eq(routingSessions.id, id) });
  const baseline = await findModel(ctx.db, eq(models.name, body.model as string));
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
    const target = choice?.target ?? baseline;
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
  if (row.requestedModelId !== baseline.model.id || row.contractHash !== contract.hash)
    throw new RoutingSessionError(
      'The requested model or tool definitions changed within this session',
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
      profile.candidateModelId !== target.model.id ||
      profile.baselineModelId !== baseline.model.id ||
      !profile.evidence.toolContracts?.includes(contract.hash) ||
      !matchesFingerprint(baseline, profile.evidence.baseline) ||
      !matchesFingerprint(target, profile.evidence.candidate))
  )
    throw new RoutingSessionError('The session routing profile was disabled, removed or changed');
  return { row, target, profile: profile ?? null };
}

export async function forgetRoutingSessions(ctx: AppContext) {
  // Keep expired IDs briefly so the caller receives an explicit expiry response.
  await ctx.db
    .delete(routingSessions)
    .where(lt(routingSessions.expiresAt, new Date(Date.now() - 7 * 86_400_000)));
}
