import type { Meter } from './meter.ts';
import { type SSEEvent, UpstreamError } from './sse.ts';
import type { OAIChunk } from './types.ts';
import type { Wire } from './upstream.ts';

/** A closed transport is not proof that the provider completed its response. */
export class SessionStream {
  #finished = false;
  #stopped = false;
  private wire: Wire;
  constructor(wire: Wire) {
    this.wire = wire;
  }

  event(event: SSEEvent) {
    if (event.data === '[DONE]') {
      if (this.wire !== 'openai' || !this.#finished)
        throw new UpstreamError('Session stream ended without a finished response');
      this.#stopped = true;
      return;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    } catch {
      throw new UpstreamError('Session provider sent an invalid stream event');
    }
    if (data.error || data.type === 'error' || data.type === 'response.failed') {
      const error = (data.error ?? (data.response as { error?: unknown })?.error) as
        | { message?: string }
        | undefined;
      throw new UpstreamError(error?.message ?? 'Session provider reported a stream failure');
    }
    if (this.wire === 'openai') {
      const choices = data.choices as { finish_reason?: unknown }[] | undefined;
      if (!Array.isArray(choices)) throw new UpstreamError('Invalid session Chat stream event');
      if (choices.some((choice) => typeof choice.finish_reason === 'string')) this.#finished = true;
    } else if (this.wire === 'anthropic') {
      if (data.type === 'message_delta' && (data.delta as { stop_reason?: unknown })?.stop_reason)
        this.#finished = true;
      if (data.type === 'message_stop') this.#stopped = true;
    } else if (data.type === 'response.completed' || data.type === 'response.incomplete') {
      this.#finished = true;
      this.#stopped = true;
    }
  }

  end() {
    if (!this.#finished || !this.#stopped)
      throw new UpstreamError('Session provider stream interrupted before completion');
  }
}

export async function* sessionEvents(events: AsyncIterable<SSEEvent>, wire: Wire, meter: Meter) {
  const guard = new SessionStream(wire);
  for await (const event of events) {
    guard.event(event);
    meter.sseEvent(wire, event);
    yield event;
  }
  guard.end();
}

export async function* sessionChunks(events: AsyncIterable<SSEEvent>, meter: Meter) {
  for await (const event of sessionEvents(events, 'openai', meter)) {
    if (event.data !== '[DONE]') yield JSON.parse(event.data) as OAIChunk;
  }
}
