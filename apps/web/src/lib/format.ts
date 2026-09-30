const number = new Intl.NumberFormat('en-US');
const money2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money3 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

export const fmtNumber = (value: number) => number.format(Math.round(value));

/** Sub-dollar amounts get a third decimal so single requests do not read as $0.00. */
export const fmtUsd = (value: number) =>
  (value !== 0 && Math.abs(value) < 1 ? money3 : money2).format(value);

export const fmtLimit = (value: number) =>
  Number.isInteger(value) ? `$${number.format(value)}` : money2.format(value);

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return seconds < 5 ? 'just now' : `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export const fmtDate = (
  iso: string,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' },
) => new Date(iso).toLocaleDateString('en-US', options);

export const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

export const plural = (count: number, word: string) =>
  `${fmtNumber(count)} ${word}${count === 1 ? '' : 's'}`;
