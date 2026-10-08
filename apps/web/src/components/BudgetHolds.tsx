import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { api, type BudgetHoldRow, meQuery, unwrap } from '../lib/api.ts';
import { fmtDate } from '../lib/format.ts';
import { Button, Card, Empty, ErrorNote, Field, Input, Status, Switch } from './ui.tsx';

export function BudgetHolds() {
  const { m } = useI18n();
  const t = m.reservations;
  const holds = useQuery({
    queryKey: ['budget-holds'],
    queryFn: () => unwrap(api['budget-holds'].$get()),
    refetchInterval: 5000,
  });
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">{t.title}</h2>
        <p className="text-xs text-muted">{t.newest}</p>
      </div>
      <p className="text-sm text-muted">{t.hint}</p>
      <p className="text-xs text-muted">{t.limitHint}</p>
      <ErrorNote error={holds.error} />
      {holds.data?.length === 0 && <Empty>{t.empty}</Empty>}
      {holds.data?.map((row) => (
        <Hold key={row.reservation.id} row={row} />
      ))}
    </Card>
  );
}

function Hold({ row }: { row: BudgetHoldRow }) {
  const { m, locale } = useI18n();
  const t = m.reservations;
  const hold = row.reservation;
  const { data: me } = useQuery(meQuery);
  const editable = me?.user.role === 'admin' && !me.gateway.demo && hold.state === 'unknown';
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [verified, setVerified] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api['budget-holds'][':id'].$patch({
          param: { id: hold.id },
          json: { chargedUsd: Number(value) },
        }),
      ),
    onSuccess: async () => {
      await Promise.all(
        ['budget-holds', 'keys', 'teams', 'overview', 'routing-profiles', 'logs', 'log'].map(
          (key) => queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });
  const money = (number: number) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 6,
    }).format(number);
  const message =
    save.error instanceof Error &&
    save.error.message === 'Only an uncertain charge can be reconciled'
      ? new Error(t.onlyUncertain)
      : save.error;
  return (
    <div className="space-y-3 border-t border-line py-4">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <p className="font-medium">
            {row.keyName ?? '—'} · {hold.modelName}
          </p>
          <p className="text-xs text-muted">
            {hold.providerName} · {row.teamName ?? '—'} · {fmtDate(hold.createdAt)}
          </p>
        </div>
        <Status tone={hold.state === 'active' ? 'info' : 'warn'}>
          {hold.state === 'active' ? t.activeState : t.unknownState}
        </Status>
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {(
          [
            [t.estimate, hold.estimatedUsd],
            [t.spent, hold.chargedUsd],
            [hold.state === 'active' ? t.active : t.uncertain, hold.heldUsd],
          ] as const
        ).map(([label, number]) => (
          <div key={label}>
            <dt className="inline text-muted">{label}: </dt>
            <dd className="inline font-mono">{money(number)}</dd>
          </div>
        ))}
      </dl>
      {row.logId ? (
        <Link to="/logs" search={{ id: row.logId }} className="font-mono text-xs text-accent">
          {hold.requestId}
        </Link>
      ) : (
        <p className="font-mono text-xs text-muted">{hold.requestId}</p>
      )}
      {editable && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirm(t.confirm)) save.mutate();
          }}
        >
          <Field label={t.charge}>
            <Input
              type="number"
              min={0}
              max={1000000}
              step="any"
              required
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={save.isPending}
            />
          </Field>
          <Switch
            checked={verified}
            onChange={setVerified}
            label={t.verify}
            disabled={save.isPending}
          />
          <ErrorNote error={message} />
          <Button
            type="submit"
            disabled={
              save.isPending ||
              !verified ||
              !value.trim() ||
              !Number.isFinite(Number(value)) ||
              Number(value) < 0
            }
          >
            {t.save}
          </Button>
        </form>
      )}
    </div>
  );
}
