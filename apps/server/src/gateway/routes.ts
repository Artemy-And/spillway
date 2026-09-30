import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { type AppContext, VERSION } from '../context.ts';
import { models, providers } from '../db/schema.ts';
import { authenticate, errorResponse, type Format, handleGateway } from './handler.ts';
import { findModel } from './policy.ts';
import { callUpstream, upstreamFailure } from './upstream.ts';

/** Model ids a key may call: enabled ones, narrowed by its team and its own list. */
async function visibleModels(ctx: AppContext, headers: Headers) {
  const caller = await authenticate(ctx, headers);
  if (!caller) return null;
  const rows = await ctx.db
    .select({ model: models, provider: providers })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(eq(models.enabled, true))
    .all();
  return rows.filter(
    ({ model }) =>
      (!caller.team?.allowedModelIds || caller.team.allowedModelIds.includes(model.id)) &&
      (!caller.key.allowedModelIds || caller.key.allowedModelIds.includes(model.id)),
  );
}

/** OpenAI (/v1/chat/completions), Anthropic (/v1/messages) and Ollama (/api/*) endpoints. */
export function gatewayRoutes(ctx: AppContext) {
  const app = new Hono();
  const guarded = (format: Format) =>
    bodyLimit({
      maxSize: 32 * 1024 * 1024,
      onError: () => errorResponse(format, 413, 'Request body is larger than 32 MB'),
    });

  app.use('/v1/*', cors());
  app.use('/api/*', cors());

  app.post('/v1/chat/completions', guarded('openai'), (c) => handleGateway(ctx, c, 'openai'));
  app.post('/v1/messages', guarded('anthropic'), (c) => handleGateway(ctx, c, 'anthropic'));
  app.post('/api/chat', guarded('ollama-chat'), (c) => handleGateway(ctx, c, 'ollama-chat'));
  app.post('/api/generate', guarded('ollama-generate'), (c) =>
    handleGateway(ctx, c, 'ollama-generate'),
  );

  // One list that satisfies both OpenAI and Anthropic SDKs.
  app.get('/v1/models', async (c) => {
    const format: Format = c.req.header('anthropic-version') ? 'anthropic' : 'openai';
    const rows = await visibleModels(ctx, c.req.raw.headers);
    if (!rows) return errorResponse(format, 401, 'Missing or invalid Gatehouse key');
    const data = rows.map(({ model }) => ({
      id: model.name,
      object: 'model',
      type: 'model',
      created: Math.floor(model.createdAt.getTime() / 1000),
      created_at: model.createdAt.toISOString(),
      owned_by: 'gatehouse',
      display_name: model.label ?? model.name,
    }));
    return c.json({
      object: 'list',
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
    });
  });

  // Claude Code asks for token counts; forward to Anthropic or estimate.
  app.post('/v1/messages/count_tokens', async (c) => {
    const caller = await authenticate(ctx, c.req.raw.headers);
    if (!caller) return errorResponse('anthropic', 401, 'Missing or invalid Gatehouse key');
    const body = await c.req.json<{ model?: string }>().catch(() => null);
    if (!body?.model) return errorResponse('anthropic', 400, 'Field "model" is required');
    const target = await findModel(ctx.db, eq(models.name, body.model));
    if (target?.provider.kind === 'anthropic') {
      const res = await callUpstream(ctx, target.provider, '/messages/count_tokens', {
        body: { ...body, model: target.model.upstreamModel },
        incoming: c.req.raw.headers,
      });
      if (res.ok) return c.json(await res.json());
      const failure = await upstreamFailure(target.provider, res);
      return errorResponse('anthropic', failure.status, failure.message);
    }
    return c.json({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) });
  });

  // Enough of the Ollama API for Open WebUI and other Ollama clients.
  app.get('/api/version', (c) => c.json({ version: `0.0.0-gatehouse-${VERSION}` }));
  app.get('/api/tags', async (c) => {
    const rows = await visibleModels(ctx, c.req.raw.headers);
    if (!rows) return errorResponse('ollama-chat', 401, 'Missing or invalid Gatehouse key');
    return c.json({
      models: rows.map(({ model, provider }) => ({
        name: model.name,
        model: model.name,
        modified_at: model.createdAt.toISOString(),
        size: 0,
        digest: '',
        details: { family: provider.kind, format: provider.isLocal ? 'local' : 'cloud' },
      })),
    });
  });

  return app;
}
