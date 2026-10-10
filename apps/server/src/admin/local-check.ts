// Can the local model take over from a cloud model for Claude Code and Codex? They send 20–30
// thousand tokens a request and work through tool calls. Ollama runs a model with 4,096 tokens
// unless told otherwise and drops the start of a longer prompt without an error, and its
// OpenAI-compatible endpoint, which the gateway uses, has no way to ask for more per request.
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { models, type Provider } from '../db/schema.ts';
import type { Target } from '../gateway/policy.ts';
import { UpstreamError } from '../gateway/sse.ts';
import { callUpstream, upstreamFailure } from '../gateway/upstream.ts';

/** What a coding agent's request needs, with room for the answer. */
export const AGENT_CONTEXT = 32_768;

export interface LocalCheck {
  /** Tokens the server runs the model with now, and the most the model supports */
  context: { inUse: number | null; max: number | null; needed: number };
  /** Whether the model calls tools, which coding agents need; null when it cannot be told */
  tools: boolean | null;
  tokensPerSecond: number | null;
  /** A copy of the model with a longer context that Spillway can ask Ollama to make */
  fix: { name: string; context: number } | null;
}

export class LocalCheckError extends Error {}

const SPEED_PROMPT = 'Count from 1 to 30, separated by spaces.';

const ollamaBase = (provider: Provider) =>
  provider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

async function ollama<T>(
  provider: Provider,
  path: string,
  body?: unknown,
  ms = 180_000,
): Promise<T> {
  const res = await fetch(`${ollamaBase(provider)}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  }).catch((error: Error) => {
    throw new UpstreamError(`Could not reach ${provider.name}: ${error.message}`);
  });
  if (!res.ok) throw await upstreamFailure(provider, res);
  return (await res.json()) as T;
}

/** "qwen3:1.7b" stays, "llama3" is "llama3:latest", as Ollama lists running models. */
function nameAndTag(model: string): [string, string] {
  const colon = model.lastIndexOf(':');
  return colon > model.lastIndexOf('/')
    ? [model.slice(0, colon), model.slice(colon + 1)]
    : [model, 'latest'];
}
const tagged = (model: string) => nameAndTag(model).join(':');

/** "qwen3:1.7b" with 32,768 tokens becomes "qwen3:1.7b-32k". */
export function longerName(model: string, context: number): string {
  const [name, tag] = nameAndTag(model);
  return `${name}:${tag}-${Math.round(context / 1024)}k`;
}

interface Shown {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

/** The most tokens the model supports, from its own metadata. */
function maxContext(shown: Shown): number | null {
  const entry = Object.entries(shown.model_info ?? {}).find(([key]) =>
    key.endsWith('.context_length'),
  );
  return typeof entry?.[1] === 'number' ? entry[1] : null;
}

async function checkOllama(target: Target): Promise<LocalCheck> {
  const { provider } = target;
  const model = target.model.upstreamModel;
  const shown = await ollama<Shown>(provider, '/api/show', { model }, 30_000);
  const max = maxContext(shown);
  // Loads the model as the gateway's requests do, with the context Ollama gives it, and times
  // a short answer. A thinking model answers without thinking, so the timing is of plain output.
  const run = await ollama<{ eval_count?: number; eval_duration?: number }>(
    provider,
    '/api/generate',
    {
      model,
      prompt: SPEED_PROMPT,
      stream: false,
      ...(shown.capabilities?.includes('thinking') ? { think: false } : {}),
      options: { num_predict: 48 },
    },
  );
  const running = await ollama<{
    models?: { name: string; model?: string; context_length?: number }[];
  }>(provider, '/api/ps', undefined, 15_000);
  const loaded = running.models?.find((entry) =>
    [entry.name, entry.model ?? ''].some((name) => tagged(name) === tagged(model)),
  );
  const inUse = loaded?.context_length ?? null;
  const reachable = max === null ? AGENT_CONTEXT : Math.min(AGENT_CONTEXT, max);
  return {
    context: { inUse, max, needed: AGENT_CONTEXT },
    tools: shown.capabilities ? shown.capabilities.includes('tools') : null,
    tokensPerSecond:
      run.eval_count && run.eval_duration ? run.eval_count / (run.eval_duration / 1e9) : null,
    fix:
      inUse !== null && inUse < reachable
        ? { name: longerName(model, reachable), context: reachable }
        : null,
  };
}

/** LM Studio, vLLM and other OpenAI-compatible servers do not say their context size. */
async function checkCompatible(ctx: AppContext, target: Target): Promise<LocalCheck> {
  const ask = async (body: Record<string, unknown>) => {
    const res = await callUpstream(ctx, target.provider, '/chat/completions', {
      body: { model: target.model.upstreamModel, stream: false, ...body },
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw await upstreamFailure(target.provider, res);
    return (await res.json()) as {
      choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[];
      usage?: { completion_tokens?: number };
    };
  };
  const started = performance.now();
  const timed = await ask({ messages: [{ role: 'user', content: SPEED_PROMPT }], max_tokens: 48 });
  const seconds = (performance.now() - started) / 1000;
  const called = await ask({
    messages: [{ role: 'user', content: 'What is the weather in Paris? Use get_weather.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Current weather in a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
    max_tokens: 256,
  });
  const tokens = timed.usage?.completion_tokens;
  return {
    context: { inUse: null, max: null, needed: AGENT_CONTEXT },
    tools:
      called.choices?.[0]?.message?.tool_calls?.some(
        (call) => call.function?.name === 'get_weather',
      ) ?? false,
    tokensPerSecond: tokens && seconds > 0 ? tokens / seconds : null,
    fix: null,
  };
}

export function checkLocal(ctx: AppContext, target: Target): Promise<LocalCheck> {
  if (!target.provider.isLocal) throw new LocalCheckError('Only a local model can be checked here');
  return target.provider.kind === 'ollama' ? checkOllama(target) : checkCompatible(ctx, target);
}

/**
 * Asks Ollama for a copy of the model that runs with a longer context (no new download, more
 * memory in use) and points the Spillway model at it, so clients keep the same model name.
 */
export async function lengthenContext(ctx: AppContext, target: Target) {
  if (!target.provider.isLocal || target.provider.kind !== 'ollama') {
    throw new LocalCheckError('Only an Ollama model can get a longer context here');
  }
  const model = target.model.upstreamModel;
  const max = maxContext(await ollama<Shown>(target.provider, '/api/show', { model }, 30_000));
  const context = max === null ? AGENT_CONTEXT : Math.min(AGENT_CONTEXT, max);
  const name = longerName(model, context);
  await ollama(target.provider, '/api/create', {
    model: name,
    from: model,
    parameters: { num_ctx: context },
    stream: false,
  });
  await ctx.db.update(models).set({ upstreamModel: name }).where(eq(models.id, target.model.id));
  return { upstreamModel: name, context };
}
