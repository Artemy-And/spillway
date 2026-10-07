import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button, Card, ErrorNote, Field, Input, PageHeader } from '../components/ui.tsx';
import { LanguageSelect, useI18n } from '../i18n/index.tsx';
import { api, meQuery, unwrap } from '../lib/api.ts';

export function AccountPage() {
  const { m } = useI18n();
  const { data: me } = useQuery(meQuery);

  return (
    <>
      <PageHeader title={m.account.title} subtitle={m.account.subtitle} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {me && (
          <Profile
            name={me.user.name ?? ''}
            email={me.user.email}
            emailLocked={me.user.emailLocked}
          />
        )}
        {me && <Password hasPassword={me.user.hasPassword} />}
        <Card aria-label={m.common.language} className="flex flex-col gap-3 px-6 py-5">
          <h2 className="text-[15px] font-semibold">{m.common.language}</h2>
          <LanguageSelect className="h-10 w-full max-w-xs cursor-pointer rounded-lg border border-field bg-surface px-2.5 text-sm text-ink" />
          <p className="text-xs text-muted">{m.account.languageHint}</p>
        </Card>
        <Tour />
      </div>
    </>
  );
}

function Profile({
  name: savedName,
  email: savedEmail,
  emailLocked,
}: {
  name: string;
  email: string;
  emailLocked: boolean;
}) {
  const { m } = useI18n();
  const queryClient = useQueryClient();
  const [name, setName] = useState(savedName);
  const [email, setEmail] = useState(savedEmail);
  useEffect(() => {
    setName(savedName);
    setEmail(savedEmail);
  }, [savedName, savedEmail]);

  const save = useMutation({
    mutationFn: () => unwrap(api.me.$patch({ json: { name: name.trim(), email } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
  const dirty = name.trim() !== savedName || email.trim().toLowerCase() !== savedEmail;

  return (
    <Card aria-label={m.account.profile} className="flex flex-col gap-4 px-6 py-5">
      <h2 className="text-[15px] font-semibold">{m.account.profile}</h2>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label={m.common.name}>
          <Input
            required
            maxLength={128}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={m.common.email} hint={emailLocked ? m.account.emailFromSso : undefined}>
          <Input
            type="email"
            required
            autoComplete="email"
            value={email}
            disabled={emailLocked}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <ErrorNote error={save.error} />
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
            {m.common.save}
          </Button>
          {save.isSuccess && !dirty && (
            <span className="text-[13px] text-accent-strong">{m.common.saved}</span>
          )}
        </div>
      </form>
    </Card>
  );
}

function Password({ hasPassword }: { hasPassword: boolean }) {
  const { m } = useI18n();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm !== '' && confirm !== password;

  const change = useMutation({
    mutationFn: () =>
      unwrap(
        api.me.password.$post({
          json: { password, ...(hasPassword ? { current } : {}) },
        }),
      ),
    onSuccess: async () => {
      // Changing the password ends every session, this one included.
      setTimeout(() => navigate({ to: '/login', search: { error: undefined } }), 1500);
    },
  });

  return (
    <Card aria-label={m.account.password} className="flex flex-col gap-4 px-6 py-5">
      <h2 className="text-[15px] font-semibold">{m.account.password}</h2>
      {!hasPassword && <p className="text-[13px] text-muted">{m.account.noPassword}</p>}
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!mismatch) change.mutate();
        }}
      >
        {hasPassword && (
          <Field label={m.account.current}>
            <Input
              type="password"
              required
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
        )}
        <Field label={m.account.newPassword} hint={m.setup.passwordHint}>
          <Input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={m.account.confirm} hint={mismatch ? m.setup.mismatch : undefined}>
          <Input
            type="password"
            required
            autoComplete="new-password"
            aria-invalid={mismatch}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <ErrorNote error={change.error} />
        {change.isSuccess ? (
          <p className="rounded-lg bg-ok-bg px-3 py-2 text-[13px] text-ok-fg">
            {m.account.changed}
          </p>
        ) : (
          <Button
            type="submit"
            variant="primary"
            className="self-start"
            disabled={change.isPending || mismatch}
          >
            {m.account.change}
          </Button>
        )}
      </form>
    </Card>
  );
}

function Tour() {
  const { m } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const again = useMutation({
    mutationFn: () => unwrap(api.me.$patch({ json: { welcomed: false, checklistHidden: false } })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await navigate({ to: '/' });
    },
  });
  return (
    <Card aria-label={m.account.tour} className="flex flex-col gap-3 px-6 py-5">
      <h2 className="text-[15px] font-semibold">{m.account.tour}</h2>
      <p className="text-[13px] text-muted">{m.account.tourText}</p>
      <Button className="self-start" disabled={again.isPending} onClick={() => again.mutate()}>
        {m.account.tourButton}
      </Button>
    </Card>
  );
}
