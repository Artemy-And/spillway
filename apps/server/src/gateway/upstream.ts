import { existsSync } from 'node:fs';
import type { AppContext } from '../context.ts';
import type { Provider, ProviderKind } from '../db/schema.ts';
import { UpstreamError } from './sse.ts';

export type Wire = 'openai' | 'anthropic';

/** Ollama is reached through its OpenAI-compatible endpoint. */
export function wireOf(kind: ProviderKind): Wire {
  return kind === 'anthropic' ? 'anthropic' : 'openai';
}

// Inside Docker, "localhost" is the container itself; Ollama usually runs on the host.
const OLLAMA_HOST = existsSync('/.dockerenv') ? 'host.docker.internal' : 'localhost';

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  ollama: `http://${OLLAMA_HOST}:11434`,
};

function url(provider: Provider, path: string): string {
  const base = provider.baseUrl.replace(/\/+$/, '');
  return provider.kind === 'openai' ? `${base}${path}` : `${base}/v1${path}`;
}

function headers(ctx: AppContext, provider: Provider, incoming?: Headers): Headers {
  const out = new Headers({ 'content-type': 'application/json' });
  const apiKey = provider.apiKeyEnc ? ctx.vault.decrypt(provider.apiKeyEnc) : null;
  if (provider.kind === 'anthropic') {
    if (apiKey) out.set('x-api-key', apiKey);
    out.set('anthropic-version', incoming?.get('anthropic-version') ?? '2023-06-01');
    const beta = incoming?.get('anthropic-beta');
    if (beta) out.set('anthropic-beta', beta);
  } else if (apiKey) {
    out.set('authorization', `Bearer ${apiKey}`);
  }
  return out;
}

export async function callUpstream(
  ctx: AppContext,
  provider: Provider,
  path: string,
  init: { method?: string; body?: unknown; incoming?: Headers; signal?: AbortSignal } = {},
): Promise<Response> {
  try {
    return await fetch(url(provider, path), {
      method: init.method ?? 'POST',
      headers: headers(ctx, provider, init.incoming),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    const reason =
      error instanceof Error
        ? ((error.cause as Error | undefined)?.message ?? error.message)
        : String(error);
    throw new UpstreamError(`Could not reach ${provider.name}: ${reason}`, 502);
  }
}

/** Pulls a readable message out of any provider's error body. */
export async function upstreamFailure(provider: Provider, res: Response): Promise<UpstreamError> {
  const text = await res.text();
  let message = text.slice(0, 500);
  try {
    const body = JSON.parse(text) as {
      error?: string | { message?: string; metadata?: { raw?: unknown } };
      message?: string;
    };
    const error = typeof body.error === 'string' ? { message: body.error } : body.error;
    // Aggregators like OpenRouter put the real reason ("rate-limited upstream, retry shortly")
    // under metadata.raw and only "Provider returned error" in the message.
    const raw = typeof error?.metadata?.raw === 'string' ? error.metadata.raw : null;
    message = raw ?? error?.message ?? body.message ?? message;
  } catch {}
  // A rejected provider key is the gateway's problem, not the client's.
  const status = res.status === 401 || res.status === 403 ? 502 : res.status;
  return new UpstreamError(`${provider.name} returned ${res.status}: ${message}`, status);
}

/** Model ids the provider offers, for the "add models" picker. */
export async function listUpstreamModels(ctx: AppContext, provider: Provider): Promise<string[]> {
  const signal = AbortSignal.timeout(10_000);
  if (provider.kind === 'ollama') {
    const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/api/tags`, { signal }).catch(
      (error: Error) => {
        throw new UpstreamError(`Could not reach ${provider.name}: ${error.message}`);
      },
    );
    if (!res.ok) throw await upstreamFailure(provider, res);
    const body = (await res.json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((model) => model.name).sort();
  }
  const res = await callUpstream(ctx, provider, '/models', { method: 'GET', signal });
  if (!res.ok) throw await upstreamFailure(provider, res);
  const body = (await res.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((model) => model.id).sort();
}
