import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { Logo } from '../components/Layout.tsx';
import { Button, ErrorNote, Field, Input } from '../components/ui.tsx';
import { LanguageSelect, useI18n } from '../i18n/index.tsx';
import { auth, unwrap } from '../lib/api.ts';
import { browserZone } from '../lib/format.ts';

/**
 * First start: the admin account, created by someone holding the setup code the server prints to
 * its logs. The printed link fills the code in.
 */
export function SetupPage() {
  const { m } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { code: linked } = useSearch({ from: '/setup' });
  const [code, setCode] = useState(linked ?? '');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm !== '' && confirm !== password;
  const { data: config } = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => unwrap(auth.config.$get()),
  });

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        auth.setup.$post({
          // The browser's zone becomes the gateway's, so budgets reset on the team's midnight.
          json: { name: name.trim(), email, password, code: code.trim(), timeZone: browserZone() },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await navigate({ to: '/' });
    },
  });

  return (
    <AuthShell>
      <div>
        <h1 className="text-xl font-semibold">{m.setup.title}</h1>
        <p className="mt-1 text-sm text-muted">{m.setup.subtitle}</p>
      </div>
      {config?.sso && (
        <>
          <a
            href="/auth/oidc/start"
            className="flex h-11 items-center justify-center rounded-lg bg-accent text-sm font-medium text-white no-underline hover:bg-accent-strong hover:text-white"
          >
            {config.sso.label}
          </a>
          <p className="-mt-3 text-xs text-muted">{m.setup.ssoHint}</p>
          <div className="flex items-center gap-3 text-xs text-faint">
            <span className="h-px flex-1 bg-line" />
            {m.setup.orSso}
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!mismatch) create.mutate();
        }}
      >
        <Field label={m.setup.code} hint={m.setup.codeHint}>
          <Input
            required
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field label={m.setup.name}>
          <Input
            required
            autoComplete="name"
            maxLength={128}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={m.common.email}>
          <Input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label={m.common.password} hint={m.setup.passwordHint}>
          <Input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={m.setup.confirm} hint={mismatch ? m.setup.mismatch : undefined}>
          <Input
            type="password"
            required
            autoComplete="new-password"
            aria-invalid={mismatch}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <ErrorNote error={create.error} />
        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending || mismatch}
          className="h-11"
        >
          {create.isPending ? m.setup.submitting : m.setup.submit}
        </Button>
        <p className="text-center text-xs text-muted">{m.setup.note}</p>
      </form>
    </AuthShell>
  );
}

/** The dark backdrop and card the sign-in and setup pages share. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-rail px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-xl bg-surface p-8 shadow-xl">
        <div className="flex items-center justify-between gap-3 text-ink">
          <Logo />
          <LanguageSelect className="h-8 cursor-pointer rounded-md border border-field bg-surface px-2 text-xs text-ink-2" />
        </div>
        {children}
      </div>
    </div>
  );
}
