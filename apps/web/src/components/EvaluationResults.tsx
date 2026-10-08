import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { evaluationError } from '../i18n/evaluations.ts';
import { useI18n } from '../i18n/index.tsx';
import { api, type ComparisonReport, meQuery, type TaskSetRow, unwrap } from '../lib/api.ts';
import { fmtDate, fmtNumber } from '../lib/format.ts';
import { taskSetsQuery } from './TaskSetLibrary.tsx';
import { Button, Card, ErrorNote, Status } from './ui.tsx';

export function EvaluationResults({
  report,
  money,
  onLoad,
  busy,
}: {
  report: ComparisonReport;
  money: (value: number) => string;
  onLoad: (row: TaskSetRow, report: ComparisonReport) => void;
  busy: boolean;
}) {
  const { m } = useI18n();
  const t = m.evaluations;
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const sets = useQuery(taskSetsQuery);
  const source = report.evaluation!;
  const current = sets.data?.find((row) => row.id === source.id);
  const changes = useQuery({
    queryKey: ['regressions', report.id, report.cells.map((cell) => cell.status).join(',')],
    enabled: !!source.reference,
    queryFn: () => unwrap(api.comparisons[':id'].regressions.$get({ param: { id: report.id } })),
  });
  const load = useMutation({
    mutationFn: () => unwrap(api['task-sets'][':id'].$get({ param: { id: source.id } })),
    onSuccess: (row) => onLoad(row, report),
  });
  const pin = useMutation({
    mutationFn: () =>
      unwrap(
        api['task-sets'][':id'].reference.$post({
          param: { id: source.id },
          json: { reportId: report.id, revision: current!.revision },
        }),
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['task-sets'] });
    },
  });
  const eligible =
    current?.fingerprint === source.fingerprint &&
    report.status === 'completed' &&
    report.cells.every((cell) => ['passed', 'failed'].includes(cell.status));
  const disabled = busy || pin.isPending || load.isPending || !!me?.gateway.demo;
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          {source.name} · {t.revision} {source.revision}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled || !current} onClick={() => load.mutate()}>
            {t.repeat}
          </Button>
          <Button
            disabled={disabled || !eligible || current?.reference?.id === report.id}
            onClick={() => pin.mutate()}
          >
            {t.pin}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted">{t.pinHint}</p>
      <ErrorNote
        error={evaluationError(load.error ?? pin.error ?? changes.error ?? sets.error, t)}
      />
      {source.reference && (
        <>
          <h3 className="font-semibold">{t.regressions}</h3>
          <p className="text-xs text-muted">
            {t.reference}: {source.reference.name} · {fmtDate(source.reference.createdAt)}
          </p>
          {changes.data?.models.map((row) => (
            <div key={row.modelId} className="space-y-3 rounded-lg border border-line p-4">
              <div className="flex items-center justify-between gap-3">
                <h4 className="font-semibold">{row.label}</h4>
                <Status tone={row.regressions.length ? 'block' : row.inconclusive ? 'warn' : 'ok'}>
                  {t.compared}: {row.compared}/{report.cases.length}
                </Status>
              </div>
              {row.newModel && <p className="text-xs text-muted">{t.newModel}</p>}
              {row.configurationChanged && (
                <p className="text-xs text-warn-fg">{t.configurationChanged}</p>
              )}
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                {[
                  [t.regressed, row.regressions.length],
                  [t.improved, row.improved],
                  [t.inconclusive, row.inconclusive],
                  [t.operational, row.operationalFailures],
                ].map(([label, count]) => (
                  <div key={label} className="flex justify-between gap-2">
                    <dt className="text-muted">{label}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
              {!!row.regressions.length && (
                <ul className="list-inside list-disc text-sm text-block-fg">
                  {row.regressions.map((task) => (
                    <li key={task.caseIndex}>
                      {task.caseIndex + 1}. {task.name}
                    </li>
                  ))}
                </ul>
              )}
              {row.cost && (
                <p className="text-xs text-muted">
                  {t.pairedCost} ({row.cost.pairs}): {money(row.cost.previousUsd)} →{' '}
                  {money(row.cost.currentUsd)}
                </p>
              )}
              {row.latency && (
                <p className="text-xs text-muted">
                  {t.pairedLatency} ({row.latency.pairs}): {fmtNumber(row.latency.previousMs)} →{' '}
                  {fmtNumber(row.latency.currentMs)} ms
                </p>
              )}
            </div>
          ))}
          <p className="text-xs text-muted">{t.metricHint}</p>
        </>
      )}
    </Card>
  );
}
