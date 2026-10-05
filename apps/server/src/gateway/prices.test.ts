import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Meter } from './meter.ts';
import { listPrice, publishedPrice } from './prices.ts';

test('list prices find a model under any of its spellings', () => {
  const sonnet = { input: 3, output: 15, cacheRead: null };
  assert.deepEqual(listPrice('claude-sonnet-4-5'), sonnet);
  assert.deepEqual(listPrice('claude-sonnet-4-5-20250929'), sonnet, 'dated snapshot');
  assert.deepEqual(listPrice('anthropic/claude-sonnet-4.5'), sonnet, 'OpenRouter id');
  assert.deepEqual(listPrice('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2 });
  assert.deepEqual(listPrice('gpt-4o-2024-08-06'), { input: 2.5, output: 10, cacheRead: 1.25 });
  assert.deepEqual(listPrice('gpt-4o-mini'), { input: 0.15, output: 0.6, cacheRead: 0.075 });
  assert.equal(listPrice('models/gemini-2.5-flash')?.input, 0.3);
  assert.equal(listPrice('gemini-2.5-flash-preview-09-2025')?.input, 0.3);
  assert.equal(listPrice('gemini-2.5-flash-lite')?.input, 0.1, 'not confused with Flash');
  assert.equal(listPrice('mistral-small-2506')?.output, 0.3);
  assert.equal(listPrice('mistral-small-latest')?.output, 0.3);
  assert.equal(listPrice('grok-4-0709')?.input, 3);
  assert.equal(listPrice('text-embedding-3-small')?.input, 0.02);
});

test('models that are not on the list get no price', () => {
  assert.equal(listPrice('llama3.1:8b'), null);
  assert.equal(listPrice('gpt-4o-audio-preview'), null);
  assert.equal(listPrice('some-company/fine-tune-7'), null);
});

test('prices a provider publishes per token become prices per million', () => {
  assert.deepEqual(
    publishedPrice({
      pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
    }),
    { input: 3, output: 15, cacheRead: 0.3 },
  );
  assert.deepEqual(publishedPrice({ pricing: { prompt: '0', completion: '0' } }), {
    input: 0,
    output: 0,
    cacheRead: null,
  });
  assert.equal(publishedPrice({ pricing: { prompt: '-1', completion: '-1' } }), null);
  assert.equal(publishedPrice({}), null);
});

test('cached tokens cost the model’s cached price, one-hour cache writes twice the input', () => {
  const meter = new Meter();
  meter.anthropicResponse({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 10_000,
      cache_creation: { ephemeral_1h_input_tokens: 4000 },
    },
  });
  assert.equal(meter.totalInput, 111_000);
  // 1000×4 + 100000×0.20 + 6000×4×1.25 + 4000×4×2 + 500×20, per million
  const cost = meter.cost({ inputPrice: 4, outputPrice: 20, cacheReadPrice: 0.2 });
  assert.equal(Math.round(cost * 1e6), 96_000);
  // Without a cached price set, cache reads cost a tenth of the input price.
  const fallback = meter.cost({ inputPrice: 4, outputPrice: 20, cacheReadPrice: null });
  assert.equal(Math.round(fallback * 1e6), 116_000);
});

test('OpenAI cached tokens are split out of prompt_tokens', () => {
  const meter = new Meter();
  meter.openAIResponse({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-5',
    choices: [],
    usage: {
      prompt_tokens: 10_000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 8000 },
    },
  });
  assert.equal(meter.inputTokens, 2000);
  assert.equal(meter.cacheReadTokens, 8000);
  assert.equal(meter.totalInput, 10_000);
  // 2000×1.25 + 8000×0.125 + 100×10, per million
  const cost = meter.cost({ inputPrice: 1.25, outputPrice: 10, cacheReadPrice: 0.125 });
  assert.equal(Math.round(cost * 1e6), 4500);
});

test('a model without a price costs nothing', () => {
  const meter = new Meter();
  meter.inputTokens = 1000;
  meter.outputTokens = 1000;
  assert.equal(meter.cost({ inputPrice: null, outputPrice: null, cacheReadPrice: null }), 0);
});
