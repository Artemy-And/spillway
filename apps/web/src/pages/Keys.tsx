import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { CloseIcon, PlusIcon, SearchIcon } from '../components/icons.tsx';
import {
  Aside,
  Button,
  Card,
  Chip,
  CopyButton,
  cx,
  Empty,
  ErrorNote,
  Field,
  Input,
  KIND_LABELS,
  PageHeader,
  Progress,
  Segmented,
  Select,
  Status,
  Switch,
  type Tone,
} from '../components/ui.tsx';
import { api, type KeyRow, meQuery, modelsQuery, teamsQuery, unwrap } from '../lib/api.ts';
import { fmtAgo, fmtLimit, fmtUsd, pct } from '../lib/format.ts';

type Kind = keyof typeof KIND_LABELS;
type Filter = 'all' | Kind;

interface Draft {
  name: string;
  kind: Kind;
  userId: string;
  teamId: string;
  daily: string;
  monthly: string;
  fallbackToLocal: boolean;
  allowedModelIds: string[] | null;
}

const EMPTY: Draft = {
  name: '',
  kind: 'person',
  userId: '',
  teamId: '',
  daily: '',
  monthly: '',
  fallbackToLocal: true,
  allowedModelIds: null,
};

function status(key: KeyRow): { label: string; tone: Tone } {
  if (key.revokedAt) return { label: 'Revoked', tone: 'off' };
  if (key.dailyLimitUsd != null && key.spentToday >= key.dailyLimitUsd) {
    return key.fallbackToLocal
      ? { label: 'Local only', tone: 'info' }
      : { label: 'Limit reached', tone: 'block' };
  }
  if (key.dailyLimitUsd && key.spentToday >= key.dailyLimitUsd * 0.8)
    return { label: 'Near limit', tone: 'warn' };
  return { label: 'Active', tone: 'ok' };
}

const money = (value: string) => (value.trim() === '' ? null : Number(value));

export function KeysPage() {
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const isAdmin = me?.user.role === 'admin';
  const { data: keys = [] } = useQuery({
    queryKey: ['keys'],
    queryFn: () => unwrap(api.keys.$get()),
    refetchInterval: 30_000,
  });
  const { data: models = [] } = useQuery(modelsQuery);
  const { data: teams = [] } = useQuery(teamsQuery);
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => unwrap(api.users.$get()),
    enabled: isAdmin,
  });
  const { data: rules } = useQuery({
    queryKey: ['rules'],
    queryFn: () => unwrap(api.rules.$get()),
  });

  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<
    | { mode: 'new' }
    | { mode: 'edit'; id: string }
    | { mode: 'created'; key: string; name: string }
    | null
  >(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const counts = useMemo(() => {
    const live = keys.filter((k) => !k.revokedAt);
    return {
      all: live.length,
      person: live.filter((k) => k.kind === 'person').length,
      device: live.filter((k) => k.kind === 'device').length,
      agent: live.filter((k) => k.kind === 'agent').length,
    };
  }, [keys]);

  const visible = keys.filter((key) => {
    if (filter !== 'all' && key.kind !== filter) return false;
    const q = search.trim().toLowerCase();
    return (
      !q ||
      key.name.toLowerCase().includes(q) ||
      (key.owner ?? '').toLowerCase().includes(q) ||
      (key.team ?? '').toLowerCase().includes(q)
    );
  });

  const localModel = models.find((m) => m.id === rules?.localModelId);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['keys'] });

  const body = () => ({
    name: draft.name.trim(),
    kind: draft.kind,
    ...(isAdmin
      ? {
          userId: draft.userId || null,
          teamId: draft.teamId || null,
          dailyLimitUsd: money(draft.daily),
          monthlyLimitUsd: money(draft.monthly),
          fallbackToLocal: draft.fallbackToLocal,
          allowedModelIds: draft.allowedModelIds,
        }
      : {}),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (panel?.mode === 'edit') {
        await unwrap(api.keys[':id'].$patch({ param: { id: panel.id }, json: body() }));
        return null;
      }
      return unwrap(api.keys.$post({ json: body() }));
    },
    onSuccess: async (created) => {
      await refresh();
      setPanel(created ? { mode: 'created', key: created.key, name: draft.name } : null);
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.keys[':id'].revoke.$post({ param: { id } })),
    onSuccess: async () => {
      await refresh();
      setPanel(null);
    },
  });

  const openNew = () => {
    save.reset();
    setDraft({ ...EMPTY, teamId: me?.user.teamId ?? '' });
    setPanel({ mode: 'new' });
  };

  const openEdit = (key: KeyRow) => {
    save.reset();
    setDraft({
      name: key.name,
      kind: key.kind,
      userId: key.userId ?? '',
      teamId: key.teamId ?? '',
      daily: key.dailyLimitUsd?.toString() ?? '',
      monthly: key.monthlyLimitUsd?.toString() ?? '',
      fallbackToLocal: key.fallbackToLocal,
      allowedModelIds: key.allowedModelIds,
    });
    setPanel({ mode: 'edit', id: key.id });
  };

  const editing = panel?.mode === 'edit' ? keys.find((k) => k.id === panel.id) : undefined;

  return (
    <>
      <PageHeader
        title="Keys"
        subtitle="One key per person, device or agent. Revoke one without touching the rest."
      >
        <Button variant="primary" onClick={openNew}>
          <PlusIcon strokeWidth={2.2} />
          New key
        </Button>
      </PageHeader>

      <div className="flex flex-col gap-6 xl:flex-row">
        <section aria-label="All keys" className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Segmented
              label="Key type"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: `All ${counts.all}` },
                { value: 'person', label: `People ${counts.person}` },
                { value: 'device', label: `Devices ${counts.device}` },
                { value: 'agent', label: `Agents ${counts.agent}` },
              ]}
            />
            <label className="flex h-10 w-full items-center gap-2 rounded-lg border border-field bg-surface px-3 text-muted sm:w-60">
              <SearchIcon />
              <span className="sr-only">Search keys</span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search keys or owners"
                className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
              />
            </label>
          </div>

          <Card className="overflow-x-auto px-5 py-1">
            <div className="min-w-[640px]">
              <div className="grid grid-cols-[2fr_0.9fr_1.7fr_1fr_1fr] gap-3.5 border-b border-line py-3 text-xs font-medium text-muted">
                <div>Key</div>
                <div>Type</div>
                <div>Today vs daily limit</div>
                <div>Last used</div>
                <div>Status</div>
              </div>
              {visible.length === 0 && (
                <Empty>
                  {keys.length
                    ? 'No keys match.'
                    : 'No keys yet. Create one for each person, device or agent.'}
                </Empty>
              )}
              {visible.map((key) => {
                const s = status(key);
                const used = key.dailyLimitUsd ? pct(key.spentToday, key.dailyLimitUsd) : 0;
                return (
                  <div
                    key={key.id}
                    className={cx(
                      'grid grid-cols-[2fr_0.9fr_1.7fr_1fr_1fr] items-center gap-3.5 border-b border-line-soft py-3 text-sm last:border-0',
                      panel?.mode === 'edit' && panel.id === key.id && '-mx-5 bg-accent-soft px-5',
                      key.revokedAt && 'opacity-70',
                    )}
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <button
                        type="button"
                        disabled={!!key.revokedAt || !isAdmin}
                        onClick={() => openEdit(key)}
                        className="w-fit cursor-pointer truncate text-left font-mono text-[13px] font-medium enabled:hover:text-accent disabled:cursor-default"
                      >
                        {key.name}
                      </button>
                      <span className="truncate text-xs text-muted">
                        {[key.owner, key.team && `${key.team} team`].filter(Boolean).join(' · ') ||
                          'No owner'}{' '}
                        · <span className="font-mono">{key.prefix}…</span>
                      </span>
                    </div>
                    <div>
                      <Chip>{KIND_LABELS[key.kind]}</Chip>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {key.dailyLimitUsd != null ? (
                        <>
                          <Progress
                            value={used}
                            color={used >= 80 ? 'bg-warn-bar' : 'bg-accent'}
                            label={`${key.name} daily limit used`}
                          />
                          <span className="font-mono text-xs text-ink-2">
                            {fmtUsd(key.spentToday)} / {fmtLimit(key.dailyLimitUsd)}
                          </span>
                        </>
                      ) : (
                        <span className="font-mono text-xs text-ink-2">
                          {fmtUsd(key.spentToday)} today · no limit
                        </span>
                      )}
                    </div>
                    <div className="text-[13px] text-ink-2">{fmtAgo(key.lastUsedAt)}</div>
                    <div>
                      <Status tone={s.tone}>{s.label}</Status>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </section>

        {panel?.mode === 'created' && (
          <CreatedKey name={panel.name} value={panel.key} onClose={() => setPanel(null)} />
        )}

        {(panel?.mode === 'new' || panel?.mode === 'edit') && (
          <Aside label={panel.mode === 'new' ? 'New key' : 'Edit key'}>
            <form
              className="flex flex-col gap-[18px]"
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate();
              }}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-[17px] font-semibold">
                  {panel.mode === 'new' ? 'New key' : `Edit ${editing?.name ?? 'key'}`}
                </h2>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setPanel(null)}
                  className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-track"
                >
                  <CloseIcon />
                </button>
              </div>

              <Field label="Name">
                <Input
                  mono
                  required
                  maxLength={64}
                  placeholder="anna-macbook"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>

              {isAdmin && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Owner">
                    <Select
                      value={draft.userId}
                      onChange={(e) => setDraft({ ...draft, userId: e.target.value })}
                    >
                      <option value="">Nobody (team key)</option>
                      {users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name ?? user.email}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Team">
                    <Select
                      value={draft.teamId}
                      onChange={(e) => setDraft({ ...draft, teamId: e.target.value })}
                    >
                      <option value="">{draft.userId ? "Owner's team" : 'No team'}</option>
                      {teams.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              )}

              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-[13px] font-medium">Type</legend>
                <div className="grid grid-cols-3 gap-1.5">
                  {(Object.keys(KIND_LABELS) as Kind[]).map((kind) => (
                    <label
                      key={kind}
                      className={cx(
                        'flex h-[38px] cursor-pointer items-center justify-center rounded-lg border text-[13px]',
                        draft.kind === kind
                          ? 'border-accent bg-accent-soft font-medium text-accent-strong'
                          : 'border-field text-ink-2',
                      )}
                    >
                      <input
                        type="radio"
                        name="kind"
                        className="sr-only"
                        checked={draft.kind === kind}
                        onChange={() => setDraft({ ...draft, kind })}
                      />
                      {KIND_LABELS[kind]}
                    </label>
                  ))}
                </div>
              </fieldset>

              {isAdmin && (
                <>
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1.5 text-[13px] font-medium">Allowed models</legend>
                    <Switch
                      checked={draft.allowedModelIds === null}
                      onChange={(all) =>
                        setDraft({
                          ...draft,
                          allowedModelIds: all ? null : models.map((m) => m.id),
                        })
                      }
                      label="Everything the team may use"
                    />
                    {draft.allowedModelIds !== null &&
                      models.map((model) => (
                        <label key={model.id} className="flex items-center gap-2.5 pl-6 text-sm">
                          <input
                            type="checkbox"
                            className="size-4 accent-accent"
                            checked={draft.allowedModelIds?.includes(model.id) ?? false}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                allowedModelIds: e.target.checked
                                  ? [...(draft.allowedModelIds ?? []), model.id]
                                  : (draft.allowedModelIds ?? []).filter((id) => id !== model.id),
                              })
                            }
                          />
                          {model.label ?? model.name}
                          {model.isLocal && <span className="text-muted">· local</span>}
                        </label>
                      ))}
                  </fieldset>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Daily limit, $">
                      <Input
                        mono
                        inputMode="decimal"
                        type="number"
                        min="0"
                        step="any"
                        placeholder="none"
                        value={draft.daily}
                        onChange={(e) => setDraft({ ...draft, daily: e.target.value })}
                      />
                    </Field>
                    <Field label="Monthly limit, $">
                      <Input
                        mono
                        inputMode="decimal"
                        type="number"
                        min="0"
                        step="any"
                        placeholder="none"
                        value={draft.monthly}
                        onChange={(e) => setDraft({ ...draft, monthly: e.target.value })}
                      />
                    </Field>
                  </div>

                  <div className="rounded-lg bg-canvas p-3">
                    <Switch
                      checked={draft.fallbackToLocal}
                      onChange={(fallbackToLocal) => setDraft({ ...draft, fallbackToLocal })}
                      label="Over the limit? Use a local model"
                      description={
                        localModel
                          ? `Requests go to ${localModel.label ?? localModel.name} instead of being blocked.`
                          : 'Pick a local model in Settings first; until then requests are blocked.'
                      }
                    />
                  </div>
                </>
              )}
              {!isAdmin && (
                <p className="text-[13px] text-muted">Limits for your keys are set by an admin.</p>
              )}

              <ErrorNote error={save.error ?? revoke.error} />
              <div className="flex flex-wrap justify-between gap-2.5">
                {editing ? (
                  <Button
                    variant="danger"
                    onClick={() =>
                      confirm(`Revoke ${editing.name}? Apps using it stop working at once.`) &&
                      revoke.mutate(editing.id)
                    }
                  >
                    Revoke
                  </Button>
                ) : (
                  <span />
                )}
                <div className="flex gap-2.5">
                  <Button onClick={() => setPanel(null)}>Cancel</Button>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={save.isPending || !draft.name.trim()}
                  >
                    {panel.mode === 'new' ? 'Create key' : 'Save'}
                  </Button>
                </div>
              </div>
            </form>
          </Aside>
        )}
      </div>
    </>
  );
}

function CreatedKey({
  name,
  value,
  onClose,
}: {
  name: string;
  value: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'curl' | 'claude' | 'webui'>('curl');
  const origin = window.location.origin;
  const snippets = {
    curl: `curl ${origin}/v1/chat/completions \\\n  -H "Authorization: Bearer ${value}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "<model name>", "messages": [{"role": "user", "content": "Hi"}]}'`,
    claude: `export ANTHROPIC_BASE_URL=${origin}\nexport ANTHROPIC_AUTH_TOKEN=${value}\nexport ANTHROPIC_MODEL=<model name>\nclaude`,
    webui: `Open WebUI → Settings → Connections\n\nOpenAI API:  ${origin}/v1\nOllama API:  ${origin}\nKey:         ${value}`,
  };
  return (
    <Aside label="Key created">
      <div className="flex items-center justify-between">
        <h2 className="text-[17px] font-semibold">Key for {name} is ready</h2>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-track"
        >
          <CloseIcon />
        </button>
      </div>
      <p className="rounded-lg bg-warn-bg px-3 py-2 text-[13px] text-warn-fg">
        Copy it now. Spillway stores only a hash and cannot show it again.
      </p>
      <div className="rounded-lg bg-canvas p-3 font-mono text-[13px] break-all">{value}</div>
      <CopyButton value={value} label="Copy key" />
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold">Connect a client</h3>
        <Segmented
          label="Client"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'curl', label: 'curl / SDK' },
            { value: 'claude', label: 'Claude Code' },
            { value: 'webui', label: 'Open WebUI' },
          ]}
        />
        <pre className="overflow-x-auto rounded-lg bg-rail p-3 font-mono text-xs leading-relaxed text-rail-ink">
          {snippets[tab]}
        </pre>
      </div>
    </Aside>
  );
}
