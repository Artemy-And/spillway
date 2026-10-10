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
  type KeyKind,
  KINDS,
  PageHeader,
  Progress,
  Segmented,
  Select,
  Status,
  Switch,
  type Tone,
} from '../components/ui.tsx';
import type { Messages } from '../i18n/en.ts';
import { useI18n } from '../i18n/index.tsx';
import { api, type KeyRow, meQuery, modelsQuery, teamsQuery, unwrap } from '../lib/api.ts';
import { fmtAgo, fmtLimit, fmtUsd, pct } from '../lib/format.ts';

type Kind = KeyKind;
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

function status(key: KeyRow, m: Messages): { label: string; tone: Tone } {
  const labels = m.keys.status;
  if (key.revokedAt) return { label: labels.revoked, tone: 'off' };
  if (key.dailyLimitUsd != null && key.spentToday >= key.dailyLimitUsd) {
    return key.fallbackToLocal
      ? { label: labels.localOnly, tone: 'info' }
      : { label: labels.limitReached, tone: 'block' };
  }
  if (key.dailyLimitUsd && key.spentToday >= key.dailyLimitUsd * 0.8)
    return { label: labels.nearLimit, tone: 'warn' };
  return { label: labels.active, tone: 'ok' };
}

const money = (value: string) => (value.trim() === '' ? null : Number(value));

export function KeysPage() {
  const { m } = useI18n();
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
      <PageHeader title={m.keys.title} subtitle={m.keys.subtitle}>
        <Button variant="primary" onClick={openNew}>
          <PlusIcon strokeWidth={2.2} />
          {m.keys.newKey}
        </Button>
      </PageHeader>

      <div className="flex flex-col gap-6 xl:flex-row">
        <section aria-label={m.keys.allKeys} className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Segmented
              label={m.keys.keyType}
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: m.keys.filterAll(counts.all) },
                { value: 'person', label: m.keys.filterPeople(counts.person) },
                { value: 'device', label: m.keys.filterDevices(counts.device) },
                { value: 'agent', label: m.keys.filterAgents(counts.agent) },
              ]}
            />
            <label className="flex h-10 w-full items-center gap-2 rounded-lg border border-field bg-surface px-3 text-muted sm:w-60">
              <SearchIcon />
              <span className="sr-only">{m.keys.search}</span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={m.keys.searchPlaceholder}
                className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
              />
            </label>
          </div>

          <Card className="overflow-x-auto px-5 py-1">
            <div className="min-w-[640px]">
              <div className="grid grid-cols-[2fr_0.9fr_1.7fr_1fr_1fr] gap-3.5 border-b border-line py-3 text-xs font-medium text-muted">
                <div>{m.common.key}</div>
                <div>{m.common.type}</div>
                <div>{m.keys.todayVsLimit}</div>
                <div>{m.keys.lastUsed}</div>
                <div>{m.common.status}</div>
              </div>
              {visible.length === 0 && <Empty>{keys.length ? m.keys.noMatch : m.keys.none}</Empty>}
              {visible.map((key) => {
                const s = status(key, m);
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
                        {[key.owner, key.team && m.keys.teamSuffix(key.team)]
                          .filter(Boolean)
                          .join(' · ') || m.keys.noOwner}{' '}
                        · <span className="font-mono">{key.prefix}…</span>
                      </span>
                    </div>
                    <div>
                      <Chip>{m.kinds[key.kind]}</Chip>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {key.dailyLimitUsd != null ? (
                        <>
                          <Progress
                            value={used}
                            color={used >= 80 ? 'bg-warn-bar' : 'bg-accent'}
                            label={m.keys.limitUsed(key.name)}
                          />
                          <span className="font-mono text-xs text-ink-2">
                            {fmtUsd(key.spentToday)} / {fmtLimit(key.dailyLimitUsd)}
                          </span>
                        </>
                      ) : (
                        <span className="font-mono text-xs text-ink-2">
                          {m.keys.todayNoLimit(fmtUsd(key.spentToday))}
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
          <Aside label={panel.mode === 'new' ? m.keys.newKey : m.keys.editKey}>
            <form
              className="flex flex-col gap-[18px]"
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate();
              }}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-[17px] font-semibold">
                  {panel.mode === 'new'
                    ? m.keys.newKey
                    : editing
                      ? m.common.edit(editing.name)
                      : m.keys.editKey}
                </h2>
                <button
                  type="button"
                  aria-label={m.common.close}
                  onClick={() => setPanel(null)}
                  className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-track"
                >
                  <CloseIcon />
                </button>
              </div>

              <Field label={m.common.name}>
                <Input
                  mono
                  required
                  maxLength={64}
                  placeholder={m.keys.namePlaceholder}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>

              {isAdmin && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label={m.keys.owner}>
                    <Select
                      value={draft.userId}
                      onChange={(e) => setDraft({ ...draft, userId: e.target.value })}
                    >
                      <option value="">{m.keys.nobody}</option>
                      {users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name ?? user.email}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={m.common.team}>
                    <Select
                      value={draft.teamId}
                      onChange={(e) => setDraft({ ...draft, teamId: e.target.value })}
                    >
                      <option value="">{draft.userId ? m.keys.ownersTeam : m.common.noTeam}</option>
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
                <legend className="mb-1.5 text-[13px] font-medium">{m.common.type}</legend>
                <div className="grid grid-cols-3 gap-1.5">
                  {KINDS.map((kind) => (
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
                      {m.kinds[kind]}
                    </label>
                  ))}
                </div>
              </fieldset>

              {isAdmin && (
                <>
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1.5 text-[13px] font-medium">
                      {m.keys.allowedModels}
                    </legend>
                    <Switch
                      checked={draft.allowedModelIds === null}
                      onChange={(all) =>
                        setDraft({
                          ...draft,
                          allowedModelIds: all ? null : models.map((m) => m.id),
                        })
                      }
                      label={m.keys.everything}
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
                          {model.isLocal && <span className="text-muted">· {m.common.local}</span>}
                        </label>
                      ))}
                  </fieldset>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label={m.keys.daily}>
                      <Input
                        mono
                        inputMode="decimal"
                        type="number"
                        min="0"
                        step="any"
                        placeholder={m.common.none}
                        value={draft.daily}
                        onChange={(e) => setDraft({ ...draft, daily: e.target.value })}
                      />
                    </Field>
                    <Field label={m.keys.monthly}>
                      <Input
                        mono
                        inputMode="decimal"
                        type="number"
                        min="0"
                        step="any"
                        placeholder={m.common.none}
                        value={draft.monthly}
                        onChange={(e) => setDraft({ ...draft, monthly: e.target.value })}
                      />
                    </Field>
                  </div>

                  <div className="rounded-lg bg-canvas p-3">
                    <Switch
                      checked={draft.fallbackToLocal}
                      onChange={(fallbackToLocal) => setDraft({ ...draft, fallbackToLocal })}
                      label={m.keys.fallback}
                      description={
                        localModel
                          ? m.keys.fallbackTo(localModel.label ?? localModel.name)
                          : m.keys.fallbackNone
                      }
                    />
                  </div>
                </>
              )}
              {!isAdmin && <p className="text-[13px] text-muted">{m.keys.adminSets}</p>}

              <ErrorNote error={save.error ?? revoke.error} />
              <div className="flex flex-wrap justify-between gap-2.5">
                {editing ? (
                  <Button
                    variant="danger"
                    onClick={() =>
                      confirm(m.keys.revokeConfirm(editing.name)) && revoke.mutate(editing.id)
                    }
                  >
                    {m.keys.revoke}
                  </Button>
                ) : (
                  <span />
                )}
                <div className="flex gap-2.5">
                  <Button onClick={() => setPanel(null)}>{m.common.cancel}</Button>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={save.isPending || !draft.name.trim()}
                  >
                    {panel.mode === 'new' ? m.keys.create : m.common.save}
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
  const { m } = useI18n();
  const [tab, setTab] = useState<'curl' | 'chatbox' | 'claude' | 'codex' | 'webui'>('curl');
  const origin = window.location.origin;
  const model = m.keys.modelPlaceholder;
  // In Windows PowerShell "curl" is another command; curl.exe works there and in Git Bash.
  const windows = navigator.userAgent.includes('Windows');
  const snippets = {
    chatbox: `Chatbox → Settings → Model provider → Add custom provider\n\nAPI mode:  OpenAI API Compatible\nAPI host:  ${origin}/v1\nAPI key:   ${value}`,
    curl: `curl ${origin}/v1/chat/completions \\\n  -H "Authorization: Bearer ${value}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Hi"}]}'`,
    // Claude Code's settings file covers the terminal and VS Code. It also sends background
    // requests (titles, summaries) to its Haiku model, and shows the status line after messages.
    claude: JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: origin,
          ANTHROPIC_AUTH_TOKEN: value,
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        },
        statusLine: {
          type: 'command',
          command: `${windows ? 'curl.exe' : 'curl'} -s -m 2 -H "Authorization: Bearer ${value}" --data-binary "@-" ${origin}/v1/spillway/status`,
        },
      },
      null,
      2,
    ),
    codex: `# ~/.codex/config.toml\nmodel = "${model}"\nmodel_provider = "spillway"\n\n[model_providers.spillway]\nname = "Spillway"\nbase_url = "${origin}/v1"\nenv_key = "SPILLWAY_API_KEY"\nwire_api = "responses"\n\n# then, in the terminal: macOS, Linux\nexport SPILLWAY_API_KEY=${value}\ncodex\n\n# or Windows PowerShell\n$env:SPILLWAY_API_KEY = "${value}"\ncodex`,
    webui: `Open WebUI → Settings → Connections\n\nOpenAI API:  ${origin}/v1\nOllama API:  ${origin}\nKey:         ${value}`,
  };
  return (
    <Aside label={m.keys.keyCreated}>
      <div className="flex items-center justify-between">
        <h2 className="text-[17px] font-semibold">{m.keys.ready(name)}</h2>
        <button
          type="button"
          aria-label={m.common.close}
          onClick={onClose}
          className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-track"
        >
          <CloseIcon />
        </button>
      </div>
      <p className="rounded-lg bg-warn-bg px-3 py-2 text-[13px] text-warn-fg">{m.keys.copyNow}</p>
      <div className="rounded-lg bg-canvas p-3 font-mono text-[13px] break-all">{value}</div>
      <CopyButton value={value} label={m.keys.copyKey} />
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold">{m.keys.connect}</h3>
        <Segmented
          label={m.keys.client}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'curl', label: 'curl / SDK' },
            { value: 'chatbox', label: 'Chatbox' },
            { value: 'claude', label: 'Claude Code' },
            { value: 'codex', label: 'Codex' },
            { value: 'webui', label: 'Open WebUI' },
          ]}
        />
        {tab === 'claude' && <p className="text-[12px] text-muted">{m.keys.claudeFile}</p>}
        <pre className="overflow-x-auto rounded-lg bg-rail p-3 font-mono text-xs leading-relaxed text-rail-ink">
          {snippets[tab]}
        </pre>
        <div>
          <CopyButton value={snippets[tab]} />
        </div>
        {tab === 'claude' && (
          <p className="text-[12px] text-muted">
            {m.keys.claudeStatus} {windows ? m.keys.claudeOnMac : m.keys.claudeOnWindows}
          </p>
        )}
      </div>
    </Aside>
  );
}
