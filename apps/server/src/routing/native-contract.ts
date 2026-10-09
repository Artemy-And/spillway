import type { Format } from '../gateway/handler.ts';
import { sessionContract } from './tool-contract.ts';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: ObjectValue, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function text(value: unknown, kinds: string[]): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  if (
    !value.every(
      (part) =>
        object(part) &&
        kinds.includes(String(part.type)) &&
        typeof part.text === 'string' &&
        fields(part, ['type', 'text', 'annotations']) &&
        (part.annotations === undefined ||
          (Array.isArray(part.annotations) && !part.annotations.length)),
    )
  )
    return null;
  return value.map((part) => part.text).join('\n');
}

/** Validate native history before adapting it; never silently drop provider-only context. */
export function sessionContractFor(format: Format, body: ObjectValue) {
  if (format === 'openai') return sessionContract(body);
  if (format !== 'responses' && format !== 'anthropic') return null;
  const common = ['model', 'stream', 'temperature', 'top_p', 'tools', 'tool_choice'];
  const extra =
    format === 'responses'
      ? [
          'input',
          'instructions',
          'max_output_tokens',
          'parallel_tool_calls',
          'store',
          'previous_response_id',
          'reasoning',
        ]
      : ['messages', 'system', 'max_tokens', 'stop_sequences', 'thinking'];
  if (!fields(body, [...common, ...extra]) || !Array.isArray(body.tools)) return null;
  const native = nativeContextRequested(format, body);
  const cap = format === 'responses' ? body.max_output_tokens : body.max_tokens;
  if (
    !Number.isSafeInteger(cap) ||
    (cap as number) < 1 ||
    (cap as number) > (native ? 32768 : 2048)
  )
    return null;
  if (body.thinking !== undefined) {
    if (!object(body.thinking) || !fields(body.thinking, ['type', 'budget_tokens', 'display']))
      return null;
    const thinking = body.thinking;
    if (
      thinking.display !== undefined &&
      !['summarized', 'omitted'].includes(String(thinking.display))
    )
      return null;
    if (thinking.type === 'enabled') {
      if (
        !Number.isSafeInteger(thinking.budget_tokens) ||
        (thinking.budget_tokens as number) < 1024 ||
        (thinking.budget_tokens as number) >= (cap as number)
      )
        return null;
    } else if (thinking.type !== 'adaptive' || thinking.budget_tokens !== undefined) return null;
  }
  if (
    body.reasoning !== undefined &&
    (!object(body.reasoning) ||
      !fields(body.reasoning, ['effort', 'summary']) ||
      (body.reasoning.effort !== undefined &&
        !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(
          String(body.reasoning.effort),
        )) ||
      (body.reasoning.summary !== undefined &&
        !['auto', 'concise', 'detailed'].includes(String(body.reasoning.summary))))
  )
    return null;
  const tools: ObjectValue[] = [];
  for (const fn of body.tools) {
    if (
      !object(fn) ||
      !fields(
        fn,
        format === 'responses'
          ? ['type', 'name', 'description', 'parameters', 'strict']
          : ['name', 'description', 'input_schema'],
      )
    )
      return null;
    if (format === 'responses' && (fn.type !== 'function' || fn.strict !== false)) return null;
    tools.push({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description,
        parameters: format === 'responses' ? fn.parameters : fn.input_schema,
      },
    });
  }
  const messages: ObjectValue[] = [];
  const system = format === 'responses' ? body.instructions : body.system;
  if (system !== undefined) {
    const content = text(system, ['text']);
    if (content === null) return null;
    messages.push({ role: 'system', content });
  }
  if (format === 'responses') {
    if (
      body.parallel_tool_calls !== false ||
      (body.store !== undefined && typeof body.store !== 'boolean') ||
      (body.previous_response_id !== undefined &&
        (typeof body.previous_response_id !== 'string' ||
          !body.previous_response_id.length ||
          body.previous_response_id.length > 200 ||
          body.store === false)) ||
      (body.reasoning !== undefined && !native) ||
      (body.tool_choice !== undefined && body.tool_choice !== 'auto')
    )
      return null;
    const input =
      typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
    if (!Array.isArray(input)) return null;
    for (const item of input) {
      if (!object(item)) return null;
      if (item.type === undefined || item.type === 'message') {
        if (
          !fields(item, ['type', 'role', 'content', 'id', 'status']) ||
          !['system', 'developer', 'user', 'assistant'].includes(String(item.role))
        )
          return null;
        const content = text(item.content, ['input_text', 'output_text']);
        if (content === null) return null;
        messages.push({ role: item.role, content });
      } else if (item.type === 'function_call') {
        if (!fields(item, ['type', 'id', 'status', 'call_id', 'name', 'arguments'])) return null;
        const call = {
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments },
        };
        const previous = messages.at(-1);
        if (previous?.role === 'assistant' && previous.tool_calls === undefined)
          previous.tool_calls = [call];
        else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      } else if (item.type === 'function_call_output') {
        if (!fields(item, ['type', 'id', 'call_id', 'output']) || typeof item.output !== 'string')
          return null;
        // The persisted head validates the real outstanding call before forwarding.
        if (body.previous_response_id !== undefined)
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: item.call_id,
                type: 'function',
                function: { name: (body.tools[0] as ObjectValue)?.name, arguments: '{}' },
              },
            ],
          });
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
      } else return null;
    }
  } else {
    if (
      !object(body.tool_choice) ||
      !fields(body.tool_choice, ['type', 'disable_parallel_tool_use']) ||
      body.tool_choice.type !== 'auto' ||
      body.tool_choice.disable_parallel_tool_use !== true ||
      !Array.isArray(body.messages)
    )
      return null;
    for (const message of body.messages) {
      if (
        !object(message) ||
        !fields(message, ['role', 'content']) ||
        !['user', 'assistant'].includes(String(message.role))
      )
        return null;
      if (typeof message.content === 'string') {
        messages.push({ role: message.role, content: message.content });
        continue;
      }
      if (!Array.isArray(message.content)) return null;
      const parts: string[] = [];
      const calls: ObjectValue[] = [];
      let hadText = false;
      for (const block of message.content) {
        if (!object(block)) return null;
        if (block.type === 'text') {
          if (!fields(block, ['type', 'text']) || typeof block.text !== 'string') return null;
          parts.push(block.text);
          hadText = true;
        } else if (block.type === 'thinking' && message.role === 'assistant') {
          if (
            !fields(block, ['type', 'thinking', 'signature']) ||
            typeof block.thinking !== 'string' ||
            typeof block.signature !== 'string' ||
            !block.signature.length
          )
            return null;
        } else if (block.type === 'redacted_thinking' && message.role === 'assistant') {
          if (
            !fields(block, ['type', 'data']) ||
            typeof block.data !== 'string' ||
            !block.data.length
          )
            return null;
        } else if (block.type === 'tool_use' && message.role === 'assistant') {
          if (!fields(block, ['type', 'id', 'name', 'input']) || !object(block.input)) return null;
          calls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
        } else if (block.type === 'tool_result' && message.role === 'user') {
          if (
            hadText ||
            !fields(block, ['type', 'tool_use_id', 'content', 'is_error']) ||
            (block.is_error !== undefined && typeof block.is_error !== 'boolean')
          )
            return null;
          const content = text(block.content, ['text']);
          if (content === null) return null;
          messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
        } else return null;
      }
      if (calls.length || parts.length || message.role === 'assistant')
        messages.push({
          role: message.role,
          content: parts.join('\n') || (calls.length ? null : ''),
          ...(calls.length ? { tool_calls: calls } : {}),
        });
    }
  }
  const contract = sessionContract({
    model: body.model,
    messages,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    max_tokens: Math.min(cap as number, 2048),
    stream: body.stream,
  });
  return contract && body.previous_response_id !== undefined
    ? { ...contract, initial: false }
    : contract;
}

export function nativeContextRequested(format: Format, body: ObjectValue): boolean {
  if (format === 'responses') return body.store === true || body.previous_response_id !== undefined;
  return (
    format === 'anthropic' &&
    (body.thinking !== undefined ||
      (Array.isArray(body.messages) &&
        body.messages.some(
          (message) =>
            object(message) &&
            Array.isArray(message.content) &&
            message.content.some(
              (block) =>
                object(block) && ['thinking', 'redacted_thinking'].includes(String(block.type)),
            ),
        )))
  );
}
