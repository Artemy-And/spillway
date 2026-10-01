// Sets a new random password for someone who is locked out, and signs them out everywhere.
// Run: pnpm reset-password you@company.com
// In Docker: docker compose exec spillway node apps/server/src/reset-password.ts you@company.com
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb } from './db/client.ts';
import { sessions, users } from './db/schema.ts';
import { loadEnv } from './env.ts';
import { hashPassword, randomToken } from './lib/crypto.ts';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: reset-password <email>');
  process.exit(1);
}

const env = loadEnv();
mkdirSync(env.DATA_DIR, { recursive: true });
const { db, close } = await openDb(join(env.DATA_DIR, 'spillway.db'));

const user = await db.query.users.findFirst({ where: eq(users.email, email) });
if (!user) {
  console.error(`Nobody with the email ${email}.`);
  close();
  process.exit(1);
}

const password = randomToken(12);
await db
  .update(users)
  .set({ passwordHash: await hashPassword(password), disabledAt: null })
  .where(eq(users.id, user.id));
await db.delete(sessions).where(eq(sessions.userId, user.id));
close();

console.log(
  `New password for ${email}: ${password}\nChange it on the Account page after signing in.`,
);
