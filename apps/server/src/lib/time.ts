// Calendar math in the gateway's time zone (Settings → Time zone), without a date library:
// "today", "this month" and working hours follow the team's clock, not the server's.

/** The zone the server process runs in: TZ in the container, else the system's. */
export const SERVER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const pad = (value: number) => String(value).padStart(2, '0');

export class Calendar {
  readonly zone: string;
  #format: Intl.DateTimeFormat;

  constructor(zone: string) {
    this.zone = zone;
    this.#format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  }

  /** What a wall clock in this zone shows at `date`. */
  wall(date: Date): WallClock {
    const out: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
    for (const part of this.#format.formatToParts(date)) {
      if (part.type in out) out[part.type as keyof WallClock] = Number(part.value);
    }
    return out;
  }

  /** How far the zone's clock is ahead of UTC at `date`, in milliseconds. */
  #offset(date: Date): number {
    const w = this.wall(date);
    const seconds = Math.floor(date.getTime() / 1000) * 1000;
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - seconds;
  }

  /**
   * The moment the zone's clock shows this date and time. Months and days may overflow, like
   * Date.UTC: day 0 is the last day of the previous month.
   */
  at(year: number, month: number, day: number, hour = 0, minute = 0): Date {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    // A second pass settles the offset on days when clocks change.
    const guess = wall - this.#offset(new Date(wall));
    return new Date(wall - this.#offset(new Date(guess)));
  }

  startOfDay(now = new Date()): Date {
    const w = this.wall(now);
    return this.at(w.year, w.month, w.day);
  }

  startOfMonth(now = new Date()): Date {
    const w = this.wall(now);
    return this.at(w.year, w.month, 1);
  }

  startOfNextMonth(now = new Date()): Date {
    const w = this.wall(now);
    return this.at(w.year, w.month + 1, 1);
  }

  /** Midnight `days` calendar days before today. */
  daysAgo(days: number, now = new Date()): Date {
    const w = this.wall(now);
    return this.at(w.year, w.month, w.day - days);
  }

  /** "2026-10-05": the date in this zone. */
  dayKey(date: Date): string {
    const w = this.wall(date);
    return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  }

  /** "HH:MM" window check; handles windows that wrap past midnight. */
  isWithin(from: string, to: string, now = new Date()): boolean {
    const w = this.wall(now);
    const minutes = w.hour * 60 + w.minute;
    const [fh, fm] = from.split(':').map(Number) as [number, number];
    const [th, tm] = to.split(':').map(Number) as [number, number];
    const start = fh * 60 + fm;
    const end = th * 60 + tm;
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  }
}

const calendars = new Map<string, Calendar>();

export function calendar(zone: string): Calendar {
  let found = calendars.get(zone);
  if (!found) {
    found = new Calendar(zone);
    calendars.set(zone, found);
  }
  return found;
}

export function usd(value: number): string {
  return `$${value.toFixed(value !== 0 && Math.abs(value) < 1 ? 3 : 2)}`;
}
