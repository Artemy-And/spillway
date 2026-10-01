import type { Model } from '../db/schema.ts';
import type { SSEEvent } from './sse.ts';
import type { AResponse, AStreamEvent, AUsage, OAIChatResponse, OAIChunk } from './types.ts';
import type { Wire } from './upstream.ts';

const PREVIEW_LIMIT = 4000;

/** Counts tokens and keeps the start of the answer while a response goes by. */
export class Meter {
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  text = '';

  #append(text: string | null | undefined) {
    if (text && this.text.length < PREVIEW_LIMIT) this.text += text;
  }

  #anthropicUsage(usage: Partial<AUsage> | undefined) {
    if (!usage) return;
    if (usage.input_tokens != null) this.inputTokens = usage.input_tokens;
    if (usage.output_tokens != null) this.outputTokens = usage.output_tokens;
    if (usage.cache_read_input_tokens != null) this.cacheReadTokens = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens != null) {
      this.cacheWriteTokens = usage.cache_creation_input_tokens;
    }
  }

  openAIChunk(chunk: OAIChunk) {
    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens;
      this.outputTokens = chunk.usage.completion_tokens;
    }
    this.#append(chunk.choices[0]?.delta?.content);
  }

  openAIResponse(res: OAIChatResponse) {
    this.inputTokens = res.usage?.prompt_tokens ?? 0;
    this.outputTokens = res.usage?.completion_tokens ?? 0;
    this.#append(res.choices[0]?.message?.content);
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

  sseEvent(wire: Wire, event: SSEEvent) {
    if (event.data === '[DONE]') return;
    try {
      const data: unknown = JSON.parse(event.data);
      if (wire === 'openai') this.openAIChunk(data as OAIChunk);
      else this.anthropicEvent(data as AStreamEvent);
    } catch {}
  }

  /** All prompt tokens, cached ones included. */
  get totalInput(): number {
    return this.inputTokens + this.cacheReadTokens + this.cacheWriteTokens;
  }

  /** USD. Cache reads bill at 10% of the input price, cache writes at 125%. */
  cost(model: Model): number {
    return (
      (this.inputTokens * model.inputPrice +
        this.cacheReadTokens * model.inputPrice * 0.1 +
        this.cacheWriteTokens * model.inputPrice * 1.25 +
        this.outputTokens * model.outputPrice) /
      1_000_000
    );
  }
}
