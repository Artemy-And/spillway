import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { models, providers, routingProfiles } from '../db/schema.ts';
import type { Format } from '../gateway/handler.ts';
import type { Caller, Target } from '../gateway/policy.ts';
import { sha256 } from '../lib/crypto.ts';
import type { ModelFingerprint, RoutingSkipReason } from './types.ts';

export function fingerprint(target: Target): ModelFingerprint {
  return {
    name: target.model.name,
    providerId: target.provider.id,
    providerKind: target.provider.kind,
    providerUrlHash: sha256(target.provider.baseUrl),
    upstreamModel: target.model.upstreamModel,
    isLocal: target.provider.isLocal,
    inputPrice: target.model.inputPrice,
    outputPrice: target.model.outputPrice,
    cacheReadPrice: target.model.cacheReadPrice,
  };
}

export function matchesFingerprint(target: Target, saved: ModelFingerprint): boolean {
  const current = fingerprint(target);
  return (Object.keys(current) as (keyof ModelFingerprint)[]).every(
    (key) => current[key] === saved[key],
  );
}

export async function routingTarget(ctx: AppContext, id: string): Promise<Target | null> {
  return (
    (await ctx.db
      .select({ model: models, provider: providers })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(and(eq(models.id, id), eq(models.enabled, true)))
      .get()) ?? null
  );
}

export function allowed(caller: Caller, modelId: string): boolean {
  return (
    (!caller.key.allowedModelIds || caller.key.allowedModelIds.includes(modelId)) &&
    (!caller.team?.allowedModelIds || caller.team.allowedModelIds.includes(modelId))
  );
}

function textParts(value: unknown, kinds: string[]): boolean {
  if (typeof value === 'string') return true;
  return (
    Array.isArray(value) &&
    value.every((part: unknown) => {
      if (!part || typeof part !== 'object') return false;
      const block = part as Record<string, unknown>;
      return (
        kinds.includes(String(block.type)) &&
        typeof block.text === 'string' &&
        Object.keys(block).every((key) => key === 'type' || key === 'text')
      );
    })
  );
}

/** Only the text capabilities exercised by comparisons are eligible for automatic routing. */
export function supportsProfileRequest(format: Format, body: Record<string, unknown>): boolean {
  const common = ['model', 'stream', 'temperature', 'top_p'];
  const fields: Record<Format, string[]> = {
    openai: ['messages', 'max_tokens', 'stop', 'stream_options', 'n'],
    anthropic: ['messages', 'system', 'max_tokens', 'stop_sequences'],
    responses: ['input', 'instructions', 'max_output_tokens', 'store'],
    'ollama-chat': ['messages'],
    'ollama-generate': ['prompt', 'system'],
  };
  if (Object.keys(body).some((field) => !common.includes(field) && !fields[format].includes(field)))
    return false;
  if (body.n !== undefined && body.n !== 1) return false;
  if (format === 'responses') {
    if (body.store === true) return false;
    if (typeof body.input === 'string') return true;
    return (
      Array.isArray(body.input) &&
      body.input.every((value: unknown) => {
        if (!value || typeof value !== 'object') return false;
        const item = value as Record<string, unknown>;
        return (
          (item.type === undefined || item.type === 'message') &&
          Object.keys(item).every((key) => ['type', 'role', 'content'].includes(key)) &&
          ['system', 'developer', 'user', 'assistant'].includes(String(item.role)) &&
          textParts(item.content, ['input_text', 'output_text'])
        );
      })
    );
  }
  if (format === 'ollama-generate')
    return (
      typeof body.prompt === 'string' &&
      (body.system === undefined || typeof body.system === 'string')
    );
  if (format === 'anthropic' && body.system !== undefined && !textParts(body.system, ['text']))
    return false;
  return (
    Array.isArray(body.messages) &&
    body.messages.every((value: unknown) => {
      if (!value || typeof value !== 'object') return false;
      const message = value as Record<string, unknown>;
      return (
        ['system', 'developer', 'user', 'assistant'].includes(String(message.role)) &&
        Object.keys(message).every((key) => key === 'role' || key === 'content') &&
        textParts(message.content, ['text'])
      );
    })
  );
}

export async function chooseProfile(
  ctx: AppContext,
  caller: Caller,
  baseline: Target,
  body: Record<string, unknown>,
  format: Format,
) {
  const profile = await ctx.db.query.routingProfiles.findFirst({
    where: and(
      eq(routingProfiles.keyId, caller.key.id),
      eq(routingProfiles.baselineModelId, baseline.model.id),
      eq(routingProfiles.enabled, true),
    ),
  });
  if (!profile) return null;
  let reason: RoutingSkipReason | null = null;
  let target: Target | null = null;
  if (!supportsProfileRequest(format, body)) reason = 'unsupported';
  else if (!allowed(caller, profile.candidateModelId)) reason = 'permission';
  else {
    target = await routingTarget(ctx, profile.candidateModelId);
    if (!target) reason = 'unavailable';
    else if (
      !matchesFingerprint(baseline, profile.evidence.baseline) ||
      !matchesFingerprint(target, profile.evidence.candidate)
    )
      reason = 'changed';
  }
  return { profile, target: reason ? null : target, reason };
}
