import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthEnv, adminOnly } from '../auth/session.ts';
import type { AppContext } from '../context.ts';
import { ComparisonError, comparisonRunner } from './runner.ts';
import { CHECKS } from './types.ts';

export const caseInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(12000),
    check: z.enum(CHECKS),
    expected: z.string().max(12000).default(''),
  })
  .superRefine((task, context) => {
    if ((task.check === 'exact' || task.check === 'contains') && !task.expected.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['expected'],
        message: 'An expected answer is required',
      });
    }
    if (task.check === 'json' && task.expected.trim()) {
      try {
        JSON.parse(task.expected);
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['expected'],
          message: 'Expected JSON must be valid',
        });
      }
    }
  });

export const comparisonInput = z.object({
  name: z.string().trim().min(1).max(80),
  keyId: z.string().min(1),
  modelIds: z
    .array(z.string().min(1))
    .min(2)
    .max(4)
    .refine((ids) => new Set(ids).size === ids.length, 'Select different models'),
  system: z.string().max(4000).default(''),
  maxSpendUsd: z.number().min(0).max(50),
  maxOutputTokens: z.number().int().min(32).max(2048),
  cases: z.array(caseInput).min(1).max(20),
});

export function comparisonRoutes(ctx: AppContext) {
  const runner = comparisonRunner(ctx);
  return new Hono<AuthEnv>()
    .use('*', adminOnly)
    .onError((error, c) => {
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
