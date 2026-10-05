import type { Context } from 'hono';
import type { AppContext } from '../context.ts';
import type { requestLogs } from '../db/schema.ts';
import { shortId } from '../lib/crypto.ts';
import { maskPii } from '../lib/pii.ts';
import { usd } from '../lib/time.ts';
import { cached, cacheKey, remember, wantsCache } from './cache.ts';
import { authenticate, errorResponse, PREVIEW, writeLog } from './handler.ts';
import { Meter } from './meter.ts';
import { decide, modelLabel, step } from './policy.ts';
import { UpstreamError } from './sse.ts';
import { callUpstream, upstreamFailure } from './upstream.ts';

/** OpenAI's /v1/embeddings, Ollama's /api/embed and its older /api/embeddings. */
export type EmbeddingsFormat = 'openai' | 'ollama-embed' | 'ollama-embeddings';

interface OAIEmbeddings {
  object: 'list';
  data: { object: 'embedding'; index: number; embedding: number[] | string }[];
  model: string;
  usage?: { prompt_tokens: number; total_tokens?: number } | null;
}

/** Texts and token arrays, as OpenAI takes them; Ollama sends text only. */
type Input = string | string[] | number[] | number[][];

function inputOf(format: EmbeddingsFormat, body: Record<string, unknown>): Input | null {
  const input = format === 'ollama-embeddings' ? body.prompt : body.input;
  if (typeof input === 'string') return input;
  if (Array.isArray(input) && input.length) return input as Input;
  return null;
}

const textsOf = (input: Input): string[] =>
  (Array.isArray(input) ? input : [input]).filter((item) => typeof item === 'string');

const count = (input: Input) => (Array.isArray(input) ? input.length : 1);

/** OpenAI SDKs ask for base64 by default; Ollama and some others answer with numbers anyway. */
function asBase64(vector: number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

function fromOpenAI(format: EmbeddingsFormat, res: OAIEmbeddings, model: string): unknown {
  const vectors = [...res.data]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding as number[]);
  if (format === 'ollama-embeddings') return { embedding: vectors[0] ?? [] };
  return {
    model,
    embeddings: vectors,
    total_duration: 0,
    load_duration: 0,
    prompt_eval_count: res.usage?.prompt_tokens ?? 0,
  };
}

export async function handleEmbeddings(
  ctx: AppContext,
  c: Context,
  format: EmbeddingsFormat,
): Promise<Response> {
  const started = Date.now();
  const errorFormat = format === 'openai' ? 'openai' : 'ollama-chat';
  const caller = await authenticate(ctx, c.req.raw.headers);
  if (!caller) {
    return errorResponse(
      errorFormat,
      401,
      'Missing or invalid Spillway key. Send it as "Authorization: Bearer sw-…" or "x-api-key: sw-…".',
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(errorFormat, 400, 'Request body must be JSON');
  }
  if (typeof body.model !== 'string' || !body.model) {
    return errorResponse(errorFormat, 400, 'Field "model" is required');
  }
  const input = inputOf(format, body);
  if (!input) {
    const field = format === 'ollama-embeddings' ? 'prompt' : 'input';
    return errorResponse(errorFormat, 400, `Field "${field}" must be text or a list of texts`);
  }

  const settings = await ctx.settings.get();
  const texts = textsOf(input);
  const scan = maskPii(texts.join('\n'));
  const decision = await decide(ctx, {
    caller,
    requestedName: body.model,
    pii: scan.found,
    settings,
    purpose: 'embeddings',
  });
  const what = step('info', `Embeddings for ${count(input)} text(s)`, 'embeddings', {
    count: count(input),
  });

  const id = shortId('req');
  const base: typeof requestLogs.$inferInsert = {
    id,
    keyId: caller.key.id,
    teamId: caller.key.teamId,
    format: format === 'openai' ? 'openai' : 'ollama',
    requestedModel: body.model,
    requestedModelId: decision.requested?.model.id ?? null,
    servedModelId: decision.target?.model.id ?? null,
    servedModel: decision.target ? modelLabel(decision.target) : null,
    servedLocal: decision.target?.provider.isLocal ?? false,
    providerName: decision.target?.provider.name ?? null,
    status: decision.status,
    result: decision.result,
    ruleId: decision.ruleId,
    trace: [what, ...decision.trace],
    pii: Object.keys(scan.found).length ? scan.found : null,
    promptPreview: settings.storePrompts
      ? maskPii(texts[0] ?? '').text.slice(0, PREVIEW) || null
      : null,
  };

  const target = decision.target;
  if (!target) {
    await writeLog(ctx, { ...base, latencyMs: Date.now() - started }, caller.key.id);
    return errorResponse(errorFormat, decision.status, decision.message);
  }

  // Indexing the same documents again is the most common repeat, and vectors never change.
  const cacheId =
    settings.cache.enabled && decision.result === 'ok' && !base.pii && wantsCache(c.req.raw.headers)
      ? cacheKey(caller.key.id, target.model, `embeddings:${format}`, body)
      : null;
  const headers = (cache: 'hit' | 'miss' | null) => ({
    'content-type': 'application/json',
    'x-spillway-request-id': id,
    'x-spillway-result': decision.result,
    'x-spillway-model': target.model.name,
    ...(cache ? { 'x-spillway-cache': cache } : {}),
  });
  const hit = cacheId ? await cached(ctx, cacheId) : null;
  if (hit) {
    await writeLog(
      ctx,
      {
        ...base,
        ruleId: 'cache',
        savedUsd: hit.costUsd,
        latencyMs: Date.now() - started,
        trace: [
          ...(base.trace ?? []).filter((s) => s.code !== 'sentTo'),
          step('info', `Answered from the cache: ${usd(hit.costUsd)} not spent`, 'cacheHit', {
            saved: hit.costUsd,
          }),
        ],
      },
      caller.key.id,
    );
    return new Response(hit.body, { headers: headers('hit') });
  }

  // Cloud providers get the usual deadline; local models run on our own hardware.
  const upstream = new AbortController();
  const client = c.req.raw.signal;
  if (client.aborted) upstream.abort(client.reason);
  else client.addEventListener('abort', () => upstream.abort(client.reason), { once: true });
  const seconds = ctx.env.UPSTREAM_TIMEOUT_SECONDS;
  const deadline = target.provider.isLocal
    ? undefined
    : setTimeout(
        () =>
          upstream.abort(
            new UpstreamError(`${target.provider.name} did not answer within ${seconds} s`, 504),
          ),
        seconds * 1000,
      );

  const meter = new Meter();
  try {
    if (target.provider.kind === 'anthropic') {
      throw new UpstreamError(
        `${target.provider.name} has no embeddings API; pick an OpenAI-compatible or Ollama model`,
        400,
      );
    }
    const request =
      format === 'openai'
        ? { ...body, model: target.model.upstreamModel }
        : {
            model: target.model.upstreamModel,
            input,
            ...(typeof body.dimensions === 'number' ? { dimensions: body.dimensions } : {}),
          };
    const res = await callUpstream(ctx, target.provider, '/embeddings', {
      body: request,
      signal: upstream.signal,
    });
    if (!res.ok) throw await upstreamFailure(target.provider, res);
    const json = (await res.json()) as OAIEmbeddings;
    if (!Array.isArray(json.data)) {
      throw new UpstreamError(`${target.provider.name} did not return embeddings`, 502);
    }
    meter.embeddingsResponse(json);
    if (format === 'openai' && body.encoding_format === 'base64') {
      for (const item of json.data) {
        if (Array.isArray(item.embedding)) item.embedding = asBase64(item.embedding);
      }
    }
    const costUsd = meter.cost(target.model);
    await writeLog(
      ctx,
      { ...base, inputTokens: meter.totalInput, costUsd, latencyMs: Date.now() - started },
      caller.key.id,
    );
    const out = format === 'openai' ? { ...json, model: target.model.name } : null;
    const text = JSON.stringify(out ?? fromOpenAI(format, json, target.model.name));
    if (cacheId) {
      const entry = { id: cacheId, keyId: caller.key.id, modelId: target.model.id, body: text };
      await remember(ctx, { ...entry, costUsd }, settings.cache.ttlHours);
    }
    return new Response(text, { headers: headers(cacheId ? 'miss' : null) });
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 502;
    const message = error instanceof Error ? error.message : 'Upstream request failed';
    await writeLog(
      ctx,
      {
        ...base,
        status,
        result: 'error',
        latencyMs: Date.now() - started,
        error: message,
        trace: [...(base.trace ?? []), step('block', message, 'upstreamError', { message })],
      },
      caller.key.id,
    );
    return errorResponse(errorFormat, status, message);
  } finally {
    clearTimeout(deadline);
  }
}
