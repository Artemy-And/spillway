import { and, eq, gte, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import type { Db } from '../db/client.ts';
import {
  type ApiKey,
  type Model,
  models,
  type Provider,
  providers,
  type Result,
  requestLogs,
  type Team,
  type TraceStep,
  type TraceTone,
  type User,
} from '../db/schema.ts';
import { describePii, type PiiCounts, type PiiKind } from '../lib/pii.ts';
import { type Calendar, usd } from '../lib/time.ts';
import { calendarOf, RULE_IDS, type RuleId, type Settings } from '../settings.ts';

/** A key read from the database; one put together in code may leave out the newer columns */
export type CallerKey = Omit<ApiKey, 'runaway' | 'extra'> &
  Partial<Pick<ApiKey, 'runaway' | 'extra'>>;

export interface Caller {
  key: CallerKey;
  team: Team | null;
  user: User | null;
}

/** A key's daily limit today: what an admin set, plus what one approved on top for today. */
export function dailyLimit(
  key: Pick<CallerKey, 'dailyLimitUsd' | 'extra'>,
  cal: Calendar,
  now = new Date(),
): number | null {
  if (key.dailyLimitUsd == null) return null;
  return key.dailyLimitUsd + (key.extra?.day === cal.dayKey(now) ? key.extra.usd : 0);
}

/** Where a person whose key used up its daily limit can ask an admin for more. */
export const askUrl = (ctx: AppContext) => `${ctx.env.PUBLIC_URL.replace(/\/+$/, '')}/keys`;

export interface Target {
  model: Model;
  provider: Provider;
}

export interface Decision {
  result: Result;
  status: number;
  requested: Target | null;
  target: Target | null;
  ruleId: RuleId | null;
  trace: TraceStep[];
  message: string;
}

/** Kinds that stop a request to a cloud model. Emails, phones and IPs are only masked in logs. */
const BLOCKING_PII: PiiKind[] = [
  'card',
  'iban',
  'ssn',
  'nino',
  'passport',
  'snils',
  'inn',
  'secret',
];

export function modelLabel(target: Target): string {
  return `${target.model.label ?? target.model.name}${target.provider.isLocal ? ' · local' : ''}`;
}

/** Model name without the " · local" suffix, for translated trace steps. */
const plainName = (target: Target) => target.model.label ?? target.model.name;

export const ruleNumber = (id: RuleId) => RULE_IDS.indexOf(id) + 1;

export function step(
  tone: TraceTone,
  text: string,
  code: string,
  params?: TraceStep['params'],
): TraceStep {
  return params ? { tone, text, code, params } : { tone, text, code };
}

export async function findModel(db: Db, where: ReturnType<typeof eq>): Promise<Target | null> {
  const row = await db
    .select({ model: models, provider: providers })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(where, eq(models.enabled, true)))
    .get();
  return row ?? null;
}

export async function spent(
  db: Db,
  column: typeof requestLogs.keyId | typeof requestLogs.teamId,
  id: string,
  since: Date,
) {
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${requestLogs.costUsd}), 0)` })
    .from(requestLogs)
    .where(and(eq(column, id), gte(requestLogs.createdAt, since)))
    .get();
  return row?.total ?? 0;
}

interface Input {
  caller: Caller;
  requestedName: string;
  pii: PiiCounts;
  settings: Settings;
  /** Embeddings never switch to another model, see below. */
  purpose?: 'chat' | 'embeddings';
  /** Only asking where a request would go (the status bar): no request is sent or counted. */
  preview?: boolean;
  /** How spending is added up; the status bar keeps team totals for a while. */
  sum?: typeof spent;
  now?: Date;
}

export async function decide(ctx: AppContext, input: Input): Promise<Decision> {
  const { caller, requestedName, pii, settings } = input;
  const embeddings = input.purpose === 'embeddings';
  const { key, team } = caller;
  const now = input.now ?? new Date();
  const cal = calendarOf(settings);
  const rules = settings.rules;
  const trace: TraceStep[] = [];

  const stop = (
    result: Result,
    status: number,
    blocked: TraceStep,
    requested: Target | null,
    ruleId: RuleId | null = null,
  ): Decision => {
    trace.push(blocked);
    return { result, status, requested, target: null, ruleId, trace, message: blocked.text };
  };

  // 1. Model exists and this key may use it
  const requested = await findModel(ctx.db, eq(models.name, requestedName));
  if (!requested) {
    return stop(
      'blocked_model',
      404,
      step('block', `Model "${requestedName}" is not available on this gateway`, 'modelMissing', {
        model: requestedName,
      }),
      null,
    );
  }
  const teamAllows = !team?.allowedModelIds || team.allowedModelIds.includes(requested.model.id);
  const keyAllows = !key.allowedModelIds || key.allowedModelIds.includes(requested.model.id);
  if (!teamAllows || !keyAllows) {
    const byTeam = !teamAllows && team;
    const who = byTeam ? `team ${team.name}` : `key ${key.name}`;
    return stop(
      'blocked_model',
      403,
      step(
        'block',
        `${modelLabel(requested)} is not allowed for ${who}`,
        byTeam ? 'modelNotAllowedTeam' : 'modelNotAllowedKey',
        { model: plainName(requested), name: byTeam ? team.name : key.name },
      ),
      requested,
    );
  }
  trace.push(
    step('ok', `Key valid, model allowed${team ? ` for ${team.name}` : ''}`, 'keyValid', {
      team: team?.name ?? null,
    }),
  );

  // 2. Rate limit for agents
  if (rules.agentRateLimit.enabled && key.kind === 'agent' && !input.preview) {
    if (!ctx.rateLimiter.hit(key.id, rules.agentRateLimit.rpm)) {
      const rule = ruleNumber('agentRateLimit');
      const { rpm } = rules.agentRateLimit;
      return stop(
        'rate_limited',
        429,
        step(
          'block',
          `Rule ${rule}: agent keys may send at most ${rpm} requests per minute`,
          'agentRateLimit',
          { rule, rpm },
        ),
        requested,
        'agentRateLimit',
      );
    }
  }

  let target = requested;
  let result: Result = 'ok';
  let ruleId: RuleId | null = null;

  // 3. Budgets and schedule. Local models cost nothing, so they skip this.
  if (requested.provider.isLocal) {
    trace.push(step('info', 'Local model: no API cost, budgets do not apply', 'localNoBudget'));
  } else {
    /** `hard` is a limit that is used up; the others are rules that save money early. */
    let reroute: {
      reason: TraceStep;
      ruleId: RuleId | null;
      allowed: boolean;
      hard: boolean;
    } | null = null;

    const sum = input.sum ?? spent;
    const today = dailyLimit(key, cal, now);
    const keyDay =
      key.dailyLimitUsd != null
        ? await sum(ctx.db, requestLogs.keyId, key.id, cal.startOfDay(now))
        : 0;
    const keyMonth =
      key.monthlyLimitUsd != null
        ? await sum(ctx.db, requestLogs.keyId, key.id, cal.startOfMonth(now))
        : 0;
    const teamMonth =
      team?.monthlyBudgetUsd != null
        ? await sum(ctx.db, requestLogs.teamId, team.id, cal.startOfMonth(now))
        : 0;

    if (rules.runawayGuard.enabled && key.runaway) {
      const rule = ruleNumber('runawayGuard');
      const { spent: hour, usual } = key.runaway;
      reroute = {
        reason: step(
          'warn',
          `Rule ${rule}: key ${key.name} spent ${usd(hour)} in an hour; its busiest hour before was ${usd(usual)}`,
          'runaway',
          { rule, key: key.name, spent: hour, usual },
        ),
        ruleId: 'runawayGuard',
        allowed: key.fallbackToLocal,
        hard: true,
      };
    } else if (today != null && keyDay >= today) {
      reroute = {
        reason: step(
          'warn',
          `Key ${key.name} reached its ${usd(today)} daily limit (${usd(keyDay)} spent)`,
          'keyDailyLimit',
          { key: key.name, limit: today, spent: keyDay },
        ),
        ruleId: null,
        allowed: key.fallbackToLocal,
        hard: true,
      };
    } else if (key.monthlyLimitUsd != null && keyMonth >= key.monthlyLimitUsd) {
      reroute = {
        reason: step(
          'warn',
          `Key ${key.name} reached its ${usd(key.monthlyLimitUsd)} monthly limit (${usd(keyMonth)} spent)`,
          'keyMonthlyLimit',
          { key: key.name, limit: key.monthlyLimitUsd, spent: keyMonth },
        ),
        ruleId: null,
        allowed: key.fallbackToLocal,
        hard: true,
      };
    } else if (team?.monthlyBudgetUsd != null && team.monthlyBudgetUsd >= 0) {
      const percent = team.monthlyBudgetUsd > 0 ? (teamMonth / team.monthlyBudgetUsd) * 100 : 100;
      const over = percent >= 100;
      const threshold = rules.budgetThreshold.enabled && percent >= rules.budgetThreshold.percent;
      if (over || threshold) {
        reroute = {
          reason: step(
            'warn',
            `${team.name} is at ${Math.round(percent)}% of its ${usd(team.monthlyBudgetUsd)} budget`,
            'teamBudget',
            { team: team.name, percent: Math.round(percent), budget: team.monthlyBudgetUsd },
          ),
          ruleId: threshold ? 'budgetThreshold' : null,
          allowed: true,
          hard: over,
        };
      }
    }
    if (
      !reroute &&
      rules.offHours.enabled &&
      !cal.isWithin(rules.offHours.from, rules.offHours.to, now)
    ) {
      const { from, to } = rules.offHours;
      reroute = {
        reason: step('warn', `Outside working hours ${from}–${to}`, 'offHours', { from, to }),
        ruleId: 'offHours',
        allowed: true,
        hard: false,
      };
    }

    // Vectors from another model do not match the ones already stored, so embeddings never
    // switch: a rule that would save money early lets them through, a used-up limit blocks them.
    if (reroute && embeddings) {
      trace.push(reroute.reason);
      if (reroute.hard) {
        return stop(
          'blocked_budget',
          429,
          step(
            'block',
            'Request blocked: embeddings cannot switch to another model',
            'blockedEmbeddings',
          ),
          requested,
          reroute.ruleId,
        );
      }
      const rule = ruleNumber(reroute.ruleId!);
      trace.push(
        step(
          'info',
          `Rule ${rule} skipped: embeddings stay on their model`,
          'ruleSkippedEmbeddings',
          {
            rule,
          },
        ),
      );
      reroute = null;
    } else if (reroute) {
      trace.push(reroute.reason);
      const local = settings.localModelId
        ? await findModel(ctx.db, eq(models.id, settings.localModelId))
        : null;
      if (!reroute.allowed || !local) {
        // Whoever reads the refusal in their client needs to know it is not their daily limit.
        const blocked =
          reroute.ruleId === 'runawayGuard'
            ? step(
                'block',
                'Request blocked: Spillway stopped this key for unusual spending; an admin can let it back on the Keys page',
                'runawayStopped',
              )
            : !reroute.allowed
              ? step(
                  'block',
                  'Request blocked: this key blocks instead of switching to a local model',
                  'blockedKeyNoFallback',
                )
              : step(
                  'block',
                  'Request blocked: no local model is configured',
                  'blockedNoLocalModel',
                );
        const refused = stop('blocked_budget', 429, blocked, requested, reroute.ruleId);
        // The client shows this text: someone who used up the day's limit learns where to ask.
        if (reroute.reason.code === 'keyDailyLimit' && key.userId) {
          refused.message = `${reroute.reason.text}. ${blocked.text}. Ask an admin for more: ${askUrl(ctx)}`;
        }
        return refused;
      }
      target = local;
      result = 'rerouted';
      ruleId = reroute.ruleId;
      const rule = reroute.ruleId ? ruleNumber(reroute.ruleId) : null;
      trace.push(
        step(
          'info',
          `${rule ? `Rule ${rule} matched → ` : ''}sent to ${modelLabel(local)}`,
          'sentToLocal',
          { rule, model: plainName(local) },
        ),
      );
    } else {
      const parts = [
        today != null ? `key ${usd(keyDay)} of ${usd(today)} today` : null,
        team?.monthlyBudgetUsd
          ? `${team.name} at ${Math.round((teamMonth / team.monthlyBudgetUsd) * 100)}% of ${usd(team.monthlyBudgetUsd)}`
          : null,
      ].filter(Boolean);
      trace.push(
        parts.length
          ? step('ok', `Within budget: ${parts.join(' · ')}`, 'withinBudget', {
              keySpent: today != null ? keyDay : null,
              keyLimit: today,
              team: team?.monthlyBudgetUsd ? team.name : null,
              teamPercent: team?.monthlyBudgetUsd
                ? Math.round((teamMonth / team.monthlyBudgetUsd) * 100)
                : null,
              teamBudget: team?.monthlyBudgetUsd || null,
            })
          : step('ok', 'No budget set', 'noBudget'),
      );
    }
  }

  // 4. Sensitive data never leaves for a cloud model
  const blocking = Object.fromEntries(
    Object.entries(pii).filter(([kind]) => BLOCKING_PII.includes(kind as PiiKind)),
  ) as PiiCounts;
  if (Object.keys(pii).length === 0) {
    trace.push(step('ok', 'No sensitive data found in prompt', 'noPii'));
  } else if (!target.provider.isLocal && rules.piiGuard.enabled && Object.keys(blocking).length) {
    const rule = ruleNumber('piiGuard');
    return stop(
      'blocked_pii',
      403,
      step(
        'block',
        `Rule ${rule}: prompt contains ${describePii(blocking)}; cloud models are blocked for it`,
        'piiBlocked',
        { rule, pii: blocking as Record<string, number> },
      ),
      requested,
      'piiGuard',
    );
  } else {
    trace.push(
      step(
        'info',
        `Found ${describePii(pii)}; masked in the log${target.provider.isLocal ? ', model is local' : ''}`,
        'piiMasked',
        { pii: pii as Record<string, number>, local: target.provider.isLocal },
      ),
    );
  }

  if (result === 'ok')
    trace.push(
      step('info', `Sent to ${modelLabel(target)} (${target.provider.name})`, 'sentTo', {
        model: plainName(target),
        provider: target.provider.name,
        local: target.provider.isLocal,
      }),
    );
  // Without a price a cloud request is logged at $0, so no budget or limit ever counts it.
  const { inputPrice, outputPrice } = target.model;
  if (!target.provider.isLocal && (inputPrice === null || (!embeddings && outputPrice === null)))
    trace.push(
      step(
        'warn',
        `${plainName(target)} has no price: budgets do not count this request`,
        'noPrice',
        { model: plainName(target) },
      ),
    );
  return { result, status: 200, requested, target, ruleId, trace, message: '' };
}
