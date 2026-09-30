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
import { api, meQuery, modelsQuery, teamsQuery, unwrap } from '../lib/api.ts';
import { fmtAgo } from '../lib/format.ts';

export function SettingsPage() {
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
      <PageHeader title="Settings & SSO" subtitle="Privacy, rerouting and who can sign in." />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card aria-label="Prompt storage" className="flex flex-col gap-4 px-6 py-5">
          <h2 className="text-[15px] font-semibold">Prompt storage</h2>
          <Switch
            checked={storePrompts}
            onChange={setStorePrompts}
            label="Keep prompts and answers in the log"
            description="Emails, phone numbers, card and document numbers and API keys are masked before anything is written."
          />
          <Field
            label="Keep texts for, days"
            hint="After that only the numbers stay: tokens, cost, route. Budgets keep working."
          >
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
            Save
          </Button>
        </Card>

        <Card aria-label="Rerouting" className="flex flex-col gap-4 px-6 py-5">
          <h2 className="text-[15px] font-semibold">Local model for rerouting</h2>
          <p className="text-[13px] text-muted">
            Budgets and rules send requests here instead of blocking them. Without one, those
            requests are refused with a clear error.
          </p>
          <Field label="Model">
            <Select
              value={settings?.localModelId ?? ''}
              onChange={(e) => save.mutate({ localModelId: e.target.value || null })}
            >
              <option value="">None: block instead</option>
              {local.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label ?? model.name} ({model.provider})
                </option>
              ))}
            </Select>
          </Field>
          {local.length === 0 && (
            <p className="text-[13px] text-warn-fg">Add an Ollama provider and its models first.</p>
          )}
        </Card>
      </div>

      <Card aria-label="Single sign-on" className="flex flex-col gap-3 px-6 py-5">
        <div className="flex items-center gap-3">
          <h2 className="text-[15px] font-semibold">Single sign-on</h2>
          {settings?.sso ? (
            <Status tone="ok">Connected</Status>
          ) : (
            <Status tone="off">Not set up</Status>
          )}
          <span className="text-[13px] text-muted">Free, like everything else here.</span>
        </div>
        {settings?.sso ? (
          <dl className="grid grid-cols-[160px_1fr] gap-x-3 gap-y-2 text-[13px]">
            <dt className="text-muted">Issuer</dt>
            <dd className="font-mono text-xs">{settings.sso.issuer}</dd>
            <dt className="text-muted">Allowed domains</dt>
            <dd>{settings.sso.allowedDomains.join(', ') || 'Only people added below'}</dd>
            <dt className="text-muted">Become admins</dt>
            <dd>{settings.sso.adminEmails.join(', ') || '—'}</dd>
            <dt className="text-muted">Redirect URI</dt>
            <dd className="font-mono text-xs">{redirect}</dd>
          </dl>
        ) : (
          <>
            <p className="text-[13px] text-muted">
              Works with Google Workspace, Microsoft Entra ID or any OpenID Connect provider.
              Register an app there with this redirect URI, then set the variables and restart:
            </p>
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
    <Card aria-label="People" className="flex flex-col gap-4 overflow-x-auto px-6 py-5">
      <div>
        <h2 className="text-[15px] font-semibold">People</h2>
        <p className="mt-1 text-[13px] text-muted">
          Add someone before their first SSO sign-in to put them in a team. They can then create
          their own keys.
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Email" className="min-w-60 flex-1">
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
          />
        </Field>
        <Field label="Team">
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">No team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={add.isPending}>
          Add person
        </Button>
      </form>
      <ErrorNote error={add.error ?? update.error} />
      <div className="min-w-[720px]">
        <div className="grid grid-cols-[2fr_1fr_1.2fr_1fr_90px] gap-3 border-b border-line py-2.5 text-xs font-medium text-muted">
          <div>Person</div>
          <div>Role</div>
          <div>Team</div>
          <div>Last sign-in</div>
          <div>Active</div>
        </div>
        {users.length === 0 && <Empty>No people yet.</Empty>}
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
              aria-label={`${user.email} role`}
              className="h-8"
              value={user.role}
              disabled={user.id === me?.user.id}
              onChange={(e) =>
                update.mutate({ id: user.id, role: e.target.value as 'member' | 'admin' })
              }
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
            <Select
              aria-label={`${user.email} team`}
              className="h-8"
              value={user.teamId ?? ''}
              onChange={(e) => update.mutate({ id: user.id, teamId: e.target.value || null })}
            >
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <span className="text-[13px] text-ink-2">{fmtAgo(user.lastLoginAt)}</span>
            <input
              type="checkbox"
              aria-label={`${user.email} active`}
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
