import { useI18n } from '../i18n/index.tsx';

export function BudgetNumbers({
  spent,
  active,
  uncertain,
  remaining,
  period,
}: {
  spent: number;
  active: number;
  uncertain: number;
  remaining: number | null;
  period?: string;
}) {
  const { m, locale } = useI18n();
  const t = m.reservations;
  const money = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 6,
    }).format(value);
  return (
    <div className="space-y-1 text-xs text-muted">
      {period && <p className="font-medium">{period}</p>}
      <dl className="flex flex-wrap gap-x-3 gap-y-1">
        {(
          [
            [t.spent, spent],
            [t.active, active],
            [t.uncertain, uncertain],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="inline">{label}: </dt>
            <dd className="inline font-mono">{money(value)}</dd>
          </div>
        ))}
        {remaining !== null && (
          <div>
            <dt className="inline">{t.remaining}: </dt>
            <dd className="inline font-mono">{money(remaining)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
