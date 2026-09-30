import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { DailyChart } from '../components/DailyChart.tsx';
import {
  Card,
  Chip,
  cx,
  Empty,
  KIND_LABELS,
  PageHeader,
  Progress,
  Segmented,
} from '../components/ui.tsx';
import { api, meQuery, unwrap } from '../lib/api.ts';
import { fmtDate, fmtLimit, fmtNumber, fmtUsd, pct, plural } from '../lib/format.ts';

type Period = '7d' | '30d' | 'month';

const PERIODS: { value: Period; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'month', label: 'This month' },
];

const ALERT_DOT = { block: 'bg-block-bar', warn: 'bg-warn-bar', muted: 'bg-faint' } as const;

function Tile({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-2 px-5 py-[18px]">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="font-mono text-[30px] font-medium tracking-tight">{value}</div>
      {children}
    </Card>
  );
}

export function OverviewPage() {
  const [period, setPeriod] = useState<Period>('month');
  const { data: me } = useQuery(meQuery);
  const { data } = useQuery({
    queryKey: ['overview', period],
    queryFn: () => unwrap(api.overview.$get({ query: { period } })),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const periodLabel =
    period === 'month'
      ? new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : `Last ${period === '7d' ? 7 : 30} days`;
  const active = data ? Object.values(data.activeKeys).reduce((a, b) => a + b, 0) : 0;
  const change = data?.previousRequests
    ? Math.round(((data.requests - data.previousRequests) / data.previousRequests) * 100)
    : null;
  const kinds = data
    ? (['person', 'device', 'agent'] as const)
        .filter((kind) => data.activeKeys[kind])
        .map((kind) =>
          plural(data.activeKeys[kind] ?? 0, kind === 'person' ? 'person' : kind).replace(
            'persons',
            'people',
          ),
        )
    : [];
  const topShare = data?.spenders.length ? Math.max(...data.spenders.map((s) => s.spend)) : 0;
  const topModel = data?.models.length ? Math.max(...data.models.map((m) => m.spend)) : 0;
  const days = period === 'month' ? 'month' : period === '7d' ? 7 : 30;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`${periodLabel} · ${me?.user.role === 'admin' ? 'all teams' : 'your keys'} · ${plural(active, 'active key')}`}
      >
        <Segmented label="Period" value={period} options={PERIODS} onChange={setPeriod} />
        <a
          href={`/admin/export/requests.csv?days=${days === 'month' ? new Date().getDate() : days}`}
          className="inline-flex h-10 items-center rounded-lg border border-field bg-surface px-4 text-sm font-medium text-ink no-underline hover:bg-canvas hover:text-ink"
        >
          Export CSV
        </a>
      </PageHeader>

      <section
        aria-label="Key numbers"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Tile
          label={period === 'month' ? 'Spend this month' : `Spend · ${periodLabel.toLowerCase()}`}
          value={fmtUsd(data?.spend ?? 0)}
        >
          {data?.budget && period === 'month' ? (
            <>
              <Progress
                value={pct(data.spend, data.budget)}
                color={data.spend >= data.budget ? 'bg-block-bar' : 'bg-accent'}
                label="Budget used"
              />
              <div className="text-[13px] text-muted">
                {pct(data.spend, data.budget)}% of {fmtLimit(data.budget)} budget · resets{' '}
                {fmtDate(data.resetsAt)}
              </div>
            </>
          ) : (
            <div className="text-[13px] text-muted">
              {data?.budget ? 'Team budgets are monthly' : 'No team budgets set yet'}
            </div>
          )}
          {!!data?.saved && (
            <div className="text-[13px] font-medium text-accent-strong">
              {fmtUsd(data.saved)} saved by local models
            </div>
          )}
        </Tile>
        <Tile label="Requests" value={fmtNumber(data?.requests ?? 0)}>
          {change !== null && (
            <div
              className={cx(
                'text-[13px] font-medium',
                change >= 0 ? 'text-accent-strong' : 'text-ink-2',
              )}
            >
              {change >= 0 ? '+' : ''}
              {change}% vs previous period
            </div>
          )}
          <div className="text-[13px] text-muted">
            {kinds.length ? `from ${kinds.join(', ')}` : 'No traffic yet'}
          </div>
        </Tile>
        <Tile
          label="Served by local models"
          value={`${pct(data?.local ?? 0, data?.requests ?? 0)}%`}
        >
          <Progress
            value={pct(data?.local ?? 0, data?.requests ?? 0)}
            color="bg-local"
            label="Share served locally"
          />
          <div className="text-[13px] text-muted">
            {plural(data?.local ?? 0, 'request')} at $0 API cost
          </div>
        </Tile>
        <Tile label="Blocked requests" value={fmtNumber(data?.blocked ?? 0)}>
          {!!data?.blockedPii && (
            <div className="text-[13px] font-medium text-block-fg">
              {fmtNumber(data.blockedPii)} contained sensitive data
            </div>
          )}
          <div className="text-[13px] text-muted">
            {fmtNumber((data?.blocked ?? 0) - (data?.blockedPii ?? 0))} over budget, rate limit or
            model access
          </div>
        </Tile>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card aria-label="Requests per day" className="flex flex-col gap-4 px-6 py-5 xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold">Requests per day · last 14 days</h2>
            <div className="flex gap-4 text-[13px] text-ink-2">
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-accent" />
                Cloud (paid)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-local" />
                Local (free)
              </span>
            </div>
          </div>
          {data && <DailyChart days={data.daily} />}
        </Card>

        <Card aria-label="Needs attention" className="flex flex-col gap-3.5 px-6 py-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">Needs attention</h2>
            <Link to="/logs" search={{ id: undefined }} className="text-[13px] font-medium">
              View log
            </Link>
          </div>
          {data?.alerts.length ? (
            data.alerts.map((alert) => (
              <div key={alert.text} className="flex items-start gap-3">
                <span
                  className={cx('mt-1.5 size-2 shrink-0 rounded-full', ALERT_DOT[alert.tone])}
                />
                <div className="flex flex-col gap-0.5">
                  <div className="text-sm leading-snug">{alert.text}</div>
                  <div className="text-xs text-muted">{alert.meta}</div>
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted">
              Nothing needs attention. Limits, blocks and unused keys will show up here.
            </p>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card aria-label="Top spenders" className="flex flex-col px-6 py-5 xl:col-span-2">
          <h2 className="mb-2 text-[15px] font-semibold">Top spenders</h2>
          <div className="overflow-x-auto">
            <div className="min-w-[560px]">
              <div className="grid grid-cols-[2fr_1.2fr_1fr_1fr_1.4fr] gap-3 border-b border-line py-2.5 text-xs font-medium text-muted">
                <div>Key</div>
                <div>Team</div>
                <div className="text-right">Requests</div>
                <div className="text-right">Spend</div>
                <div>Share of spend</div>
              </div>
              {data?.spenders.length ? (
                data.spenders.map((row) => {
                  const share = pct(row.spend, data.spend);
                  return (
                    <div
                      key={row.keyId}
                      className="grid grid-cols-[2fr_1.2fr_1fr_1fr_1.4fr] items-center gap-3 border-b border-line-soft py-2.5 text-sm"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-[13px]">{row.name}</span>
                        <Chip>{KIND_LABELS[row.kind]}</Chip>
                      </div>
                      <div className="truncate text-ink-2">{row.team ?? '—'}</div>
                      <div className="text-right font-mono text-[13px]">
                        {fmtNumber(row.requests)}
                      </div>
                      <div className="text-right font-mono text-[13px] font-medium">
                        {fmtUsd(row.spend)}
                      </div>
                      <div className="flex items-center gap-2">
                        <Progress
                          value={topShare ? (row.spend / topShare) * 100 : 0}
                          label={`${row.name} share of spend`}
                        />
                        <span className="w-9 text-right font-mono text-xs text-muted">
                          {share}%
                        </span>
                      </div>
                    </div>
                  );
                })
              ) : (
                <Empty>No requests in this period yet.</Empty>
              )}
            </div>
          </div>
        </Card>

        <Card aria-label="Spend by model" className="flex flex-col gap-3.5 px-6 py-5">
          <h2 className="text-[15px] font-semibold">Spend by model</h2>
          {data?.models.length ? (
            data.models.map((row) => (
              <div key={row.model} className="flex flex-col gap-1.5">
                <div className="flex justify-between gap-3 text-sm">
                  <span className="truncate">{row.model}</span>
                  <span className="font-mono text-[13px]">{fmtUsd(row.spend)}</span>
                </div>
                <Progress
                  value={topModel ? (row.spend / topModel) * 100 : 0}
                  label={`${row.model} spend`}
                />
              </div>
            ))
          ) : (
            <p className="text-sm text-muted">No paid requests in this period.</p>
          )}
          {data?.localModels.map((row) => (
            <div
              key={row.model}
              className="mt-auto flex justify-between gap-3 rounded-lg bg-accent-soft px-3.5 py-3 text-[13px] text-accent-strong"
            >
              <span className="truncate">{row.model}</span>
              <span className="font-mono whitespace-nowrap">
                {fmtNumber(row.requests)} req · $0
              </span>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}
