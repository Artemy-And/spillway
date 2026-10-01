import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { invites, type User, users } from '../db/schema.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';

export const INVITE_DAYS = 7;

/**
 * A fresh link for someone to set their password: an invite for new people, a reset for
 * everyone else. Older links for the same person stop working.
 */
export async function createInvite(db: Db, userId: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  await db.delete(invites).where(eq(invites.userId, userId));
  await db.insert(invites).values({ id: sha256(token), userId, expiresAt });
  return { token, expiresAt: expiresAt.toISOString() };
}

/** The person a link belongs to, while it is valid and they are not disabled. */
export async function findInvite(db: Db, token: string): Promise<User | null> {
  const row = await db
    .select({ user: users })
    .from(invites)
    .innerJoin(users, eq(invites.userId, users.id))
    .where(and(eq(invites.id, sha256(token)), gt(invites.expiresAt, new Date())))
    .get();
  return row && !row.user.disabledAt ? row.user : null;
}
