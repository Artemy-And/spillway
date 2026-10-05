// Exact-match response cache. The same key sending the same request to the same model within the
// cache lifetime gets the stored answer, and the provider is not called or paid.
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { type Model, responseCache } from '../db/schema.ts';
import { sha256 } from '../lib/crypto.ts';

/** Fields that do not change the answer: the stream switch, client ids, Ollama's keep-alive. */
const IGNORED = new Set(['model', 'stream', 'stream_options', 'user', 'metadata', 'keep_alive']);

export function cacheKey(
  keyId: string,
  model: Model,
  format: string,
  body: Record<string, unknown>,
): string {
  const request = Object.fromEntries(Object.entries(body).filter(([name]) => !IGNORED.has(name)));
  return sha256(JSON.stringify([keyId, model.id, model.upstreamModel, format, request]));
}

/** Clients can skip the cache for one request with Cache-Control: no-cache or no-store. */
export function wantsCache(headers: Headers): boolean {
  return !/no-cache|no-store/i.test(headers.get('cache-control') ?? '');
}

export async function cached(ctx: AppContext, id: string, now = new Date()) {
  const row = await ctx.db
    .select({ body: responseCache.body, costUsd: responseCache.costUsd })
    .from(responseCache)
    .where(and(eq(responseCache.id, id), gt(responseCache.expiresAt, now)))
    .get();
  if (row) {
    await ctx.db
      .update(responseCache)
      .set({ hits: sql`${responseCache.hits} + 1` })
      .where(eq(responseCache.id, id));
  }
  return row ?? null;
}

export async function remember(
  ctx: AppContext,
  entry: { id: string; keyId: string; modelId: string; body: string; costUsd: number },
  ttlHours: number,
  now = new Date(),
): Promise<void> {
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
  try {
    await ctx.db
      .insert(responseCache)
      .values({ ...entry, createdAt: now, expiresAt })
      .onConflictDoUpdate({
        target: responseCache.id,
        set: { body: entry.body, costUsd: entry.costUsd, createdAt: now, expiresAt },
      });
  } catch (error) {
    console.error('Failed to cache a response', error);
  }
}

export async function forgetExpired(ctx: AppContext, now = new Date()): Promise<void> {
  await ctx.db.delete(responseCache).where(lt(responseCache.expiresAt, now));
}
