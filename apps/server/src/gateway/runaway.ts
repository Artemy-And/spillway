// Rule 5, runaway spending. A key that suddenly spends far more in an hour than it ever did in
// the two weeks before is stopped, so an agent stuck in a loop cannot burn the budget overnight:
// its cloud requests go to the local model, or are refused, until an admin lets it back.
// Only keys without a daily or monthly limit of their own are watched: for the others an admin
// already chose how much is too much.
//
// Nothing here reads the request log per request. Each key's last hour of cloud spend is kept in
// memory and added to as requests finish. What it spent hour by hour in the two weeks before is
// read from the log once when the gateway starts, key by key, and then one hour at a time.
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import type { Db } from '../db/client.ts';
import { apiKeys, type Runaway, requestLogs } from '../db/schema.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** "Before" runs from 15 days to 1 day ago, in clock hours: today never raises its own bar. */
const OLDEST = 15 * 24;
const NEWEST = 24;

interface Spend {
  at: number;
  cost: number;
}

class SpendWatch {
  /** Cloud spend per key over the last hour, oldest first */
  #recent = new Map<string, Spend[]>();
  /** Cloud spend per key and clock hour, for the hours that count as before */
  #hours = new Map<string, Map<number, number>>();
  /** The busiest of those hours per key */
  #busiest = new Map<string, number>();
  /** An admin let the key back: the pace it was stopped at is fine for a day */
  #allowed = new Map<string, { usual: number; until: number }>();
  /** The clock hour #hours is up to date for; -1 = not read yet */
  #hour = -1;
  /** Requests that finish while the log is read wait for the same read */
  #reading: Promise<void> | null = null;

  ready(db: Db, now: number): Promise<void> {
    const hour = Math.floor(now / HOUR);
    if (hour === this.#hour) return Promise.resolve();
    this.#reading ??= this.#read(db, now, hour).finally(() => {
      this.#reading = null;
    });
    return this.#reading;
  }

  async #read(db: Db, now: number, hour: number) {
    if (this.#hour === -1) {
      await this.#loadRecent(db, now);
      // Two weeks of a busy gateway take a while to add up: one key at a time, letting
      // requests through in between, rather than one long query that holds them all.
      const keys = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(isNull(apiKeys.revokedAt))
        .all();
      for (const key of keys) {
        this.#addHours(await hourlySpend(db, hour - OLDEST, hour - NEWEST, key.id));
        await new Promise((resolve) => setImmediate(resolve));
      }
    } else {
      this.#addHours(
        await hourlySpend(db, Math.max(this.#hour - NEWEST, hour - OLDEST), hour - NEWEST),
      );
    }
    for (const [keyId, hours] of this.#hours) {
      for (const at of hours.keys()) if (at < hour - OLDEST) hours.delete(at);
      if (!hours.size) this.#hours.delete(keyId);
    }
    this.#busiest = new Map(
      [...this.#hours].map(([keyId, hours]) => [keyId, Math.max(...hours.values())]),
    );
    this.#hour = hour;
  }

  #addHours(rows: { keyId: string | null; hour: number; spent: number }[]) {
    for (const row of rows) {
      if (!row.keyId || row.spent <= 0) continue;
      const hours = this.#hours.get(row.keyId) ?? new Map<number, number>();
      hours.set(row.hour, row.spent);
      this.#hours.set(row.keyId, hours);
    }
  }

  async #loadRecent(db: Db, now: number) {
    const rows = await db
      .select({ keyId: requestLogs.keyId, at: requestLogs.createdAt, cost: requestLogs.costUsd })
      .from(requestLogs)
      .where(and(gte(requestLogs.createdAt, new Date(now - HOUR)), sql`${requestLogs.costUsd} > 0`))
      .orderBy(requestLogs.createdAt)
      .all();
    for (const row of rows) {
      if (row.keyId) this.add(row.keyId, row.cost, row.at.getTime());
    }
  }

  /** Adds a request's cost and returns what the key spent over the last hour. */
  add(keyId: string, cost: number, now: number): number {
    const list = this.#recent.get(keyId) ?? [];
    list.push({ at: now, cost });
    this.#recent.set(keyId, list);
    return this.lastHour(keyId, now);
  }

  lastHour(keyId: string, now: number): number {
    const list = this.#recent.get(keyId);
    if (!list) return 0;
    const old = list.findIndex((spend) => spend.at > now - HOUR);
    if (old === -1) {
      this.#recent.delete(keyId);
      return 0;
    }
    if (old > 0) list.splice(0, old);
    return list.reduce((sum, spend) => sum + spend.cost, 0);
  }

  usual(keyId: string, now: number): number {
    const allowed = this.#allowed.get(keyId);
    const busiest = this.#busiest.get(keyId) ?? 0;
    return allowed && allowed.until > now ? Math.max(busiest, allowed.usual) : busiest;
  }

  /** Starts the key's hour afresh and accepts the pace it was stopped at for a day. */
  allow(keyId: string, usual: number, now: number) {
    this.#recent.delete(keyId);
    this.#allowed.set(keyId, { usual, until: now + DAY });
  }
}

/** Cloud spend per key and clock hour, for hours `from` up to `to` (hours since 1970). */
async function hourlySpend(db: Db, from: number, to: number, keyId?: string) {
  if (from >= to) return [];
  // The divisor is written out: node:sqlite binds numbers as REAL, and a bound divisor would
  // turn created_at / ? into a fraction that groups every row on its own.
  const hour = sql<number>`${requestLogs.createdAt} / 3600000`;
  return db
    .select({
      keyId: requestLogs.keyId,
      hour,
      spent: sql<number>`sum(${requestLogs.costUsd})`,
    })
    .from(requestLogs)
    .where(
      and(
        keyId ? eq(requestLogs.keyId, keyId) : undefined,
        gte(requestLogs.createdAt, new Date(from * HOUR)),
        lt(requestLogs.createdAt, new Date(to * HOUR)),
      ),
    )
    .groupBy(requestLogs.keyId, hour)
    .all();
}

/** One watch per running gateway, made when the first request finishes. */
const watches = new WeakMap<AppContext, SpendWatch>();
const watchOf = (ctx: AppContext) => {
  let watch = watches.get(ctx);
  if (!watch) {
    watch = new SpendWatch();
    watches.set(ctx, watch);
  }
  return watch;
};

/**
 * Counts a finished request's cost and stops a key without limits of its own when its last hour
 * passes both bars: the rule's minimum, and `times` its busiest hour before. Returns the stop it
 * recorded, if any.
 * Called before the request's log row is written, so the first read of the log after a start
 * does not count it twice.
 */
export async function recordSpend(
  ctx: AppContext,
  keyId: string,
  cost: number,
  now = Date.now(),
): Promise<Runaway | null> {
  if (cost <= 0) return null;
  const watch = watchOf(ctx);
  await watch.ready(ctx.db, now);
  const spent = watch.add(keyId, cost, now);
  const { runawayGuard: rule } = (await ctx.settings.get()).rules;
  if (!rule.enabled || spent < rule.minUsd) return null;
  const usual = watch.usual(keyId, now);
  if (spent <= usual * rule.times) return null;
  const runaway: Runaway = { at: now, spent, usual };
  const stopped = await ctx.db
    .update(apiKeys)
    .set({ runaway })
    .where(
      and(
        eq(apiKeys.id, keyId),
        isNull(apiKeys.runaway),
        isNull(apiKeys.dailyLimitUsd),
        isNull(apiKeys.monthlyLimitUsd),
      ),
    )
    .returning({ id: apiKeys.id });
  return stopped.length ? runaway : null;
}

/** An admin let a stopped key back: it goes to the cloud again, at the pace it was stopped at. */
export async function letBack(ctx: AppContext, keyId: string, now = Date.now()): Promise<boolean> {
  const key = await ctx.db.query.apiKeys.findFirst({ where: eq(apiKeys.id, keyId) });
  if (!key?.runaway) return false;
  watchOf(ctx).allow(keyId, key.runaway.spent, now);
  await ctx.db.update(apiKeys).set({ runaway: null }).where(eq(apiKeys.id, keyId));
  return true;
}

/** With the rule off, no key stays stopped by it. */
export async function letAllBack(ctx: AppContext): Promise<void> {
  await ctx.db.update(apiKeys).set({ runaway: null }).where(sql`${apiKeys.runaway} is not null`);
}
