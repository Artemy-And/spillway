// Asking for more: someone whose key used up its daily limit asks an admin for more, and an admin
// approves or declines with one click. An approved ask adds to the key's daily limit for that day
// only, so tight limits do not have to stop work, and nobody has to remember to lower them again.
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { apiKeys, type LimitAsk, limitAsks, users } from '../db/schema.ts';
import type { Calendar } from '../lib/time.ts';

export interface Ask {
  id: string;
  keyId: string;
  key: string;
  person: string;
  usd: number;
  reason: string | null;
  createdAt: Date;
  approved: boolean | null;
}

const columns = {
  id: limitAsks.id,
  keyId: limitAsks.keyId,
  key: apiKeys.name,
  person: sql<string>`coalesce(${users.name}, ${users.email}, '')`,
  usd: limitAsks.usd,
  reason: limitAsks.reason,
  createdAt: limitAsks.createdAt,
  approved: limitAsks.approved,
};

/** Today's asks still waiting for an admin, newest first. */
export async function waitingAsks(db: Db, cal: Calendar, now = new Date()): Promise<Ask[]> {
  return db
    .select(columns)
    .from(limitAsks)
    .innerJoin(apiKeys, eq(limitAsks.keyId, apiKeys.id))
    .leftJoin(users, eq(limitAsks.userId, users.id))
    .where(and(eq(limitAsks.day, cal.dayKey(now)), isNull(limitAsks.approved)))
    .orderBy(desc(limitAsks.createdAt))
    .all();
}

/** What someone asked for today on their own keys, answered or not, newest first. */
export async function asksBy(db: Db, userId: string, cal: Calendar, now = new Date()) {
  return db
    .select(columns)
    .from(limitAsks)
    .innerJoin(apiKeys, eq(limitAsks.keyId, apiKeys.id))
    .leftJoin(users, eq(limitAsks.userId, users.id))
    .where(and(eq(limitAsks.day, cal.dayKey(now)), eq(apiKeys.userId, userId)))
    .orderBy(desc(limitAsks.createdAt))
    .all();
}

export type AskResult = { ask: LimitAsk } | { error: string; status: 404 | 409 };

export async function askForMore(
  db: Db,
  input: { keyId: string; userId: string; usd: number; reason: string | null },
  cal: Calendar,
  now = new Date(),
): Promise<AskResult> {
  const key = await db.query.apiKeys.findFirst({
    where: and(
      eq(apiKeys.id, input.keyId),
      eq(apiKeys.userId, input.userId),
      isNull(apiKeys.revokedAt),
    ),
  });
  if (!key) return { error: 'You can ask for more only on your own keys', status: 404 };
  if (key.dailyLimitUsd == null) return { error: 'This key has no daily limit', status: 409 };
  const day = cal.dayKey(now);
  const waiting = await db.query.limitAsks.findFirst({
    where: and(eq(limitAsks.keyId, key.id), eq(limitAsks.day, day), isNull(limitAsks.approved)),
  });
  if (waiting) return { error: 'You already asked; an admin has not answered yet', status: 409 };
  const [ask] = await db
    .insert(limitAsks)
    .values({ ...input, day, createdAt: now })
    .returning();
  return { ask: ask! };
}

/** Approving adds the amount to the key's daily limit for the day the ask was for. */
export async function answerAsk(
  db: Db,
  id: string,
  approved: boolean,
  adminId: string,
  cal: Calendar,
  now = new Date(),
): Promise<{ ok: true } | { error: string; status: 404 | 409 }> {
  const ask = await db.query.limitAsks.findFirst({ where: eq(limitAsks.id, id) });
  if (!ask) return { error: 'No such ask', status: 404 };
  if (ask.approved != null) return { error: 'This ask was already answered', status: 409 };
  const day = cal.dayKey(now);
  if (approved && ask.day !== day) return { error: 'This ask was for another day', status: 409 };
  if (approved) {
    const key = await db.query.apiKeys.findFirst({ where: eq(apiKeys.id, ask.keyId) });
    const before = key?.extra?.day === day ? key.extra.usd : 0;
    await db
      .update(apiKeys)
      .set({ extra: { day, usd: before + ask.usd } })
      .where(eq(apiKeys.id, ask.keyId));
  }
  await db
    .update(limitAsks)
    .set({ approved, decidedAt: now, decidedBy: adminId })
    .where(eq(limitAsks.id, id));
  return { ok: true };
}
