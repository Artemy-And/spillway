import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { Button, ErrorNote, Field, Input } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { auth, unwrap } from '../lib/api.ts';
import { AuthShell } from './Setup.tsx';

export function LoginPage() {
  const { m } = useI18n();
  const { error: ssoError } = useSearch({ from: '/login' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { data: config } = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => unwrap(auth.config.$get()),
  });

  const login = useMutation({
    mutationFn: () => unwrap(auth.login.$post({ json: { email, password } })),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await navigate({ to: '/' });
    },
  });

  // Nobody exists yet: the first visitor creates the admin account instead.
  if (config?.setup) return <Navigate to="/setup" />;

  return (
    <AuthShell>
      <div>
        <h1 className="text-xl font-semibold">{m.login.title}</h1>
        <p className="mt-1 text-sm text-muted">{m.login.subtitle}</p>
      </div>
      {ssoError && <ErrorNote error={ssoError} />}
      {config?.sso && (
        <>
          <a
            href="/auth/oidc/start"
            className="flex h-11 items-center justify-center rounded-lg bg-accent text-sm font-medium text-white no-underline hover:bg-accent-strong hover:text-white"
          >
            {config.sso.label}
          </a>
          <div className="flex items-center gap-3 text-xs text-faint">
            <span className="h-px flex-1 bg-line" />
            {m.login.orPassword}
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate();
        }}
      >
        <Field label={m.common.email}>
          <Input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label={m.common.password}>
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorNote error={login.error} />
        <Button
          type="submit"
          variant={config?.sso ? 'secondary' : 'primary'}
          disabled={login.isPending}
          className="h-11"
        >
          {login.isPending ? m.login.submitting : m.login.submit}
        </Button>
      </form>
    </AuthShell>
  );
}
