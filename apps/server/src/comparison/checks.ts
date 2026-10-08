import type { Check, Reason } from './types.ts';

/** Expected objects are subsets; arrays and scalar values must match exactly. No code executes. */
export function jsonMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, i) => jsonMatches(actual[i], value))
    );
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(
      ([key, value]) =>
        Object.hasOwn(actual, key) && jsonMatches((actual as Record<string, unknown>)[key], value),
    );
  }
  return actual === expected;
}

export function checkAnswer(
  check: Check,
  expected: string,
  output: string,
): {
  status: 'passed' | 'failed' | 'review';
  reason: Reason;
} {
  if (check === 'manual') return { status: 'review', reason: 'manual' };
  if (check === 'json') {
    try {
      const actual: unknown = JSON.parse(output.trim());
      const matched = !expected.trim() || jsonMatches(actual, JSON.parse(expected));
      return { status: matched ? 'passed' : 'failed', reason: matched ? 'matched' : 'mismatch' };
    } catch {
      return { status: 'failed', reason: 'invalidJson' };
    }
  }
  const matched = check === 'exact' ? output.trim() === expected.trim() : output.includes(expected);
  return { status: matched ? 'passed' : 'failed', reason: matched ? 'matched' : 'mismatch' };
}
