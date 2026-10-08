import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  PageHeader,
  Select,
  Status,
  Switch,
} from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { api, meQuery, type RoutingProfileRow, unwrap } from '../lib/api.ts';
import { fmtNumber } from '../lib/format.ts';

export function RoutingProfilesPage() {
  const { m } = useI18n();
  const t = m.profiles;
  const profiles = useQuery({
    queryKey: ['routing-profiles'],
    queryFn: () => unwrap(api['routing-profiles'].$get()),
    refetchInterval: 10_000,
  });
  return (
    <div className="space-y-6">
      <PageHeader title={t.title} subtitle={t.subtitle}>
        <Link
          to="/comparisons"
          search={{ id: undefined }}
          className="text-sm font-medium text-accent"
        >
          {t.comparisons}
        </Link>
      </PageHeader>
      <ErrorNote error={profiles.error} />
      {profiles.data?.length === 0 && (
        <Card>
          <Empty>{t.empty}</Empty>
        </Card>
      )}
      {profiles.data?.map((profile) => (
        <Profile key={profile.id} profile={profile} />
      ))}
    </div>
  );
}

function Profile({ profile }: { profile: RoutingProfileRow }) {
  const { m, locale } = useI18n();
  const t = m.profiles;
  const queryClient = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['routing-profiles'] });
  const update = useMutation({
    mutationFn: (json: { enabled?: boolean; fallbackOnError?: boolean; rolloutPercent?: number }) =>
      unwrap(api['routing-profiles'][':id'].$patch({ param: { id: profile.id }, json })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api['routing-profiles'][':id'].$delete({ param: { id: profile.id } })),
    onSuccess: refresh,
  });
  const money = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(value);
  const disabled = update.isPending || remove.isPending || !!me?.gateway.demo;
  const stats = profile.metrics;
  const tools = profile.evidence.mode === 'tools';
  return (
    <Card className="space-y-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{profile.name}</h2>
          <Status tone="info">
            {tools ? m.sessionRouting.toolsMode : m.sessionRouting.textMode}
          </Status>
          <p className="text-sm text-muted">
            {profile.keyName} · {profile.evidence.baselineLabel} → {profile.evidence.candidateLabel}
          </p>
        </div>
        {profile.revokedAt && <Status tone="block">{t.revoked}</Status>}
        <Button
          variant="danger"
          disabled={disabled}
          onClick={() => {
            if (confirm(t.deleteConfirm)) remove.mutate();
          }}
        >
          {t.delete}
        </Button>
      </div>
      <Switch
        checked={profile.enabled}
        onChange={(enabled) => update.mutate({ enabled })}
        label={t.enabled}
        disabled={disabled || !!profile.revokedAt}
      />
      {tools ? (
        <p className="text-sm text-muted">{m.sessionRouting.fallbackHint}</p>
      ) : (
        <Switch
          checked={profile.fallbackOnError}
          onChange={(fallbackOnError) => update.mutate({ fallbackOnError })}
          label={t.fallback}
          description={t.fallbackHint}
          disabled={disabled}
        />
      )}
      {tools && <p className="text-sm text-muted">{m.sessionRouting.connectionHint}</p>}
      {tools && (
        <label className="space-y-2 text-sm" htmlFor={`rollout-${profile.id}`}>
          <span>{m.sessionRouting.rollout}</span>
          <Select
            id={`rollout-${profile.id}`}
            value={profile.rolloutPercent}
            disabled={disabled}
            onChange={(e) => update.mutate({ rolloutPercent: Number(e.target.value) })}
          >
            {[...new Set([0, 5, 10, 25, 50, 100, profile.rolloutPercent])]
              .sort((a, b) => a - b)
              .map((value) => (
                <option key={value} value={value}>
                  {value}%
                </option>
              ))}
          </Select>
          <p className="text-xs text-muted">{m.sessionRouting.rolloutHint}</p>
        </label>
      )}
      <ErrorNote error={update.error ?? remove.error} />
      <p className="text-xs text-muted">{t.proofHint}</p>
      <p className="text-xs text-muted">{t.window}</p>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted">{t.spend}</dt>
          <dd className="text-2xl font-semibold">{money(stats.recordedSpendUsd)}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted">{t.estimated}</dt>
          <dd className="text-2xl font-semibold">{money(stats.estimatedSavingsUsd)}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted">{t.estimateHint}</p>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {(
          [
            [t.requests, stats.requests],
            [t.selected, stats.selected],
            [t.fallbacks, stats.fallbacks],
            [t.skipped, stats.skipped],
            [t.errors, stats.errors],
            [t.eligible, stats.eligibleRequests],
            [t.unknown, stats.unknownCostRequests],
            ...(tools ? [[m.sessionRouting.activeSessions, profile.activeSessions] as const] : []),
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="font-medium">{fmtNumber(value)}</dd>
          </div>
        ))}
      </dl>
      {stats.unknownCostRequests > 0 && <p className="text-sm text-warn-fg">{t.unknownHint}</p>}
      <Link to="/comparisons" search={{ id: profile.comparisonId }} className="text-sm text-accent">
        {t.source}: {profile.evidence.comparisonName}
      </Link>
    </Card>
  );
}
