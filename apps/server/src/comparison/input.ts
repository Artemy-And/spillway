import { z } from 'zod';
import { parseToolObject, TOOL_JSON_LIMIT } from './tools.ts';
import { CHECKS } from './types.ts';

const toolName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
export const toolScenarioInput = z
  .object({
    mode: z.enum(['call', 'loop']),
    definitions: z
      .array(
        z.object({
          name: toolName,
          description: z.string().max(1000).default(''),
          parameters: z.string().min(1).max(TOOL_JSON_LIMIT),
        }),
      )
      .min(1)
      .max(4),
    steps: z
      .array(
        z.object({
          name: toolName,
          arguments: z.string().min(1).max(TOOL_JSON_LIMIT),
          result: z.string().max(TOOL_JSON_LIMIT).default(''),
        }),
      )
      .min(1)
      .max(3),
  })
  .superRefine((scenario, context) => {
    const names = new Set<string>();
    scenario.definitions.forEach((definition, index) => {
      if (names.has(definition.name)) {
        context.addIssue({
          code: 'custom',
          path: ['definitions', index, 'name'],
          message: 'Use unique tool names',
        });
      }
      names.add(definition.name);
      const parameters = parseToolObject(definition.parameters);
      if (
        parameters?.type !== 'object' ||
        (parameters.properties !== undefined &&
          (!parameters.properties ||
            typeof parameters.properties !== 'object' ||
            Array.isArray(parameters.properties)))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['definitions', index, 'parameters'],
          message: 'Tool parameters must be a JSON object schema',
        });
      }
    });
    scenario.steps.forEach((step, index) => {
      if (!names.has(step.name)) {
        context.addIssue({
          code: 'custom',
          path: ['steps', index, 'name'],
          message: 'Choose a defined tool',
        });
      }
      if (!parseToolObject(step.arguments)) {
        context.addIssue({
          code: 'custom',
          path: ['steps', index, 'arguments'],
          message: 'Expected arguments must be a JSON object',
        });
      }
    });
    if (scenario.mode === 'call' && scenario.steps.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'A tool-call check needs exactly one step',
      });
    }
    if (JSON.stringify(scenario).length > 24000) {
      context.addIssue({ code: 'custom', message: 'Tool scenario is too large' });
    }
  });

export const caseInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(12000),
    check: z.enum(CHECKS),
    expected: z.string().max(12000).default(''),
    tools: toolScenarioInput.optional(),
  })
  .superRefine((task, context) => {
    if (
      task.tools?.mode !== 'call' &&
      (task.check === 'exact' || task.check === 'contains') &&
      !task.expected.trim()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expected'],
        message: 'An expected answer is required',
      });
    }
    if (task.tools?.mode !== 'call' && task.check === 'json' && task.expected.trim()) {
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
