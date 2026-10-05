// Alerts to Slack, Microsoft Teams and email: budgets running out, providers failing and coming
// back, and a Monday summary. An admin without DevOps does not open the dashboard every day.
import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { failingProviders, keySpend, teamSpend } from './admin/stats.ts';
import type { AppContext } from './context.ts';
import { apiKeys, models, providers, requestLogs, settings, teams } from './db/schema.ts';
import { findModel, modelLabel, ruleNumber } from './gateway/policy.ts';
import { type Mail, sendMail } from './lib/smtp.ts';
import { type Calendar, usd } from './lib/time.ts';
import { calendarOf, type Settings } from './settings.ts';

export interface Notice {
  title: string;
  lines: string[];
  /** Path in the admin UI, like "/budgets" */
  path: string;
}

export type Channel = 'slack' | 'teams' | 'email';

export interface Delivery {
  channel: Channel;
  ok: boolean;
  error?: string;
}

const DAY = 86_400_000;
/** Sent notices are remembered this long, enough to cover a month's keys. */
const REMEMBER_MS = 62 * DAY;
const NOTICES_KEY = 'notices';

const slackBody = (notice: Notice, url: string) => ({
  text: [`*${notice.title}*`, ...notice.lines, `<${url}|Open Spillway>`].join('\n'),
});

/** An Adaptive Card: what Teams workflows and the older incoming webhooks both accept. */
const teamsBody = (notice: Notice, url: string) => ({
  type: 'message',
  attachments: [
    {
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: notice.title, weight: 'Bolder', size: 'Medium', wrap: true },
          ...notice.lines.map((text) => ({ type: 'TextBlock', text, wrap: true })),
        ],
        actions: [{ type: 'Action.OpenUrl', title: 'Open Spillway', url }],
      },
    },
  ],
});

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** The sender: SMTP_FROM, else the SMTP user, else an address on the gateway's own host. */
export function mailFrom(ctx: AppContext): string {
  if (ctx.env.SMTP_FROM) return ctx.env.SMTP_FROM;
  const user = ctx.env.SMTP_URL ? decodeURIComponent(new URL(ctx.env.SMTP_URL).username) : '';
  const address = user.includes('@') ? user : `spillway@${new URL(ctx.env.PUBLIC_URL).hostname}`;
  return `Spillway <${address}>`;
}

/** Channels that are set up; email also needs SMTP_URL. */
export function channels(ctx: AppContext, settings: Settings): Channel[] {
  const { slackUrl, teamsUrl, emails } = settings.notifications;
  return [
    ...(slackUrl ? (['slack'] as const) : []),
    ...(teamsUrl ? (['teams'] as const) : []),
    ...(emails.length && ctx.env.SMTP_URL ? (['email'] as const) : []),
  ];
}

/** Sends to every channel that is set up; one failing channel does not stop the others. */
export async function send(ctx: AppContext, notice: Notice): Promise<Delivery[]> {
  const current = await ctx.settings.get();
  const { slackUrl, teamsUrl, emails } = current.notifications;
  const url = `${ctx.env.PUBLIC_URL.replace(/\/+$/, '')}${notice.path}`;
  const jobs: Record<Channel, () => Promise<void>> = {
    slack: () => post(ctx.vault.decrypt(slackUrl!), slackBody(notice, url)),
    teams: () => post(ctx.vault.decrypt(teamsUrl!), teamsBody(notice, url)),
    email: () => {
      const mail: Mail = {
        from: mailFrom(ctx),
        to: emails,
        subject: `[Spillway] ${notice.title}`,
        text: [...notice.lines, '', url].join('\n'),
      };
      return sendMail(ctx.env.SMTP_URL!, mail);
    },
  };
  return Promise.all(
    channels(ctx, current).map(async (channel) => {
      try {
        await jobs[channel]();
        return { channel, ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Notification to ${channel} failed: ${message}`);
        return { channel, ok: false, error: message };
      }
    }),
  );
}

// ── What was already sent ────────────────────────────────────────────────────

type Sent = Record<string, number>;

async function loadSent(ctx: AppContext): Promise<Sent> {
  const row = await ctx.db.query.settings.findFirst({ where: eq(settings.key, NOTICES_KEY) });
  return (row?.value as Sent | undefined) ?? {};
}

async function saveSent(ctx: AppContext, sent: Sent, now: Date): Promise<void> {
  const kept = Object.fromEntries(
    Object.entries(sent).filter(([, at]) => now.getTime() - at < REMEMBER_MS),
  );
  await ctx.db
    .insert(settings)
    .values({ key: NOTICES_KEY, value: kept })
    .onConflictDoUpdate({ target: settings.key, set: { value: kept } });
}

// ── The checks ───────────────────────────────────────────────────────────────

const monthKey = (cal: Calendar, now: Date) => cal.dayKey(now).slice(0, 7);
const time = (cal: Calendar, at: number) => {
  const w = cal.wall(new Date(at));
  return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
};

async function localName(ctx: AppContext, current: Settings): Promise<string | null> {
  if (!current.localModelId) return null;
  const local = await findModel(ctx.db, eq(models.id, current.localModelId));
  return local ? modelLabel(local) : null;
}

async function budgetNotices(
  ctx: AppContext,
  current: Settings,
  cal: Calendar,
  now: Date,
  sent: Sent,
): Promise<[string, Notice][]> {
  const out: [string, Notice][] = [];
  const local = await localName(ctx, current);
  const month = monthKey(cal, now);
  const { budgetThreshold } = current.rules;
  const threshold = budgetThreshold.enabled ? budgetThreshold.percent : 80;

  const spentByTeam = await teamSpend(ctx.db, cal, now);
  for (const team of await ctx.db.select().from(teams).all()) {
    const budget = team.monthlyBudgetUsd;
    if (!budget) continue;
    const spent = spentByTeam.get(team.id) ?? 0;
    const percent = Math.round((spent / budget) * 100);
    const line = `${usd(spent)} of ${usd(budget)} spent this month.`;
    if (spent >= budget) {
      out.push([
        `team-over:${team.id}:${month}`,
        {
          title: `${team.name} is over its budget`,
          lines: [
            line,
            local
              ? `Its cloud requests go to ${local} until the budget resets.`
              : 'Its cloud requests are blocked until the budget resets.',
          ],
          path: '/budgets',
        },
      ]);
    } else if (percent >= threshold && !sent[`team-over:${team.id}:${month}`]) {
      const rerouting = budgetThreshold.enabled && local;
      out.push([
        `team-threshold:${team.id}:${month}`,
        {
          title: `${team.name} is at ${percent}% of its budget`,
          lines: [
            line,
            ...(rerouting
              ? [`Rule ${ruleNumber('budgetThreshold')} now sends its cloud requests to ${local}.`]
              : []),
          ],
          path: '/budgets',
        },
      ]);
    }
  }

  const keys = await ctx.db.select().from(apiKeys).where(isNull(apiKeys.revokedAt)).all();
  const spend = await keySpend(ctx.db, null, cal, now);
  for (const key of keys) {
    const usage = spend.get(key.id);
    const then = key.fallbackToLocal && local ? `go to ${local}` : 'are blocked';
    // A zero limit means no cloud at all for this key, which is no news.
    if (key.dailyLimitUsd && (usage?.today ?? 0) >= key.dailyLimitUsd) {
      out.push([
        `key-day:${key.id}:${cal.dayKey(now)}`,
        {
          title: `Key ${key.name} reached its daily limit`,
          lines: [
            `${usd(usage?.today ?? 0)} of ${usd(key.dailyLimitUsd)} spent today.`,
            `Its cloud requests ${then} until midnight.`,
          ],
          path: '/keys',
        },
      ]);
    } else if (key.monthlyLimitUsd && (usage?.month ?? 0) >= key.monthlyLimitUsd) {
      out.push([
        `key-month:${key.id}:${month}`,
        {
          title: `Key ${key.name} reached its monthly limit`,
          lines: [
            `${usd(usage?.month ?? 0)} of ${usd(key.monthlyLimitUsd)} spent this month.`,
            `Its cloud requests ${then} until the month ends.`,
          ],
          path: '/keys',
        },
      ]);
    }
  }
  return out;
}

/** The most recent request that asked for one of the provider's models. */
async function lastRequest(ctx: AppContext, provider: string) {
  return ctx.db
    .select({
      result: requestLogs.result,
      status: requestLogs.status,
      ruleId: requestLogs.ruleId,
      error: requestLogs.error,
    })
    .from(requestLogs)
    .innerJoin(models, eq(requestLogs.requestedModelId, models.id))
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(eq(providers.name, provider))
    .orderBy(desc(requestLogs.createdAt))
    .limit(1)
    .get();
}

async function lastError(ctx: AppContext, provider: string): Promise<string | null> {
  const row = await ctx.db
    .select({ error: requestLogs.error })
    .from(requestLogs)
    .innerJoin(models, eq(requestLogs.requestedModelId, models.id))
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(providers.name, provider), sql`${requestLogs.error} is not null`))
    .orderBy(desc(requestLogs.createdAt))
    .limit(1)
    .get();
  return row?.error ?? null;
}

/**
 * A provider is announced once when it starts failing and once when a request to it succeeds
 * again. Quiet traffic does not count as recovery.
 */
async function outageNotices(
  ctx: AppContext,
  current: Settings,
  cal: Calendar,
  now: Date,
  sent: Sent,
): Promise<{ notices: [string, Notice][]; recovered: string[] }> {
  const notices: [string, Notice][] = [];
  const recovered: string[] = [];
  const failing = new Set(await failingProviders(ctx.db, now));
  const local = current.rerouteOnFailure ? await localName(ctx, current) : null;

  for (const provider of failing) {
    const key = `outage:${provider}`;
    if (sent[key]) continue;
    const error = await lastError(ctx, provider);
    notices.push([
      key,
      {
        title: `${provider} is failing`,
        lines: [
          ...(error ? [error] : []),
          local
            ? `Requests to it are answered by ${local} meanwhile.`
            : 'Requests to it fail meanwhile.',
        ],
        path: '/',
      },
    ]);
  }

  for (const [key, since] of Object.entries(sent)) {
    if (!key.startsWith('outage:')) continue;
    const provider = key.slice('outage:'.length);
    if (failing.has(provider)) continue;
    const last = await lastRequest(ctx, provider);
    const failed =
      !last ||
      last.ruleId === 'outage' ||
      (last.result === 'error' && (last.status >= 500 || last.status === 429));
    if (failed) continue;
    recovered.push(key);
    notices.push([
      `recovered:${provider}:${since}`,
      {
        title: `${provider} answers again`,
        lines: [`It was failing from ${time(cal, since)} to ${time(cal, now.getTime())}.`],
        path: '/',
      },
    ]);
  }
  return { notices, recovered };
}

/** Monday from 09:00 in the gateway's zone: the week before, Monday to Sunday. */
export async function weeklyNotice(
  ctx: AppContext,
  cal: Calendar,
  now: Date,
): Promise<[string, Notice] | null> {
  const w = cal.wall(now);
  const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  if (weekday !== 1 || w.hour < 9) return null;
  const end = cal.startOfDay(now);
  const start = cal.daysAgo(7, now);
  const inWeek = and(gte(requestLogs.createdAt, start), lt(requestLogs.createdAt, end));

  const totals = await ctx.db
    .select({
      spend: sql<number>`coalesce(sum(${requestLogs.costUsd}), 0)`,
      saved: sql<number>`coalesce(sum(${requestLogs.savedUsd}), 0)`,
      requests: sql<number>`count(*)`,
      local: sql<number>`coalesce(sum(case when ${requestLogs.servedLocal} and ${requestLogs.status} = 200 then 1 else 0 end), 0)`,
      blocked: sql<number>`coalesce(sum(case when ${requestLogs.result} like 'blocked%' or ${requestLogs.result} = 'rate_limited' then 1 else 0 end), 0)`,
    })
    .from(requestLogs)
    .where(inWeek)
    .get();
  if (!totals?.requests) return null;

  const top = await ctx.db
    .select({ name: apiKeys.name, spend: sql<number>`sum(${requestLogs.costUsd})` })
    .from(requestLogs)
    .innerJoin(apiKeys, eq(requestLogs.keyId, apiKeys.id))
    .where(inWeek)
    .groupBy(apiKeys.id)
    .orderBy(desc(sql`sum(${requestLogs.costUsd})`))
    .limit(3)
    .all();
  const spentByTeam = await teamSpend(ctx.db, cal, now);
  const budgets = (await ctx.db.select().from(teams).orderBy(teams.name).all())
    .filter((team) => team.monthlyBudgetUsd)
    .map((team) => {
      const percent = Math.round(((spentByTeam.get(team.id) ?? 0) / team.monthlyBudgetUsd!) * 100);
      return `${team.name} ${percent}% of ${usd(team.monthlyBudgetUsd!)}`;
    });

  const day = (date: Date) =>
    date.toLocaleDateString('en-US', { timeZone: cal.zone, month: 'short', day: 'numeric' });
  const share = Math.round((totals.local / totals.requests) * 100);
  const spenders = top.filter((row) => row.spend > 0);
  return [
    `weekly:${cal.dayKey(now)}`,
    {
      title: `Last week on Spillway: ${usd(totals.spend)} spent`,
      lines: [
        `${day(start)} – ${day(new Date(end.getTime() - 1))}: ${totals.requests.toLocaleString('en-US')} requests, ${share}% answered by local models, ${totals.blocked} blocked.`,
        `Local models saved ${usd(totals.saved)}.`,
        ...(spenders.length
          ? [`Top spenders: ${spenders.map((row) => `${row.name} ${usd(row.spend)}`).join(', ')}.`]
          : []),
        ...(budgets.length ? [`Team budgets this month: ${budgets.join(', ')}.`] : []),
      ],
      path: '/',
    },
  ];
}

let running = false;

/** Runs every minute: sends what is new, remembers it, and never sends the same thing twice. */
export async function watch(ctx: AppContext, now = new Date()): Promise<number> {
  const current = await ctx.settings.get();
  if (running || !channels(ctx, current).length) return 0;
  running = true;
  try {
    const cal = calendarOf(current);
    const sent = await loadSent(ctx);
    const { budget, outages, weekly } = current.notifications;
    const due: [string, Notice][] = [];
    if (budget) due.push(...(await budgetNotices(ctx, current, cal, now, sent)));
    if (outages) {
      const found = await outageNotices(ctx, current, cal, now, sent);
      due.push(...found.notices);
      for (const key of found.recovered) delete sent[key];
    }
    if (weekly) {
      const notice = await weeklyNotice(ctx, cal, now);
      if (notice) due.push(notice);
    }

    let count = 0;
    for (const [key, notice] of due) {
      if (sent[key]) continue;
      const deliveries = await send(ctx, notice);
      // Remembered even when a channel failed: a broken webhook should not repeat every minute.
      sent[key] = now.getTime();
      if (deliveries.some((delivery) => delivery.ok)) count++;
    }
    await saveSent(ctx, sent, now);
    return count;
  } finally {
    running = false;
  }
}
