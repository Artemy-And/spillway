import type { OAIChunk } from './types.ts';

export interface SSEEvent {
  event: string | null;
  data: string;
}

export class UpstreamError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Incremental text/event-stream parser: feed decoded text, get complete events back. */
export class SSEParser {
  #buffer = '';
  #event: string | null = null;
  #data: string[] = [];

  feed(text: string): SSEEvent[] {
    this.#buffer += text;
    const events: SSEEvent[] = [];
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#line(line, events);
      newline = this.#buffer.indexOf('\n');
    }
    return events;
  }

  end(): SSEEvent[] {
    const events: SSEEvent[] = [];
    if (this.#buffer) this.#line(this.#buffer.replace(/\r$/, ''), events);
    this.#buffer = '';
    this.#line('', events);
    return events;
  }

  #line(line: string, events: SSEEvent[]) {
    if (line === '') {
      if (this.#data.length) events.push({ event: this.#event, data: this.#data.join('\n') });
      this.#event = null;
      this.#data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.#event = value;
    else if (field === 'data') this.#data.push(value);
  }
}

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    yield* parser.feed(decoder.decode(chunk, { stream: true }));
  }
  yield* parser.feed(decoder.decode());
  yield* parser.end();
}

export async function* openAIChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<OAIChunk> {
  for await (const event of parseSSE(body)) {
    if (event.data === '[DONE]') return;
    const parsed = JSON.parse(event.data) as OAIChunk & { error?: { message?: string } };
    if (parsed.error) throw new UpstreamError(parsed.error.message ?? 'Upstream stream error');
    yield parsed;
  }
}

export function sse(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}
