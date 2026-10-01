import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  Select,
  Status,
  Switch,
} from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { api, meQuery, modelsQuery, teamsQuery, unwrap } from '../lib/api.ts';
import { fmtAgo } from '../lib/format.ts';

export function SettingsPage() {
  const { m } = useI18n();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => unwrap(api.settings.$get()),
  });
  const { data: models = [] } = useQuery(modelsQuery);
  const [storePrompts, setStorePrompts] = useState(true);
  const [retention, setRetention] = useState('30');

  useEffect(() => {
    if (!settings) return;
    setStorePrompts(settings.storePrompts);
    setRetention(String(settings.retentionDays));
  }, [settings]);

  const save = useMutation({
    mutationFn: (json: {
      storePrompts?: boolean;
      retentionDays?: number;
      localModelId?: string | null;
      rerouteOnFailure?: boolean;
    }) => unwrap(api.settings.$put({ json })),
    onSuccess: () =>
      Promise.all(
        ['settings', 'rules'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
      ),
  });

  const local = models.filter((m) => m.isLocal && m.enabled);
  const redirect = settings ? `${settings.publicUrl.replace(/\/$/, '')}/auth/oidc/callback` : '';

  return (
    <>
      <PageHeader title={m.settings.title} subtitle={m.settings.subtitle} />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card aria-label={m.settings.storage} className="flex flex-col gap-4 px-6 py-5">
          <h2 className="text-[15px] font-semibold">{m.settings.storage}</h2>
          <Switch
            checked={storePrompts}
            onChange={setStorePrompts}
            label={m.settings.keepPrompts}
            description={m.settings.keepPromptsHint}
          />
          <Field label={m.settings.keepDays} hint={m.settings.keepDaysHint}>
            <Input
              mono
              type="number"
              min={1}
              max={3650}
              className="w-32"
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
            />
          </Field>
          <ErrorNote error={save.error} />
          <Button
            variant="primary"
            className="self-start"
            disabled={save.isPending}
            onClick={() => save.mutate({ storePrompts, retentionDays: Number(retention) })}
          >
            {m.common.save}
          </Button>
        </Card>

        <Card aria-label={m.settings.rerouting} className="flex flex-col gap-4 px-6 py-5">
          <h2 className="text-[15px] font-semibold">{m.settings.rerouting}</h2>
          <p className="text-[13px] text-muted">{m.settings.reroutingText}</p>
          <Field label={m.common.model}>
            <Select
              value={settings?.localModelId ?? ''}
              onChange={(e) => save.mutate({ localModelId: e.target.value || null })}
            >
              <option value="">{m.settings.noneBlock}</option>
              {local.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label ?? model.name} ({model.provider})
                </option>
              ))}
            </Select>
          </Field>
          {local.length === 0 && <p className="text-[13px] text-warn-fg">{m.settings.addOllama}</p>}
          <Switch
            checked={settings?.rerouteOnFailure ?? true}
            disabled={!settings?.localModelId}
            onChange={(rerouteOnFailure) => save.mutate({ rerouteOnFailure })}
            label={m.settings.onFailure}
            description={m.settings.onFailureHint}
          />
        </Card>
      </div>

      <Card aria-label={m.settings.sso} className="flex flex-col gap-3 px-6 py-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[15px] font-semibold">{m.settings.sso}</h2>
          {settings?.sso ? (
            <Status tone="ok">{m.settings.connected}</Status>
          ) : (
            <Status tone="off">{m.settings.notSetUp}</Status>
          )}
          <span className="text-[13px] text-muted">{m.settings.free}</span>
        </div>
        {settings?.sso ? (
          <dl className="grid grid-cols-[160px_1fr] gap-x-3 gap-y-2 text-[13px]">
            <dt className="text-muted">{m.settings.issuer}</dt>
            <dd className="font-mono text-xs">{settings.sso.issuer}</dd>
            <dt className="text-muted">{m.settings.domains}</dt>
            <dd>{settings.sso.allowedDomains.join(', ') || m.settings.onlyAdded}</dd>
            <dt className="text-muted">{m.settings.becomeAdmins}</dt>
            <dd>{settings.sso.adminEmails.join(', ') || '—'}</dd>
            <dt className="text-muted">{m.settings.redirect}</dt>
            <dd className="font-mono text-xs">{redirect}</dd>
          </dl>
        ) : (
          <>
            <p className="text-[13px] text-muted">{m.settings.ssoIntro}</p>
            <pre className="overflow-x-auto rounded-lg bg-rail p-3 font-mono text-xs leading-relaxed text-rail-ink">
              {`# redirect URI: ${redirect}
OIDC_ISSUER=https://accounts.google.com   # or https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_ALLOWED_DOMAINS=example.com
ADMIN_EMAILS=you@example.com`}
            </pre>
          </>
        )}
      </Card>

      <People />
    </>
  );
}

function People() {
  const { m } = useI18n();
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => unwrap(api.users.$get()),
  });
  const { data: teams = [] } = useQuery(teamsQuery);
  const [email, setEmail] = useState('');
  const [teamId, setTeamId] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const add = useMutation({
    mutationFn: () => unwrap(api.users.$post({ json: { email, role, teamId: teamId || null } })),
    onSuccess: async () => {
      setEmail('');
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({
      id,
      ...json
    }: {
      id: string;
      role?: 'member' | 'admin';
      teamId?: string | null;
      disabled?: boolean;
    }) => unwrap(api.users[':id'].$patch({ param: { id }, json })),
    onSuccess: refresh,
  });

  return (
    <Card aria-label={m.settings.people} className="flex flex-col gap-4 overflow-x-auto px-6 py-5">
      <div>
        <h2 className="text-[15px] font-semibold">{m.settings.people}</h2>
        <p className="mt-1 text-[13px] text-muted">{m.settings.peopleIntro}</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label={m.common.email} className="min-w-60 flex-1">
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
          />
        </Field>
        <Field label={m.common.team}>
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">{m.common.noTeam}</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={m.common.role}>
          <Select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
            <option value="member">{m.common.member}</option>
            <option value="admin">{m.common.admin}</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={add.isPending}>
          {m.settings.addPerson}
        </Button>
      </form>
      <ErrorNote error={add.error ?? update.error} />
      <div className="min-w-[720px]">
        <div className="grid grid-cols-[2fr_1fr_1.2fr_1fr_90px] gap-3 border-b border-line py-2.5 text-xs font-medium text-muted">
          <div>{m.settings.person}</div>
          <div>{m.common.role}</div>
          <div>{m.common.team}</div>
          <div>{m.settings.lastSignIn}</div>
          <div>{m.settings.active}</div>
        </div>
        {users.length === 0 && <Empty>{m.settings.noPeople}</Empty>}
        {users.map((user) => (
          <div
            key={user.id}
            className="grid grid-cols-[2fr_1fr_1.2fr_1fr_90px] items-center gap-3 border-b border-line-soft py-2.5 text-sm last:border-0"
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate">{user.name ?? user.email}</span>
              {user.name && <span className="truncate text-xs text-muted">{user.email}</span>}
            </div>
            <Select
              aria-label={m.settings.roleLabel(user.email)}
              className="h-8"
              value={user.role}
              disabled={user.id === me?.user.id}
              onChange={(e) =>
                update.mutate({ id: user.id, role: e.target.value as 'member' | 'admin' })
              }
            >
              <option value="member">{m.common.member}</option>
              <option value="admin">{m.common.admin}</option>
            </Select>
            <Select
              aria-label={m.settings.teamLabel(user.email)}
              className="h-8"
              value={user.teamId ?? ''}
              onChange={(e) => update.mutate({ id: user.id, teamId: e.target.value || null })}
            >
              <option value="">{m.common.noTeam}</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <span className="text-[13px] text-ink-2">{fmtAgo(user.lastLoginAt)}</span>
            <input
              type="checkbox"
              aria-label={m.settings.activeLabel(user.email)}
              checked={!user.disabledAt}
              disabled={user.id === me?.user.id}
              onChange={(e) => update.mutate({ id: user.id, disabled: !e.target.checked })}
              className="size-4 accent-accent"
            />
          </div>
        ))}
      </div>
    </Card>
  );
}
