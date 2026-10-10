// One line for the status bar at the bottom of Claude Code: what the key has spent and where its
// next request goes. Claude Code runs the status command after every message, and the whole
// gateway waits while SQLite adds up spending. So a line is kept for a few seconds (and made
// again as soon as the key has sent another request), and a team's month total for a minute.
import type { Context } from 'hono';
import type { AppContext } from '../context.ts';
import { requestLogs } from '../db/schema.ts';
import { usd } from '../lib/time.ts';
import { calendarOf } from '../settings.ts';
import { authenticate } from './handler.ts';
import { type Caller, type Decision, decide, spent, type Target } from './policy.ts';

const LINE_MS = 10_000;
const TEAM_MS = 60_000;

interface Kept {
  lines: Map<string, { at: number; line: string }>;
  teams: Map<string, { at: number; total: number }>;
}
const keptBy = new WeakMap<AppContext, Kept>();

const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/** Why a request would not go to the model asked for, by trace step. */
const REASONS: Record<string, string> = {
  keyDailyLimit: 'daily limit reached',
  keyMonthlyLimit: 'monthly limit reached',
  teamBudget: 'team budget',
  offHours: 'outside working hours',
};

/** The model Claude Code is on, from the session details it passes to the command. */
function modelOf(body: string): string | null {
  try {
    const id = (JSON.parse(body) as { model?: { id?: unknown } }).model?.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** Drops what has expired once a map has grown, so it stays small. */
function prune<T extends { at: number }>(map: Map<string, T>, limit: number, ms: number) {
  if (map.size <= limit) return;
  const now = Date.now();
  for (const [id, entry] of map) if (now - entry.at >= ms) map.delete(id);
}

/** Spending as the gateway adds it up, except a team's total: the slow sum, kept a minute. */
function keptSum(kept: Kept): typeof spent {
  return async (db, column, id, since) => {
    if (column !== requestLogs.teamId) return spent(db, column, id, since);
    const at = Date.now();
    const hit = kept.teams.get(`${id} ${since.getTime()}`);
    if (hit && at - hit.at < TEAM_MS) return hit.total;
    const total = await spent(db, column, id, since);
    prune(kept.teams, 100, TEAM_MS);
    kept.teams.set(`${id} ${since.getTime()}`, { at, total });
    return total;
  };
}

const named = (target: Target) =>
  `${target.model.label ?? target.model.name}${target.provider.isLocal ? ', local' : ''}`;

function destination(decision: Decision): string {
  const reason = decision.trace.map((step) => REASONS[step.code ?? '']).find(Boolean);
  const why = reason ? ` (${reason})` : '';
  if (decision.result === 'ok') return named(decision.target!);
  if (decision.result === 'rerouted') return `${YELLOW}→ ${named(decision.target!)}${why}${RESET}`;
  if (decision.result === 'blocked_budget') return `${RED}blocked${why}${RESET}`;
  return `${RED}${decision.message}${RESET}`;
}

async function statusLine(
  ctx: AppContext,
  caller: Caller,
  model: string | null,
  sum: typeof spent,
): Promise<string> {
  const settings = await ctx.settings.get();
  const cal = calendarOf(settings);
  const now = new Date();
  const { key, team } = caller;
  const parts = ['Spillway'];
  if (key.dailyLimitUsd == null && key.monthlyLimitUsd != null) {
    const month = await sum(ctx.db, requestLogs.keyId, key.id, cal.startOfMonth(now));
    parts.push(`${usd(month)} of ${usd(key.monthlyLimitUsd)} this month`);
  } else {
    const today = await sum(ctx.db, requestLogs.keyId, key.id, cal.startOfDay(now));
    parts.push(
      key.dailyLimitUsd == null
        ? `${usd(today)} today`
        : `${usd(today)} of ${usd(key.dailyLimitUsd)} today`,
    );
  }
  if (team?.monthlyBudgetUsd) {
    const month = await sum(ctx.db, requestLogs.teamId, team.id, cal.startOfMonth(now));
    parts.push(`${team.name} at ${Math.round((month / team.monthlyBudgetUsd) * 100)}%`);
  }
  if (model) {
    const input = { caller, requestedName: model, pii: {}, settings, now, preview: true, sum };
    parts.push(destination(await decide(ctx, input)));
  }
  return parts.join(' · ');
}

export async function handleStatus(ctx: AppContext, c: Context): Promise<Response> {
  const caller = await authenticate(ctx, c.req.raw.headers);
  if (!caller) return c.text('Spillway · key not accepted', 401);
  const model = c.req.method === 'POST' ? modelOf(await c.req.text()) : null;
  const kept = keptBy.get(ctx) ?? { lines: new Map(), teams: new Map() };
  keptBy.set(ctx, kept);
  // Each request the key sends moves its "last used" time, so its next line is made afresh.
  const id = `${caller.key.id} ${caller.key.lastUsedAt?.getTime() ?? 0} ${model ?? ''}`;
  const hit = kept.lines.get(id);
  if (hit && Date.now() - hit.at < LINE_MS) return c.text(hit.line);
  const line = await statusLine(ctx, caller, model, keptSum(kept));
  prune(kept.lines, 1000, LINE_MS);
  kept.lines.set(id, { at: Date.now(), line });
  return c.text(line);
}
