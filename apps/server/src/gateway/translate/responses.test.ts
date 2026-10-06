import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UpstreamError } from '../sse.ts';
import type { OAIChunk, RRequest, RTool } from '../types.ts';
import {
  openAIResponseToResponses,
  openAIStreamToResponses,
  responsesRequestToOpenAI,
} from './responses.ts';

async function* from<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}

/** The events of a Responses stream, parsed. */
// biome-ignore lint/suspicious/noExplicitAny: tests assert on event fields directly
async function events(source: AsyncIterable<string>): Promise<any[]> {
  const out = [];
  for await (const text of source) out.push(JSON.parse(text.slice(text.indexOf('data: ') + 6)));
  return out;
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

// The tool kinds Codex sends: plain functions, a namespace, a freeform tool and built-ins.
const CODEX_TOOLS: RTool[] = [
  {
    type: 'function',
    name: 'exec_command',
    description: 'Run a command',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
  },
  {
    type: 'namespace',
    name: 'multi_agent_v1',
    tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }],
  },
  {
    type: 'custom',
    name: 'apply_patch',
    description: 'Edit files.',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: "*** Begin Patch"' },
  },
  { type: 'web_search' },
  { type: 'tool_search', name: 'tool_search' },
];

test('a Codex conversation becomes chat messages, with built-in tools left out', () => {
  const req = responsesRequestToOpenAI({
    model: 'gpt-5.5',
    instructions: 'You are Codex.',
    tools: CODEX_TOOLS,
    tool_choice: 'auto',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Sandbox on' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files' }] },
      { type: 'reasoning', id: 'rs_1' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking' }] },
      { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'a.txt' },
      { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'c2', output: 'Done' },
      {
        type: 'function_call',
        call_id: 'c3',
        name: 'spawn_agent',
        namespace: 'multi_agent_v1',
        arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'c3', output: [{ type: 'input_text', text: 'ok' }] },
    ],
  });

  assert.deepEqual(req.messages, [
    { role: 'system', content: 'You are Codex.' },
    { role: 'system', content: 'Sandbox on' },
    { role: 'user', content: 'List files' },
    {
      role: 'assistant',
      content: 'Looking',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'exec_command', arguments: '{"cmd":"ls"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c2',
          type: 'function',
          function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'c2', content: 'Done' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c3', type: 'function', function: { name: 'spawn_agent', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c3', content: 'ok' },
  ]);
  assert.deepEqual(
    req.tools?.map((tool) => tool.function.name),
    ['exec_command', 'spawn_agent', 'apply_patch'],
  );
  const patch = req.tools?.find((tool) => tool.function.name === 'apply_patch')?.function;
  assert.deepEqual(patch?.parameters, {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
    additionalProperties: false,
  });
  assert.match(patch?.description ?? '', /lark grammar:\nstart: "\*\*\* Begin Patch"/);
  assert.equal(req.tool_choice, 'auto');
});

test('images a tool returns follow all the tool results', () => {
  const image = { type: 'input_image', image_url: 'data:image/png;base64,iVBOR' };
  const req = responsesRequestToOpenAI({
    model: 'm',
    input: [
      { type: 'function_call', call_id: 'a', name: 'view_image', arguments: '{}' },
      { type: 'function_call', call_id: 'b', name: 'view_image', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: [image] },
      { type: 'function_call_output', call_id: 'b', output: 'no such file' },
      { role: 'user', content: 'What is on it?' },
    ],
  });
  assert.deepEqual(
    req.messages.map((message) => message.role),
    ['assistant', 'tool', 'tool', 'user', 'user'],
  );
  assert.equal(req.messages[1]?.content, '(image attached below)');
  assert.deepEqual(req.messages[3]?.content, [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } },
  ]);
});

test('a string input, limits and a JSON schema carry over', () => {
  const req = responsesRequestToOpenAI({
    model: 'm',
    input: 'Hi',
    max_output_tokens: 500,
    temperature: 0.2,
    text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } },
  });
  assert.deepEqual(req.messages, [{ role: 'user', content: 'Hi' }]);
  assert.equal(req.max_tokens, 500);
  assert.equal(req.temperature, 0.2);
  assert.deepEqual(req.response_format, {
    type: 'json_schema',
    json_schema: { name: 'answer', schema: { type: 'object' } },
  });
});

test('stored conversations cannot be translated', () => {
  assert.throws(
    () => responsesRequestToOpenAI({ model: 'm', input: 'Hi', previous_response_id: 'resp_1' }),
    (error) => error instanceof UpstreamError && error.status === 400,
  );
});

test('tools that share a name across namespaces get the namespace in front', () => {
  const req: RRequest = {
    model: 'm',
    input: 'Hi',
    tools: [
      { type: 'namespace', name: 'a', tools: [{ type: 'function', name: 'open' }] },
      { type: 'namespace', name: 'b', tools: [{ type: 'function', name: 'open' }] },
    ],
  };
  const out = responsesRequestToOpenAI(req);
  assert.deepEqual(
    out.tools?.map((tool) => tool.function.name),
    ['a__open', 'b__open'],
  );
  const answer = openAIResponseToResponses(
    {
      id: 'x',
      object: 'chat.completion',
      created: 0,
      model: 'm',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'k', type: 'function', function: { name: 'b__open', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    'm',
    req,
  );
  assert.deepEqual(answer.output[0], {
    type: 'function_call',
    id: answer.output[0]?.id,
    status: 'completed',
    call_id: 'k',
    name: 'open',
    namespace: 'b',
    arguments: '{}',
  });
});

test('a streamed answer becomes Responses events Codex can follow', async () => {
  const out = await events(
    openAIStreamToResponses(
      from([
        chunk({ role: 'assistant', content: 'Hel' }),
        chunk({ content: 'lo' }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd"' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }),
        chunk({
          tool_calls: [
            {
              index: 1,
              id: 'call_2',
              type: 'function',
              function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' },
            },
          ],
        }),
        chunk({}, 'tool_calls'),
        { ...chunk({}), choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
      ]),
      'gpt-5.5',
      { model: 'gpt-5.5', input: 'Hi', tools: CODEX_TOOLS },
    ),
  );

  assert.deepEqual(
    out.map((event) => event.type),
    [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.output_item.added',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.output_item.done',
      'response.completed',
    ],
  );
  assert.deepEqual(
    out.map((event) => event.sequence_number),
    out.map((_, index) => index),
  );
  const completed = out.at(-1).response;
  assert.equal(completed.status, 'completed');
  assert.deepEqual(
    completed.output.map((item: { type: string }) => item.type),
    ['message', 'function_call', 'custom_tool_call'],
  );
  assert.equal(completed.output[0].content[0].text, 'Hello');
  assert.equal(completed.output[1].call_id, 'call_1');
  assert.equal(completed.output[1].arguments, '{"cmd":"ls"}');
  assert.equal(completed.output[2].call_id, 'call_2');
  assert.equal(completed.output[2].input, '*** Begin Patch');
  assert.deepEqual(completed.usage, {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 120,
  });
});

test('an answer cut off by the token limit ends incomplete', async () => {
  const out = await events(
    openAIStreamToResponses(from([chunk({ content: 'Part' }), chunk({}, 'length')]), 'm', {
      model: 'm',
      input: 'Hi',
    }),
  );
  const last = out.at(-1);
  assert.equal(last.type, 'response.incomplete');
  assert.deepEqual(last.response.incomplete_details, { reason: 'max_output_tokens' });
});
