import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { api, type ComparisonReport, type KeyRow, meQuery, unwrap } from '../lib/api.ts';
import { Button, Card, ErrorNote, Field, Input, Select, Switch } from './ui.tsx';

export function ProfileFromComparison({
  report,
  keys,
}: {
  report: ComparisonReport;
  keys: KeyRow[];
}) {
  const { m } = useI18n();
  const t = m.profiles;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useQuery(meQuery);
  const baseline = report.models[0];
  const cost = (id: string) => {
    const cells = report.cells.filter((cell) => cell.modelId === id);
    return cells.length === report.cases.length &&
      cells.every((cell) => cell.status === 'passed' && cell.costUsd !== null)
      ? cells.reduce((sum, cell) => sum + cell.costUsd!, 0)
      : null;
  };
  const baselineCost = baseline ? cost(baseline.id) : null;
  const candidates = report.models.filter((model) => {
    const value = cost(model.id);
    return (
      model.id !== baseline?.id && value !== null && baselineCost !== null && value < baselineCost
    );
  });
  const activeKeys = keys.filter((key) => !key.revokedAt);
  const [name, setName] = useState(report.name.slice(0, 80));
  const [keyId, setKeyId] = useState(report.keyId);
  const [candidateId, setCandidateId] = useState(candidates[0]?.id ?? '');
  const [fallbackOnError, setFallbackOnError] = useState(true);
  // Manual reviews can make candidates eligible after this component has mounted.
  const chosen = candidates.find((model) => model.id === candidateId) ?? candidates[0];
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api['routing-profiles'].$post({
          json: {
            name: name.trim(),
            keyId,
            comparisonId: report.id,
            baselineModelId: baseline!.id,
            candidateModelId: chosen!.id,
            fallbackOnError,
          },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['routing-profiles'] });
      await navigate({ to: '/routing-profiles' });
    },
  });
  const disabled = create.isPending || !!me?.gateway.demo;
  return (
    <Card className="space-y-5 p-5">
      <h2 className="text-lg font-semibold">{t.applyTitle}</h2>
      <p className="text-sm text-muted">{t.applyHint}</p>
      {!baseline || !candidates.length ? (
        <p className="text-sm text-muted">{t.unavailable}</p>
      ) : (
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <p className="text-sm text-muted">{t.proofHint}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t.name}>
              <Input
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={disabled}
              />
            </Field>
            <Field label={t.key}>
              <Select
                required
                value={keyId}
                onChange={(event) => setKeyId(event.target.value)}
                disabled={disabled}
              >
                <option value="">—</option>
                {activeKeys.map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t.baseline}>
              <Input readOnly value={baseline.label} />
            </Field>
            <Field label={t.candidate}>
              <Select
                value={chosen?.id ?? ''}
                onChange={(event) => setCandidateId(event.target.value)}
                disabled={disabled}
              >
                {candidates.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Switch
            checked={fallbackOnError}
            onChange={setFallbackOnError}
            label={t.fallback}
            description={t.fallbackHint}
            disabled={disabled}
          />
          <ErrorNote error={create.error} />
          <Button
            type="submit"
            variant="primary"
            disabled={disabled || !name.trim() || !activeKeys.some((key) => key.id === keyId)}
          >
            {t.apply}
          </Button>
        </form>
      )}
    </Card>
  );
}
