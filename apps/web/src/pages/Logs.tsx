import type { Result } from '@server/db/schema.ts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import {
  Aside,
  Card,
  cx,
  Empty,
  MaskedText,
  PageHeader,
  RESULT_LABELS,
  Select,
  Status,
  type Tone,
} from '../components/ui.tsx';
import { api, type LogDetail, type LogRow, modelsQuery, unwrap } from '../lib/api.ts';
import { fmtNumber, fmtTime, fmtUsd } from '../lib/format.ts';

type Period = '24h' | '7d' | '30d';

const STEP_TONE: Record<string, string> = {
  ok: 'bg-ok-bg text-ok-fg',
  warn: 'bg-warn-bg text-warn-fg',
  info: 'bg-info-bg text-info-fg',
  block: 'bg-block-bg text-block-fg',
};

const TITLES: Record<string, string> = {
  ok: 'Served',
  rerouted: 'Rerouted to a local model',
  blocked_pii: 'Blocked: sensitive data',
  blocked_budget: 'Blocked: over budget',
  blocked_model: 'Blocked: model not allowed',
  rate_limited: 'Held: rate limit',
  error: 'Failed upstream',
};

function route(row: LogRow): string {
  const asked = row.requestedLabel ?? row.requestedModel;
  if (row.result === 'rerouted') return `${asked} → ${row.servedModel}`;
  if (row.result === 'rate_limited') return `${asked} → held`;
  if (row.result.startsWith('blocked')) return `${asked} → blocked`;
  return row.servedModel ?? asked;
}

export function LogsPage() {
  const { id: selected } = useSearch({ from: '/app/logs' });
  const navigate = useNavigate({ from: '/logs' });
  const [keyId, setKeyId] = useState('');
  const [model, setModel] = useState('');
  const [result, setResult] = useState<Result | ''>('');
  const [period, setPeriod] = useState<Period>('24h');

  const { data: keys = [] } = useQuery({
    queryKey: ['keys'],
    queryFn: () => unwrap(api.keys.$get()),
  });
  const { data: models = [] } = useQuery(modelsQuery);
  const { data: rows = [], isFetching } = useQuery({
    queryKey: ['logs', keyId, model, result, period],
    queryFn: () =>
      unwrap(
        api.logs.$get({
          query: {
            period,
            limit: '100',
            ...(keyId && { keyId }),
            ...(model && { model }),
            ...(result && { result }),
          },
        }),
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
  });
  const { data: detail } = useQuery({
    queryKey: ['log', selected],
    queryFn: () => unwrap(api.logs[':id'].$get({ param: { id: selected! } })),
    enabled: !!selected,
  });

  const select = (id: string) => navigate({ search: { id }, replace: true });

  return (
    <>
      <PageHeader
        title="Request log"
        subtitle="Every request: who sent it, where it went, what it cost and why."
      >
        <div className="flex items-center gap-2 text-[13px] font-medium text-accent-strong">
          <span className={cx('size-2 rounded-full bg-accent', isFetching && 'animate-pulse')} />
          Live
        </div>
        <a
          href={`/admin/export/requests.csv?days=${period === '24h' ? 1 : period === '7d' ? 7 : 30}`}
          className="inline-flex h-10 items-center rounded-lg border border-field bg-surface px-4 text-sm font-medium text-ink no-underline hover:bg-canvas hover:text-ink"
        >
          Export
        </a>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
        <Filter label="Key">
          <Select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
            <option value="">All keys</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </Select>
        </Filter>
        <Filter label="Model">
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">All models</option>
            {models.map((m) => (
              <option key={m.id} value={m.name}>
                {m.label ?? m.name}
              </option>
            ))}
          </Select>
        </Filter>
        <Filter label="Result">
          <Select value={result} onChange={(e) => setResult(e.target.value as Result | '')}>
            <option value="">All results</option>
            {Object.entries(RESULT_LABELS).map(([value, { label }]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Filter>
        <Filter label="Period">
          <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </Select>
        </Filter>
      </div>

      <div className="flex flex-col gap-5 xl:flex-row">
        <Card aria-label="Requests" className="min-w-0 flex-1 overflow-x-auto py-1">
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[76px_1.1fr_1.8fr_1.2fr_0.7fr_1fr] gap-3 border-b border-line px-5 py-3 text-xs font-medium text-muted">
              <div>Time</div>
              <div>Key</div>
              <div>Asked for → served by</div>
              <div className="text-right">Tokens in / out</div>
              <div className="text-right">Cost</div>
              <div>Result</div>
            </div>
            {rows.length === 0 && (
              <Empty>No requests match. Send one with a key from the Keys page.</Empty>
            )}
            {rows.map((row) => {
              const r = RESULT_LABELS[row.result] ?? { label: row.result, tone: 'off' as Tone };
              return (
                <button
                  type="button"
                  key={row.id}
                  onClick={() => select(row.id)}
                  aria-current={row.id === selected}
                  className={cx(
                    'grid w-full cursor-pointer grid-cols-[76px_1.1fr_1.8fr_1.2fr_0.7fr_1fr] items-center gap-3 border-b border-line-soft px-5 py-[11px] text-left text-[13px] last:border-0 hover:bg-canvas',
                    row.id === selected && 'bg-accent-soft hover:bg-accent-soft',
                  )}
                >
                  <span className="font-mono text-xs text-ink-2">{fmtTime(row.createdAt)}</span>
                  <span className="truncate font-mono text-xs font-medium">
                    {row.keyName ?? '—'}
                  </span>
                  <span className="truncate text-ink-2">{route(row)}</span>
                  <span className="text-right font-mono text-xs whitespace-nowrap">
                    {fmtNumber(row.inputTokens)} / {fmtNumber(row.outputTokens)}
                  </span>
                  <span className="text-right font-mono text-xs">{fmtUsd(row.costUsd)}</span>
                  <span>
                    <Status tone={r.tone}>{r.label}</Status>
                  </span>
                </button>
              );
            })}
          </div>
        </Card>

        {selected && detail && <Details log={detail} />}
      </div>
    </>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the select is passed as children
    <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:w-[170px]">
      {label}
      {children}
    </label>
  );
}

function Details({ log }: { log: LogDetail }) {
  const served = log.servedModel
    ? `${log.servedModel}${log.providerName ? `, ${log.providerName}` : ''}`
    : '—';
  return (
    <Aside label="Request details">
      <div>
        <div className="font-mono text-xs text-muted">
          {log.id} · {fmtTime(log.createdAt)}
        </div>
        <h2 className="mt-1 text-[17px] font-semibold">{TITLES[log.result] ?? log.result}</h2>
      </div>
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-[13px]">
        <dt className="text-muted">Key</dt>
        <dd>
          <span className="font-mono">{log.keyName ?? '—'}</span>
          {log.team && ` · ${log.team}`}
        </dd>
        <dt className="text-muted">Asked for</dt>
        <dd>{log.requestedLabel ?? log.requestedModel}</dd>
        <dt className="text-muted">Served by</dt>
        <dd>{served}</dd>
        <dt className="text-muted">Tokens</dt>
        <dd className="font-mono text-xs">
          {fmtNumber(log.inputTokens)} in · {fmtNumber(log.outputTokens)} out
        </dd>
        <dt className="text-muted">Cost</dt>
        <dd>
          <span className="font-mono text-xs">{fmtUsd(log.costUsd)}</span>
          {log.savedUsd > 0 && (
            <span className="text-accent-strong"> (saved {fmtUsd(log.savedUsd)})</span>
          )}
        </dd>
        <dt className="text-muted">Latency</dt>
        <dd className="font-mono text-xs">{(log.latencyMs / 1000).toFixed(1)} s</dd>
        <dt className="text-muted">Client</dt>
        <dd>
          {log.format === 'openai' ? 'OpenAI' : log.format === 'anthropic' ? 'Anthropic' : 'Ollama'}{' '}
          API
          {log.stream && ' · streaming'}
        </dd>
      </dl>

      <div className="flex flex-col gap-2.5">
        <h3 className="text-[13px] font-semibold">Why</h3>
        <ol className="flex flex-col gap-2.5 text-[13px] leading-snug">
          {log.trace.map((step, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are an ordered, immutable list
            <li key={i} className="flex gap-2.5">
              <span
                className={cx(
                  'flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px]',
                  STEP_TONE[step.tone],
                )}
              >
                {i + 1}
              </span>
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold">Prompt</h3>
        {log.promptPreview ? (
          <div className="max-h-48 overflow-y-auto rounded-lg bg-canvas p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">
            <MaskedText text={log.promptPreview} />
          </div>
        ) : (
          <p className="text-[13px] text-muted">Not stored.</p>
        )}
        {log.responsePreview && (
          <>
            <h3 className="mt-2 text-[13px] font-semibold">Response</h3>
            <div className="max-h-48 overflow-y-auto rounded-lg bg-canvas p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">
              <MaskedText text={log.responsePreview} />
            </div>
          </>
        )}
        <p className="text-xs text-muted">
          Prompts are stored with personal data masked, for {log.retentionDays} days. Change it in
          Settings.
        </p>
      </div>
    </Aside>
  );
}
