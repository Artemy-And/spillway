/**
 * List prices of well-known cloud models, in USD per million tokens. They fill in a model's price
 * when an admin adds it, so budgets count from the first request; the admin can change them at
 * any time. Providers change prices, so the list carries the date it was checked.
 */
export const PRICE_LIST_DATE = '2026-10-01';

export interface Price {
  input: number;
  output: number;
  /** Cached input tokens; null means the usual tenth of the input price. */
  cacheRead: number | null;
}

/** [input, output, cached input] per million tokens. */
const LIST: Record<string, [number, number, number?]> = {
  // Anthropic
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-opus-4-5': [5, 25],
  'claude-opus-4-1': [15, 75],
  'claude-opus-4-0': [15, 75],
  'claude-opus-4': [15, 75],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-sonnet-4-5': [3, 15],
  'claude-sonnet-4-0': [3, 15],
  'claude-sonnet-4': [3, 15],
  'claude-3-7-sonnet': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'claude-3-5-haiku': [0.8, 4],
  'claude-3-haiku': [0.25, 1.25],

  // OpenAI
  'gpt-5.2': [1.75, 14, 0.175],
  'gpt-5.1': [1.25, 10, 0.125],
  'gpt-5.1-codex': [1.25, 10, 0.125],
  'gpt-5.1-codex-mini': [0.25, 2, 0.025],
  'gpt-5': [1.25, 10, 0.125],
  'gpt-5-chat-latest': [1.25, 10, 0.125],
  'gpt-5-codex': [1.25, 10, 0.125],
  'gpt-5-mini': [0.25, 2, 0.025],
  'gpt-5-nano': [0.05, 0.4, 0.005],
  'gpt-4.1': [2, 8, 0.5],
  'gpt-4.1-mini': [0.4, 1.6, 0.1],
  'gpt-4.1-nano': [0.1, 0.4, 0.025],
  'gpt-4o': [2.5, 10, 1.25],
  'gpt-4o-mini': [0.15, 0.6, 0.075],
  o3: [2, 8, 0.5],
  'o3-mini': [1.1, 4.4, 0.55],
  'o4-mini': [1.1, 4.4, 0.275],
  o1: [15, 60, 7.5],
  'text-embedding-3-small': [0.02, 0],
  'text-embedding-3-large': [0.13, 0],
  'text-embedding-ada-002': [0.1, 0],

  // Google Gemini (prompts up to 200K tokens)
  'gemini-3-pro-preview': [2, 12],
  'gemini-3-flash-preview': [0.5, 3],
  'gemini-2.5-pro': [1.25, 10],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-flash-lite': [0.1, 0.4],
  'gemini-2.0-flash': [0.1, 0.4],
  'gemini-2.0-flash-lite': [0.075, 0.3],
  'gemini-embedding-001': [0.15, 0],

  // Mistral
  'mistral-medium-latest': [0.4, 2],
  'mistral-small-latest': [0.1, 0.3],
  'codestral-latest': [0.3, 0.9],
  'magistral-medium-latest': [2, 5],
  'magistral-small-latest': [0.5, 1.5],
  'ministral-8b-latest': [0.1, 0.1],
  'ministral-3b-latest': [0.04, 0.04],
  'mistral-embed': [0.1, 0],

  // DeepSeek
  'deepseek-chat': [0.28, 0.42, 0.028],
  'deepseek-reasoner': [0.28, 0.42, 0.028],

  // xAI
  'grok-4': [3, 15, 0.75],
  'grok-4-fast-reasoning': [0.2, 0.5, 0.05],
  'grok-4-fast-non-reasoning': [0.2, 0.5, 0.05],
  'grok-code-fast-1': [0.2, 1.5, 0.02],
  'grok-3': [3, 15, 0.75],
  'grok-3-mini': [0.3, 0.5, 0.075],
};

/**
 * One spelling per model: vendor prefixes, snapshot dates and "-latest" are dropped, so
 * "openai/gpt-4o-2024-08-06", "claude-haiku-4-5-20251001" and "anthropic/claude-sonnet-4.5"
 * find their list entries.
 */
export function priceKey(id: string): string {
  let key = id.trim().toLowerCase();
  key = key.slice(key.lastIndexOf('/') + 1);
  key = key
    .replace(/@\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(?:latest|preview(?:-\d{2}-\d{2,4})?)$/, '')
    .replace(/-\d{3,4}$/, '');
  return key.startsWith('claude') ? key.replaceAll('.', '-') : key;
}

const BY_KEY = new Map(
  Object.entries(LIST).map(([id, [input, output, cacheRead]]) => [
    priceKey(id),
    { input, output, cacheRead: cacheRead ?? null },
  ]),
);

/** The list price for an upstream model id, if the model is on the list. */
export function listPrice(upstreamModel: string): Price | null {
  return BY_KEY.get(priceKey(upstreamModel)) ?? null;
}

const perMillion = (perToken: unknown): number | null => {
  const value = typeof perToken === 'string' ? Number(perToken) : perToken;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1e6 * 1e6) / 1e6
    : null;
};

/**
 * Prices a provider publishes in its own model list. OpenRouter and some other aggregators put
 * per-token prices on each model: `pricing: { prompt, completion, input_cache_read }`.
 */
export function publishedPrice(model: { pricing?: Record<string, unknown> }): Price | null {
  const input = perMillion(model.pricing?.prompt);
  const output = perMillion(model.pricing?.completion);
  if (input === null || output === null) return null;
  return { input, output, cacheRead: perMillion(model.pricing?.input_cache_read) };
}
