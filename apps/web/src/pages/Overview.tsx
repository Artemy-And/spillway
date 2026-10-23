import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { Checklist } from '../components/Checklist.tsx';
import { DailyChart } from '../components/DailyChart.tsx';
import {
  Card,
  Chip,
  cx,
  Empty,
  PageHeader,
  Progress,
  Segmented,
  Select,
} from '../components/ui.tsx';
import type { Messages } from '../i18n/en.ts';
import { useI18n } from '../i18n/index.tsx';
import { api, meQuery, modelsQuery, type Overview, unwrap } from '../lib/api.ts';
import { fmtDate, fmtDuration, fmtLimit, fmtMonth, fmtNumber, fmtUsd, pct } from '../lib/format.ts';

type Period = '7d' | '30d' | 'month';
type Alert = Overview['alerts'][number];

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

/** Alert text and the small grey line under it, in the viewer's language. */
function describeAlert(alert: Alert, m: Messages): { text: string; meta: string } {
  switch (alert.code) {
    case 'keyLimit':
      return { text: m.alerts.keyLimit(alert), meta: alert.team ?? m.common.noTeam };
    case 'keyUnused':
      return { text: m.alerts.keyUnused(alert), meta: m.alerts.considerRevoking };
    case 'keyRunaway':
      return { text: m.alerts.keyRunaway(alert), meta: m.alerts.letBackOnKeys };
    case 'piiBlocked':
      return { text: m.alerts.piiBlocked(alert), meta: alert.key };
    case 'teamOverBudget':
      return {
        text: m.alerts.teamOverBudget(alert),
        meta: m.alerts.spentOf(fmtUsd(alert.spent), fmtLimit(alert.budget)),
      };
    case 'teamBudgetPace':
      return {
        text: m.alerts.teamBudgetPace(alert, fmtDate(new Date(alert.reachesAt).toISOString())),
        meta: m.alerts.spentOf(fmtUsd(alert.spent), fmtLimit(alert.budget)),
      };
    case 'providerFailing':
      return { text: m.alerts.providerFailing(alert), meta: alert.error ?? '' };
    case 'modelNoPrice':
      return { text: m.alerts.modelNoPrice(alert), meta: alert.models.join(', ') };
    case 'promptCut':
      return { text: m.alerts.promptCut(alert), meta: m.alerts.promptCutFix };
  }
}

/** Who keeps the local models busy; local answers cost nothing, so spend cannot show it. */
function LocalUse({ period }: { period: Period }) {
  const { m } = useI18n();
  const { data } = useQuery({
    queryKey: ['local-use', period],
    queryFn: () => unwrap(api['local-use'].$get({ query: { period } })),
    placeholderData: keepPreviousData,
  });
  const top = data?.keys.length ? Math.max(...data.keys.map((row) => row.timeMs)) : 0;
  const columns = 'grid grid-cols-[2fr_1.2fr_0.9fr_1fr_1fr_1.4fr] gap-3';

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <div className={cx(columns, 'border-b border-line py-2.5 text-xs font-medium text-muted')}>
          <div>{m.common.key}</div>
          <div>{m.common.team}</div>
          <div className="text-right">{m.overview.requestsCol}</div>
          <div className="text-right">{m.overview.tokensCol}</div>
          <div className="text-right">{m.overview.timeCol}</div>
          <div>{m.overview.shareTime}</div>
        </div>
        {data?.keys.length ? (
          data.keys.map((row) => (
            <div
              key={row.keyId}
              className={cx(columns, 'items-center border-b border-line-soft py-2.5 text-sm')}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-[13px]">{row.name}</span>
                <Chip>{m.kinds[row.kind]}</Chip>
              </div>
              <div className="truncate text-ink-2">{row.team ?? '—'}</div>
              <div className="text-right font-mono text-[13px]">{fmtNumber(row.requests)}</div>
              <div className="text-right font-mono text-[13px]">{fmtNumber(row.tokens)}</div>
              <div className="text-right font-mono text-[13px] font-medium">
                {fmtDuration(row.timeMs)}
              </div>
              <div className="flex items-center gap-2">
                <Progress
                  value={top ? (row.timeMs / top) * 100 : 0}
                  color="bg-local"
                  label={m.overview.timeShareOf(row.name)}
                />
                <span className="w-9 text-right font-mono text-xs text-muted">
                  {pct(row.timeMs, data.timeMs)}%
                </span>
              </div>
            </div>
          ))
        ) : (
          <Empty>{m.overview.noLocal}</Empty>
        )}
        <p className="mt-3 text-xs text-muted">{m.overview.timeHint}</p>
      </div>
    </div>
  );
}

/** What the period's paid requests would have cost on another cloud model, asked for on demand. */
function WhatIf({ period }: { period: Period }) {
  const { m } = useI18n();
  const id = useId();
  const [modelId, setModelId] = useState('');
  const { data: models } = useQuery(modelsQuery);
  const { data } = useQuery({
    queryKey: ['what-if', period, modelId],
    queryFn: () => unwrap(api['what-if'].$get({ query: { period, model: modelId } })),
    enabled: !!modelId,
    placeholderData: keepPreviousData,
  });
  const choices = (models ?? []).filter(
    (row) => !row.isLocal && row.enabled && row.inputPrice && row.outputPrice,
  );
  if (choices.length < 2) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-line-soft pt-3.5">
      <label htmlFor={id} className="flex flex-col gap-1.5 text-[13px] text-muted">
        {m.overview.whatIf}
        <Select id={id} value={modelId} onChange={(e) => setModelId(e.target.value)}>
          <option value="">{m.overview.whatIfPick}</option>
          {choices.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label ?? row.name}
            </option>
          ))}
        </Select>
      </label>
      {modelId && data && (
        <div className="text-sm font-medium">
          {data.requests
            ? m.overview.whatIfCost(fmtUsd(data.cost), fmtUsd(data.actual))
            : m.overview.noPaid}
        </div>
      )}
      {modelId && !!data?.unpriced && (
        <div className="text-xs text-muted">{m.overview.whatIfUnpriced(data.unpriced)}</div>
      )}
    </div>
  );
}

export function OverviewPage() {
  const { m, join } = useI18n();
  const [period, setPeriod] = useState<Period>('month');
  const [view, setView] = useState<'spend' | 'local'>('spend');
  const { data: me } = useQuery(meQuery);
  const { data } = useQuery({
    queryKey: ['overview', period],
    queryFn: () => unwrap(api.overview.$get({ query: { period } })),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const periodLabel =
    period === 'month' ? fmtMonth(new Date(), true) : m.overview.lastDays(period === '7d' ? 7 : 30);
  const change = data?.previousRequests
    ? Math.round(((data.requests - data.previousRequests) / data.previousRequests) * 100)
    : null;
  const activity = data?.activity;
  const sources = activity
    ? [
        activity.people ? m.overview.people(activity.people) : null,
        activity.sharedKeys ? m.overview.sharedKeys(activity.sharedKeys) : null,
        activity.devices ? m.overview.devices(activity.devices) : null,
        activity.agents ? m.overview.agents(activity.agents) : null,
      ].filter((part): part is string => !!part)
    : [];
  const topShare = data?.spenders.length ? Math.max(...data.spenders.map((s) => s.spend)) : 0;
  const topModel = data?.models.length ? Math.max(...data.models.map((m) => m.spend)) : 0;
  const appRequests = data?.apps.reduce((total, row) => total + row.requests, 0) ?? 0;
  const days = period === 'month' ? 'month' : period === '7d' ? 7 : 30;
  const periods: { value: Period; label: string }[] = [
    { value: '7d', label: m.overview.periods['7d'] },
    { value: '30d', label: m.overview.periods['30d'] },
    { value: 'month', label: m.overview.periods.month },
  ];

  return (
    <>
      <PageHeader
        title={m.overview.title}
        subtitle={`${periodLabel} · ${me?.user.role === 'admin' ? m.overview.allTeams : m.overview.yourKeys} · ${m.overview.activeKeys(activity?.keys ?? 0)}`}
      >
        <Segmented label={m.common.period} value={period} options={periods} onChange={setPeriod} />
        <a
          href={`/admin/export/requests.csv?days=${days === 'month' ? new Date().getDate() : days}`}
          className="inline-flex h-10 items-center rounded-lg border border-field bg-surface px-4 text-sm font-medium text-ink no-underline hover:bg-canvas hover:text-ink"
        >
          {m.overview.exportCsv}
        </a>
      </PageHeader>

      <Checklist />

      <section
        aria-label={m.overview.keyNumbers}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Tile
          label={
            period === 'month' ? m.overview.spendThisMonth : m.overview.spendPeriod(periodLabel)
          }
          value={fmtUsd(data?.spend ?? 0)}
        >
          {data?.budget && period === 'month' ? (
            <>
              <Progress
                value={pct(data.spend, data.budget)}
                color={data.spend >= data.budget ? 'bg-block-bar' : 'bg-accent'}
                label={m.overview.budgetUsed}
              />
              <div className="text-[13px] text-muted">
                {m.overview.budgetLine(
                  pct(data.spend, data.budget),
                  fmtLimit(data.budget),
                  fmtDate(data.resetsAt),
                )}
              </div>
            </>
          ) : (
            <div className="text-[13px] text-muted">
              {data?.budget ? m.overview.budgetsMonthly : m.overview.noBudgets}
            </div>
          )}
          {period === 'month' && !!data?.forecast && data.forecast > data.spend && (
            <div
              className={cx(
                'text-[13px]',
                data.budget && data.forecast > data.budget ? 'text-warn-fg' : 'text-muted',
              )}
            >
              {m.overview.forecast(
                fmtLimit(data.forecast >= 10 ? Math.round(data.forecast) : data.forecast),
              )}
            </div>
          )}
          {!!data?.saved && (
            <div className="text-[13px] font-medium text-accent-strong">
              {m.overview.saved(fmtUsd(data.saved))}
            </div>
          )}
          {!!data?.savedCache && (
            <div className="text-[13px] font-medium text-accent-strong">
              {m.overview.savedCache(fmtUsd(data.savedCache))}
            </div>
          )}
        </Tile>
        <Tile label={m.overview.requests} value={fmtNumber(data?.requests ?? 0)}>
          {change !== null && (
            <div
              className={cx(
                'text-[13px] font-medium',
                change >= 0 ? 'text-accent-strong' : 'text-ink-2',
              )}
            >
              {m.overview.vsPrevious(`${change >= 0 ? '+' : ''}${change}`)}
            </div>
          )}
          <div className="text-[13px] text-muted">
            {sources.length ? m.overview.from(join(sources)) : m.overview.noTraffic}
          </div>
        </Tile>
        <Tile
          label={m.overview.servedLocal}
          value={`${pct(data?.local ?? 0, data?.requests ?? 0)}%`}
        >
          <Progress
            value={pct(data?.local ?? 0, data?.requests ?? 0)}
            color="bg-local"
            label={m.overview.shareLocal}
          />
          <div className="text-[13px] text-muted">{m.overview.localRequests(data?.local ?? 0)}</div>
        </Tile>
        <Tile label={m.overview.blocked} value={fmtNumber(data?.blocked ?? 0)}>
          {!!data?.blockedPii && (
            <div className="text-[13px] font-medium text-block-fg">
              {m.overview.blockedPii(fmtNumber(data.blockedPii))}
            </div>
          )}
          <div className="text-[13px] text-muted">
            {m.overview.blockedOther(fmtNumber((data?.blocked ?? 0) - (data?.blockedPii ?? 0)))}
          </div>
        </Tile>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card
          aria-label={m.overview.perDayLabel}
          className="flex flex-col gap-4 px-6 py-5 xl:col-span-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold">{m.overview.perDay}</h2>
            <div className="flex gap-4 text-[13px] text-ink-2">
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-accent" />
                {m.overview.cloudPaid}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-local" />
                {m.overview.localFree}
              </span>
            </div>
          </div>
          {data && <DailyChart days={data.daily} />}
        </Card>

        <Card aria-label={m.overview.attention} className="flex flex-col gap-3.5 px-6 py-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">{m.overview.attention}</h2>
            <Link to="/logs" search={{ id: undefined }} className="text-[13px] font-medium">
              {m.overview.viewLog}
            </Link>
          </div>
          {data?.alerts.length ? (
            data.alerts.map((alert) => {
              const { text, meta } = describeAlert(alert, m);
              return (
                <div key={text} className="flex items-start gap-3">
                  <span
                    className={cx('mt-1.5 size-2 shrink-0 rounded-full', ALERT_DOT[alert.tone])}
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="text-sm leading-snug">{text}</div>
                    {meta && (
                      <div className="truncate text-xs text-muted" title={meta}>
                        {meta}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <p className="text-sm text-muted">{m.overview.nothing}</p>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4 xl:col-span-2">
          <Card
            aria-label={view === 'local' ? m.overview.localUse : m.overview.topSpenders}
            className="flex flex-1 flex-col px-6 py-5"
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold">
                {view === 'local' ? m.overview.localUse : m.overview.topSpenders}
              </h2>
              {!!data?.localModels.length && (
                <Segmented
                  label={m.overview.showBy}
                  value={view}
                  options={[
                    { value: 'spend', label: m.overview.spendView },
                    { value: 'local', label: m.overview.localView },
                  ]}
                  onChange={setView}
                />
              )}
            </div>
            {view === 'local' ? (
              <LocalUse period={period} />
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[560px]">
                  <div className="grid grid-cols-[2fr_1.2fr_1fr_1fr_1.4fr] gap-3 border-b border-line py-2.5 text-xs font-medium text-muted">
                    <div>{m.common.key}</div>
                    <div>{m.common.team}</div>
                    <div className="text-right">{m.overview.requestsCol}</div>
                    <div className="text-right">{m.overview.spend}</div>
                    <div>{m.overview.share}</div>
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
                            <Chip>{m.kinds[row.kind]}</Chip>
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
                              label={m.overview.shareOf(row.name)}
                            />
                            <span className="w-9 text-right font-mono text-xs text-muted">
                              {share}%
                            </span>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <Empty>{m.overview.noRequests}</Empty>
                  )}
                </div>
              </div>
            )}
          </Card>

          {!!data?.apps.length && (
            <Card aria-label={m.overview.byApp} className="flex flex-col gap-3.5 px-6 py-5">
              <h2 className="text-[15px] font-semibold">{m.overview.byApp}</h2>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-x-6 gap-y-4">
                {data.apps.map((row) => {
                  const share = pct(row.requests, appRequests);
                  return (
                    <div key={row.app} className="flex flex-col gap-1.5">
                      <div className="flex justify-between gap-3 text-sm">
                        <span className="min-w-0">{m.apps[row.app]}</span>
                        <span className="font-mono text-[13px]">{share}%</span>
                      </div>
                      <Progress value={share} label={m.overview.appShare(m.apps[row.app])} />
                      <div className="font-mono text-xs text-muted">{fmtUsd(row.spend)}</div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>

        <Card aria-label={m.overview.byModel} className="flex flex-col gap-3.5 px-6 py-5">
          <h2 className="text-[15px] font-semibold">{m.overview.byModel}</h2>
          {data?.models.length ? (
            data.models.map((row) => (
              <div key={row.model} className="flex flex-col gap-1.5">
                <div className="flex justify-between gap-3 text-sm">
                  <span className="truncate">{row.model}</span>
                  <span className="font-mono text-[13px]">{fmtUsd(row.spend)}</span>
                </div>
                <Progress
                  value={topModel ? (row.spend / topModel) * 100 : 0}
                  label={m.overview.modelSpend(row.model ?? '')}
                />
              </div>
            ))
          ) : (
            <p className="text-sm text-muted">{m.overview.noPaid}</p>
          )}
          {!!data?.models.length && <WhatIf period={period} />}
          {!!data?.localModels.length && (
            <div className="mt-auto flex flex-col gap-3.5">
              {data.localModels.map((row) => (
                <div
                  key={row.model}
                  className="flex justify-between gap-3 rounded-lg bg-accent-soft px-3.5 py-3 text-[13px] text-accent-strong"
                >
                  <span className="truncate">{row.model}</span>
                  <span className="font-mono whitespace-nowrap">
                    {m.overview.localReq(fmtNumber(row.requests))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
