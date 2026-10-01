import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { AppContext } from './context.ts';
import { models, providers, requestLogs, sessions, users } from './db/schema.ts';
import { listUpstreamModels } from './gateway/upstream.ts';
import { hashPassword } from './lib/crypto.ts';

/** Makes sure someone can sign in, and adds providers from the environment on first start. */
export async function bootstrap(ctx: AppContext): Promise<void> {
  const { db, env } = ctx;

  // The first admin is created in the browser (the setup page), or from ADMIN_PASSWORD for
  // unattended installs. Either way it happens once; passwords then live on the account page.
  const anyone = await db.select({ count: sql<number>`count(*)` }).from(users).get();
  if (!anyone?.count) {
    if (env.ADMIN_PASSWORD) {
      await db.insert(users).values({
        email: env.ADMIN_EMAIL,
        name: 'Admin',
        role: 'admin',
        passwordHash: await hashPassword(env.ADMIN_PASSWORD),
      });
    } else {
      console.log(`\n  First start: open ${env.PUBLIC_URL} to create the admin account.\n`);
    }
  }

  const existing = await db.select({ count: sql<number>`count(*)` }).from(providers).get();
  if (existing?.count) return;

  if (env.OLLAMA_URL) {
    const [ollama] = await db
      .insert(providers)
      .values({ name: 'Ollama', kind: 'ollama', baseUrl: env.OLLAMA_URL, isLocal: true })
      .returning();
    try {
      const names = await listUpstreamModels(ctx, ollama!);
      for (const name of names) {
        await db
          .insert(models)
          .values({ name, providerId: ollama!.id, upstreamModel: name })
          .onConflictDoNothing();
      }
      const first = await db.query.models.findFirst({ where: eq(models.providerId, ollama!.id) });
      if (first) await ctx.settings.update({ localModelId: first.id });
      console.log(`Added Ollama at ${env.OLLAMA_URL} with ${names.length} models`);
    } catch (error) {
      console.warn(
        `Added Ollama at ${env.OLLAMA_URL}, but could not list its models yet:`,
        (error as Error).message,
      );
    }
  }
  if (env.OPENAI_API_KEY) {
    await db.insert(providers).values({
      name: 'OpenAI',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnc: ctx.vault.encrypt(env.OPENAI_API_KEY),
    });
  }
  if (env.ANTHROPIC_API_KEY) {
    await db.insert(providers).values({
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKeyEnc: ctx.vault.encrypt(env.ANTHROPIC_API_KEY),
    });
  }
}

/** Drops stored prompt texts after the retention period (the numbers stay) and old sessions. */
export async function cleanup(ctx: AppContext): Promise<void> {
  const { retentionDays } = await ctx.settings.get();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  await ctx.db
    .update(requestLogs)
    .set({ promptPreview: null, responsePreview: null })
    .where(
      and(
        lt(requestLogs.createdAt, cutoff),
        or(isNotNull(requestLogs.promptPreview), isNotNull(requestLogs.responsePreview)),
      ),
    );
  await ctx.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
