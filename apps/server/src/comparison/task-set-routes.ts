import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthEnv, adminOnly } from '../auth/session.ts';
import type { AppContext } from '../context.ts';
import { taskSets } from '../db/schema.ts';
import { taskSetInput } from './input.ts';
import { getTaskSet, listTaskSets, saveTaskSet, setReference, TaskSetError } from './task-sets.ts';

export function taskSetRoutes(ctx: AppContext) {
  return new Hono<AuthEnv>()
    .use('*', adminOnly)
    .onError((error, c) => {
      if (error instanceof TaskSetError) return c.json({ error: error.message }, error.status);
      console.error('Task set API failed', error);
      return c.json({ error: 'Task set could not be saved' }, 500);
    })
    .get('/', async (c) => c.json(await listTaskSets(ctx)))
    .get('/:id', async (c) => c.json(await getTaskSet(ctx, c.req.param('id'))))
    .post('/', zValidator('json', taskSetInput), async (c) =>
      c.json(await saveTaskSet(ctx, c.req.valid('json'), c.get('user').id), 201),
    )
    .put(
      '/:id',
      zValidator('json', taskSetInput.extend({ revision: z.number().int().positive() })),
      async (c) => {
        const { revision, ...input } = c.req.valid('json');
        return c.json(
          await saveTaskSet(ctx, input, c.get('user').id, { id: c.req.param('id'), revision }),
        );
      },
    )
    .post(
      '/:id/reference',
      zValidator(
        'json',
        z.object({ revision: z.number().int().positive(), reportId: z.string().min(1).nullable() }),
      ),
      async (c) => {
        const { revision, reportId } = c.req.valid('json');
        return c.json(await setReference(ctx, c.req.param('id'), revision, reportId));
      },
    )
    .delete(
      '/:id',
      zValidator('json', z.object({ revision: z.number().int().positive() })),
      async (c) => {
        const [row] = await ctx.db
          .delete(taskSets)
          .where(
            and(
              eq(taskSets.id, c.req.param('id')),
              eq(taskSets.revision, c.req.valid('json').revision),
            ),
          )
          .returning({ id: taskSets.id });
        if (!row) throw new TaskSetError('Task set changed; load the latest revision', 409);
        return c.json({ ok: true });
      },
    );
}
