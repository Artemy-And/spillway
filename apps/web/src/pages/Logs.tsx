import type { Result, TraceStep } from '@server/db/schema.ts';
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
  RESULT_TONES,
  Select,
  Status,
} from '../components/ui.tsx';
import type { Messages } from '../i18n/en.ts';
import type { TraceParams } from '../i18n/helpers.ts';
import { useI18n } from '../i18n/index.tsx';
import { api, type LogDetail, type LogRow, modelsQuery, unwrap } from '../lib/api.ts';
import { fmtNumber, fmtTime, fmtUsd } from '../lib/format.ts';

type Period = '24h' | '7d' | '30d';

/** The API a request came in through; Codex uses OpenAI's Responses API. */
const CLIENT_NAMES: Record<LogDetail['format'], string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  responses: 'OpenAI Responses',
};

const STEP_TONE: Record<string, string> = {
  ok: 'bg-ok-bg text-ok-fg',
  warn: 'bg-warn-bg text-warn-fg',
  info: 'bg-info-bg text-info-fg',
  block: 'bg-block-bg text-block-fg',
};

function route(row: LogRow, m: Messages): string {
  const asked = row.requestedLabel ?? row.requestedModel;
  if (row.result === 'rerouted') return `${asked} → ${row.servedModel}`;
  if (row.result === 'rate_limited') return `${asked} → ${m.logs.held}`;
  if (row.result.startsWith('blocked')) return `${asked} → ${m.logs.blocked}`;
  return row.servedModel ?? asked;
}

/** A trace step in the viewer's language; rows from before translation keep their English. */
function stepText(step: TraceStep, m: Messages): string {
  const translate = step.code ? m.trace[step.code] : undefined;
  return translate ? translate((step.params ?? {}) as TraceParams) : step.text;
}

export function LogsPage() {
  const { m } = useI18n();
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
      <PageHeader title={m.logs.title} subtitle={m.logs.subtitle}>
        <div className="flex items-center gap-2 text-[13px] font-medium text-accent-strong">
          <span className={cx('size-2 rounded-full bg-accent', isFetching && 'animate-pulse')} />
          {m.logs.live}
        </div>
        <a
          href={`/admin/export/requests.csv?days=${period === '24h' ? 1 : period === '7d' ? 7 : 30}`}
          className="inline-flex h-10 items-center rounded-lg border border-field bg-surface px-4 text-sm font-medium text-ink no-underline hover:bg-canvas hover:text-ink"
        >
          {m.logs.export}
        </a>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
        <Filter label={m.common.key}>
          <Select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
            <option value="">{m.logs.allKeys}</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </Select>
        </Filter>
        <Filter label={m.common.model}>
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{m.logs.allModels}</option>
            {models.map((row) => (
              <option key={row.id} value={row.name}>
                {row.label ?? row.name}
              </option>
            ))}
          </Select>
        </Filter>
        <Filter label={m.logs.result}>
          <Select value={result} onChange={(e) => setResult(e.target.value as Result | '')}>
            <option value="">{m.logs.allResults}</option>
            {(Object.keys(RESULT_TONES) as Result[]).map((value) => (
              <option key={value} value={value}>
                {m.results[value]}
              </option>
            ))}
          </Select>
        </Filter>
        <Filter label={m.common.period}>
          <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            <option value="24h">{m.logs.last24h}</option>
            <option value="7d">{m.logs.last7d}</option>
            <option value="30d">{m.logs.last30d}</option>
          </Select>
        </Filter>
      </div>

      <div className="flex flex-col gap-5 xl:flex-row">
        <Card aria-label={m.logs.requests} className="min-w-0 flex-1 overflow-x-auto py-1">
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[76px_1.1fr_1.8fr_1.2fr_0.7fr_1fr] gap-3 border-b border-line px-5 py-3 text-xs font-medium text-muted">
              <div>{m.logs.time}</div>
              <div>{m.common.key}</div>
              <div>{m.logs.route}</div>
              <div className="text-right">{m.logs.tokensInOut}</div>
              <div className="text-right">{m.logs.cost}</div>
              <div>{m.logs.result}</div>
            </div>
            {rows.length === 0 && <Empty>{m.logs.empty}</Empty>}
            {rows.map((row) => (
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
                <span className="truncate font-mono text-xs font-medium">{row.keyName ?? '—'}</span>
                <span className="truncate text-ink-2">{route(row, m)}</span>
                <span className="text-right font-mono text-xs whitespace-nowrap">
                  {fmtNumber(row.inputTokens)} / {fmtNumber(row.outputTokens)}
                </span>
                <span className="text-right font-mono text-xs">{fmtUsd(row.costUsd)}</span>
                <span>
                  <Status tone={RESULT_TONES[row.result] ?? 'off'}>
                    {m.results[row.result] ?? row.result}
                  </Status>
                </span>
              </button>
            ))}
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
  const { m } = useI18n();
  const served = log.servedModel
    ? `${log.servedModel}${log.providerName ? `, ${log.providerName}` : ''}`
    : '—';
  const outage = log.result === 'rerouted' && log.trace.some((s) => s.code === 'failover');
  const title = m.logs.titles[outage ? 'outage' : log.result] ?? log.result;
  const client = CLIENT_NAMES[log.format];
  return (
    <Aside label={m.logs.details}>
      <div>
        <div className="font-mono text-xs text-muted">
          {log.id} · {fmtTime(log.createdAt)}
        </div>
        <h2 className="mt-1 text-[17px] font-semibold">{title}</h2>
      </div>
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-[13px]">
        <dt className="text-muted">{m.common.key}</dt>
        <dd>
          <span className="font-mono">{log.keyName ?? '—'}</span>
          {log.team && ` · ${log.team}`}
        </dd>
        <dt className="text-muted">{m.logs.askedFor}</dt>
        <dd>{log.requestedLabel ?? log.requestedModel}</dd>
        <dt className="text-muted">{m.logs.servedBy}</dt>
        <dd>{served}</dd>
        <dt className="text-muted">{m.logs.tokens}</dt>
        <dd className="font-mono text-xs">
          {m.logs.tokensValue(fmtNumber(log.inputTokens), fmtNumber(log.outputTokens))}
        </dd>
        <dt className="text-muted">{m.logs.cost}</dt>
        <dd>
          <span className="font-mono text-xs">{fmtUsd(log.costUsd)}</span>
          {log.savedUsd > 0 && (
            <span className="text-accent-strong"> {m.logs.savedAmount(fmtUsd(log.savedUsd))}</span>
          )}
        </dd>
        <dt className="text-muted">{m.logs.latency}</dt>
        <dd className="font-mono text-xs">{(log.latencyMs / 1000).toFixed(1)} s</dd>
        <dt className="text-muted">{m.logs.client}</dt>
        <dd>
          {m.logs.clientApi(client)}
          {log.stream && ` · ${m.logs.streaming}`}
        </dd>
      </dl>

      <div className="flex flex-col gap-2.5">
        <h3 className="text-[13px] font-semibold">{m.logs.why}</h3>
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
              <span className="min-w-0 break-words">{stepText(step, m)}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold">{m.logs.prompt}</h3>
        {log.promptPreview ? (
          <div className="max-h-48 overflow-y-auto rounded-lg bg-canvas p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">
            <MaskedText text={log.promptPreview} />
          </div>
        ) : (
          <p className="text-[13px] text-muted">{m.logs.notStored}</p>
        )}
        {log.responsePreview && (
          <>
            <h3 className="mt-2 text-[13px] font-semibold">{m.logs.response}</h3>
            <div className="max-h-48 overflow-y-auto rounded-lg bg-canvas p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">
              <MaskedText text={log.responsePreview} />
            </div>
          </>
        )}
        <p className="text-xs text-muted">{m.logs.retention(log.retentionDays)}</p>
      </div>
    </Aside>
  );
}
