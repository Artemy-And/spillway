import type { ComparisonInput, ToolScenario } from '@server/comparison/types.ts';
import { useI18n } from '../i18n/index.tsx';
import { Button, Field, Input, Segmented, Select } from './ui.tsx';

function boundedDepth(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (typeof value === 'number' && !Number.isFinite(value)) return false;
  if (!value || typeof value !== 'object') return true;
  return Object.values(value).every((child) => boundedDepth(child, depth + 1));
}
function jsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !boundedDepth(value))
    throw new Error('Invalid object');
  return value as Record<string, unknown>;
}

/** Preserve JSON source text while using the same fields and defaults as saved revisions. */
export function normalizeToolScenario(value: unknown): ToolScenario {
  if (!value || typeof value !== 'object') throw new Error('Invalid tools');
  const tools = value as Record<string, unknown>;
  if (
    (tools.mode !== 'call' && tools.mode !== 'loop') ||
    !Array.isArray(tools.definitions) ||
    tools.definitions.length < 1 ||
    tools.definitions.length > 4 ||
    !Array.isArray(tools.steps) ||
    tools.steps.length < 1 ||
    tools.steps.length > 3 ||
    (tools.mode === 'call' && tools.steps.length !== 1)
  )
    throw new Error('Invalid tools');
  const definitions = tools.definitions.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid tool');
    const tool = item as Record<string, unknown>;
    if (
      typeof tool.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name) ||
      (tool.description !== undefined &&
        (typeof tool.description !== 'string' || tool.description.length > 1000)) ||
      typeof tool.parameters !== 'string' ||
      tool.parameters.length > 8000
    )
      throw new Error('Invalid tool');
    const schema = jsonObject(tool.parameters);
    if (
      schema.type !== 'object' ||
      (schema.properties !== undefined &&
        (!schema.properties ||
          typeof schema.properties !== 'object' ||
          Array.isArray(schema.properties)))
    )
      throw new Error('Invalid schema');
    return {
      name: tool.name,
      description: (tool.description as string | undefined) ?? '',
      parameters: tool.parameters,
    };
  });
  const names = new Set(definitions.map((tool) => tool.name));
  if (names.size !== definitions.length) throw new Error('Duplicate tool');
  const steps = tools.steps.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid step');
    const step = item as Record<string, unknown>;
    if (
      typeof step.name !== 'string' ||
      !names.has(step.name) ||
      typeof step.arguments !== 'string' ||
      step.arguments.length > 8000 ||
      (step.result !== undefined && (typeof step.result !== 'string' || step.result.length > 8000))
    )
      throw new Error('Invalid step');
    jsonObject(step.arguments);
    return {
      name: step.name,
      arguments: step.arguments,
      result: (step.result as string | undefined) ?? '',
    };
  });
  const scenario = { mode: tools.mode, definitions, steps };
  if (JSON.stringify(scenario).length > 24000) throw new Error('Scenario too large');
  return scenario as ToolScenario;
}
export function validToolScenario(value: unknown): boolean {
  try {
    normalizeToolScenario(value);
    return true;
  } catch {
    return false;
  }
}
export function validComparisonTask(task: ComparisonInput['cases'][number]): boolean {
  if (
    !task.name.trim() ||
    task.name.length > 80 ||
    !task.prompt.trim() ||
    task.prompt.length > 12000 ||
    task.expected.length > 12000
  )
    return false;
  if (task.tools && !validToolScenario(task.tools)) return false;
  if (task.tools?.mode === 'call') return true;
  if ((task.check === 'exact' || task.check === 'contains') && !task.expected.trim()) return false;
  if (task.check === 'json' && task.expected.trim()) {
    try {
      JSON.parse(task.expected);
    } catch {
      return false;
    }
  }
  return true;
}

const blankTool = (name = 'get_order') => ({
  name,
  description: '',
  parameters: '{"type":"object","properties":{},"additionalProperties":false}',
});
const blankStep = (name = 'get_order') => ({ name, arguments: '{}', result: '' });
const textClass =
  'min-h-24 w-full rounded-lg border border-field bg-surface px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:outline-none disabled:opacity-60';

export function ToolScenarioEditor({
  tools,
  onChange,
  onExample,
}: {
  tools?: ToolScenario;
  onChange: (tools: ToolScenario | undefined) => void;
  onExample: (patch: Partial<ComparisonInput['cases'][number]>) => void;
}) {
  const { m } = useI18n();
  const t = m.toolEvaluations;
  const mode = tools?.mode ?? 'text';
  const example = () =>
    onExample({
      name: t.sampleName,
      prompt: t.samplePrompt,
      check: mode === 'call' ? 'manual' : 'contains',
      expected: mode === 'call' ? '' : 'paid',
      tools: {
        mode: mode === 'call' ? 'call' : 'loop',
        definitions: [
          {
            name: 'get_order',
            description: 'Look up an order by its ID and return its status.',
            parameters:
              '{"type":"object","properties":{"orderId":{"type":"string"}},"required":["orderId"],"additionalProperties":false}',
          },
        ],
        steps: [
          {
            name: 'get_order',
            arguments: '{"orderId":"DEMO-17"}',
            result: '{"orderId":"DEMO-17","status":"paid"}',
          },
        ],
      },
    });
  return (
    <div className="space-y-3">
      <Segmented
        label={t.mode}
        value={mode}
        options={[
          { value: 'text', label: t.text },
          { value: 'call', label: t.call },
          { value: 'loop', label: t.loop },
        ]}
        onChange={(next) =>
          onChange(
            next === 'text'
              ? undefined
              : {
                  mode: next,
                  definitions: tools?.definitions ?? [blankTool()],
                  steps:
                    next === 'call'
                      ? (tools?.steps ?? [blankStep()]).slice(0, 1)
                      : (tools?.steps ?? [blankStep()]),
                },
          )
        }
      />
      {tools && (
        <div className="space-y-4 rounded-lg border border-line p-4">
          <p className="text-xs leading-relaxed text-muted">
            {tools.mode === 'call' ? t.callHint : t.loopHint} {t.fixtureHint}
          </p>
          <Button onClick={example}>{t.example}</Button>
          <h4 className="text-sm font-semibold">
            {t.definitions} ({tools.definitions.length}/4)
          </h4>
          {tools.definitions.map((definition, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-position editable definitions
            <div key={index} className="space-y-3 rounded-lg bg-canvas/50 p-3">
              <div className="flex items-end gap-2">
                <Field className="flex-1" label={t.toolName}>
                  <Input
                    required
                    maxLength={64}
                    value={definition.name}
                    onChange={(e) =>
                      onChange({
                        ...tools,
                        definitions: tools.definitions.map((item, i) =>
                          i === index ? { ...item, name: e.target.value } : item,
                        ),
                        steps: tools.steps.map((step) =>
                          step.name === definition.name ? { ...step, name: e.target.value } : step,
                        ),
                      })
                    }
                  />
                </Field>
                <Button
                  variant="ghost"
                  disabled={tools.definitions.length === 1}
                  onClick={() =>
                    onChange({
                      ...tools,
                      definitions: tools.definitions.filter((_, i) => i !== index),
                    })
                  }
                >
                  {t.removeTool}
                </Button>
              </div>
              <Field label={t.description}>
                <Input
                  maxLength={1000}
                  value={definition.description}
                  onChange={(e) =>
                    onChange({
                      ...tools,
                      definitions: tools.definitions.map((item, i) =>
                        i === index ? { ...item, description: e.target.value } : item,
                      ),
                    })
                  }
                />
              </Field>
              <Field label={t.parameters} hint={t.parametersHint}>
                <textarea
                  required
                  className={textClass}
                  maxLength={8000}
                  value={definition.parameters}
                  onChange={(e) =>
                    onChange({
                      ...tools,
                      definitions: tools.definitions.map((item, i) =>
                        i === index ? { ...item, parameters: e.target.value } : item,
                      ),
                    })
                  }
                />
              </Field>
            </div>
          ))}
          <Button
            disabled={tools.definitions.length >= 4}
            onClick={() =>
              onChange({
                ...tools,
                definitions: [
                  ...tools.definitions,
                  blankTool(`tool_${tools.definitions.length + 1}`),
                ],
              })
            }
          >
            {t.addTool}
          </Button>
          <h4 className="text-sm font-semibold">
            {t.steps} ({tools.steps.length}/{tools.mode === 'call' ? 1 : 3})
          </h4>
          {tools.steps.map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered expected sequence
            <div key={index} className="space-y-3 rounded-lg bg-canvas/50 p-3">
              <div className="flex items-end gap-2">
                <Field className="flex-1" label={`${index + 1}. ${t.stepName}`}>
                  <Select
                    value={step.name}
                    onChange={(e) =>
                      onChange({
                        ...tools,
                        steps: tools.steps.map((item, i) =>
                          i === index ? { ...item, name: e.target.value } : item,
                        ),
                      })
                    }
                  >
                    {!tools.definitions.some((tool) => tool.name === step.name) && (
                      <option value={step.name}>{step.name}</option>
                    )}
                    {[...new Set(tools.definitions.map((tool) => tool.name))].map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {tools.mode === 'loop' && (
                  <Button
                    variant="ghost"
                    disabled={tools.steps.length === 1}
                    onClick={() =>
                      onChange({ ...tools, steps: tools.steps.filter((_, i) => i !== index) })
                    }
                  >
                    {t.removeStep}
                  </Button>
                )}
              </div>
              <Field label={t.arguments} hint={t.argumentsHint}>
                <textarea
                  required
                  className={textClass}
                  maxLength={8000}
                  value={step.arguments}
                  onChange={(e) =>
                    onChange({
                      ...tools,
                      steps: tools.steps.map((item, i) =>
                        i === index ? { ...item, arguments: e.target.value } : item,
                      ),
                    })
                  }
                />
              </Field>
              {tools.mode === 'loop' && (
                <Field label={t.result} hint={t.resultHint}>
                  <textarea
                    className={textClass}
                    maxLength={8000}
                    value={step.result}
                    onChange={(e) =>
                      onChange({
                        ...tools,
                        steps: tools.steps.map((item, i) =>
                          i === index ? { ...item, result: e.target.value } : item,
                        ),
                      })
                    }
                  />
                </Field>
              )}
            </div>
          ))}
          {tools.mode === 'loop' && (
            <Button
              disabled={tools.steps.length >= 3}
              onClick={() =>
                onChange({
                  ...tools,
                  steps: [...tools.steps, blankStep(tools.definitions[0]?.name)],
                })
              }
            >
              {t.addStep}
            </Button>
          )}
          {!validToolScenario(tools) && <p className="text-xs text-block-fg">{t.invalid}</p>}
        </div>
      )}
    </div>
  );
}
