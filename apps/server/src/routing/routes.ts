import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthEnv, adminOnly } from '../auth/session.ts';
import type { AppContext } from '../context.ts';
import { routingProfiles } from '../db/schema.ts';
import { createProfile, listProfiles, RoutingError, updateProfile } from './service.ts';

export function routingProfileRoutes(ctx: AppContext) {
  return new Hono<AuthEnv>()
    .use('*', adminOnly)
    .onError((error, c) => {
      if (error instanceof RoutingError) return c.json({ error: error.message }, 400);
      console.error('Routing profile API failed', error);
      return c.json({ error: 'Routing profile could not be saved' }, 500);
    })
    .get('/', async (c) => c.json(await listProfiles(ctx)))
    .post(
      '/',
      zValidator(
        'json',
        z.object({
          name: z.string().trim().min(1).max(80),
          keyId: z.string().min(1),
          comparisonId: z.string().min(1),
          baselineModelId: z.string().min(1),
          candidateModelId: z.string().min(1),
          fallbackOnError: z.boolean(),
          mode: z.enum(['text', 'tools']).default('text'),
        }),
      ),
      async (c) => c.json(await createProfile(ctx, c.req.valid('json'), c.get('user').id), 201),
    )
    .patch(
      '/:id',
      zValidator(
        'json',
        z.object({
          enabled: z.boolean().optional(),
          fallbackOnError: z.boolean().optional(),
        }),
      ),
      async (c) => c.json(await updateProfile(ctx, c.req.param('id'), c.req.valid('json'))),
    )
    .delete('/:id', async (c) => {
      await ctx.db.delete(routingProfiles).where(eq(routingProfiles.id, c.req.param('id')));
      return c.json({ ok: true });
    });
}
