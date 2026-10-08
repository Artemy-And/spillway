import type { Model } from '../db/schema.ts';
import type { SSEEvent } from './sse.ts';
import type {
  AResponse,
  AStreamEvent,
  AUsage,
  OAIChatResponse,
  OAIChunk,
  OAIUsage,
  RResponse,
  RStreamEvent,
  RUsage,
} from './types.ts';
import type { Wire } from './upstream.ts';

const PREVIEW_LIMIT = 4000;

export type Prices = Pick<Model, 'inputPrice' | 'outputPrice' | 'cacheReadPrice'>;

/** Counts tokens and keeps the start of the answer while a response goes by. */
export class Meter {
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  /** All cache writes; the one-hour ones are also counted in `cacheWrite1hTokens`. */
  cacheWriteTokens = 0;
  cacheWrite1hTokens = 0;
  text = '';
  /** Why a stream the provider sent untouched ended in failure, if it did. */
  failure: string | null = null;
  #knownInput = false;
  #knownOutput = false;

  get usageKnown(): boolean {
    return (
      this.#knownInput &&
      this.#knownOutput &&
      [
        this.inputTokens,
        this.outputTokens,
        this.cacheReadTokens,
        this.cacheWriteTokens,
        this.cacheWrite1hTokens,
      ].every((value) => Number.isSafeInteger(value) && value >= 0)
    );
  }

  /** A failed attempt's cache usage and text must not carry over to the next provider. */
  reset() {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.cacheWrite1hTokens = 0;
    this.text = '';
    this.failure = null;
    this.#knownInput = false;
    this.#knownOutput = false;
  }

  #append(text: string | null | undefined) {
    if (text && this.text.length < PREVIEW_LIMIT) this.text += text;
  }

  #anthropicUsage(usage: Partial<AUsage> | undefined) {
    if (!usage) return;
    if (usage.input_tokens != null) {
      this.#knownInput = Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0;
      this.inputTokens = this.#knownInput ? usage.input_tokens : 0;
    }
    if (usage.output_tokens != null) {
      this.#knownOutput = Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0;
      this.outputTokens = this.#knownOutput ? usage.output_tokens : 0;
    }
    if (usage.cache_read_input_tokens != null) this.cacheReadTokens = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens != null) {
      this.cacheWriteTokens = usage.cache_creation_input_tokens;
    }
    if (usage.cache_creation?.ephemeral_1h_input_tokens != null) {
      this.cacheWrite1hTokens = usage.cache_creation.ephemeral_1h_input_tokens;
    }
  }

  /** OpenAI counts cached tokens inside prompt_tokens; they are billed at the cached price. */
  #openAIUsage(usage: OAIUsage) {
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const validCached =
      Number.isSafeInteger(cached) && cached >= 0 && cached <= usage.prompt_tokens;
    this.#knownInput =
      Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 && validCached;
    this.#knownOutput =
      Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0;
    this.cacheReadTokens = validCached ? cached : 0;
    this.inputTokens = this.#knownInput ? usage.prompt_tokens - cached : 0;
    this.outputTokens = this.#knownOutput ? usage.completion_tokens : 0;
  }

  /** The Responses API counts cached tokens inside input_tokens, like chat completions. */
  #responsesUsage(usage: RUsage | null | undefined) {
    if (!usage) return;
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    this.#knownInput =
      Number.isSafeInteger(usage.input_tokens) &&
      usage.input_tokens >= 0 &&
      Number.isSafeInteger(cached) &&
      cached >= 0 &&
      cached <= usage.input_tokens;
    this.#knownOutput = Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0;
    this.cacheReadTokens = this.#knownInput ? cached : 0;
    this.inputTokens = this.#knownInput ? usage.input_tokens - cached : 0;
    this.outputTokens = this.#knownOutput ? usage.output_tokens : 0;
  }

  openAIChunk(chunk: OAIChunk) {
    if (chunk.usage) this.#openAIUsage(chunk.usage);
    this.#append(chunk.choices[0]?.delta?.content);
  }

  openAIResponse(res: OAIChatResponse) {
    if (res.usage) this.#openAIUsage(res.usage);
    this.#append(res.choices[0]?.message?.content);
  }

  /** Embeddings bill their input only. */
  embeddingsResponse(res: { usage?: { prompt_tokens?: number } | null }) {
    this.inputTokens = res.usage?.prompt_tokens ?? 0;
  }

  anthropicEvent(event: AStreamEvent) {
    if (event.type === 'message_start') this.#anthropicUsage(event.message?.usage);
    if (event.type === 'message_delta') this.#anthropicUsage(event.usage);
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      this.#append(event.delta.text);
    }
  }

  anthropicResponse(res: AResponse) {
    this.#anthropicUsage(res.usage);
    for (const block of res.content) if (block.type === 'text') this.#append(block.text);
  }

  responsesEvent(event: RStreamEvent) {
    if (event.type === 'response.output_text.delta') this.#append(event.delta);
    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      this.#responsesUsage(event.response?.usage);
    }
    if (event.type === 'response.failed') {
      this.#responsesUsage(event.response?.usage);
      this.failure = event.response?.error?.message ?? 'The provider reported a failed response';
    }
  }

  responsesResponse(res: RResponse) {
    this.#responsesUsage(res.usage);
    for (const item of res.output ?? []) {
      if (item.type !== 'message' || typeof item.content === 'string') continue;
      for (const part of item.content ?? [])
        if (part.type === 'output_text') this.#append(part.text);
    }
  }

  sseEvent(wire: Wire, event: SSEEvent) {
    if (event.data === '[DONE]') return;
    try {
      const data: unknown = JSON.parse(event.data);
      if (wire === 'openai') this.openAIChunk(data as OAIChunk);
      else if (wire === 'responses') this.responsesEvent(data as RStreamEvent);
      else this.anthropicEvent(data as AStreamEvent);
    } catch {}
  }

  /** All prompt tokens, cached ones included. */
  get totalInput(): number {
    return this.inputTokens + this.cacheReadTokens + this.cacheWriteTokens;
  }

  /**
   * USD. Cache reads bill at the model's cached price (a tenth of the input price unless set),
   * five-minute cache writes at 125% of the input price, one-hour writes at 200%.
   * A price that is not set counts as zero.
   */
  cost(model: Prices): number {
    const input = model.inputPrice ?? 0;
    const cacheRead = model.cacheReadPrice ?? input * 0.1;
    const write1h = Math.min(this.cacheWrite1hTokens, this.cacheWriteTokens);
    return (
      (this.inputTokens * input +
        this.cacheReadTokens * cacheRead +
        (this.cacheWriteTokens - write1h) * input * 1.25 +
        write1h * input * 2 +
        this.outputTokens * (model.outputPrice ?? 0)) /
      1_000_000
    );
  }
}
