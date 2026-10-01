import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button, ErrorNote, Field, Input } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { auth, unwrap } from '../lib/api.ts';
import { AuthShell } from './Setup.tsx';

/** Opened from a link an admin sent: a new person joins, or someone sets a new password. */
export function InvitePage() {
  const { m } = useI18n();
  const { token } = useParams({ from: '/invite/$token' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => unwrap(auth.invite[':token'].$get({ param: { token } })),
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm !== '' && confirm !== password;
  const reset = !!invite.data?.hasPassword;

  useEffect(() => {
    if (invite.data?.name) setName(invite.data.name);
  }, [invite.data?.name]);

  const accept = useMutation({
    mutationFn: () =>
      unwrap(
        auth.invite[':token'].$post({ param: { token }, json: { name: name.trim(), password } }),
      ),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: '/' });
    },
  });

  if (invite.isLoading) {
    return (
      <AuthShell>
        <p className="text-sm text-muted">{m.invite.checking}</p>
      </AuthShell>
    );
  }

  if (!invite.data) {
    return (
      <AuthShell>
        <ErrorNote error={invite.error} />
        <Link to="/login" search={{ error: undefined }} className="text-sm font-medium">
          {m.invite.toSignIn}
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div>
        <h1 className="text-xl font-semibold">{reset ? m.invite.resetTitle : m.invite.title}</h1>
        <p className="mt-1 text-sm text-muted">
          {(reset ? m.invite.resetSubtitle : m.invite.subtitle)(invite.data.email)}
        </p>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!mismatch) accept.mutate();
        }}
      >
        <Field label={m.setup.name}>
          <Input
            required
            autoComplete="name"
            maxLength={128}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {/* Lets password managers save the login under the right email. */}
        <input type="email" autoComplete="username" value={invite.data.email} readOnly hidden />
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
        <ErrorNote error={accept.error} />
        <Button
          type="submit"
          variant="primary"
          disabled={accept.isPending || mismatch}
          className="h-11"
        >
          {accept.isPending ? m.invite.submitting : reset ? m.invite.resetSubmit : m.invite.submit}
        </Button>
      </form>
    </AuthShell>
  );
}
