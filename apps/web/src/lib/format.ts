// Numbers, money and dates in the viewer's language. The i18n provider sets the locale.
let locale = 'en';
let number = new Intl.NumberFormat(locale);
let money2 = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' });
let money3 = new Intl.NumberFormat(locale, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});
let relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
let seconds = secondsFormat(locale);

/** "0.9s", "0,9 с", "0.9秒": one decimal and the language's own short unit. */
function secondsFormat(locale: string) {
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

export function setFormatLocale(next: string) {
  locale = next;
  number = new Intl.NumberFormat(locale);
  money2 = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' });
  money3 = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
  relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  seconds = secondsFormat(locale);
}

export const fmtNumber = (value: number) => number.format(Math.round(value));

export const fmtSeconds = (ms: number) => seconds.format(ms / 1000);

/** Sub-dollar amounts get a third decimal so single requests do not read as $0.00. */
export const fmtUsd = (value: number) =>
  (value !== 0 && Math.abs(value) < 1 ? money3 : money2).format(value);

export const fmtLimit = (value: number) =>
  Number.isInteger(value)
    ? new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(value)
    : money2.format(value);

/** "5 min ago", "yesterday"; a dash when it never happened. */
export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (Math.abs(seconds) < 45) return relative.format(Math.abs(seconds) < 5 ? 0 : seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

/** 24-hour clock everywhere; plain English would otherwise switch to AM/PM. */
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(locale === 'en' ? 'en-GB' : locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export const fmtDate = (
  iso: string,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' },
) => new Date(iso).toLocaleDateString(locale, options);

export const fmtMonth = (date: Date, withYear = false) =>
  date.toLocaleDateString(
    locale,
    withYear ? { month: 'long', year: 'numeric' } : { month: 'long' },
  );

export const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

/** The viewer's time zone, e.g. "Europe/Berlin". */
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Every IANA zone the browser knows, for the time zone picker. */
export function allZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [browserZone(), 'UTC'];
  }
}
