// Budgets reset on the server's local calendar (set TZ in the container to change it).

const DAY = 86_400_000;

export function startOfDay(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function startOfMonth(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function startOfNextMonth(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

export function daysAgo(days: number, now = new Date()): Date {
  return new Date(startOfDay(now).getTime() - days * DAY);
}

/** "HH:MM" window check; handles windows that wrap past midnight. */
export function isWithin(from: string, to: string, now = new Date()): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = from.split(':').map(Number) as [number, number];
  const [th, tm] = to.split(':').map(Number) as [number, number];
  const start = fh * 60 + fm;
  const end = th * 60 + tm;
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function usd(value: number): string {
  return `$${value.toFixed(value !== 0 && Math.abs(value) < 1 ? 3 : 2)}`;
}
