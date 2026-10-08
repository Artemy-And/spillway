import assert from 'node:assert/strict';
import { test } from 'node:test';
import { caseInput, toolScenarioInput } from './input.ts';
import { buildToolDefinitions, parseToolObject, validateToolCall } from './tools.ts';

const scenario = {
  mode: 'call' as const,
  definitions: [
    {
      name: 'lookup_stock',
      description: 'Look up synthetic inventory',
      parameters: '{"type":"object","properties":{"sku":{"type":"string"}}}',
    },
    {
      name: 'lookup_order',
      description: '',
      parameters: '{"type":"object"}',
    },
  ],
  steps: [
    {
      name: 'lookup_stock',
      arguments: '{"sku":"TEST-42","options":{"warehouse":"A","units":[1,2]}}',
      result: '{"stock":7}',
    },
  ],
};

function call(
  argumentsText: unknown = scenario.steps[0]!.arguments,
  name = 'lookup_stock',
  id = 'c1',
) {
  return { id, type: 'function', function: { name, arguments: argumentsText } };
}

test('tool definitions are parsed as inert data and retain the offered alternatives', () => {
  const definitions = buildToolDefinitions(scenario);
  assert.deepEqual(definitions[0], {
    type: 'function',
    function: {
      name: 'lookup_stock',
      description: 'Look up synthetic inventory',
      parameters: { type: 'object', properties: { sku: { type: 'string' } } },
    },
  });
  assert.equal(definitions[1]!.function.name, 'lookup_order');
  assert.equal(Object.hasOwn(definitions[1]!.function, 'description'), false);
});

test('tool arguments match structurally without relying on JSON property order', () => {
  const ids = new Set<string>();
  const result = validateToolCall(
    call('{"options":{"units":[1,2],"warehouse":"A"},"sku":"TEST-42"}'),
    scenario.steps[0]!,
    ids,
  );
  assert.equal(result.reason, null);
  assert.equal(result.call?.function.name, 'lookup_stock');
  assert.deepEqual([...ids], ['c1']);
});

test('unexpected functions, extra or missing arguments and array reorderings never consume fixtures', () => {
  const ids = new Set<string>();
  assert.equal(
    validateToolCall(call(undefined, 'lookup_order'), scenario.steps[0]!, ids).reason,
    'toolUnexpected',
  );
  for (const argumentsText of [
    '{"sku":"TEST-42"}',
    '{"sku":"TEST-42","options":{"warehouse":"A","units":[1,2]},"extra":true}',
    '{"sku":"TEST-42","options":{"warehouse":"A","units":[2,1]}}',
    '{"sku":"TEST-41","options":{"warehouse":"A","units":[1,2]}}',
  ]) {
    assert.equal(
      validateToolCall(call(argumentsText), scenario.steps[0]!, ids).reason,
      'toolArguments',
    );
  }
  assert.equal(ids.size, 0);
});

test('malformed arguments and excessive JSON depth are rejected before recursive matching', () => {
  const ids = new Set<string>();
  for (const raw of ['[1]', 'null', 'false', '{broken}', 1, '{}'.repeat(4001)]) {
    assert.equal(validateToolCall(call(raw), scenario.steps[0]!, ids).reason, 'toolArguments');
  }
  assert.equal(parseToolObject('{"n":1e400}'), null);
  assert.equal(parseToolObject(`${'{"v":'.repeat(40)}0${'}'.repeat(40)}`), null);
  assert.deepEqual(parseToolObject('{"v":"process.exit(1)"}'), { v: 'process.exit(1)' });
});

test('tool call identifiers are bounded, required and unique within the model cell', () => {
  const ids = new Set<string>();
  assert.equal(
    validateToolCall(call(undefined, undefined, ''), scenario.steps[0]!, ids).reason,
    'toolUnexpected',
  );
  assert.equal(
    validateToolCall(call(undefined, undefined, 'x'.repeat(201)), scenario.steps[0]!, ids).reason,
    'toolUnexpected',
  );
  assert.equal(validateToolCall(call(), scenario.steps[0]!, ids).reason, null);
  assert.equal(validateToolCall(call(), scenario.steps[0]!, ids).reason, 'toolSequence');
  assert.equal(
    validateToolCall({ ...call(), type: 'custom' }, scenario.steps[0]!, new Set()).reason,
    'toolUnexpected',
  );
});

test('tool cases require valid schemas, declared unique names and object arguments', () => {
  assert.equal(toolScenarioInput.safeParse(scenario).success, true);
  const invalid = [
    { ...scenario, definitions: [scenario.definitions[0], scenario.definitions[0]] },
    { ...scenario, definitions: [{ ...scenario.definitions[0], name: '9-invalid' }] },
    { ...scenario, definitions: [{ ...scenario.definitions[0], parameters: '{"type":"array"}' }] },
    {
      ...scenario,
      definitions: [
        { ...scenario.definitions[0], parameters: '{"type":"object","properties":[]}' },
      ],
    },
    { ...scenario, steps: [{ ...scenario.steps[0], name: 'undefined_tool' }] },
    { ...scenario, steps: [{ ...scenario.steps[0], arguments: '[1,2]' }] },
    { ...scenario, steps: [scenario.steps[0], scenario.steps[0]] },
    { ...scenario, mode: 'loop', steps: Array(4).fill(scenario.steps[0]) },
  ];
  for (const input of invalid) assert.equal(toolScenarioInput.safeParse(input).success, false);
});

test('tool scenario size includes all schemas and fixed results', () => {
  const large = {
    ...scenario,
    mode: 'loop',
    steps: Array(3).fill({ ...scenario.steps[0], result: 'x'.repeat(8000) }),
  };
  assert.equal(toolScenarioInput.safeParse(large).success, false);
});

test('call-only checks do not require final text, while loops preserve existing answer rules', () => {
  const base = { name: 'Inventory', prompt: 'Look up TEST-42', check: 'exact', expected: '' };
  assert.equal(caseInput.safeParse({ ...base, tools: scenario }).success, true);
  assert.equal(
    caseInput.safeParse({ ...base, tools: { ...scenario, mode: 'loop' } }).success,
    false,
  );
  assert.equal(caseInput.safeParse(base).success, false);
  assert.equal(
    caseInput.safeParse({ ...base, expected: '7', tools: { ...scenario, mode: 'loop' } }).success,
    true,
  );
});

test('property names resembling prototype fields remain ordinary exact JSON data', () => {
  const expected = { ...scenario.steps[0]!, arguments: '{"__proto__":{"test":1}}' };
  const result = validateToolCall(call(expected.arguments), expected, new Set());
  assert.equal(result.reason, null);
  assert.equal(Object.hasOwn({}, 'test'), false);
  assert.equal(validateToolCall(call('{}'), expected, new Set()).reason, 'toolArguments');
});
