import type { Check, ComparisonInput } from '@server/comparison/types.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { EvaluationResults } from '../components/EvaluationResults.tsx';
import { ProfileFromComparison } from '../components/ProfileFromComparison.tsx';
import { matchesTaskSet, TaskSetLibrary } from '../components/TaskSetLibrary.tsx';
import {
  Button,
  Card,
  cx,
  Empty,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Progress,
  Select,
  Status,
  type Tone,
} from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import {
  api,
  type ComparisonReport,
  meQuery,
  modelsQuery,
  type TaskSetRow,
  unwrap,
} from '../lib/api.ts';
import { fmtDate, fmtNumber } from '../lib/format.ts';

type Task = ComparisonInput['cases'][number] & { id: string };
const CHECKS: Check[] = ['manual', 'contains', 'exact', 'json'];
const TONES: Record<ComparisonReport['cells'][number]['status'], Tone> = {
  queued: 'off',
  running: 'info',
  passed: 'ok',
  failed: 'block',
  review: 'warn',
  error: 'block',
  skipped: 'off',
};
const textareaClass =
  'min-h-24 w-full rounded-lg border border-field bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-60';

function Textarea(props: ComponentProps<'textarea'>) {
  return <textarea className={textareaClass} {...props} />;
}

function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function tasksFromJson(value: unknown): Task[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20)
    throw new Error('Invalid tasks');
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid task');
    const task = item as Record<string, unknown>;
    if (
      typeof task.name !== 'string' ||
      !task.name.trim() ||
      task.name.length > 80 ||
      typeof task.prompt !== 'string' ||
      !task.prompt.trim() ||
      task.prompt.length > 12000 ||
      !CHECKS.includes(task.check as Check) ||
      (task.expected !== undefined && typeof task.expected !== 'string')
    )
      throw new Error('Invalid task');
    const expected = (task.expected as string | undefined) ?? '';
    if (
      expected.length > 12000 ||
      ((task.check === 'exact' || task.check === 'contains') && !expected.trim())
    )
      throw new Error('Invalid expected answer');
    if (task.check === 'json' && expected.trim()) JSON.parse(expected);
    return {
      id: crypto.randomUUID(),
      name: task.name,
      prompt: task.prompt,
      check: task.check as Check,
      expected,
    };
  });
}

export function ComparisonsPage() {
  const { m, locale } = useI18n();
  const t = m.comparisons;
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: '/comparisons' });
  const { id: selected } = useSearch({ from: '/app/comparisons' });
  const money = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(value);
  const { data: me } = useQuery(meQuery);
  const models = useQuery(modelsQuery);
  const keys = useQuery({ queryKey: ['keys'], queryFn: () => unwrap(api.keys.$get()) });
  const history = useQuery({
    queryKey: ['comparisons'],
    queryFn: () => unwrap(api.comparisons.$get()),
    refetchInterval: (query) =>
      query.state.data?.some((row) => row.status === 'running') ? 1500 : false,
  });
  const report = useQuery({
    queryKey: ['comparison', selected],
    enabled: !!selected,
    queryFn: () => unwrap(api.comparisons[':id'].$get({ param: { id: selected! } })),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1000 : false),
    retry: false,
  });
  const [name, setName] = useState(t.newRun);
  const [keyId, setKeyId] = useState('');
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [system, setSystem] = useState('');
  const [maxSpend, setMaxSpend] = useState('0.10');
  const [maxTokens, setMaxTokens] = useState('256');
  const [tasks, setTasks] = useState<Task[]>(() => [
    {
      id: crypto.randomUUID(),
      name: t.exampleName,
      prompt: t.examplePrompt,
      check: 'json',
      expected: '{"orderId":"A-17","status":"paid"}',
    },
  ]);
  const [importError, setImportError] = useState<string | null>(null);
  const [taskSet, setTaskSet] = useState<TaskSetRow | null>(null);
  const loadTaskSet = (row: TaskSetRow) => {
    setTaskSet(row);
    setName(row.content.name);
    setSystem(row.content.system);
    setMaxTokens(String(row.content.maxOutputTokens));
    setTasks(row.content.cases.map((task) => ({ ...task, id: crypto.randomUUID() })));
    setImportError(null);
  };
  const input: ComparisonInput = {
    name,
    keyId,
    modelIds,
    system,
    maxSpendUsd: Number(maxSpend),
    maxOutputTokens: Number(maxTokens),
    cases: tasks.map(({ id: _id, ...task }) => task),
  };
  if (taskSet && matchesTaskSet(input, taskSet))
    input.taskSet = { id: taskSet.id, revision: taskSet.revision };
  const fingerprint = JSON.stringify(input);
  const estimate = useMutation({
    mutationFn: async (value: ComparisonInput) => ({
      fingerprint: JSON.stringify(value),
      quote: await unwrap(api.comparisons.quote.$post({ json: value })),
    }),
  });
  const start = useMutation({
    mutationFn: (value: ComparisonInput) => unwrap(api.comparisons.$post({ json: value })),
    onSuccess: async (result) => {
      queryClient.setQueryData(['comparison', result.id], result);
      await queryClient.invalidateQueries({ queryKey: ['comparisons'] });
      await navigate({ search: { id: result.id } });
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => unwrap(api.comparisons[':id'].cancel.$post({ param: { id } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['comparison', selected] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.comparisons[':id'].$delete({ param: { id } })),
    onSuccess: async () => {
      await navigate({ search: { id: undefined } });
      await queryClient.invalidateQueries({ queryKey: ['comparisons'] });
    },
  });
  const review = useMutation({
    mutationFn: (json: {
      caseIndex: number;
      modelId: string;
      status: 'passed' | 'failed' | 'review';
    }) => unwrap(api.comparisons[':id'].review.$patch({ param: { id: selected! }, json })),
    onSuccess: (result) => queryClient.setQueryData(['comparison', result.id], result),
  });
  const quote = estimate.data?.fingerprint === fingerprint ? estimate.data.quote : null;
  const busy =
    start.isPending ||
    report.data?.status === 'running' ||
    history.data?.some((row) => row.status === 'running');
  const activeKeys = keys.data?.filter((key) => !key.revokedAt) ?? [];
  const enabledModels = models.data?.filter((model) => model.enabled) ?? [];
  const ready =
    modelIds.length >= 2 &&
    !!keyId &&
    !!name.trim() &&
    !!maxSpend.trim() &&
    Number.isFinite(input.maxSpendUsd) &&
    input.maxSpendUsd >= 0 &&
    input.maxSpendUsd <= 50 &&
    Number.isInteger(input.maxOutputTokens) &&
    input.maxOutputTokens >= 32 &&
    input.maxOutputTokens <= 2048 &&
    tasks.every(
      (task) =>
        task.name.trim() &&
        task.prompt.trim() &&
        ((task.check !== 'contains' && task.check !== 'exact') || task.expected.trim()),
    );
  const updateTask = (id: string, patch: Partial<Task>) =>
    setTasks((previous) => previous.map((task) => (task.id === id ? { ...task, ...patch } : task)));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <ErrorNote error={models.error ?? keys.error ?? history.error} />
      {(enabledModels.length < 2 || activeKeys.length === 0) &&
        !models.isLoading &&
        !keys.isLoading && (
          <Card className="p-5">
            <p className="text-sm text-muted">{t.noModels}</p>
          </Card>
        )}
      <Card className="p-5">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (quote && ready) start.mutate(input);
          }}
        >
          <fieldset disabled={!!busy} className="flex flex-col gap-5 border-0 p-0">
            <legend className="mb-4 text-lg font-semibold">{t.newRun}</legend>
            <TaskSetLibrary
              input={input}
              selected={taskSet}
              onLoad={loadTaskSet}
              onSelect={setTaskSet}
              disabled={!!busy}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t.name}>
                <Input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label={t.key}>
                <Select required value={keyId} onChange={(e) => setKeyId(e.target.value)}>
                  <option value="">{t.chooseKey}</option>
                  {activeKeys.map((key) => (
                    <option key={key.id} value={key.id}>
                      {key.name} · {key.prefix}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <fieldset className="rounded-lg border border-line p-4">
              <legend className="px-1 text-sm font-semibold">{t.models}</legend>
              <p className="mb-3 text-xs text-muted">{t.modelsHint}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {enabledModels.map((model) => {
                  const chosen = modelIds.includes(model.id);
                  const unpriced =
                    !model.isLocal && (model.inputPrice === null || model.outputPrice === null);
                  return (
                    <label
                      key={model.id}
                      className={cx(
                        'flex items-start gap-2.5 rounded-lg border p-3 text-sm',
                        chosen ? 'border-accent bg-accent/5' : 'border-line',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 size-4 accent-accent"
                        checked={chosen}
                        disabled={unpriced || (!chosen && modelIds.length >= 4)}
                        onChange={(e) =>
                          setModelIds(
                            e.target.checked
                              ? [...modelIds, model.id]
                              : modelIds.filter((id) => id !== model.id),
                          )
                        }
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{model.label ?? model.name}</span>
                        {modelIds[0] === model.id && (
                          <span className="ml-2">
                            <Status tone="info">{t.baseline}</Status>
                          </span>
                        )}
                        <span className="mt-1 block text-xs text-muted">
                          {model.provider} ·{' '}
                          {model.isLocal
                            ? m.common.local
                            : unpriced
                              ? m.models.noPrice
                              : m.models.perMillion(
                                  money(model.inputPrice!),
                                  money(model.outputPrice!),
                                )}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <Field label={t.system}>
              <Textarea
                maxLength={4000}
                value={system}
                onChange={(e) => setSystem(e.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.budget}>
                <Input
                  required
                  type="number"
                  min={0}
                  max={50}
                  step="any"
                  value={maxSpend}
                  onChange={(e) => setMaxSpend(e.target.value)}
                />
              </Field>
              <Field label={t.maxTokens}>
                <Input
                  required
                  type="number"
                  min={32}
                  max={2048}
                  step={1}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                />
              </Field>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              {t.budgetHint} {t.localHint}
            </p>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold">
                {t.tasks} ({tasks.length}/20)
              </h2>
              <div className="flex flex-wrap gap-2">
                <Field label={t.importTasks}>
                  <input
                    type="file"
                    accept=".json,application/json"
                    className="max-w-56 text-xs"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      try {
                        if (file.size > 600000) throw new Error('File too large');
                        setTasks(tasksFromJson(JSON.parse(await file.text())));
                        setImportError(null);
                      } catch {
                        setImportError(t.importError);
                      }
                    }}
                  />
                </Field>
                <Button onClick={() => download('spillway-tasks.json', input.cases)}>
                  {t.exportTasks}
                </Button>
              </div>
            </div>
            {importError && <p className="text-sm text-block-fg">{importError}</p>}
            {tasks.map((task, index) => (
              <div
                key={task.id}
                className="flex flex-col gap-3 rounded-lg border border-line bg-canvas/40 p-4"
              >
                <div className="flex items-end gap-3">
                  <Field className="flex-1" label={t.taskName}>
                    <Input
                      required
                      maxLength={80}
                      value={task.name}
                      onChange={(e) => updateTask(task.id, { name: e.target.value })}
                    />
                  </Field>
                  <Button
                    disabled={tasks.length === 1}
                    variant="ghost"
                    onClick={() => setTasks(tasks.filter((item) => item.id !== task.id))}
                  >
                    {t.remove} {index + 1}
                  </Button>
                </div>
                <Field label={t.prompt}>
                  <Textarea
                    required
                    maxLength={12000}
                    value={task.prompt}
                    onChange={(e) => updateTask(task.id, { prompt: e.target.value })}
                  />
                </Field>
                <Field label={t.check}>
                  <Select
                    value={task.check}
                    onChange={(e) => updateTask(task.id, { check: e.target.value as Check })}
                  >
                    {CHECKS.map((check) => (
                      <option key={check} value={check}>
                        {t.checks[check]}
                      </option>
                    ))}
                  </Select>
                </Field>
                {task.check !== 'manual' && (
                  <Field label={t.expected} hint={t.expectedHint}>
                    <Textarea
                      required={task.check !== 'json'}
                      maxLength={12000}
                      value={task.expected}
                      onChange={(e) => updateTask(task.id, { expected: e.target.value })}
                    />
                  </Field>
                )}
              </div>
            ))}
            <div>
              <Button
                disabled={tasks.length >= 20}
                onClick={() =>
                  setTasks([
                    ...tasks,
                    {
                      id: crypto.randomUUID(),
                      name: `${t.task} ${tasks.length + 1}`,
                      prompt: '',
                      check: 'manual',
                      expected: '',
                    },
                  ])
                }
              >
                {t.addTask}
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted">{t.privacy}</p>
            {me?.gateway.demo && <p className="text-sm text-warn-fg">{t.demo}</p>}
            <ErrorNote error={estimate.error ?? start.error} />
            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
              <Button
                disabled={!ready || estimate.isPending || me?.gateway.demo}
                onClick={() => estimate.mutate(input)}
              >
                {t.estimate}
              </Button>
              {quote && (
                <p className="text-sm text-ink-2">
                  {t.estimated}: <strong>{money(quote.estimatedUsd)}</strong> · {t.calls}:{' '}
                  {quote.calls}
                </p>
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={!ready || !quote || me?.gateway.demo}
              >
                {t.run}
              </Button>
            </div>
          </fieldset>
        </form>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-base font-semibold">{t.history}</h2>
        {!history.data?.length && <Empty>{t.noHistory}</Empty>}
        <div className="flex flex-col gap-1">
          {history.data?.map((row) => (
            <Link
              key={row.id}
              to="/comparisons"
              search={{ id: row.id }}
              className={cx(
                'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg px-3 py-2 text-sm hover:bg-canvas',
                row.id === selected && 'bg-canvas',
              )}
            >
              <span className="min-w-0 flex-1 font-medium">{row.name}</span>
              <span className="text-xs text-muted">
                {fmtDate(row.createdAt)} · {row.done}/{row.total}
              </span>
              <Status
                tone={
                  row.status === 'running' ? 'info' : row.status === 'completed' ? 'ok' : 'warn'
                }
              >
                {t.states[row.status]}
              </Status>
              <span className="font-mono text-xs">
                {money(row.spentUsd)}
                {row.unknownCosts ? ' + ?' : ''}
              </span>
            </Link>
          ))}
        </div>
      </Card>
      <ErrorNote error={report.error ?? cancel.error ?? remove.error ?? review.error} />
      {report.data && (
        <ComparisonResults
          report={report.data}
          money={money}
          reviewing={review.isPending}
          onReview={(value) => review.mutate(value)}
        >
          {report.data.status === 'running' ? (
            <Button
              variant="danger"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(report.data!.id)}
            >
              {t.cancel}
            </Button>
          ) : (
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                if (confirm(t.deleteConfirm)) remove.mutate(report.data!.id);
              }}
            >
              {t.deleteReport}
            </Button>
          )}
          <Button
            onClick={() => download(`spillway-comparison-${report.data!.id}.json`, report.data)}
          >
            {t.exportReport}
          </Button>
        </ComparisonResults>
      )}
      {report.data?.status === 'completed' && (
        <ProfileFromComparison key={report.data.id} report={report.data} keys={keys.data ?? []} />
      )}
      {report.data?.evaluation && (
        <EvaluationResults
          key={report.data.id}
          report={report.data}
          money={money}
          busy={!!busy}
          onLoad={(row, previous) => {
            loadTaskSet(row);
            setKeyId(previous.keyId);
            setModelIds(previous.models.map((model) => model.id));
            setMaxSpend(String(previous.maxSpendUsd));
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      )}
    </div>
  );
}

function ComparisonResults({
  report,
  money,
  children,
  reviewing,
  onReview,
}: {
  report: ComparisonReport;
  money: (value: number) => string;
  children: ReactNode;
  reviewing: boolean;
  onReview: (value: {
    caseIndex: number;
    modelId: string;
    status: 'passed' | 'failed' | 'review';
  }) => void;
}) {
  const { m } = useI18n();
  const t = m.comparisons;
  const done = report.cells.filter(
    (cell) => cell.status !== 'queued' && cell.status !== 'running',
  ).length;
  const baseline = report.models[0]!;
  return (
    <Card className="flex flex-col gap-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {t.report}: {report.name}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {t.progress}: {done}/{report.cells.length} · {t.spent}: {money(report.spentUsd)}
            {report.unknownCosts ? ' + ?' : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{children}</div>
      </div>
      <Progress value={(done / report.cells.length) * 100} label={t.progress} />
      {report.unknownCosts && (
        <p className="rounded-lg bg-warn-bg p-3 text-sm text-warn-fg">{t.unknownHint}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {report.models.map((model) => {
          const cells = report.cells.filter((cell) => cell.modelId === model.id);
          const measured = cells.filter((cell) => cell.latencyMs !== null);
          const cost = cells.reduce((sum, cell) => sum + (cell.costUsd ?? 0), 0);
          const pairs = cells
            .filter((cell) => cell.status === 'passed' && cell.costUsd !== null)
            .map((cell) => ({
              cell,
              base: report.cells.find(
                (other) =>
                  other.caseIndex === cell.caseIndex &&
                  other.modelId === baseline.id &&
                  other.status === 'passed' &&
                  other.costUsd !== null,
              ),
            }))
            .filter((pair) => pair.base);
          const baseCost = pairs.reduce((sum, pair) => sum + pair.base!.costUsd!, 0);
          const candidateCost = pairs.reduce((sum, pair) => sum + pair.cell.costUsd!, 0);
          const delta = baseCost > 0 ? ((baseCost - candidateCost) / baseCost) * 100 : null;
          const unknown = cells.some(
            (cell) =>
              cell.costUsd === null && cell.status !== 'queued' && cell.status !== 'running',
          );
          return (
            <div key={model.id} className="rounded-lg border border-line p-4">
              <h3 className="font-semibold">
                {model.label}{' '}
                {model.id === baseline.id && <Status tone="info">{t.baseline}</Status>}
              </h3>
              <p className="mt-1 text-xs text-muted">
                {model.provider}
                {model.isLocal ? ` · ${m.common.local}` : ''}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted">{t.passed}</dt>
                <dd>
                  {cells.filter((cell) => cell.status === 'passed').length}/{report.cases.length}
                </dd>
                <dt className="text-muted">{t.reviewed}</dt>
                <dd>{cells.filter((cell) => cell.status === 'review').length}</dd>
                <dt className="text-muted">{t.failure}</dt>
                <dd>
                  {
                    cells.filter((cell) => cell.status === 'failed' || cell.status === 'error')
                      .length
                  }
                </dd>
                <dt className="text-muted">{t.cost}</dt>
                <dd>
                  {money(cost)}
                  {unknown ? ' + ?' : ''}
                </dd>
                <dt className="text-muted">{t.latency}</dt>
                <dd>
                  {measured.length
                    ? `${fmtNumber(
                        measured.reduce((sum, cell) => sum + cell.latencyMs!, 0) / measured.length,
                      )} ms`
                    : '—'}
                </dd>
              </dl>
              {model.id !== baseline.id && (
                <div className="mt-3 border-t border-line pt-3 text-sm">
                  <p className="text-xs text-muted">{t.savings}</p>
                  <p className="mt-1 font-medium">
                    {pairs.length && delta !== null
                      ? Math.abs(delta).toFixed(1) +
                        '% ' +
                        (delta > 0 ? t.fewer : delta < 0 ? t.more : t.equal) +
                        ' (' +
                        pairs.length +
                        '/' +
                        report.cases.length +
                        ')'
                      : pairs.length && baseCost === 0 && candidateCost === 0
                        ? t.equal
                        : t.noSavings}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {t.savingsHint} {t.localHint}
      </p>
      {report.cases.some((task) => task.check === 'manual') && (
        <p className="text-sm text-muted">{t.manualHint}</p>
      )}
      {report.cases.map((task, caseIndex) => (
        <section key={task.id} className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">
            {caseIndex + 1}. {task.name}{' '}
            <span className="font-normal text-muted">· {t.checks[task.check]}</span>
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {report.models.map((model) => {
              const cell = report.cells.find(
                (cell) => cell.caseIndex === caseIndex && cell.modelId === model.id,
              )!;
              return (
                <div key={model.id} className="min-w-0 rounded-lg border border-line p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{model.label}</span>
                    <Status tone={TONES[cell.status]}>{t.statuses[cell.status]}</Status>
                  </div>
                  {cell.reason && (
                    <p className="mt-2 text-xs text-muted">{t.reasons[cell.reason]}</p>
                  )}
                  {cell.latencyMs !== null && (
                    <p className="mt-2 font-mono text-xs text-muted">
                      {cell.costUsd === null ? t.unknown : money(cell.costUsd)} ·{' '}
                      {fmtNumber(cell.latencyMs)} ms
                    </p>
                  )}
                  {cell.output !== null && (
                    <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-canvas p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                      {cell.output}
                    </pre>
                  )}
                  {!report.storesOutputs &&
                    ['passed', 'failed', 'review'].includes(cell.status) && (
                      <p className="mt-3 text-xs text-muted">{t.hidden}</p>
                    )}
                  {cell.outputTruncated && (
                    <p className="mt-2 text-xs text-warn-fg">{t.outputCut}</p>
                  )}
                  {cell.requestId && (
                    <details className="mt-3 text-xs text-muted">
                      <summary className="cursor-pointer">{t.request}</summary>
                      <Link
                        to="/logs"
                        search={{ id: cell.requestId }}
                        className="mt-2 block break-all text-accent underline"
                      >
                        {cell.requestId}
                      </Link>
                      <p className="mt-1">
                        {t.tokens}: {cell.inputTokens ?? '?'} / {cell.outputTokens ?? '?'}
                      </p>
                      {cell.servedModel && (
                        <p>
                          {t.served}: {cell.servedModel}
                        </p>
                      )}
                    </details>
                  )}
                  {task.check === 'manual' &&
                    report.status !== 'running' &&
                    ['review', 'passed', 'failed'].includes(cell.status) &&
                    cell.output !== null &&
                    !cell.outputTruncated && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          disabled={reviewing || cell.status === 'passed'}
                          onClick={() =>
                            onReview({ caseIndex, modelId: model.id, status: 'passed' })
                          }
                        >
                          {t.approve}
                        </Button>
                        <Button
                          disabled={reviewing || cell.status === 'failed'}
                          onClick={() =>
                            onReview({ caseIndex, modelId: model.id, status: 'failed' })
                          }
                        >
                          {t.reject}
                        </Button>
                        {cell.status !== 'review' && (
                          <Button
                            variant="ghost"
                            disabled={reviewing}
                            onClick={() =>
                              onReview({ caseIndex, modelId: model.id, status: 'review' })
                            }
                          >
                            {t.reset}
                          </Button>
                        )}
                      </div>
                    )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </Card>
  );
}
