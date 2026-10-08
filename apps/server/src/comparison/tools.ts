import type { OAITool, OAIToolCall } from '../gateway/types.ts';
import { jsonMatches } from './checks.ts';
import type { Reason, ToolScenario, ToolStep } from './types.ts';

export const TOOL_JSON_LIMIT = 8000;

/** Fixtures and returned arguments are data only; deeply nested JSON is rejected before matching. */
export function parseToolObject(raw: string): Record<string, unknown> | null {
  if (!raw.trim() || raw.length > TOOL_JSON_LIMIT) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
    while (pending.length) {
      const item = pending.pop()!;
      if (item.depth > 32) return null;
      if (typeof item.value === 'number' && !Number.isFinite(item.value)) return null;
      if (item.value && typeof item.value === 'object') {
        for (const child of Object.values(item.value)) {
          pending.push({ value: child, depth: item.depth + 1 });
        }
      }
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildToolDefinitions(scenario: ToolScenario): OAITool[] {
  return scenario.definitions.map((definition) => {
    const parameters = parseToolObject(definition.parameters);
    if (parameters?.type !== 'object') throw new Error('Tool parameters must be an object schema');
    return {
      type: 'function',
      function: {
        name: definition.name,
        ...(definition.description ? { description: definition.description } : {}),
        parameters,
      },
    };
  });
}

/** Match one expected function and exact JSON arguments before consuming its fixed result. */
export function validateToolCall(
  value: unknown,
  expected: ToolStep,
  usedIds: Set<string>,
): { call: OAIToolCall | null; reason: Reason | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { call: null, reason: 'toolUnexpected' };
  }
  const call = value as Record<string, unknown>;
  if (
    call.type !== 'function' ||
    typeof call.id !== 'string' ||
    !call.id.trim() ||
    call.id.length > 200 ||
    !call.function ||
    typeof call.function !== 'object' ||
    Array.isArray(call.function)
  ) {
    return { call: null, reason: 'toolUnexpected' };
  }
  if (usedIds.has(call.id)) return { call: null, reason: 'toolSequence' };
  const fn = call.function as Record<string, unknown>;
  if (typeof fn.name !== 'string' || fn.name !== expected.name) {
    return { call: null, reason: 'toolUnexpected' };
  }
  if (typeof fn.arguments !== 'string') return { call: null, reason: 'toolArguments' };
  const actual = parseToolObject(fn.arguments);
  const wanted = parseToolObject(expected.arguments);
  if (!actual || !wanted || !jsonMatches(actual, wanted) || !jsonMatches(wanted, actual)) {
    return { call: null, reason: 'toolArguments' };
  }
  usedIds.add(call.id);
  return {
    call: { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } },
    reason: null,
  };
}
