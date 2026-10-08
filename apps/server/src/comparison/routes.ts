import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthEnv, adminOnly } from '../auth/session.ts';
import type { AppContext } from '../context.ts';
import { comparisonInput } from './input.ts';
import { regressionReport } from './regressions.ts';
import { ComparisonError, comparisonRunner } from './runner.ts';
import { TaskSetError } from './task-sets.ts';

export { caseInput, comparisonInput } from './input.ts';

export function comparisonRoutes(ctx: AppContext) {
  const runner = comparisonRunner(ctx);
  return new Hono<AuthEnv>()
    .use('*', adminOnly)
    .onError((error, c) => {
      if (error instanceof TaskSetError) return c.json({ error: error.message }, error.status);
      if (error instanceof ComparisonError) return c.json({ error: error.message }, 400);
      console.error('Comparison API failed', error);
      return c.json({ error: 'Comparison could not be saved' }, 500);
    })
    .get('/', async (c) => c.json(await runner.list()))
    .post('/quote', zValidator('json', comparisonInput), async (c) => {
      const { targets, estimatedUsd } = await runner.prepare(c.req.valid('json'));
      return c.json({ estimatedUsd, calls: targets.length * c.req.valid('json').cases.length });
    })
    .post('/', zValidator('json', comparisonInput), async (c) =>
      c.json(await runner.start(c.req.valid('json'), c.get('user').id), 201),
    )
    .get('/:id', async (c) => {
      const report = await runner.get(c.req.param('id'));
      return report ? c.json(report) : c.json({ error: 'Comparison not found' }, 404);
    })
    .get('/:id/regressions', async (c) => {
      const report = await runner.get(c.req.param('id'));
      return report
        ? c.json(regressionReport(report))
        : c.json({ error: 'Comparison not found' }, 404);
    })
    .post('/:id/cancel', async (c) => {
      const report = await runner.get(c.req.param('id'));
      if (!report) return c.json({ error: 'Comparison not found' }, 404);
      await runner.cancel(report.id);
      return c.json({ ok: true });
    })
    .patch(
      '/:id/review',
      zValidator(
        'json',
        z.object({
          caseIndex: z.number().int().min(0).max(19),
          modelId: z.string().min(1),
          status: z.enum(['passed', 'failed', 'review']),
        }),
      ),
      async (c) => {
        const { caseIndex, modelId, status } = c.req.valid('json');
        return c.json(await runner.review(c.req.param('id'), caseIndex, modelId, status));
      },
    )
    .delete('/:id', async (c) => {
      await runner.remove(c.req.param('id'));
      return c.json({ ok: true });
    });
}
