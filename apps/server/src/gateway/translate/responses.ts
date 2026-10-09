import { randomBytes } from 'node:crypto';
import { sse, UpstreamError } from '../sse.ts';
import type {
  OAIChatRequest,
  OAIChatResponse,
  OAIChunk,
  OAIContentPart,
  OAIMessage,
  OAITool,
  OAIToolCall,
  OAIUsage,
  RContentPart,
  RItem,
  RRequest,
  RResponse,
  RTool,
  RUsage,
} from '../types.ts';
import { parseArguments } from './common.ts';

const nowSeconds = () => Math.floor(Date.now() / 1000);
const randomId = () => randomBytes(12).toString('hex');

/** Finish reasons that leave a Responses answer incomplete, and the reason it reports. */
const INCOMPLETE: Record<string, string> = {
  length: 'max_output_tokens',
  content_filter: 'content_filter',
};

// ── Tools ─────────────────────────────────────────────────────────────────────

interface ToolInfo {
  name: string;
  namespace?: string;
  /** A freeform tool such as Codex's apply_patch: its text travels in one `input` argument. */
  custom: boolean;
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: { input: { type: 'string' } },
  required: ['input'],
  additionalProperties: false,
};

function customDescription(tool: RTool): string {
  const format = tool.format;
  const grammar = format?.type === 'grammar' && format.definition;
  const how = grammar
    ? `Pass the raw text in the "input" argument. It must follow this ${format.syntax ? `${format.syntax} ` : ''}grammar:\n${format.definition}`
    : 'Pass the raw text in the "input" argument.';
  return [tool.description, how].filter(Boolean).join('\n\n');
}

/**
 * Chat completions only knows flat functions. Tools inside a namespace keep their own name
 * (prefixed with the namespace only when two share it), and freeform tools become functions with
 * one text argument; `info` turns a call back into the tool the client declared.
 */
class Tools {
  readonly list: OAITool[] = [];
  readonly #info = new Map<string, ToolInfo>();
  readonly #flat = new Map<string, string>();

  constructor(tools: RTool[] = []) {
    const declared: { tool: RTool; namespace?: string }[] = [];
    for (const tool of tools) {
      if (tool.type === 'namespace') {
        for (const inner of tool.tools ?? []) declared.push({ tool: inner, namespace: tool.name });
      } else declared.push({ tool });
    }
    // Built-in tools (web search, tool search, …) run inside OpenAI; other models can't call them.
    const usable = declared.filter(
      ({ tool }) => (tool.type === 'function' || tool.type === 'custom') && tool.name,
    );
    const count = new Map<string, number>();
    for (const { tool } of usable) count.set(tool.name!, (count.get(tool.name!) ?? 0) + 1);

    for (const { tool, namespace } of usable) {
      const name = tool.name!;
      const flat = namespace && count.get(name)! > 1 ? `${namespace}__${name}`.slice(0, 64) : name;
      const custom = tool.type === 'custom';
      this.#info.set(flat, { name, namespace, custom });
      this.#flat.set(`${namespace ?? ''}/${name}`, flat);
      this.list.push({
        type: 'function',
        function: custom
          ? { name: flat, description: customDescription(tool), parameters: INPUT_SCHEMA }
          : {
              name: flat,
              description: tool.description,
              parameters: tool.parameters ?? { type: 'object', properties: {} },
            },
      });
    }
  }

  /** The function name a call in the conversation history goes by. */
  flat(name: string, namespace?: string): string {
    return this.#flat.get(`${namespace ?? ''}/${name}`) ?? name;
  }

  info(flat: string): ToolInfo | undefined {
    return this.#info.get(flat);
  }
}

// ── Responses client → chat-completions upstream ─────────────────────────────

type TextPart = Extract<OAIContentPart, { type: 'text' }>;
const isText = (part: OAIContentPart): part is TextPart => part.type === 'text';
const joinText = (parts: OAIContentPart[]) =>
  parts
    .filter(isText)
    .map((part) => part.text)
    .join('\n');

/** Text and images. Files, audio and file ids have no chat-completions form and are left out. */
function partsOf(content: string | RContentPart[] | undefined): OAIContentPart[] {
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const parts: OAIContentPart[] = [];
  for (const part of content) {
    if (part.type === 'input_image') {
      if (part.image_url) parts.push({ type: 'image_url', image_url: { url: part.image_url } });
      continue;
    }
    const text = part.type === 'refusal' ? part.refusal : part.text;
    if (text) parts.push({ type: 'text', text });
  }
  return parts;
}

const stored = (what: string) =>
  new UpstreamError(
    `${what} needs the conversation stored at OpenAI, and this request went to another provider. Send the whole conversation in "input" instead.`,
    400,
  );

export function responsesRequestToOpenAI(req: RRequest): OAIChatRequest {
  if (req.previous_response_id) throw stored('previous_response_id');
  const tools = new Tools(req.tools);
  const messages: OAIMessage[] = [];
  if (req.instructions) messages.push({ role: 'system', content: req.instructions });

  // Tool results must directly follow the assistant turn that asked for them, so images a tool
  // returned wait in a user message until the results are all in.
  const images: OAIContentPart[] = [];
  const flushImages = () => {
    if (images.length) messages.push({ role: 'user', content: images.splice(0) });
  };
  const call = (id: string | undefined, name: string, args: string) => {
    const toolCall: OAIToolCall = {
      id: id || `call_${randomId()}`,
      type: 'function',
      function: { name, arguments: args },
    };
    const last = messages.at(-1);
    if (last?.role === 'assistant') last.tool_calls = [...(last.tool_calls ?? []), toolCall];
    else messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
  };

  const input: RItem[] =
    typeof req.input === 'string' ? [{ role: 'user', content: req.input }] : req.input;
  for (const item of input) {
    const type = item.type ?? 'message';
    if (type !== 'function_call_output' && type !== 'custom_tool_call_output') flushImages();
    switch (type) {
      case 'message': {
        const parts = partsOf(item.content);
        // Not every OpenAI-compatible server takes content arrays, so text goes as a string.
        const text = joinText(parts);
        if (item.role === 'assistant') {
          if (text) messages.push({ role: 'assistant', content: text });
        } else if (item.role === 'system' || item.role === 'developer') {
          if (text) messages.push({ role: 'system', content: text });
        } else if (parts.length) {
          messages.push({ role: 'user', content: parts.every(isText) ? text : parts });
        }
        break;
      }
      case 'function_call':
        call(item.call_id, tools.flat(item.name ?? '', item.namespace), item.arguments || '{}');
        break;
      case 'custom_tool_call':
        call(
          item.call_id,
          tools.flat(item.name ?? '', item.namespace),
          JSON.stringify({ input: item.input ?? '' }),
        );
        break;
      case 'local_shell_call':
        call(item.call_id ?? item.id, 'local_shell', JSON.stringify(item.action ?? {}));
        break;
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const parts = partsOf(item.output);
        const pictures = parts.filter((part) => !isText(part));
        images.push(...pictures);
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id ?? '',
          content: joinText(parts) || (pictures.length ? '(image attached below)' : ''),
        });
        break;
      }
      case 'agent_message': {
        const text = joinText(partsOf(item.content));
        if (text) {
          messages.push({ role: 'user', content: item.author ? `${item.author}: ${text}` : text });
        }
        break;
      }
      case 'item_reference':
        throw stored('item_reference');
      // Reasoning, web and tool searches and compacted history are OpenAI's own state, much
      // of it encrypted; other models can't read it.
    }
  }
  flushImages();

  const out: OAIChatRequest = { model: req.model, messages };
  if (tools.list.length) {
    out.tools = tools.list;
    const choice = req.tool_choice;
    if (choice === 'auto' || choice === 'none' || choice === 'required') out.tool_choice = choice;
    else if (choice && (choice.type === 'function' || choice.type === 'custom') && choice.name) {
      out.tool_choice = { type: 'function', function: { name: tools.flat(choice.name) } };
    }
  }
  if (req.max_output_tokens) out.max_tokens = req.max_output_tokens;
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  const format = req.text?.format;
  if (format?.type === 'json_schema') {
    out.response_format = {
      type: 'json_schema',
      json_schema: {
        name: format.name ?? 'response',
        schema: format.schema,
        ...(format.strict !== undefined ? { strict: format.strict } : {}),
      },
    };
  } else if (format?.type === 'json_object') {
    out.response_format = { type: 'json_object' };
  }
  if (req.stream) out.stream = true;
  return out;
}

// ── Chat-completions upstream → Responses client ─────────────────────────────

type Item = RResponse['output'][number];

function usageOf(usage: OAIUsage | null | undefined): RUsage {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
}

const messageItem = (id: string, text: string): Item => ({
  type: 'message',
  id,
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
});

/** A chat-completions tool call as the kind of item the client declared the tool as. */
function callItem(tools: Tools, id: string, callId: string, flat: string, args: string): Item {
  const info = tools.info(flat);
  const namespace = info?.namespace ? { namespace: info.namespace } : {};
  if (info?.custom) {
    // Models sometimes skip the JSON wrapper and send the text itself.
    const input = parseArguments(args).input;
    return {
      type: 'custom_tool_call',
      id: id.replace(/^fc_/, 'ctc_'),
      status: 'completed',
      call_id: callId,
      name: info.name,
      ...namespace,
      input: typeof input === 'string' ? input : args,
    };
  }
  return {
    type: 'function_call',
    id,
    status: 'completed',
    call_id: callId,
    name: info?.name ?? flat,
    ...namespace,
    arguments: args || '{}',
  };
}

function response(
  id: string,
  created: number,
  model: string,
  output: Item[],
  usage: RUsage | null,
  finish: string | null,
): RResponse {
  const incomplete = INCOMPLETE[finish ?? ''];
  return {
    id,
    object: 'response',
    created_at: created,
    status: finish === null ? 'in_progress' : incomplete ? 'incomplete' : 'completed',
    model,
    output,
    usage,
    error: null,
    incomplete_details: incomplete ? { reason: incomplete } : null,
  };
}

export function openAIResponseToResponses(
  res: OAIChatResponse,
  model: string,
  req: RRequest,
): RResponse {
  const tools = new Tools(req.tools);
  const choice = res.choices[0];
  const output: Item[] = [];
  if (choice?.message.content)
    output.push(messageItem(`msg_${randomId()}`, choice.message.content));
  for (const call of choice?.message.tool_calls ?? []) {
    output.push(
      callItem(
        tools,
        `fc_${randomId()}`,
        call.id || `call_${randomId()}`,
        call.function.name,
        call.function.arguments,
      ),
    );
  }
  const finish = choice?.finish_reason ?? 'stop';
  return response(`resp_${randomId()}`, nowSeconds(), model, output, usageOf(res.usage), finish);
}

export async function* openAIStreamToResponses(
  chunks: AsyncIterable<OAIChunk>,
  model: string,
  req: RRequest,
): AsyncGenerator<string> {
  const tools = new Tools(req.tools);
  const id = `resp_${randomId()}`;
  const created = nowSeconds();
  let sequence = 0;
  const event = (type: string, data: object) =>
    sse({ type, sequence_number: sequence++, ...data }, type);

  // Items are numbered in the order they start; `done` holds the finished ones by number.
  const done: Item[] = [];
  let next = 0;
  let text: { index: number; id: string; value: string } | null = null;
  const calls = new Map<
    number,
    { index: number; id: string; callId: string; name: string; args: string }
  >();
  let finish: string | null = null;
  let usage: OAIUsage | null | undefined;

  const pending = response(id, created, model, [], null, null);
  yield event('response.created', { response: pending });
  yield event('response.in_progress', { response: pending });

  function* closeText(): Generator<string> {
    if (!text) return;
    const { index, id: itemId, value } = text;
    text = null;
    const part = { type: 'output_text', text: value, annotations: [] };
    const at = { item_id: itemId, output_index: index, content_index: 0 };
    yield event('response.output_text.done', { ...at, text: value });
    yield event('response.content_part.done', { ...at, part });
    done[index] = messageItem(itemId, value);
    yield event('response.output_item.done', { output_index: index, item: done[index] });
  }

  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    const { content, tool_calls } = choice.delta;
    if (content) {
      if (!text) {
        text = { index: next++, id: `msg_${randomId()}`, value: '' };
        yield event('response.output_item.added', {
          output_index: text.index,
          item: {
            type: 'message',
            id: text.id,
            status: 'in_progress',
            role: 'assistant',
            content: [],
          },
        });
        yield event('response.content_part.added', {
          item_id: text.id,
          output_index: text.index,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
      }
      text.value += content;
      yield event('response.output_text.delta', {
        item_id: text.id,
        output_index: text.index,
        content_index: 0,
        delta: content,
      });
    }
    for (const delta of tool_calls ?? []) {
      let call = calls.get(delta.index);
      if (!call) {
        yield* closeText();
        call = {
          index: next++,
          id: `fc_${randomId()}`,
          callId: delta.id || `call_${randomId()}`,
          name: delta.function?.name ?? '',
          args: '',
        };
        calls.set(delta.index, call);
        const item = callItem(tools, call.id, call.callId, call.name, '');
        yield event('response.output_item.added', {
          output_index: call.index,
          item: {
            ...item,
            status: 'in_progress',
            ...(item.type === 'function_call' ? { arguments: '' } : { input: '' }),
          },
        });
      }
      const piece = delta.function?.arguments;
      if (!piece) continue;
      call.args += piece;
      // A freeform tool's text is inside the JSON arguments; it is sent whole when the call ends.
      if (!tools.info(call.name)?.custom) {
        yield event('response.function_call_arguments.delta', {
          item_id: call.id,
          output_index: call.index,
          delta: piece,
        });
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  yield* closeText();
  for (const call of calls.values()) {
    const item = callItem(tools, call.id, call.callId, call.name, call.args);
    if (item.type === 'function_call') {
      yield event('response.function_call_arguments.done', {
        item_id: call.id,
        output_index: call.index,
        arguments: item.arguments,
      });
    }
    done[call.index] = item;
    yield event('response.output_item.done', { output_index: call.index, item });
  }

  const final = response(
    id,
    created,
    model,
    done.filter(Boolean),
    usageOf(usage),
    finish ?? 'stop',
  );
  yield event(final.status === 'incomplete' ? 'response.incomplete' : 'response.completed', {
    response: final,
  });
}

/** A stream that broke off, told the way Responses clients expect; Codex retries it. */
export function responsesFailure(message: string): string {
  return sse(
    {
      type: 'response.failed',
      response: {
        id: `resp_${randomId()}`,
        object: 'response',
        created_at: nowSeconds(),
        status: 'failed',
        output: [],
        usage: null,
        error: { code: 'server_error', message },
        incomplete_details: null,
      },
    },
    'response.failed',
  );
}
