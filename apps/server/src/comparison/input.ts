import { z } from 'zod';
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

export const taskSetInput = z.object({
  name: z.string().trim().min(1).max(80),
  system: z.string().max(4000).default(''),
  maxOutputTokens: z.number().int().min(32).max(2048),
  cases: z.array(caseInput).min(1).max(20),
});

export const comparisonInput = taskSetInput.extend({
  keyId: z.string().min(1),
  modelIds: z
    .array(z.string().min(1))
    .min(2)
    .max(4)
    .refine((ids) => new Set(ids).size === ids.length, 'Select different models'),
  maxSpendUsd: z.number().min(0).max(50),
  taskSet: z.object({ id: z.string().min(1), revision: z.number().int().positive() }).optional(),
});
