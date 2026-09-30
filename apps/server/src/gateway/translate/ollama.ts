import type {
  OAIChatRequest,
  OAIChatResponse,
  OAIChunk,
  OAIContentPart,
  OAIMessage,
  OAIUsage,
  OllamaChatRequest,
  OllamaGenerateRequest,
  OllamaOptions,
} from '../types.ts';
import { parseArguments } from './common.ts';

export type OllamaMode = 'chat' | 'generate';

const FINISH_TO_OLLAMA: Record<string, string> = { stop: 'stop', length: 'length' };

function imageMime(base64: string): string {
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('R0lG')) return 'image/gif';
  if (base64.startsWith('UklG')) return 'image/webp';
  return 'image/jpeg';
}

function withImages(text: string, images: string[] | undefined): string | OAIContentPart[] {
  if (!images?.length) return text;
  return [
    { type: 'text', text },
    ...images.map((data) => ({
      type: 'image_url' as const,
      image_url: { url: `data:${imageMime(data)};base64,${data}` },
    })),
  ];
}

function applyOptions(
  out: OAIChatRequest,
  options: OllamaOptions | undefined,
  format: unknown,
): OAIChatRequest {
  if (options?.temperature !== undefined) out.temperature = options.temperature;
  if (options?.top_p !== undefined) out.top_p = options.top_p;
  if (options?.num_predict !== undefined && options.num_predict > 0) {
    out.max_tokens = options.num_predict;
  }
  if (options?.stop?.length) out.stop = options.stop;
  if (options?.seed !== undefined) out.seed = options.seed;
  if (format === 'json') out.response_format = { type: 'json_object' };
  else if (format && typeof format === 'object') {
    out.response_format = {
      type: 'json_schema',
      json_schema: { name: 'response', schema: format },
    };
  }
  return out;
}

export function ollamaChatToOpenAI(req: OllamaChatRequest): OAIChatRequest {
  // Ollama tool calls carry no ids, so pair them with results by order.
  let sequence = 0;
  const pending: string[] = [];
  const messages: OAIMessage[] = req.messages.map((message): OAIMessage => {
    const content = message.content ?? '';
    switch (message.role) {
      case 'assistant': {
        const toolCalls = (message.tool_calls ?? []).map((call) => {
          const id = `call_${sequence++}`;
          pending.push(id);
          return {
            id,
            type: 'function' as const,
            function: {
              name: call.function.name,
              arguments: JSON.stringify(call.function.arguments),
            },
          };
        });
        return {
          role: 'assistant',
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        };
      }
      case 'tool':
        return { role: 'tool', tool_call_id: pending.shift() ?? `call_${sequence++}`, content };
      case 'system':
        return { role: 'system', content };
      default:
        return { role: 'user', content: withImages(content, message.images) };
    }
  });

  const out: OAIChatRequest = { model: req.model, messages, stream: req.stream ?? true };
  if (req.tools?.length) out.tools = req.tools;
  return applyOptions(out, req.options, req.format);
}

export function ollamaGenerateToOpenAI(req: OllamaGenerateRequest): OAIChatRequest {
  const messages: OAIMessage[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: withImages(req.prompt ?? '', req.images) });
  return applyOptions(
    { model: req.model, messages, stream: req.stream ?? true },
    req.options,
    req.format,
  );
}

function doneFields(finish: string | null, usage: OAIUsage | undefined | null) {
  return {
    done: true,
    done_reason: FINISH_TO_OLLAMA[finish ?? 'stop'] ?? 'stop',
    total_duration: 0,
    load_duration: 0,
    prompt_eval_count: usage?.prompt_tokens ?? 0,
    eval_count: usage?.completion_tokens ?? 0,
  };
}

export function openAIResponseToOllama(res: OAIChatResponse, model: string, mode: OllamaMode) {
  const choice = res.choices[0];
  const content = choice?.message.content ?? '';
  const createdAt = new Date().toISOString();
  const done = doneFields(choice?.finish_reason ?? null, res.usage);
  if (mode === 'generate') return { model, created_at: createdAt, response: content, ...done };
  const toolCalls = choice?.message.tool_calls?.map((call) => ({
    function: { name: call.function.name, arguments: parseArguments(call.function.arguments) },
  }));
  return {
    model,
    created_at: createdAt,
    message: {
      role: 'assistant',
      content,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    },
    ...done,
  };
}

export async function* openAIStreamToOllama(
  chunks: AsyncIterable<OAIChunk>,
  model: string,
  mode: OllamaMode,
): AsyncGenerator<string> {
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const piece = (content: string) =>
    mode === 'chat'
      ? {
          model,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content },
          done: false,
        }
      : { model, created_at: new Date().toISOString(), response: content, done: false };

  const tools = new Map<number, { name: string; args: string }>();
  let finish: string | null = null;
  let usage: OAIUsage | null | undefined;

  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.delta.content) yield line(piece(choice.delta.content));
    for (const call of choice.delta.tool_calls ?? []) {
      const tool = tools.get(call.index) ?? { name: '', args: '' };
      tool.name += call.function?.name ?? '';
      tool.args += call.function?.arguments ?? '';
      tools.set(call.index, tool);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  // Ollama sends a tool call as one complete message rather than as deltas.
  if (tools.size && mode === 'chat') {
    yield line({
      model,
      created_at: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [...tools.values()].map((tool) => ({
          function: { name: tool.name, arguments: parseArguments(tool.args) },
        })),
      },
      done: false,
    });
  }
  const last = piece('');
  yield line({ ...last, ...doneFields(finish, usage) });
}
