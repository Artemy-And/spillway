import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthEnv, adminOnly } from '../auth/session.ts';
import type { AppContext } from '../context.ts';
import { modelAliases, models } from '../db/schema.ts';
import { type Caller, findModel } from '../gateway/policy.ts';
import { sha256 } from '../lib/crypto.ts';
import { allowed, routingTarget } from './resolve.ts';
import { RoutingSessionError } from './sessions.ts';

export async function aliasTarget(
  ctx: AppContext,
  caller: Caller,
  name: string,
  sessionId: string,
) {
  const alias = await ctx.db.query.modelAliases.findFirst({ where: eq(modelAliases.name, name) });
  if (!alias) return null;
  if (!alias.enabled) throw new RoutingSessionError('Model alias is disabled', 403);
  if (await findModel(ctx.db, eq(models.name, name)))
    throw new RoutingSessionError('Alias name conflicts with a concrete model');
  const targets = await Promise.all(
    alias.targets.map(async (entry) => ({
      ...entry,
      target: allowed(caller, entry.modelId) ? await routingTarget(ctx, entry.modelId) : null,
    })),
  );
  const eligible = targets.filter((entry) => entry.target !== null);
  if (!eligible.length)
    throw new RoutingSessionError('Alias has no available model allowed for this key/team', 403);
  if (alias.strategy === 'lowest-cost') {
    const priced = eligible.filter(
      ({ target }) =>
        target!.provider.isLocal ||
        (target!.model.inputPrice !== null && target!.model.outputPrice !== null),
    );
    if (!priced.length) throw new RoutingSessionError('Alias has no target with known pricing');
    priced.sort((a, b) => {
      const cost = (entry: typeof a) =>
        entry.target!.provider.isLocal
          ? 0
          : entry.target!.model.inputPrice! + entry.target!.model.outputPrice!;
      return cost(a) - cost(b) || a.modelId.localeCompare(b.modelId);
    });
    return priced[0]!.target!;
  }
  const total = eligible.reduce((sum, entry) => sum + entry.weight, 0);
  let slot =
    (Number.parseInt(sha256(`${sessionId}\0${name}`).slice(0, 8), 16) / 0x1_0000_0000) * total;
  for (const entry of eligible) {
    slot -= entry.weight;
    if (slot < 0) return entry.target!;
  }
  return eligible.at(-1)!.target!;
}

const input = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[\w.:/@-]+$/),
    enabled: z.boolean().default(true),
    strategy: z.enum(['weighted', 'lowest-cost']).default('weighted'),
    targets: z
      .array(z.object({ modelId: z.string().min(1), weight: z.number().int().min(1).max(1000) }))
      .min(1)
      .max(16),
  })
  .strict();

export function aliasRoutes(ctx: AppContext) {
  return new Hono<AuthEnv>()
    .use('*', adminOnly)
    .get('/', async (c) => c.json(await ctx.db.select().from(modelAliases)))
    .put('/', zValidator('json', input), async (c) => {
      const value = c.req.valid('json');
      if (await ctx.db.query.models.findFirst({ where: eq(models.name, value.name) }))
        return c.json({ error: 'Alias name conflicts with a concrete model' }, 400);
      if (new Set(value.targets.map((entry) => entry.modelId)).size !== value.targets.length)
        return c.json({ error: 'Choose distinct concrete model targets' }, 400);
      for (const entry of value.targets) {
        if (!(await routingTarget(ctx, entry.modelId)))
          return c.json({ error: 'Choose enabled concrete model targets' }, 400);
      }
      const [row] = await ctx.db
        .insert(modelAliases)
        .values(value)
        .onConflictDoUpdate({ target: modelAliases.name, set: value })
        .returning();
      return c.json(row!);
    })
    .delete('/:name', async (c) => {
      await ctx.db.delete(modelAliases).where(eq(modelAliases.name, c.req.param('name')));
      return c.json({ ok: true });
    });
}
