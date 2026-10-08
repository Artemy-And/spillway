import type { Target } from '../gateway/policy.ts';
import { speaksResponses } from '../gateway/upstream.ts';

export const DEFAULT_OUTPUT_TOKENS = 4096;

export function unmodeledFees(
  body: Record<string, unknown>,
  target: Target,
  format: string,
): boolean {
  const hosted =
    (format === 'responses' && speaksResponses(target.provider)) ||
    (format === 'anthropic' && target.provider.kind === 'anthropic');
  const extraTool = (tool: unknown): boolean => {
    if (!tool || typeof tool !== 'object') return false;
    const object = tool as Record<string, unknown>;
    if (object.type === 'namespace' && Array.isArray(object.tools))
      return object.tools.some(extraTool);
    return (
      object.type !== undefined &&
      !['function', 'custom', 'local_shell'].includes(String(object.type))
    );
  };
  return (
    (Array.isArray(body.modalities) && body.modalities.includes('audio')) ||
    (format === 'openai' && body.web_search_options !== undefined) ||
    (hosted && Array.isArray(body.tools) && body.tools.some(extraTool))
  );
}

function opaque(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(opaque);
  const object = value as Record<string, unknown>;
  return (
    (Array.isArray(object.images) && object.images.length > 0) ||
    [
      'input_image',
      'input_file',
      'image_url',
      'input_audio',
      'image',
      'document',
      'item_reference',
    ].includes(String(object.type)) ||
    Object.values(object).some(opaque)
  );
}

/** Limited cloud requests without an output cap get an explicit default before being forwarded. */
export function cappedBody(
  format: string,
  body: Record<string, unknown>,
  limited: boolean,
  nativeChat = false,
): Record<string, unknown> {
  if (!limited || format.startsWith('embeddings')) return body;
  if (format.startsWith('ollama')) {
    const options =
      body.options && typeof body.options === 'object'
        ? (body.options as Record<string, unknown>)
        : {};
    return options.num_predict === undefined
      ? { ...body, options: { ...options, num_predict: DEFAULT_OUTPUT_TOKENS } }
      : body;
  }
  const field =
    format === 'responses'
      ? 'max_output_tokens'
      : nativeChat
        ? 'max_completion_tokens'
        : 'max_tokens';
  const defaultOutput = format === 'responses' ? 32_000 : DEFAULT_OUTPUT_TOKENS;
  return body[field] === undefined &&
    body.max_tokens === undefined &&
    body.max_completion_tokens === undefined
    ? { ...body, [field]: defaultOutput }
    : body;
}

/** Text bytes overestimate ordinary tokenization; remote/stateful content has no bounded estimate. */
export function estimateRequest(
  target: Target,
  format: string,
  body: Record<string, unknown>,
): number | null {
  if (target.provider.isLocal) return 0;
  const embedding = format.startsWith('embeddings');
  if (
    target.model.inputPrice === null ||
    (!embedding && target.model.outputPrice === null) ||
    opaque(body) ||
    unmodeledFees(body, target, format) ||
    body.previous_response_id !== undefined ||
    body.conversation !== undefined ||
    body.context !== undefined
  )
    return null;
  const options = body.options as Record<string, unknown> | undefined;
  const cap = embedding
    ? 0
    : (body.max_completion_tokens ??
      body.max_output_tokens ??
      body.max_tokens ??
      options?.num_predict ??
      DEFAULT_OUTPUT_TOKENS);
  const n = body.n ?? 1;
  if (
    !Number.isSafeInteger(cap) ||
    (cap as number) < (embedding ? 0 : 1) ||
    !Number.isSafeInteger(n) ||
    (n as number) < 1
  )
    return null;
  const input = new TextEncoder().encode(JSON.stringify(body)).length + 512;
  const inputPrice = Math.max((target.model.inputPrice ?? 0) * 2, target.model.cacheReadPrice ?? 0);
  const amount =
    ((input * inputPrice + (cap as number) * (target.model.outputPrice ?? 0)) * (n as number)) /
    1_000_000;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}
