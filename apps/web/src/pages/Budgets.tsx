import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CheckIcon, PlusIcon } from '../components/icons.tsx';
import {
  Button,
  Card,
  cx,
  Empty,
  ErrorNote,
  Input,
  PageHeader,
  Progress,
} from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import {
  api,
  type ModelRow,
  meQuery,
  modelsQuery,
  type Rules,
  type TeamRow,
  teamsQuery,
  unwrap,
} from '../lib/api.ts';
import { fmtDate, fmtLimit, fmtMonth, fmtUsd, pct } from '../lib/format.ts';

type RuleSet = Rules['rules'];

export function BudgetsPage() {
  const { m } = useI18n();
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const isAdmin = me?.user.role === 'admin';
  const { data: teams = [] } = useQuery(teamsQuery);
  const { data: models = [] } = useQuery(modelsQuery);
  const { data: rules } = useQuery({
    queryKey: ['rules'],
    queryFn: () => unwrap(api.rules.$get()),
  });
  const [adding, setAdding] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['teams'] });
  const saveTeam = useMutation({
    mutationFn: ({
      id,
      ...json
    }: {
      id: string;
      monthlyBudgetUsd?: number | null;
      allowedModelIds?: string[] | null;
      name?: string;
    }) => unwrap(api.teams[':id'].$patch({ param: { id }, json })),
    onSuccess: invalidate,
  });
  const addTeam = useMutation({
    mutationFn: (json: { name: string; monthlyBudgetUsd: number | null }) =>
      unwrap(api.teams.$post({ json })),
    onSuccess: async () => {
      await invalidate();
      setAdding(false);
    },
  });
  const saveRules = useMutation({
    mutationFn: (json: RuleSet) => unwrap(api.rules.$put({ json })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rules'] }),
  });

  const month = fmtMonth(new Date());
  const totalSpent = teams.reduce((sum, t) => sum + t.spentMonth, 0);
  const totalBudget = teams.reduce((sum, t) => sum + (t.monthlyBudgetUsd ?? 0), 0);
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString();
  const localModel = models.find((m) => m.id === rules?.localModelId);

  return (
    <>
      <PageHeader title={m.budgets.title} subtitle={m.budgets.subtitle}>
        {isAdmin && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            <PlusIcon strokeWidth={2.2} />
            {m.budgets.addTeam}
          </Button>
        )}
      </PageHeader>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_1.35fr]">
        <Card aria-label={m.budgets.teamBudgets} className="flex flex-col gap-1 px-6 py-5">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold">{m.budgets.teamBudgetsMonth(month)}</h2>
            <span className="font-mono text-[13px] text-muted">
              {fmtUsd(totalSpent)}
              {totalBudget > 0 && ` / ${fmtLimit(totalBudget)}`}
            </span>
          </div>
          {adding && (
            <NewTeam
              onSave={(name, budget) => addTeam.mutate({ name, monthlyBudgetUsd: budget })}
              onCancel={() => setAdding(false)}
              error={addTeam.error}
            />
          )}
          {teams.length === 0 && !adding && <Empty>{m.budgets.noTeams}</Empty>}
          {teams.map((team) => (
            <TeamBudget
              key={team.id}
              team={team}
              monthEnd={monthEnd}
              editable={isAdmin}
              onBudget={(value) => saveTeam.mutate({ id: team.id, monthlyBudgetUsd: value })}
            />
          ))}
          <ErrorNote error={saveTeam.error} />
        </Card>

        <Card aria-label={m.budgets.routingRules} className="flex flex-col gap-3 px-6 py-5">
          <h2 className="mb-1 text-[15px] font-semibold">{m.budgets.routingRules}</h2>
          {rules && (
            <RuleList
              rules={rules.rules}
              hits={rules.hits}
              localName={
                localModel
                  ? m.budgets.localName(localModel.label ?? localModel.name)
                  : m.budgets.localUnset
              }
              editable={isAdmin}
              onChange={(next) => saveRules.mutate(next)}
            />
          )}
          <ErrorNote error={saveRules.error} />
        </Card>
      </div>

      <Card aria-label={m.budgets.modelAccess} className="flex flex-col px-6 py-5">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-semibold">{m.budgets.modelAccessTitle}</h2>
          <span className="text-[13px] text-muted">{m.budgets.narrow}</span>
        </div>
        {teams.length && models.length ? (
          <AccessMatrix
            teams={teams}
            models={models.filter((m) => m.enabled)}
            editable={isAdmin}
            onChange={(team, allowedModelIds) => saveTeam.mutate({ id: team.id, allowedModelIds })}
          />
        ) : (
          <Empty>{m.budgets.addTeamsModels}</Empty>
        )}
      </Card>
    </>
  );
}

function NewTeam({
  onSave,
  onCancel,
  error,
}: {
  onSave: (name: string, budget: number | null) => void;
  onCancel: () => void;
  error: unknown;
}) {
  const { m } = useI18n();
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  return (
    <form
      className="flex flex-col gap-3 border-b border-line-soft py-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(name.trim(), budget ? Number(budget) : null);
      }}
    >
      <div className="grid grid-cols-[1fr_140px] gap-3">
        <Input
          aria-label={m.budgets.teamName}
          required
          placeholder={m.budgets.teamName}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          aria-label={m.budgets.monthlyBudget}
          mono
          type="number"
          min="0"
          step="any"
          placeholder={m.budgets.budgetPlaceholder}
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />
      </div>
      <ErrorNote error={error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{m.common.cancel}</Button>
        <Button type="submit" variant="primary">
          {m.budgets.addTeam}
        </Button>
      </div>
    </form>
  );
}

function TeamBudget({
  team,
  monthEnd,
  editable,
  onBudget,
}: {
  team: TeamRow;
  monthEnd: string;
  editable: boolean;
  onBudget: (value: number | null) => void;
}) {
  const { m } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(team.monthlyBudgetUsd?.toString() ?? '');
  const budget = team.monthlyBudgetUsd;
  const used = budget ? pct(team.spentMonth, budget) : 0;
  const over = budget != null && team.spentMonth >= budget;
  const note =
    budget == null
      ? m.budgets.noBudget(fmtUsd(team.spentMonth), team.keys)
      : over
        ? m.budgets.over
        : (used >= 80 ? m.budgets.closeTo : m.budgets.onTrack)(
            fmtUsd(team.forecast),
            fmtDate(monthEnd),
          );

  return (
    <div className="flex flex-col gap-2 border-b border-line-soft py-3.5 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[15px] font-medium">{team.name}</span>
        {editing ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onBudget(value === '' ? null : Number(value));
              setEditing(false);
            }}
          >
            <Input
              aria-label={m.budgets.teamMonthlyBudget(team.name)}
              mono
              type="number"
              min="0"
              step="any"
              className="h-8 w-28"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
            <Button type="submit" variant="primary" className="h-8 px-3">
              {m.common.save}
            </Button>
          </form>
        ) : (
          <button
            type="button"
            disabled={!editable}
            onClick={() => setEditing(true)}
            className="cursor-pointer font-mono text-[13px] enabled:hover:text-accent disabled:cursor-default"
            title={editable ? m.budgets.changeBudget : undefined}
          >
            {m.budgets.spentOf(fmtUsd(team.spentMonth), budget != null ? fmtLimit(budget) : '—')}
          </button>
        )}
      </div>
      <Progress
        value={budget ? used : 0}
        height={8}
        color={over ? 'bg-block-bar' : used >= 80 ? 'bg-warn-bar' : 'bg-accent'}
        label={m.budgets.budgetUsed(team.name)}
      />
      <div className={cx('text-[13px]', over ? 'text-block-fg' : 'text-muted')}>{note}</div>
    </div>
  );
}

function RuleList({
  rules,
  hits,
  localName,
  editable,
  onChange,
}: {
  rules: RuleSet;
  hits: Record<string, number>;
  localName: string;
  editable: boolean;
  onChange: (next: RuleSet) => void;
}) {
  const { m } = useI18n();
  const [draft, setDraft] = useState(rules);
  const dirty = JSON.stringify(draft) !== JSON.stringify(rules);
  const num =
    'mx-1 inline-block h-7 w-16 rounded-md border border-field bg-surface px-1.5 text-center font-mono text-[13px] disabled:border-transparent disabled:bg-transparent';
  const time =
    'mx-1 inline-block h-7 w-auto rounded-md border border-field bg-surface px-1.5 font-mono text-[13px] disabled:border-transparent disabled:bg-transparent';

  const items: { id: keyof RuleSet; when: React.ReactNode; action: React.ReactNode }[] = [
    {
      id: 'budgetThreshold',
      when: (
        <>
          {m.budgets.budgetBefore}
          <input
            aria-label={m.budgets.thresholdLabel}
            type="number"
            min={1}
            max={100}
            disabled={!editable}
            className={num}
            value={draft.budgetThreshold.percent}
            onChange={(e) =>
              setDraft({
                ...draft,
                budgetThreshold: { ...draft.budgetThreshold, percent: Number(e.target.value) },
              })
            }
          />
          {m.budgets.budgetAfter}
        </>
      ),
      action: m.budgets.sendTo(localName),
    },
    {
      id: 'piiGuard',
      when: m.budgets.piiWhen,
      action: m.budgets.piiThen,
    },
    {
      id: 'agentRateLimit',
      when: m.budgets.agentWhen,
      action: (
        <>
          {m.budgets.agentBefore}
          <input
            aria-label={m.budgets.rpmLabel}
            type="number"
            min={1}
            disabled={!editable}
            className={num}
            value={draft.agentRateLimit.rpm}
            onChange={(e) =>
              setDraft({
                ...draft,
                agentRateLimit: { ...draft.agentRateLimit, rpm: Number(e.target.value) },
              })
            }
          />
          {m.budgets.agentAfter}
        </>
      ),
    },
    {
      id: 'offHours',
      when: (
        <>
          {m.budgets.offBefore}
          <input
            aria-label={m.budgets.startLabel}
            type="time"
            disabled={!editable}
            className={time}
            value={draft.offHours.from}
            onChange={(e) =>
              setDraft({ ...draft, offHours: { ...draft.offHours, from: e.target.value } })
            }
          />
          –
          <input
            aria-label={m.budgets.endLabel}
            type="time"
            disabled={!editable}
            className={time}
            value={draft.offHours.to}
            onChange={(e) =>
              setDraft({ ...draft, offHours: { ...draft.offHours, to: e.target.value } })
            }
          />
        </>
      ),
      action: m.budgets.offThen,
    },
  ];

  return (
    <>
      {items.map((rule, i) => {
        const on = draft[rule.id].enabled;
        const count = hits[rule.id] ?? 0;
        return (
          <div
            key={rule.id}
            className={cx(
              'flex items-start gap-3.5 rounded-[10px] border border-line p-3.5',
              on ? 'bg-surface' : 'bg-[#faf9f6]',
            )}
          >
            <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-track font-mono text-xs text-ink-2">
              {i + 1}
            </div>
            <div className="flex flex-1 flex-col gap-1.5 text-sm leading-relaxed">
              <div>
                <span className="mr-2 text-[11px] font-semibold tracking-wider text-muted">
                  {m.budgets.whenLabel}
                </span>
                {rule.when}
              </div>
              <div>
                <span className="mr-2 text-[11px] font-semibold tracking-wider text-muted">
                  {m.budgets.thenLabel}
                </span>
                <span className="font-medium">{rule.action}</span>
              </div>
              <div className="text-xs text-muted">
                {on ? m.budgets.matched(count) : m.common.off}
              </div>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-[13px] text-ink-2">
              <input
                type="checkbox"
                disabled={!editable}
                checked={on}
                onChange={(e) => {
                  const next = {
                    ...draft,
                    [rule.id]: { ...draft[rule.id], enabled: e.target.checked },
                  };
                  setDraft(next);
                  onChange(next);
                }}
                className="size-4 accent-accent"
              />
              {on ? m.common.on : m.common.off}
            </label>
          </div>
        );
      })}
      {dirty && editable && (
        <div className="flex justify-end gap-2">
          <Button onClick={() => setDraft(rules)}>{m.budgets.discard}</Button>
          <Button variant="primary" onClick={() => onChange(draft)}>
            {m.budgets.saveRules}
          </Button>
        </div>
      )}
    </>
  );
}

function AccessMatrix({
  teams,
  models,
  editable,
  onChange,
}: {
  teams: TeamRow[];
  models: ModelRow[];
  editable: boolean;
  onChange: (team: TeamRow, allowed: string[] | null) => void;
}) {
  const { m } = useI18n();
  const columns = `1.4fr repeat(${models.length}, minmax(96px, 1fr))`;
  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: 200 + models.length * 110 }}>
        <div
          className="grid gap-3 border-b border-line py-2.5 text-xs font-medium text-muted"
          style={{ gridTemplateColumns: columns }}
        >
          <div>{m.common.team}</div>
          {models.map((model) => (
            <div key={model.id} className="text-center">
              {model.label ?? model.name}
              {model.isLocal && ` · ${m.common.local}`}
            </div>
          ))}
        </div>
        {teams.map((team) => (
          <div
            key={team.id}
            className="grid items-center gap-3 border-b border-line-soft py-2.5 text-sm last:border-0"
            style={{ gridTemplateColumns: columns }}
          >
            <div className="font-medium">{team.name}</div>
            {models.map((model) => {
              const allowed = !team.allowedModelIds || team.allowedModelIds.includes(model.id);
              const label = `${allowed ? m.budgets.allowed : m.budgets.notAllowed}: ${team.name} · ${model.label ?? model.name}`;
              return (
                <div key={model.id} className="flex justify-center">
                  <button
                    type="button"
                    aria-pressed={allowed}
                    aria-label={label}
                    title={editable ? m.budgets.toggle : undefined}
                    disabled={!editable}
                    onClick={() => {
                      const current = team.allowedModelIds ?? models.map((m) => m.id);
                      const next = allowed
                        ? current.filter((id) => id !== model.id)
                        : [...current, model.id];
                      onChange(team, next.length === models.length ? null : next);
                    }}
                    className="flex size-9 cursor-pointer items-center justify-center rounded-md enabled:hover:bg-track disabled:cursor-default"
                  >
                    {allowed ? (
                      <CheckIcon size={18} strokeWidth={2.4} className="text-accent" />
                    ) : (
                      <span className="text-[13px] text-faint">—</span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
