import { and, eq, isNull } from 'drizzle-orm';
import { parseToolObject } from '../comparison/tools.ts';
import type { AppContext } from '../context.ts';
import { nativeSessionStates } from '../db/schema.ts';
import type { Format } from '../gateway/handler.ts';
import type { Meter } from '../gateway/meter.ts';
import type { Target } from '../gateway/policy.ts';
import { type SSEEvent, UpstreamError } from '../gateway/sse.ts';
import { speaksResponses } from '../gateway/upstream.ts';
import { sha256 } from '../lib/crypto.ts';
import { maskPii } from '../lib/pii.ts';
import { nativeContextRequested } from './native-contract.ts';
import { RoutingSessionError } from './sessions.ts';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
function hash(value: unknown) {
  return sha256(JSON.stringify(canonical(value)));
}

/** State is a single append-only head. Clients keep native blocks; SQLite keeps only hashes. */
export async function prepareNativeState(
  ctx: AppContext,
  sessionId: string,
  format: Format,
  body: ObjectValue,
  target: Target,
) {
  let row = await ctx.db.query.nativeSessionStates.findFirst({
    where: eq(nativeSessionStates.sessionId, sessionId),
  });
  const requested = nativeContextRequested(format, body);
  if (!row && !requested) return null;
  if (!requested || (format !== 'responses' && format !== 'anthropic'))
    throw new RoutingSessionError('Native context mode cannot change within a session');
  if (
    (format === 'responses' && !speaksResponses(target.provider)) ||
    (format === 'anthropic' && target.provider.kind !== 'anthropic')
  )
    throw new RoutingSessionError(
      'Native context requires a provider speaking the same API; start with a compatible model',
      400,
    );
  const config = {
    format,
    tools: body.tools,
    system: body.system,
    instructions: body.instructions,
    thinking: body.thinking,
    reasoning: body.reasoning,
    temperature: body.temperature,
    top_p: body.top_p,
    stop_sequences: body.stop_sequences,
  };
  const configHash = hash(config);
  const credentialHash = sha256(target.provider.apiKeyEnc ?? '');
  if (!row) {
    const history = body.messages as ObjectValue[] | undefined;
    if (
      body.previous_response_id !== undefined ||
      history?.some((message) => message.role === 'assistant')
    )
      throw new RoutingSessionError(
        'Native context must start on the first turn; unknown history cannot be adopted',
      );
    await ctx.db
      .insert(nativeSessionStates)
      .values({ sessionId, format, configHash, credentialHash })
      .onConflictDoNothing();
    row = (await ctx.db.query.nativeSessionStates.findFirst({
      where: eq(nativeSessionStates.sessionId, sessionId),
    }))!;
  }
  if (
    row.format !== format ||
    row.configHash !== configHash ||
    row.credentialHash !== credentialHash
  )
    throw new RoutingSessionError(
      'Native API, instructions, reasoning settings or provider credentials changed; start a fresh session',
    );
  if (row.inFlight || row.interrupted)
    throw new RoutingSessionError(
      row.interrupted
        ? 'Native context was interrupted; start a fresh conversation with a new session ID'
        : 'Native session already has an active or interrupted turn; wait for completion or start a fresh session',
    );
  if (row.contextTokens > 1_000_000)
    throw new RoutingSessionError(
      'Native context exceeded its bounded history; start a fresh conversation',
      410,
    );
  if (format === 'responses') {
    if (
      row.headHash !==
      (body.previous_response_id === undefined ? null : hash(body.previous_response_id))
    )
      throw new RoutingSessionError(
        'previous_response_id must be the latest completed response from this key and session',
      );
    const items =
      typeof body.input === 'string'
        ? [{ role: 'user', content: body.input }]
        : (body.input as ObjectValue[]);
    if (
      items.some(
        (item) =>
          item.type !== 'function_call_output' &&
          ((item.type !== undefined && item.type !== 'message') ||
            !['user', 'system', 'developer'].includes(String(item.role))),
      )
    )
      throw new RoutingSessionError(
        'Stored Responses turns accept new messages and the outstanding function result only',
        400,
      );
    const results = items.filter((item) => item.type === 'function_call_output');
    if (
      results.length !== (row.pendingCallHash ? 1 : 0) ||
      (row.pendingCallHash && hash(results[0]?.call_id) !== row.pendingCallHash)
    )
      throw new RoutingSessionError(
        'Supply exactly the outstanding function result for the latest response',
      );
  } else if (row.headHash) {
    const messages = body.messages as ObjectValue[];
    if (
      messages.length <= row.historyLength ||
      hash(messages.slice(0, row.historyLength)) !== row.headHash ||
      messages.slice(row.historyLength).some((message) => message.role !== 'user')
    )
      throw new RoutingSessionError(
        'Replay the complete prior Messages history with unchanged thinking blocks and signatures, then append a user turn',
      );
  }
  return new NativeTurn(ctx, row, body, target);
}

export class NativeTurn {
  private ctx: AppContext;
  private row: typeof nativeSessionStates.$inferSelect;
  private body: ObjectValue;
  private target: Target;
  private requestId: string | null = null;
  private answer: ObjectValue | null = null;
  private blocks: ObjectValue[] = [];
  private openBlocks = new Set<number>();
  private partialJSON = new Map<number, string>();
  private bytes = 0;
  constructor(
    ctx: AppContext,
    row: typeof nativeSessionStates.$inferSelect,
    body: ObjectValue,
    target: Target,
  ) {
    this.ctx = ctx;
    this.row = row;
    this.body = body;
    this.target = target;
  }
  get contextTokens() {
    return this.row.contextTokens;
  }
  get pii() {
    return this.row.pii;
  }
  async claim(requestId: string) {
    const claimed = await this.ctx.db
      .update(nativeSessionStates)
      .set({ inFlight: requestId })
      .where(
        and(
          eq(nativeSessionStates.sessionId, this.row.sessionId),
          eq(nativeSessionStates.revision, this.row.revision),
          eq(nativeSessionStates.interrupted, false),
          isNull(nativeSessionStates.inFlight),
        ),
      )
      .returning({ id: nativeSessionStates.sessionId });
    if (!claimed.length)
      throw new RoutingSessionError(
        'Native session changed or another turn is active; retry using its latest completed context',
      );
    this.requestId = requestId;
  }
  observe(event: SSEEvent) {
    this.bytes += new TextEncoder().encode(event.data).length;
    if (this.bytes > 2_000_000)
      throw new UpstreamError('Native state response exceeded the supported size');
    const data: ObjectValue = JSON.parse(event.data);
    if (this.row.format === 'responses') {
      if (data.type === 'response.completed') this.answer = data.response as ObjectValue;
      return;
    }
    const index = data.index as number;
    if (data.type === 'message_start')
      this.answer = { ...(data.message as ObjectValue), content: this.blocks };
    else if (data.type === 'content_block_start') {
      if (
        !Number.isSafeInteger(index) ||
        index !== this.blocks.length ||
        !object(data.content_block)
      )
        throw new UpstreamError('Invalid native block sequence');
      this.blocks.push({ ...data.content_block });
      this.openBlocks.add(index);
    } else if (data.type === 'content_block_delta') {
      const block = this.blocks[index];
      const delta = data.delta as ObjectValue;
      if (!block || !this.openBlocks.has(index) || !object(delta))
        throw new UpstreamError('Invalid native block delta');
      const field = (
        { text_delta: 'text', thinking_delta: 'thinking', signature_delta: 'signature' } as Record<
          string,
          string
        >
      )[String(delta.type)];
      if (field && typeof delta[field] === 'string')
        block[field] = String(block[field] ?? '') + delta[field];
      else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string')
        this.partialJSON.set(index, (this.partialJSON.get(index) ?? '') + delta.partial_json);
      else throw new UpstreamError('Unsupported native block delta');
    } else if (data.type === 'content_block_stop') {
      if (!this.openBlocks.delete(index)) throw new UpstreamError('Invalid native block stop');
      if (this.partialJSON.has(index))
        this.blocks[index]!.input = parseToolObject(this.partialJSON.get(index)!);
    } else if (data.type === 'message_delta' && this.answer)
      this.answer.stop_reason = (data.delta as ObjectValue)?.stop_reason;
  }
  async complete(meter: Meter, pii: Record<string, number>, json?: unknown) {
    const answer = json ?? this.answer;
    if (
      !object(answer) ||
      this.openBlocks.size ||
      new TextEncoder().encode(JSON.stringify(answer)).length > 2_000_000
    )
      throw new UpstreamError('Incomplete or oversized native context response');
    let headHash: string;
    let historyLength = 0;
    let pendingCallHash: string | null = null;
    let visible = '';
    if (this.row.format === 'responses') {
      if (
        answer.status !== 'completed' ||
        typeof answer.id !== 'string' ||
        !answer.id.length ||
        answer.id.length > 200 ||
        !Array.isArray(answer.output)
      )
        throw new UpstreamError('Responses state was not completed');
      const calls = answer.output.filter((item) => object(item) && item.type === 'function_call');
      if (
        calls.length > 1 ||
        calls.some(
          (call) =>
            typeof call.call_id !== 'string' ||
            !call.call_id.length ||
            call.call_id.length > 200 ||
            typeof call.arguments !== 'string' ||
            !parseToolObject(call.arguments) ||
            !(this.body.tools as ObjectValue[]).some((tool) => tool.name === call.name),
        )
      )
        throw new UpstreamError('Unsupported outstanding Responses function call');
      pendingCallHash = calls.length ? hash(calls[0].call_id) : null;
      headHash = hash(answer.id);
      visible = JSON.stringify(
        answer.output.map((item) =>
          object(item) && item.type === 'reasoning'
            ? { ...item, encrypted_content: undefined }
            : object(item) && item.type === 'function_call'
              ? { ...item, arguments: parseToolObject(item.arguments as string) }
              : item,
        ),
      );
    } else {
      if (
        !['tool_use', 'end_turn', 'stop_sequence'].includes(String(answer.stop_reason)) ||
        !Array.isArray(answer.content) ||
        !answer.content.length
      )
        throw new UpstreamError('Messages context was not completed');
      const content = answer.content as ObjectValue[];
      if (
        content.some(
          (block) =>
            !object(block) ||
            (block.type === 'thinking'
              ? typeof block.thinking !== 'string' ||
                typeof block.signature !== 'string' ||
                !block.signature.length
              : block.type === 'redacted_thinking'
                ? typeof block.data !== 'string' || !block.data.length
                : block.type === 'text'
                  ? typeof block.text !== 'string'
                  : block.type === 'tool_use'
                    ? typeof block.id !== 'string' ||
                      !block.id.length ||
                      !object(block.input) ||
                      !(this.body.tools as ObjectValue[]).some((tool) => tool.name === block.name)
                    : true),
        ) ||
        content.filter((block) => block.type === 'tool_use').length > 1 ||
        (answer.stop_reason === 'tool_use') !== content.some((block) => block.type === 'tool_use')
      )
        throw new UpstreamError('Incomplete thinking signature or unsupported Messages block');
      const history = [...(this.body.messages as ObjectValue[]), { role: 'assistant', content }];
      historyLength = history.length;
      headHash = hash(history);
      visible = JSON.stringify(
        content.map((block) =>
          block.type === 'thinking'
            ? { ...block, signature: undefined }
            : block.type === 'redacted_thinking'
              ? { type: block.type }
              : block,
        ),
      );
    }
    const cap = (this.body.max_output_tokens ?? this.body.max_tokens) as number;
    const outputBound = Math.max(cap, meter.outputTokens);
    const wireBody = { ...this.body, model: this.target.model.upstreamModel };
    // Messages replay visible history, but a short signature may expand into full billed thinking.
    // Reserve every prior output cap in addition to its visible request bytes; never decode it.
    const contextTokens =
      this.row.format === 'anthropic'
        ? this.row.contextTokens + outputBound
        : Math.max(
            this.row.contextTokens +
              new TextEncoder().encode(JSON.stringify(wireBody)).length +
              512 +
              outputBound,
            meter.totalInput + outputBound,
          );
    const updated = await this.ctx.db
      .update(nativeSessionStates)
      .set({
        headHash,
        historyLength,
        pendingCallHash,
        contextTokens,
        pii: { ...this.row.pii, ...pii, ...maskPii(visible).found },
        revision: this.row.revision + 1,
        inFlight: null,
      })
      .where(
        and(
          eq(nativeSessionStates.sessionId, this.row.sessionId),
          eq(nativeSessionStates.inFlight, this.requestId!),
        ),
      )
      .returning({ id: nativeSessionStates.sessionId });
    if (!updated.length) throw new UpstreamError('Native session state could not be committed');
    this.requestId = null;
  }
  async fail(attempted: boolean) {
    if (!this.requestId) return;
    await this.ctx.db
      .update(nativeSessionStates)
      .set({ inFlight: null, interrupted: attempted })
      .where(
        and(
          eq(nativeSessionStates.sessionId, this.row.sessionId),
          eq(nativeSessionStates.inFlight, this.requestId),
        ),
      );
    this.requestId = null;
  }
}
