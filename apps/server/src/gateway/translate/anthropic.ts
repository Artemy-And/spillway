import { randomBytes } from 'node:crypto';
import { type SSEEvent, sse, UpstreamError } from '../sse.ts';
import type {
  ABlock,
  AImageSource,
  AMessage,
  ARequest,
  AResponse,
  AStreamEvent,
  AUsage,
  OAIChatRequest,
  OAIChatResponse,
  OAIChunk,
  OAIContentPart,
  OAIMessage,
  OAITool,
  OAIToolCall,
  OAIUsage,
} from '../types.ts';
import { parseArguments, textOf } from './common.ts';

const DEFAULT_MAX_TOKENS = 4096;

const STOP_TO_OPENAI: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  pause_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

const STOP_TO_ANTHROPIC: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const randomId = () => randomBytes(12).toString('hex');

function imageUrl(source: AImageSource): string {
  return source.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source.url;
}

function imageSource(url: string): AImageSource {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return match ? { type: 'base64', media_type: match[1]!, data: match[2]! } : { type: 'url', url };
}

function usageToOpenAI(usage: Partial<AUsage> | undefined): OAIUsage {
  const input =
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0);
  const output = usage?.output_tokens ?? 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

// ── Anthropic client → OpenAI-compatible upstream ─────────────────────────────

export function anthropicRequestToOpenAI(req: ARequest): OAIChatRequest {
  const messages: OAIMessage[] = [];
  const system = textOf(req.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const message of req.messages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      let text = '';
      const toolCalls: OAIToolCall[] = [];
      for (const block of message.content) {
        if (block.type === 'text') text += block.text;
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      // null content is only valid next to tool calls (a turn may hold just thinking blocks).
      messages.push({
        role: 'assistant',
        content: text || (toolCalls.length ? null : ''),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // Tool results become `tool` messages; they must directly follow the assistant turn.
    const parts: OAIContentPart[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : textOf(block.content);
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.is_error ? `Error: ${content}` : content,
        });
      } else if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        parts.push({ type: 'image_url', image_url: { url: imageUrl(block.source) } });
      }
    }
    if (parts.length === 1 && parts[0]!.type === 'text') {
      messages.push({ role: 'user', content: parts[0]!.text });
    } else if (parts.length) {
      messages.push({ role: 'user', content: parts });
    }
  }

  const out: OAIChatRequest = { model: req.model, messages, max_tokens: req.max_tokens };
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;

  const tools: OAITool[] = (req.tools ?? [])
    .filter((tool) => tool.input_schema)
    .map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    }));
  if (tools.length) out.tools = tools;

  const choice = req.tool_choice;
  if (choice && tools.length) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'none') out.tool_choice = 'none';
    else if (choice.type === 'tool') {
      out.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }

  if (req.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

export function openAIResponseToAnthropic(res: OAIChatResponse, model: string): AResponse {
  const choice = res.choices[0];
  const content: ABlock[] = [];
  const text = choice?.message.content;
  if (text) content.push({ type: 'text', text });
  for (const call of choice?.message.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  return {
    id: `msg_${res.id ?? randomId()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: STOP_TO_ANTHROPIC[choice?.finish_reason ?? 'stop'] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

export async function* openAIStreamToAnthropic(
  chunks: AsyncIterable<OAIChunk>,
  model: string,
): AsyncGenerator<string> {
  const id = `msg_${randomId()}`;
  let started = false;
  let blockIndex = -1;
  let open: 'text' | 'tool' | null = null;
  const toolBlocks = new Map<number, number>();
  let finish: string | null = null;
  let usage: OAIUsage = { prompt_tokens: 0, completion_tokens: 0 };

  const start = () =>
    sse(
      {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      'message_start',
    );
  const close = () => {
    open = null;
    return sse({ type: 'content_block_stop', index: blockIndex }, 'content_block_stop');
  };

  for await (const chunk of chunks) {
    if (!started) {
      started = true;
      yield start();
    }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;

    const { content, tool_calls } = choice.delta;
    if (content) {
      if (open !== 'text') {
        if (open) yield close();
        blockIndex++;
        open = 'text';
        yield sse(
          {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
          },
          'content_block_start',
        );
      }
      yield sse(
        {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: content },
        },
        'content_block_delta',
      );
    }
    for (const call of tool_calls ?? []) {
      let index = toolBlocks.get(call.index);
      if (index === undefined) {
        if (open) yield close();
        blockIndex++;
        index = blockIndex;
        toolBlocks.set(call.index, index);
        open = 'tool';
        yield sse(
          {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: call.id ?? `toolu_${randomId()}`,
              name: call.function?.name ?? '',
              input: {},
            },
          },
          'content_block_start',
        );
      }
      if (call.function?.arguments) {
        yield sse(
          {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: call.function.arguments },
          },
          'content_block_delta',
        );
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  if (!started) yield start();
  if (open) yield close();
  yield sse(
    {
      type: 'message_delta',
      delta: {
        stop_reason: STOP_TO_ANTHROPIC[finish ?? 'stop'] ?? 'end_turn',
        stop_sequence: null,
      },
      usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
    },
    'message_delta',
  );
  yield sse({ type: 'message_stop' }, 'message_stop');
}

// ── OpenAI-format request → Anthropic upstream ────────────────────────────────

export function openAIRequestToAnthropic(req: OAIChatRequest): ARequest {
  const system: string[] = [];
  const messages: AMessage[] = [];
  // Anthropic wants alternating turns, so consecutive same-role messages are merged.
  const push = (role: AMessage['role'], blocks: ABlock[]) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    if (last?.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const message of req.messages) {
    switch (message.role) {
      case 'system':
      case 'developer':
        system.push(textOf(message.content));
        break;
      case 'user': {
        const blocks: ABlock[] = [];
        if (typeof message.content === 'string') {
          if (message.content) blocks.push({ type: 'text', text: message.content });
        } else {
          for (const part of message.content) {
            if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
            if (part.type === 'image_url') {
              blocks.push({ type: 'image', source: imageSource(part.image_url.url) });
            }
          }
        }
        push('user', blocks);
        break;
      }
      case 'assistant': {
        const blocks: ABlock[] = [];
        const text = textOf(message.content);
        if (text) blocks.push({ type: 'text', text });
        for (const call of message.tool_calls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: parseArguments(call.function.arguments),
          });
        }
        push('assistant', blocks);
        break;
      }
      case 'tool':
        push('user', [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id,
            content: textOf(message.content),
          },
        ]);
        break;
    }
  }

  const out: ARequest = {
    model: req.model,
    messages,
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? DEFAULT_MAX_TOKENS,
  };
  const systemText = system.filter(Boolean).join('\n\n');
  if (systemText) out.system = systemText;
  if (req.temperature !== undefined) out.temperature = Math.min(req.temperature, 1);
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.tools?.length) {
    out.tools = req.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
    }));
    const choice = req.tool_choice;
    if (choice === 'auto') out.tool_choice = { type: 'auto' };
    else if (choice === 'required') out.tool_choice = { type: 'any' };
    else if (choice === 'none') out.tool_choice = { type: 'none' };
    else if (choice) out.tool_choice = { type: 'tool', name: choice.function.name };
  }
  if (req.stream) out.stream = true;
  return out;
}

export function anthropicResponseToOpenAI(res: AResponse): OAIChatResponse {
  let text = '';
  const toolCalls: OAIToolCall[] = [];
  for (const block of res.content) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  return {
    id: res.id,
    object: 'chat.completion',
    created: nowSeconds(),
    model: res.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || (toolCalls.length ? null : ''),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: STOP_TO_OPENAI[res.stop_reason ?? 'end_turn'] ?? 'stop',
      },
    ],
    usage: usageToOpenAI(res.usage),
  };
}

export async function* anthropicStreamToOpenAI(
  events: AsyncIterable<SSEEvent>,
): AsyncGenerator<OAIChunk> {
  let id = `chatcmpl-${randomId()}`;
  let model = '';
  const created = nowSeconds();
  let usage: Partial<AUsage> = {};
  let finish: string | null = null;
  const toolIndex = new Map<number, number>();

  const chunk = (
    delta: OAIChunk['choices'][number]['delta'],
    finishReason: string | null = null,
  ): OAIChunk => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  for await (const event of events) {
    const data = JSON.parse(event.data) as AStreamEvent;
    switch (data.type) {
      case 'message_start':
        id = data.message?.id ?? id;
        model = data.message?.model ?? model;
        usage = { ...usage, ...data.message?.usage };
        yield chunk({ role: 'assistant', content: '' });
        break;
      case 'content_block_start':
        if (data.content_block?.type === 'tool_use' && data.index !== undefined) {
          const index = toolIndex.size;
          toolIndex.set(data.index, index);
          yield chunk({
            tool_calls: [
              {
                index,
                id: data.content_block.id,
                type: 'function',
                function: { name: data.content_block.name, arguments: '' },
              },
            ],
          });
        }
        break;
      case 'content_block_delta':
        if (data.delta?.type === 'text_delta' && data.delta.text) {
          yield chunk({ content: data.delta.text });
        } else if (data.delta?.type === 'input_json_delta' && data.index !== undefined) {
          const index = toolIndex.get(data.index);
          if (index !== undefined) {
            yield chunk({
              tool_calls: [{ index, function: { arguments: data.delta.partial_json ?? '' } }],
            });
          }
        }
        break;
      case 'message_delta':
        finish = STOP_TO_OPENAI[data.delta?.stop_reason ?? 'end_turn'] ?? 'stop';
        usage = { ...usage, ...data.usage };
        break;
      case 'error':
        throw new UpstreamError(data.error?.message ?? 'Upstream stream error');
    }
  }

  yield chunk({}, finish ?? 'stop');
  yield { ...chunk({}), choices: [], usage: usageToOpenAI(usage) };
}
