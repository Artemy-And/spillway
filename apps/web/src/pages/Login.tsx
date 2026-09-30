import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { Logo } from '../components/Layout.tsx';
import { Button, ErrorNote, Field, Input } from '../components/ui.tsx';
import { auth, unwrap } from '../lib/api.ts';

export function LoginPage() {
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

  return (
    <div className="flex min-h-dvh items-center justify-center bg-rail px-4">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-xl bg-surface p-8 shadow-xl">
        <div className="text-ink">
          <Logo />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-muted">Manage keys, budgets and the request log.</p>
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
              or with a password
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
          <Field label="Email">
            <Input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password">
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
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
