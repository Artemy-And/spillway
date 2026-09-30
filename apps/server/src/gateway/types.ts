// Minimal shapes of the three wire formats. Only the fields the gateway reads or
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
  response_format?: unknown;
}

export interface OAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
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

export type AToolChoice = { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string };

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
