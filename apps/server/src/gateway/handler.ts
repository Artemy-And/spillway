import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { admit } from '../budget/admission.ts';
import { cappedBody, unmodeledFees } from '../budget/estimate.ts';
import {
  attemptTotals,
  chargedSql,
  knownSql,
  type Reservation,
  release,
  settle,
} from '../budget/ledger.ts';
import type { AppContext } from '../context.ts';
import {
  apiKeys,
  models,
  type Result,
  requestLogs,
  type TraceStep,
  teams,
  users,
} from '../db/schema.ts';
import { sha256, shortId } from '../lib/crypto.ts';
import { maskPii, type PiiCounts } from '../lib/pii.ts';
import { usd } from '../lib/time.ts';
import { allowed, matchesFingerprint, routingTarget } from '../routing/resolve.ts';
import { RoutingSessionError, resolveSession } from '../routing/sessions.ts';
import type { Settings } from '../settings.ts';
import { cached, cacheKey, remember, wantsCache } from './cache.ts';
import { Meter } from './meter.ts';
import {
  type Caller,
  type Decision,
  decide,
  findModel,
  modelLabel,
  step,
  type Target,
} from './policy.ts';
import { SessionStream, sessionChunks, sessionEvents } from './session-stream.ts';
import { openAIChunks, parseSSE, SSEParser, sse, UpstreamError } from './sse.ts';
import {
  anthropicRequestToOpenAI,
  anthropicResponseToOpenAI,
  anthropicStreamToOpenAI,
  openAIRequestToAnthropic,
  openAIResponseToAnthropic,
  openAIStreamToAnthropic,
} from './translate/anthropic.ts';
import { textOf } from './translate/common.ts';
import {
  ollamaChatToOpenAI,
  ollamaGenerateToOpenAI,
  openAIResponseToOllama,
  openAIStreamToOllama,
} from './translate/ollama.ts';
import {
  openAIResponseToResponses,
  openAIStreamToResponses,
  responsesFailure,
  responsesRequestToOpenAI,
} from './translate/responses.ts';
import type {
  ABlock,
  AMessage,
  ARequest,
  AResponse,
  OAIChatRequest,
  OAIChatResponse,
  OAIChunk,
  OAIMessage,
  OllamaChatRequest,
  OllamaGenerateRequest,
  RContentPart,
  RItem,
  RRequest,
  RResponse,
} from './types.ts';
import { callUpstream, speaksResponses, upstreamFailure, type Wire, wireOf } from './upstream.ts';

/** `responses` is OpenAI's Responses API (/v1/responses), which Codex speaks. */
export type Format = 'openai' | 'anthropic' | 'ollama-chat' | 'ollama-generate' | 'responses';

export const PREVIEW = 2000;

const isOllama = (format: Format) => format === 'ollama-chat' || format === 'ollama-generate';

const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  429: 'rate_limit_error',
};

/** OpenAI's error codes for the gateway's refusals. */
const OPENAI_ERROR_CODES: Partial<Record<Result, string>> = {
  blocked_budget: 'insufficient_quota',
  blocked_model: 'model_not_found',
  blocked_pii: 'invalid_prompt',
  rate_limited: 'rate_limit_exceeded',
};

/** An error in the client's format; `result` says why the gateway refused, if it did. */
export function errorResponse(
  format: Format,
  status: number,
  message: string,
  result?: Result,
): Response {
  if (format === 'anthropic') {
    const type = ANTHROPIC_ERROR_TYPES[status] ?? 'api_error';
    return Response.json({ type: 'error', error: { type, message } }, { status });
  }
  if (isOllama(format)) return Response.json({ error: message }, { status });
  const code = (result && OPENAI_ERROR_CODES[result]) ?? null;
  // Codex retries any status it has no special case for, as if the connection had dropped. A 400
  // is final, and with `invalid_prompt` it shows the message as it is.
  const sent = format === 'responses' && (status === 403 || status === 404) ? 400 : status;
  const type =
    code === 'insufficient_quota'
      ? code
      : sent === 401
        ? 'authentication_error'
        : sent === 429
          ? 'rate_limit_error'
          : sent >= 500
            ? 'api_error'
            : 'invalid_request_error';
  return Response.json({ error: { message, type, code } }, { status: sent });
}

export async function authenticate(ctx: AppContext, headers: Headers): Promise<Caller | null> {
  const bearer = headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearer ?? headers.get('x-api-key');
  if (!token) return null;
  return callerWhere(ctx, eq(apiKeys.hash, sha256(token.trim())));
}

/** Internal admin jobs can charge an existing key without retrieving its plaintext secret. */
export function callerForKey(ctx: AppContext, keyId: string): Promise<Caller | null> {
  return callerWhere(ctx, eq(apiKeys.id, keyId));
}

async function callerWhere(ctx: AppContext, where: SQL): Promise<Caller | null> {
  const row = await ctx.db
    .select({ key: apiKeys, team: teams, user: users })
    .from(apiKeys)
    .leftJoin(teams, eq(apiKeys.teamId, teams.id))
    .leftJoin(users, eq(apiKeys.userId, users.id))
    .where(and(where, isNull(apiKeys.revokedAt)))
    .get();
  if (!row || row.user?.disabledAt) return null;
  return row;
}

function responsesText(content: string | RContentPart[] | undefined): string {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((part) => part.text ?? part.refusal ?? '')
    .filter(Boolean)
    .join('\n');
}

/**
 * Ollama drops the start of a prompt longer than its context (4096 tokens unless set otherwise)
 * without an error, and reports only the tokens it kept. Coding agents lose their instructions
 * that way, so a report far below the size of the request counts as a cut. The size is estimated
 * at four characters a token, leaving out inline images.
 */
export function promptCut(
  body: Record<string, unknown>,
  kept: number,
): { sent: number; kept: number } | null {
  const json = JSON.stringify(body, (key, value) =>
    key === 'images' || (typeof value === 'string' && value.startsWith('data:'))
      ? undefined
      : value,
  );
  const sent = Math.round(json.length / 4);
  return kept > 0 && sent >= kept * 1.5 && sent - kept >= 2000 ? { sent, kept } : null;
}

function decodedToolText(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : (JSON.stringify(parsed) ?? '');
  } catch {
    return value;
  }
}

/** Tool arguments may themselves contain JSON escapes; scan both the wire text and decoded data. */
function toolText(value: unknown): string {
  const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  if (typeof value !== 'string') return raw;
  const decoded = decodedToolText(value);
  return decoded === raw ? raw : `${raw}\n${decoded}`;
}

/** All text that would leave the building, plus the latest user turn for the log. */
function promptText(format: Format, body: Record<string, unknown>): { all: string; last: string } {
  const parts: string[] = [];
  if (body.tools !== undefined) parts.push(toolText(body.tools));
  let last = '';
  if (format === 'anthropic') {
    const req = body as unknown as ARequest;
    parts.push(textOf(req.system));
    for (const message of req.messages ?? ([] as AMessage[])) {
      const blocks: ABlock[] =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : message.content;
      const text = blocks
        .map((block) => {
          if (block.type === 'text') return block.text;
          if (block.type === 'tool_use') return toolText(block.input);
          if (block.type === 'tool_result') {
            const content =
              typeof block.content === 'string' ? block.content : textOf(block.content);
            const expanded = toolText(content);
            if (expanded !== content) parts.push(expanded);
            return decodedToolText(content);
          }
          return '';
        })
        .join('\n');
      parts.push(text);
      if (message.role === 'user' && text.trim()) last = text;
    }
  } else if (format === 'ollama-generate') {
    const req = body as unknown as OllamaGenerateRequest;
    parts.push(req.system ?? '', req.prompt ?? '');
    last = req.prompt ?? '';
  } else if (format === 'responses') {
    const req = body as unknown as RRequest;
    parts.push(req.instructions ?? '');
    const input: RItem[] =
      typeof req.input === 'string' ? [{ role: 'user', content: req.input }] : req.input;
    for (const item of input) {
      const message = (item.type ?? 'message') === 'message';
      // What tools return (files read, command output) goes to the model as well.
      const output =
        item.type === 'function_call_output' || item.type === 'custom_tool_call_output';
      const text = responsesText(message ? item.content : output ? item.output : undefined);
      parts.push(output ? toolText(text) : text);
      if (item.type === 'function_call') parts.push(toolText(item.arguments));
      else if (item.type === 'custom_tool_call') parts.push(toolText(item.input));
      else if (item.type === 'local_shell_call') parts.push(toolText(item.action));
      if (message && item.role === 'user' && text.trim()) last = text;
    }
  } else {
    const messages = (body.messages ?? []) as (
      | OAIMessage
      | OllamaChatRequest['messages'][number]
    )[];
    for (const message of messages) {
      const text = textOf(message.content as string);
      parts.push(message.role === 'tool' ? toolText(text) : text);
      if ('tool_calls' in message && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          parts.push(toolText(call?.function?.arguments));
        }
      }
      if (message.role === 'user' && text.trim()) last = text;
    }
  }
  return { all: parts.join('\n'), last };
}

function toOpenAIRequest(format: Format, body: Record<string, unknown>): OAIChatRequest {
  switch (format) {
    case 'anthropic':
      return anthropicRequestToOpenAI(body as unknown as ARequest);
    case 'ollama-chat':
      return ollamaChatToOpenAI(body as unknown as OllamaChatRequest);
    case 'ollama-generate':
      return ollamaGenerateToOpenAI(body as unknown as OllamaGenerateRequest);
    case 'responses':
      return responsesRequestToOpenAI(body as unknown as RRequest);
    default:
      return body as unknown as OAIChatRequest;
  }
}

/** `body` is the client's request; the Responses API answers in terms of the tools it declared. */
function fromOpenAIResponse(
  format: Format,
  res: OAIChatResponse,
  model: string,
  body: Record<string, unknown>,
): unknown {
  switch (format) {
    case 'anthropic':
      return openAIResponseToAnthropic(res, model);
    case 'ollama-chat':
      return openAIResponseToOllama(res, model, 'chat');
    case 'ollama-generate':
      return openAIResponseToOllama(res, model, 'generate');
    case 'responses':
      return openAIResponseToResponses(res, model, body as unknown as RRequest);
    default:
      return { ...res, model };
  }
}

async function* openAIToSSE(
  chunks: AsyncIterable<OAIChunk>,
  model: string,
): AsyncGenerator<string> {
  for await (const chunk of chunks) yield sse({ ...chunk, model });
  yield 'data: [DONE]\n\n';
}

function fromOpenAIStream(
  format: Format,
  chunks: AsyncIterable<OAIChunk>,
  model: string,
  body: Record<string, unknown>,
) {
  switch (format) {
    case 'anthropic':
      return openAIStreamToAnthropic(chunks, model);
    case 'ollama-chat':
      return openAIStreamToOllama(chunks, model, 'chat');
    case 'ollama-generate':
      return openAIStreamToOllama(chunks, model, 'generate');
    case 'responses':
      return openAIStreamToResponses(chunks, model, body as unknown as RRequest);
    default:
      return openAIToSSE(chunks, model);
  }
}

/** An error in the middle of a stream is sent as the client format's own error event. */
async function* withStreamErrors<T extends string | Uint8Array>(
  format: Format,
  source: AsyncIterable<T>,
): AsyncGenerator<T | string> {
  try {
    yield* source;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (format === 'anthropic')
      yield sse({ type: 'error', error: { type: 'api_error', message } }, 'error');
    else if (isOllama(format)) yield `${JSON.stringify({ error: message })}\n`;
    else if (format === 'responses') yield responsesFailure(message);
    else yield sse({ error: { message, type: 'api_error' } });
    throw error;
  }
}

async function* metered(chunks: AsyncIterable<OAIChunk>, meter: Meter): AsyncGenerator<OAIChunk> {
  for await (const chunk of chunks) {
    meter.openAIChunk(chunk);
    yield chunk;
  }
}

/**
 * Passes the provider's bytes through while metering them. Bytes before the first real event
 * (keep-alive comments some providers send while queued) are held back, so a stream that never
 * starts can still be failed over.
 */
async function* tapped(
  body: ReadableStream<Uint8Array>,
  wire: Wire,
  meter: Meter,
  strict = false,
): AsyncGenerator<Uint8Array> {
  const parser = new SSEParser();
  const guard = strict ? new SessionStream(wire) : null;
  const decoder = new TextDecoder();
  const held: Uint8Array[] = [];
  let started = false;
  for await (const chunk of body) {
    const events = parser.feed(decoder.decode(chunk, { stream: true }));
    for (const event of events) {
      guard?.event(event);
      meter.sseEvent(wire, event);
    }
    if (started) {
      yield chunk;
      continue;
    }
    held.push(chunk);
    if (events.length) {
      started = true;
      yield* held;
      held.length = 0;
    }
  }
  for (const event of [...parser.feed(decoder.decode()), ...parser.end()]) {
    guard?.event(event);
    meter.sseEvent(wire, event);
  }
  guard?.end();
  yield* held;
}

/**
 * Waits for the first item of a stream before the response is committed, so a provider that
 * fails or stalls before answering can still be retried elsewhere.
 */
async function primed<T>(source: AsyncIterable<T>): Promise<AsyncIterable<T>> {
  const iterator = source[Symbol.asyncIterator]();
  const first = await iterator.next();
  return (async function* () {
    try {
      if (first.done) return;
      yield first.value;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  })();
}

/** OpenRouter and friends can answer 200 with an error body when the model behind them fails. */
function assertAnswer(provider: Target['provider'], json: { error?: unknown; choices?: unknown }) {
  if (json.error && !json.choices) {
    const error = json.error as { message?: string; metadata?: { raw?: unknown } };
    const raw = typeof error.metadata?.raw === 'string' ? error.metadata.raw : null;
    throw new UpstreamError(`${provider.name}: ${raw ?? error.message ?? 'no answer'}`, 502);
  }
}

/** Turns an async source into a response body; `onEnd` runs exactly once, also on disconnect. */
function toBody(
  source: AsyncIterable<string | Uint8Array>,
  onEnd: (error?: unknown) => void,
  onCancel?: () => void,
) {
  const iterator = source[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let ended = false;
  const end = (error?: unknown) => {
    if (ended) return;
    ended = true;
    onEnd(error);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          end();
          controller.close();
        } else {
          controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value);
        }
      } catch (error) {
        end(error);
        controller.error(error);
      }
    },
    async cancel() {
      onCancel?.();
      end(new Error('Client disconnected'));
      await iterator.return?.();
    },
  });
}

interface Forwarded {
  response: Response;
  /** Resolves when the body is fully sent, with an error if it broke off. */
  done: Promise<unknown>;
}

async function forward(
  ctx: AppContext,
  c: Context,
  format: Format,
  body: Record<string, unknown>,
  target: Target,
  stream: boolean,
  meter: Meter,
  session = false,
): Promise<Forwarded> {
  const { model, provider } = target;
  const wire: Wire =
    format === 'responses' && speaksResponses(provider) ? 'responses' : wireOf(provider.kind);
  const incoming = c.req.raw.headers;
  const streamHeaders = {
    'content-type': isOllama(format) ? 'application/x-ndjson' : 'text/event-stream',
    'cache-control': 'no-cache',
  };
  let resolveDone: (error?: unknown) => void = () => {};
  const done = new Promise<unknown>((resolve) => {
    resolveDone = resolve;
  });

  // The client hanging up cancels the upstream call. A cloud provider also gets a deadline to
  // start answering; local models run on our own hardware and may simply be slow.
  const upstream = new AbortController();
  const client = c.req.raw.signal;
  if (client.aborted) upstream.abort(client.reason);
  else client.addEventListener('abort', () => upstream.abort(client.reason), { once: true });
  const seconds = ctx.env.UPSTREAM_TIMEOUT_SECONDS;
  const deadline = provider.isLocal
    ? undefined
    : setTimeout(
        () =>
          upstream.abort(
            new UpstreamError(`${provider.name} did not answer within ${seconds} s`, 504),
          ),
        seconds * 1000,
      );
  const signal = upstream.signal;

  try {
    // Same wire format on both sides: pass the body through untouched, only swap the model.
    if (format === wire) {
      const upstreamBody: Record<string, unknown> = { ...body, model: model.upstreamModel };
      if (wire === 'openai' && stream) {
        upstreamBody.stream_options = { ...(body.stream_options as object), include_usage: true };
      }
      const path = { openai: '/chat/completions', anthropic: '/messages', responses: '/responses' }[
        wire
      ];
      const res = await callUpstream(ctx, provider, path, { body: upstreamBody, incoming, signal });
      if (!res.ok) throw await upstreamFailure(provider, res);
      if (!stream || !res.body) {
        const json: unknown = await res.json();
        if (wire === 'openai') {
          const answer = json as OAIChatResponse & { error?: unknown };
          assertAnswer(provider, answer);
          meter.openAIResponse(answer);
        } else if (wire === 'responses') meter.responsesResponse(json as RResponse);
        else meter.anthropicResponse(json as AResponse);
        resolveDone();
        return { response: Response.json(json), done };
      }
      const source = await primed(tapped(res.body, wire, meter, session));
      // A Responses stream reports failure in an event, after the 200 has gone out.
      const ended = (error?: unknown) =>
        resolveDone(error ?? (meter.failure ? new UpstreamError(meter.failure) : undefined));
      return {
        response: new Response(
          toBody(session ? withStreamErrors(format, source) : source, ended, () =>
            upstream.abort(),
          ),
          { headers: streamHeaders },
        ),
        done,
      };
    }

    // Different formats: go through the OpenAI shape.
    const request: OAIChatRequest = {
      ...toOpenAIRequest(format, body),
      model: model.upstreamModel,
      stream,
    };
    if (stream) request.stream_options = { include_usage: true };
    else delete request.stream_options;

    let result: OAIChatResponse | null = null;
    let chunks: AsyncIterable<OAIChunk> | null = null;
    if (wire === 'openai') {
      const res = await callUpstream(ctx, provider, '/chat/completions', { body: request, signal });
      if (!res.ok) throw await upstreamFailure(provider, res);
      if (stream && res.body)
        chunks = await primed(
          session ? sessionChunks(parseSSE(res.body), meter) : openAIChunks(res.body),
        );
      else {
        const json = (await res.json()) as OAIChatResponse & { error?: unknown };
        assertAnswer(provider, json);
        result = json;
      }
    } else {
      const anthropic = openAIRequestToAnthropic(request);
      const res = await callUpstream(ctx, provider, '/messages', {
        body: anthropic,
        incoming,
        signal,
      });
      if (!res.ok) throw await upstreamFailure(provider, res);
      if (stream && res.body)
        chunks = await primed(
          anthropicStreamToOpenAI(
            session ? sessionEvents(parseSSE(res.body), wire, meter) : parseSSE(res.body),
          ),
        );
      else {
        const answer = (await res.json()) as AResponse;
        // Translation supplies compatibility defaults; only native usage proves a charge.
        meter.anthropicResponse(answer);
        result = anthropicResponseToOpenAI(answer);
      }
    }

    if (result) {
      if (wire === 'openai') meter.openAIResponse(result);
      resolveDone();
      return {
        response: Response.json(fromOpenAIResponse(format, result, model.name, body)),
        done,
      };
    }
    const out = withStreamErrors(
      format,
      fromOpenAIStream(format, session ? chunks! : metered(chunks!, meter), model.name, body),
    );
    return {
      response: new Response(
        toBody(out, resolveDone, () => upstream.abort()),
        { headers: streamHeaders },
      ),
      done,
    };
  } finally {
    clearTimeout(deadline);
  }
}

export async function writeLog(
  ctx: AppContext,
  row: typeof requestLogs.$inferInsert,
  keyId: string,
): Promise<void> {
  try {
    const tracked =
      row.id && typeof row.costKnown === 'boolean'
        ? sql`exists(select 1 from budget_reservations b where b.request_id = ${row.id})`
        : null;
    await ctx.db.insert(requestLogs).values(
      tracked
        ? {
            ...row,
            costUsd: sql`case when ${tracked} then ${chargedSql(row.id!)} else ${row.costUsd ?? 0} end`,
            costKnown: sql`case when ${tracked} then ${knownSql(row.id!)} else ${row.costKnown ? 1 : 0} end`,
            routingCostKnown: row.routingProfileId
              ? sql`case when ${tracked} then ${knownSql(row.id!)} else ${row.routingCostKnown === null ? null : row.routingCostKnown ? 1 : 0} end`
              : null,
          }
        : row,
    );
    await ctx.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyId));
  } catch (error) {
    console.error('Failed to write request log', error);
  }
}

export async function handleGateway(
  ctx: AppContext,
  c: Context,
  format: Format,
  internalCaller?: Caller,
): Promise<Response> {
  const started = Date.now();
  const caller = internalCaller ?? (await authenticate(ctx, c.req.raw.headers));
  if (!caller) {
    return errorResponse(
      format,
      401,
      'Missing or invalid Spillway key. Send it as "Authorization: Bearer sw-…" or "x-api-key: sw-…".',
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(format, 400, 'Request body must be JSON');
  }
  if (typeof body.model !== 'string' || !body.model) {
    return errorResponse(format, 400, 'Field "model" is required');
  }
  const requestedName = body.model;
  if (format === 'responses') {
    if (typeof body.input !== 'string' && !Array.isArray(body.input)) {
      return errorResponse(format, 400, 'Field "input" must be a string or an array');
    }
  } else if (format !== 'ollama-generate' && !Array.isArray(body.messages)) {
    return errorResponse(format, 400, 'Field "messages" must be an array');
  }

  const settings = await ctx.settings.get();
  const sessionToken = !internalCaller ? c.req.header('x-spillway-session') : undefined;
  let affinity: Awaited<ReturnType<typeof resolveSession>> | undefined;
  if (sessionToken !== undefined) {
    try {
      affinity = await resolveSession(ctx, caller, body, format, sessionToken);
      if (format === 'responses') body = { ...body, store: false };
    } catch (error) {
      if (!(error instanceof RoutingSessionError)) throw error;
      const id = shortId('req');
      await writeLog(
        ctx,
        {
          id,
          keyId: caller.key.id,
          teamId: caller.key.teamId,
          requestedModel: requestedName,
          format: isOllama(format) ? 'ollama' : format,
          status: error.status,
          result: 'blocked_model',
          latencyMs: Date.now() - started,
          costKnown: true,
          trace: [step('block', error.message, 'sessionBlocked', { message: error.message })],
        },
        caller.key.id,
      );
      const response = errorResponse(format, error.status, error.message, 'blocked_model');
      response.headers.set('x-spillway-request-id', id);
      response.headers.set('x-spillway-session-status', 'blocked');
      response.headers.set('x-spillway-result', 'blocked_model');
      return response;
    }
  }
  const text = promptText(format, body);
  const scan = maskPii(text.all);
  const decision: Decision = await decide(ctx, {
    caller,
    requestedName,
    pii: scan.found,
    settings,
    body,
    format,
    skipProfiles: !!internalCaller,
    affinity,
  });
  const stream = isOllama(format) ? body.stream !== false : body.stream === true;

  const id = shortId('req');
  const base: typeof requestLogs.$inferInsert = {
    id,
    createdAt: new Date(started),
    keyId: caller.key.id,
    teamId: caller.key.teamId,
    format: isOllama(format) ? 'ollama' : (format as 'openai' | 'anthropic' | 'responses'),
    requestedModel: requestedName,
    requestedModelId: decision.requested?.model.id ?? null,
    routingProfileId: decision.routingProfile?.id ?? null,
    routingProfileName: decision.routingProfile?.name ?? null,
    routingOutcome: decision.routingProfile
      ? !decision.target
        ? 'policy'
        : decision.routingApplied
          ? 'selected'
          : 'skipped'
      : null,
    routingCostKnown: decision.routingProfile && !decision.target ? true : null,
    servedModelId: decision.target?.model.id ?? null,
    servedModel: decision.target ? modelLabel(decision.target) : null,
    servedLocal: decision.target?.provider.isLocal ?? false,
    providerName: decision.target?.provider.name ?? null,
    status: decision.status,
    result: decision.result,
    costKnown: true,
    ruleId: decision.ruleId,
    trace: decision.trace,
    stream,
    pii: Object.keys(scan.found).length ? scan.found : null,
    promptPreview: settings.storePrompts ? maskPii(text.last).text.slice(0, PREVIEW) || null : null,
  };

  if (!decision.target) {
    await writeLog(ctx, { ...base, latencyMs: Date.now() - started }, caller.key.id);
    const response = errorResponse(format, decision.status, decision.message, decision.result);
    response.headers.set('x-spillway-request-id', id);
    response.headers.set('x-spillway-result', decision.result);
    if (affinity) response.headers.set('x-spillway-session-status', 'pinned');
    return response;
  }

  // With the cache on, a repeated request gets the stored answer. Only whole answers from the
  // model that was asked for are kept, and never for prompts with personal data in them.
  let cacheId =
    !affinity &&
    settings.cache.enabled &&
    !stream &&
    (decision.result === 'ok' ||
      (decision.routingApplied &&
        decision.target.model.id === decision.routingProfile?.candidateModelId)) &&
    !base.pii &&
    wantsCache(c.req.raw.headers)
      ? cacheKey(
          caller.key.id,
          decision.target.model,
          format,
          cappedBody(
            format,
            body,
            !decision.target.provider.isLocal &&
              (caller.key.dailyLimitUsd !== null ||
                caller.key.monthlyLimitUsd !== null ||
                caller.team?.monthlyBudgetUsd != null),
            format === 'openai' && speaksResponses(decision.target.provider),
          ),
        )
      : null;
  const hit = cacheId ? await cached(ctx, cacheId) : null;
  if (hit) {
    await writeLog(
      ctx,
      {
        ...base,
        ruleId: 'cache',
        savedUsd: hit.costUsd,
        routingCostKnown: decision.routingProfile ? true : null,
        latencyMs: Date.now() - started,
        trace: [
          ...decision.trace.filter((s) => s.code !== 'sentTo'),
          step('info', `Answered from the cache: ${usd(hit.costUsd)} not spent`, 'cacheHit', {
            saved: hit.costUsd,
          }),
        ],
      },
      caller.key.id,
    );
    return new Response(hit.body, {
      headers: {
        'content-type': 'application/json',
        'x-spillway-request-id': id,
        'x-spillway-result': decision.result,
        'x-spillway-model': decision.target.model.name,
        'x-spillway-cache': 'hit',
        ...(decision.routingProfile
          ? { 'x-spillway-routing-profile': decision.routingProfile.id }
          : {}),
      },
    });
  }

  const admission = await admit(ctx, {
    caller,
    target: decision.target,
    requestedModelId: decision.requested!.model.id,
    requestId: id,
    body,
    format,
    settings,
    allowLocal: affinity ? false : undefined,
  });
  if (admission.denied) {
    await writeLog(
      ctx,
      {
        ...base,
        servedModelId: null,
        servedModel: null,
        providerName: null,
        servedLocal: false,
        status: admission.status,
        result: 'blocked_budget',
        routingOutcome: decision.routingProfile ? 'policy' : null,
        routingCostKnown: decision.routingProfile ? true : null,
        trace: [...decision.trace, ...admission.trace],
        latencyMs: Date.now() - started,
      },
      caller.key.id,
    );
    const response = errorResponse(format, admission.status, admission.message, 'blocked_budget');
    response.headers.set('x-spillway-request-id', id);
    response.headers.set('x-spillway-result', 'blocked_budget');
    if (affinity) response.headers.set('x-spillway-session-status', 'pinned');
    return response;
  }
  let target = admission.target;
  let reservation: Reservation | null = admission.reservation;
  body = admission.body;
  if (target.model.id !== decision.target.model.id) cacheId = null;
  let result = target.model.id === decision.target.model.id ? decision.result : 'rerouted';
  let trace: TraceStep[] = [...decision.trace, ...admission.trace];
  let outage = false;
  let profileFallbackUsed = false;
  const attemptedModelId = target.model.id;
  const meter = new Meter();
  const settleAttempt = async (error?: unknown) => {
    if (!reservation) return;
    const known =
      error === undefined &&
      !unmodeledFees(body, target, format) &&
      meter.usageKnown &&
      target.model.inputPrice !== null &&
      target.model.outputPrice !== null;
    await settle(
      ctx.db,
      reservation,
      meter.cost(target.model),
      known,
      error === undefined ? 'missingUsage' : 'providerError',
    );
    reservation = null;
  };
  const finish = async (status: number, error?: unknown) => {
    await settleAttempt(error);
    const totals = await attemptTotals(ctx.db, id);
    const cost = totals.costUsd;
    if (!totals.known)
      trace.push(
        step(
          'warn',
          'Provider charges are unknown; remaining estimate stays reserved',
          'budgetUncertain',
          { amount: totals.heldUsd },
        ),
      );
    const requestedCost = decision.requested ? meter.cost(decision.requested.model) : cost;
    const failed = error !== undefined;
    const message = failed ? (error instanceof Error ? error.message : String(error)) : null;
    const cut =
      !failed && target.provider.kind === 'ollama' ? promptCut(body, meter.totalInput) : null;
    const routingCostKnown = totals.known;
    const eligible =
      decision.routingApplied &&
      !failed &&
      !outage &&
      !cut &&
      meter.usageKnown &&
      routingCostKnown &&
      target.model.id === decision.routingProfile?.candidateModelId &&
      decision.requested &&
      (decision.requested.provider.isLocal ||
        (decision.requested.model.inputPrice !== null &&
          decision.requested.model.outputPrice !== null));
    const baselineCostUsd = eligible
      ? decision.requested!.provider.isLocal
        ? 0
        : requestedCost
      : null;
    await writeLog(
      ctx,
      {
        ...base,
        attemptedModelId,
        servedModelId: target.model.id,
        servedModel: modelLabel(target),
        servedLocal: target.provider.isLocal,
        providerName: target.provider.name,
        status,
        result: failed && status !== 200 ? 'error' : result,
        // Only a failover the local model actually answered counts as one.
        ruleId: outage && !failed ? 'outage' : decision.ruleId,
        inputTokens: meter.totalInput,
        outputTokens: meter.outputTokens,
        costUsd: cost,
        costKnown: totals.known,
        // A failover is not a saving: the cloud model was not going to answer anyway.
        savedUsd:
          result === 'rerouted' && !outage && !decision.routingProfile
            ? Math.max(0, requestedCost - cost)
            : 0,
        routingOutcome: decision.routingProfile
          ? profileFallbackUsed || outage
            ? 'fallback'
            : !decision.routingApplied
              ? 'skipped'
              : target.model.id === decision.routingProfile.candidateModelId
                ? 'selected'
                : 'policy'
          : null,
        routingCostKnown: decision.routingProfile ? routingCostKnown : null,
        baselineCostUsd,
        routingSavingsUsd: baselineCostUsd === null ? null : baselineCostUsd - cost,
        latencyMs: Date.now() - started,
        responsePreview: settings.storePrompts
          ? maskPii(meter.text).text.slice(0, PREVIEW) || null
          : null,
        error: message,
        trace: failed
          ? [...trace, step('block', message!, 'upstreamError', { message: message! })]
          : cut
            ? [
                ...trace,
                step(
                  'warn',
                  `Ollama kept ${cut.kept} of about ${cut.sent} prompt tokens and dropped the start: its context is too small. Start Ollama with OLLAMA_CONTEXT_LENGTH=32768.`,
                  'promptCut',
                  cut,
                ),
              ]
            : trace,
      },
      caller.key.id,
    );
  };

  try {
    let forwarded: Forwarded;
    try {
      if (c.req.raw.signal.aborted) {
        if (reservation) await release(ctx.db, reservation);
        reservation = null;
        throw c.req.raw.signal.reason ?? new Error('Client disconnected');
      }
      forwarded = await forward(ctx, c, format, body, target, stream, meter, !!affinity);
    } catch (error) {
      await settleAttempt(error);
      if (affinity) throw error;
      if (c.req.raw.signal.aborted) throw error;
      const freshCaller = await callerForKey(ctx, caller.key.id);
      if (!freshCaller) throw error;
      const fallbackSettings = await ctx.settings.get();
      const baseline = await baselineFallback(
        ctx,
        freshCaller,
        decision,
        target,
        fallbackSettings,
        error,
        body,
        format,
        scan.found,
      );
      let local =
        baseline ?? (await failoverTarget(ctx, freshCaller, target, fallbackSettings, error));
      if (!local) throw error;
      const fallbackAdmission = await admit(ctx, {
        caller: freshCaller,
        target: local,
        requestedModelId: decision.requested!.model.id,
        requestId: id,
        body,
        format,
        settings: fallbackSettings,
        allowLocal: fallbackSettings.rerouteOnFailure,
      });
      if (fallbackAdmission.denied) throw error;
      local = fallbackAdmission.target;
      reservation = fallbackAdmission.reservation;
      body = fallbackAdmission.body;
      const reason = (error as Error).message;
      const failedProvider = target.provider.name;
      profileFallbackUsed = !!baseline && local.model.id === baseline.model.id;
      trace = [
        ...trace,
        ...fallbackAdmission.trace,
        step('warn', reason, 'providerFailed', { provider: failedProvider, message: reason }),
        step(
          'info',
          `${failedProvider} is unavailable → sent to ${modelLabel(local)}`,
          'failover',
          {
            provider: failedProvider,
            model: local.model.label ?? local.model.name,
          },
        ),
      ];
      if (profileFallbackUsed && baseline && decision.routingProfile) {
        trace.push(
          step(
            'warn',
            `Profile ${decision.routingProfile.name} fell back to ${baseline.model.name}`,
            'profileFallback',
            { profile: decision.routingProfile.name, model: baseline.model.name },
          ),
        );
      }
      target = local;
      result = profileFallbackUsed ? 'ok' : 'rerouted';
      outage = true;
      meter.reset();
      forwarded = await forward(ctx, c, format, body, local, stream, meter);
    }
    const { response, done } = forwarded;
    // An answer the local model gave in a provider's place is not what was asked for.
    const fresh = cacheId && !outage ? await response.clone().text() : null;
    const logged = done.then(async (error) => {
      await finish(200, error);
      if (cacheId && fresh && error === undefined) {
        const entry = { id: cacheId, keyId: caller.key.id, modelId: target.model.id, body: fresh };
        await remember(
          ctx,
          { ...entry, costUsd: meter.cost(target.model) },
          settings.cache.ttlHours,
        );
      }
    });
    // Comparisons read the finished log before sending the next request or checking its budget.
    if (!stream) await logged;
    else void logged;
    if (cacheId) response.headers.set('x-spillway-cache', 'miss');
    response.headers.set('x-spillway-request-id', id);
    response.headers.set('x-spillway-result', result);
    response.headers.set('x-spillway-model', target.model.name);
    if (affinity) {
      response.headers.set('x-spillway-session-status', 'pinned');
      response.headers.set('x-spillway-session-expires-at', affinity.row.expiresAt.toISOString());
    }
    if (internalCaller && !stream) {
      response.headers.set('x-spillway-usage-known', String(meter.usageKnown));
    }
    if (decision.routingProfile)
      response.headers.set('x-spillway-routing-profile', decision.routingProfile.id);
    return response;
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 502;
    const message = error instanceof Error ? error.message : 'Upstream request failed';
    await finish(status, error);
    const response = errorResponse(format, status, message);
    response.headers.set('x-spillway-request-id', id);
    response.headers.set('x-spillway-result', 'error');
    response.headers.set('x-spillway-model', target.model.name);
    if (affinity) response.headers.set('x-spillway-session-status', 'pinned');
    if (internalCaller && !stream) {
      response.headers.set('x-spillway-usage-known', String(meter.usageKnown));
    }
    return response;
  }
}

/**
 * The local model to answer with when a cloud provider is down, times out or rate limits us.
 * Client mistakes (4xx other than 429) are passed back as they are.
 */
async function failoverTarget(
  ctx: AppContext,
  caller: Caller,
  target: Target,
  settings: Settings,
  error: unknown,
): Promise<Target | null> {
  if (!(error instanceof UpstreamError) || (error.status < 500 && error.status !== 429)) {
    return null;
  }
  if (target.provider.isLocal || !caller.key.fallbackToLocal) return null;
  if (!settings.rerouteOnFailure || !settings.localModelId) return null;
  const local = await findModel(ctx.db, eq(models.id, settings.localModelId));
  return local?.provider.isLocal &&
    local.model.id !== target.model.id &&
    allowed(caller, local.model.id)
    ? local
    : null;
}

/** The original model is a separate, explicit fallback and must pass its own policy checks. */
async function baselineFallback(
  ctx: AppContext,
  caller: Caller,
  decision: Decision,
  target: Target,
  settings: Settings,
  error: unknown,
  body: Record<string, unknown>,
  format: Format,
  pii: PiiCounts,
): Promise<Target | null> {
  const profile = decision.routingProfile;
  if (
    !decision.routingApplied ||
    !profile?.fallbackOnError ||
    target.model.id !== profile.candidateModelId ||
    !(error instanceof UpstreamError) ||
    (error.status < 500 && error.status !== 429)
  )
    return null;
  const baseline = await routingTarget(ctx, profile.baselineModelId);
  if (!baseline || !matchesFingerprint(baseline, profile.evidence.baseline)) return null;
  const checked = await decide(ctx, {
    caller,
    requestedName: baseline.model.name,
    pii,
    settings,
    body,
    format,
    skipProfiles: true,
    skipRateLimit: true,
  });
  return checked.target?.model.id === baseline.model.id ? checked.target : null;
}
