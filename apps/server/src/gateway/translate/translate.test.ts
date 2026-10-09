import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SSEEvent } from '../sse.ts';
import type { OAIChunk } from '../types.ts';
import {
  anthropicRequestToOpenAI,
  anthropicStreamToOpenAI,
  openAIRequestToAnthropic,
  openAIStreamToAnthropic,
} from './anthropic.ts';
import { ollamaChatToOpenAI, openAIStreamToOllama } from './ollama.ts';

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

async function* from<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}

const chunk = (
  delta: OAIChunk['choices'][number]['delta'],
  finish: string | null = null,
): OAIChunk => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

test('Anthropic tool round-trip becomes OpenAI tool calls and tool messages', () => {
  const req = anthropicRequestToOpenAI({
    model: 'claude',
    max_tokens: 100,
    system: [{ type: 'text', text: 'Be brief' }],
    tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object' } }],
    tool_choice: { type: 'any' },
    messages: [
      { role: 'user', content: 'Open a.txt' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.txt' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello' }] },
    ],
  });
  assert.deepEqual(req.messages, [
    { role: 'system', content: 'Be brief' },
    { role: 'user', content: 'Open a.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 't1', content: 'hello' },
  ]);
  assert.equal(req.tool_choice, 'required');
  assert.equal(req.tools?.[0]?.function.name, 'read');
});

test('a request for one tool call at a time carries over in both directions', () => {
  const tools = [{ type: 'function' as const, function: { name: 'read', parameters: {} } }];
  const messages = [{ role: 'user' as const, content: 'Open a.txt' }];
  const toAnthropic = (extra: object) =>
    openAIRequestToAnthropic({ model: 'claude', messages, tools, ...extra }).tool_choice;
  assert.deepEqual(toAnthropic({ parallel_tool_calls: false }), {
    type: 'auto',
    disable_parallel_tool_use: true,
  });
  assert.deepEqual(toAnthropic({ parallel_tool_calls: false, tool_choice: 'required' }), {
    type: 'any',
    disable_parallel_tool_use: true,
  });
  assert.equal(toAnthropic({ parallel_tool_calls: true }), undefined);

  const back = anthropicRequestToOpenAI({
    model: 'claude',
    max_tokens: 100,
    messages,
    tools: [{ name: 'read', input_schema: { type: 'object' } }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
  });
  assert.equal(back.tool_choice, 'auto');
  assert.equal(back.parallel_tool_calls, false);
});

test('OpenAI messages become alternating Anthropic turns', () => {
  const req = openAIRequestToAnthropic({
    model: 'gpt',
    max_tokens: 50,
    stop: 'END',
    messages: [
      { role: 'system', content: 'You help.' },
      { role: 'user', content: 'Hi' },
      { role: 'user', content: 'Again' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ],
  });
  assert.equal(req.system, 'You help.');
  assert.deepEqual(req.stop_sequences, ['END']);
  assert.deepEqual(req.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Hi' },
        { type: 'text', text: 'Again' },
      ],
    },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'done' }] },
  ]);
});

test('OpenAI stream becomes a well-formed Anthropic event stream', async () => {
  const events = await collect(
    openAIStreamToAnthropic(
      from([
        chunk({ role: 'assistant', content: 'Hel' }),
        chunk({ content: 'lo' }),
        chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a"' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
        chunk({}, 'tool_calls'),
        { ...chunk({}), choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
      ]),
      'local-model',
    ),
  );
  const types = events.map((event) => /^event: (\w+)/.exec(event)?.[1]);
  assert.deepEqual(types, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  const delta = JSON.parse(events.at(-2)!.split('data: ')[1]!);
  assert.equal(delta.delta.stop_reason, 'tool_use');
  assert.deepEqual(delta.usage, { input_tokens: 7, output_tokens: 3 });
});

test('Anthropic stream becomes OpenAI chunks with usage', async () => {
  const sse = (data: unknown): SSEEvent => ({ event: null, data: JSON.stringify(data) });
  const chunks = await collect(
    anthropicStreamToOpenAI(
      from([
        sse({
          type: 'message_start',
          message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 12, output_tokens: 1 } },
        }),
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
        sse({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 5 },
        }),
        sse({ type: 'message_stop' }),
      ]),
    ),
  );
  assert.equal(chunks.map((c) => c.choices[0]?.delta.content ?? '').join(''), 'Hi');
  assert.equal(chunks.at(-2)?.choices[0]?.finish_reason, 'stop');
  assert.deepEqual(chunks.at(-1)?.usage, {
    prompt_tokens: 12,
    completion_tokens: 5,
    total_tokens: 17,
  });
});

test('Ollama chat maps images, options and tool results', async () => {
  const req = ollamaChatToOpenAI({
    model: 'llava',
    options: { num_predict: 64, temperature: 0.2 },
    messages: [
      { role: 'user', content: 'What is this?', images: ['iVBORw0KGgo='] },
      { role: 'assistant', tool_calls: [{ function: { name: 'look', arguments: { x: 1 } } }] },
      { role: 'tool', content: 'a cat' },
    ],
  });
  assert.equal(req.stream, true);
  assert.equal(req.max_tokens, 64);
  assert.deepEqual(req.messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  });
  assert.deepEqual(req.messages[2], { role: 'tool', tool_call_id: 'call_0', content: 'a cat' });

  const lines = await collect(
    openAIStreamToOllama(
      from([
        chunk({ content: 'A ' }),
        chunk({ content: 'cat' }, 'stop'),
        { ...chunk({}), choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } },
      ]),
      'llava',
      'chat',
    ),
  );
  const parsed = lines.map((line) => JSON.parse(line));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].message.content, 'A ');
  assert.equal(parsed[2].done, true);
  assert.equal(parsed[2].eval_count, 2);
});
