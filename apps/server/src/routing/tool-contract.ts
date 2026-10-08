import { parseToolObject } from '../comparison/tools.ts';
import type { ToolDefinition } from '../comparison/types.ts';
import { sha256 } from '../lib/crypto.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

/** Only definition hashes enter reports/profiles; prompts, arguments and results remain private. */
export function toolContractHash(definitions: ToolDefinition[]): string {
  return sha256(
    JSON.stringify(
      definitions
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: canonical(parseToolObject(tool.parameters)),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    ),
  );
}

/** The same Chat function-call contract used by loop evaluations, with optional streaming. */
export function sessionContract(
  body: Record<string, unknown>,
): { hash: string; initial: boolean } | null {
  const fields = [
    'model',
    'messages',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'max_tokens',
    'max_completion_tokens',
    'stream',
    'stream_options',
    'temperature',
    'top_p',
    'stop',
    'n',
  ];
  const cap = body.max_tokens ?? body.max_completion_tokens;
  if (
    !Number.isSafeInteger(cap) ||
    (cap as number) < 1 ||
    (cap as number) > 2048 ||
    (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) ||
    Object.keys(body).some((key) => !fields.includes(key)) ||
    (body.stream !== undefined && typeof body.stream !== 'boolean') ||
    (body.stream_options !== undefined &&
      (body.stream !== true ||
        !body.stream_options ||
        typeof body.stream_options !== 'object' ||
        Array.isArray(body.stream_options) ||
        Object.keys(body.stream_options).some((key) => key !== 'include_usage') ||
        ('include_usage' in body.stream_options &&
          typeof body.stream_options.include_usage !== 'boolean'))) ||
    (body.n !== undefined && body.n !== 1) ||
    body.parallel_tool_calls !== false ||
    (body.tool_choice !== undefined && body.tool_choice !== 'auto') ||
    !Array.isArray(body.tools) ||
    body.tools.length < 1 ||
    body.tools.length > 4 ||
    !Array.isArray(body.messages) ||
    !body.messages.length
  )
    return null;
  const definitions: ToolDefinition[] = [];
  const names = new Set<string>();
  for (const value of body.tools) {
    if (
      !value ||
      typeof value !== 'object' ||
      value.type !== 'function' ||
      Object.keys(value).some((key) => !['type', 'function'].includes(key))
    )
      return null;
    const fn = value.function;
    if (
      !fn ||
      typeof fn !== 'object' ||
      Array.isArray(fn) ||
      Object.keys(fn).some((key) => !['name', 'description', 'parameters'].includes(key)) ||
      typeof fn.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(fn.name) ||
      names.has(fn.name) ||
      (fn.description !== undefined &&
        (typeof fn.description !== 'string' || fn.description.length > 1000))
    )
      return null;
    const parameters = JSON.stringify(fn.parameters);
    if (!parameters) return null;
    const schema = parseToolObject(parameters);
    if (
      schema?.type !== 'object' ||
      (schema.properties !== undefined &&
        (!schema.properties ||
          typeof schema.properties !== 'object' ||
          Array.isArray(schema.properties)))
    )
      return null;
    names.add(fn.name);
    definitions.push({ name: fn.name, description: fn.description ?? '', parameters });
  }
  let initial = true;
  let pending: string | null = null;
  const ids = new Set<string>();
  for (const message of body.messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) ||
      Object.keys(message).some(
        (key) => !['role', 'content', 'tool_calls', 'tool_call_id'].includes(key),
      )
    )
      return null;
    if (message.role === 'tool') {
      initial = false;
      if (
        !pending ||
        message.tool_call_id !== pending ||
        typeof message.content !== 'string' ||
        message.tool_calls !== undefined
      )
        return null;
      pending = null;
    } else {
      if (pending || message.tool_call_id !== undefined) return null;
      if (message.role === 'assistant') initial = false;
      if (message.tool_calls !== undefined) {
        if (
          message.role !== 'assistant' ||
          !Array.isArray(message.tool_calls) ||
          message.tool_calls.length !== 1
        )
          return null;
        const call = message.tool_calls[0];
        if (
          call?.type !== 'function' ||
          typeof call.id !== 'string' ||
          !call.id.trim() ||
          Object.keys(call).some((key) => !['id', 'type', 'function'].includes(key)) ||
          !call.function ||
          typeof call.function !== 'object' ||
          Array.isArray(call.function) ||
          Object.keys(call.function).some((key) => !['name', 'arguments'].includes(key)) ||
          call.id.length > 200 ||
          ids.has(call.id) ||
          !names.has(call.function?.name) ||
          typeof call.function?.arguments !== 'string' ||
          !parseToolObject(call.function.arguments) ||
          (message.content !== undefined &&
            message.content !== null &&
            typeof message.content !== 'string')
        )
          return null;
        ids.add(call.id);
        pending = call.id;
      } else if (typeof message.content !== 'string') return null;
    }
  }
  return pending ? null : { hash: toolContractHash(definitions), initial };
}
