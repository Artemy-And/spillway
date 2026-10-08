// Minimal shapes of the four wire formats. Only the fields the gateway reads or
// translates are typed; everything else passes through untouched.

// OpenAI chat completions — also the internal canonical format.
export type OAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OAIMessage =
  | { role: 'system' | 'developer'; content: string | OAIContentPart[] }
  | { role: 'user'; content: string | OAIContentPart[] }
  | { role: 'assistant'; content: string | OAIContentPart[] | null; tool_calls?: OAIToolCall[] }
  | { role: 'tool'; content: string | OAIContentPart[]; tool_call_id: string };

export interface OAITool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

export type OAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface OAIChatRequest {
  model: string;
  messages: OAIMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  seed?: number;
  tools?: OAITool[];
  tool_choice?: OAIToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: unknown;
}

export interface OAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
  /** Part of prompt_tokens read from the provider's prompt cache. */
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

export interface OAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: 'assistant'; content: string | null; tool_calls?: OAIToolCall[] };
    finish_reason: string | null;
  }[];
  usage?: OAIUsage;
}

export interface OAIToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface OAIChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: 'assistant'; content?: string | null; tool_calls?: OAIToolCallDelta[] };
    finish_reason: string | null;
  }[];
  usage?: OAIUsage | null;
}

// Anthropic messages
export type AImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

export type ABlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: AImageSource }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content?:
        | string
        | ({ type: 'text'; text: string } | { type: 'image'; source: AImageSource })[];
      is_error?: boolean;
    }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string };

export interface AMessage {
  role: 'user' | 'assistant';
  content: string | ABlock[];
}

export interface ATool {
  name: string;
  description?: string;
  input_schema?: unknown;
  type?: string;
}

export type AToolChoice =
  | { type: 'auto' | 'any' | 'none'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean };

export interface ARequest {
  model: string;
  messages: AMessage[];
  system?: string | { type: 'text'; text: string }[];
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: ATool[];
  tool_choice?: AToolChoice;
}

export interface AUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** Cache writes by lifetime; one-hour entries cost twice the input price. */
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
}

export interface AResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ABlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AUsage;
}

export interface AStreamEvent {
  type: string;
  index?: number;
  message?: { id: string; model: string; usage?: Partial<AUsage> };
  content_block?: ABlock;
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  usage?: Partial<AUsage>;
  error?: { type: string; message: string };
}

// OpenAI Responses API (/v1/responses), the format Codex speaks. It has dozens of item and tool
// types; one loose shape each is enough, since the gateway reads only a few fields of them.
export interface RContentPart {
  /** input_text, output_text, refusal, input_image, input_file, … */
  type: string;
  text?: string;
  refusal?: string;
  image_url?: string;
  annotations?: unknown[];
}

export interface RItem {
  /** message (when missing), function_call, function_call_output, reasoning, … */
  type?: string;
  id?: string;
  role?: 'user' | 'assistant' | 'system' | 'developer';
  content?: string | RContentPart[];
  call_id?: string;
  name?: string;
  /** Set on calls of a tool that came inside a namespace */
  namespace?: string;
  /** function_call: JSON text */
  arguments?: string;
  /** custom_tool_call: the freeform text */
  input?: string;
  /** function_call_output and custom_tool_call_output */
  output?: string | RContentPart[];
  /** local_shell_call */
  action?: unknown;
  /** agent_message */
  author?: string;
  recipient?: string;
}

export interface RTool {
  /** function, custom (freeform text), namespace, web_search, tool_search, … */
  type: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  /** custom: plain text, or a grammar the text must follow */
  format?: { type: string; syntax?: string; definition?: string };
  /** namespace: the tools inside it */
  tools?: RTool[];
}

export type RToolChoice = 'auto' | 'none' | 'required' | { type: string; name?: string };

export interface RRequest {
  model: string;
  input: string | RItem[];
  instructions?: string | null;
  tools?: RTool[];
  tool_choice?: RToolChoice;
  stream?: boolean;
  max_output_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  text?: { format?: { type: string; name?: string; schema?: unknown; strict?: boolean } };
  previous_response_id?: string | null;
}

export interface RUsage {
  /** Includes the cached tokens */
  input_tokens: number;
  input_tokens_details?: { cached_tokens?: number | null } | null;
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens?: number | null } | null;
  total_tokens?: number;
}

export interface RResponse {
  id: string;
  object: 'response';
  created_at: number;
  status: string;
  model: string;
  output: (RItem & { status?: string })[];
  usage: RUsage | null;
  error: { code: string; message: string } | null;
  incomplete_details: { reason: string } | null;
}

export interface RStreamEvent {
  type: string;
  delta?: string;
  response?: Partial<RResponse>;
}

// Ollama native API
export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
}

export interface OllamaOptions {
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  stop?: string[];
  seed?: number;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  tools?: OAITool[];
  format?: unknown;
  options?: OllamaOptions;
}

export interface OllamaGenerateRequest {
  model: string;
  prompt?: string;
  system?: string;
  images?: string[];
  stream?: boolean;
  format?: unknown;
  options?: OllamaOptions;
}
