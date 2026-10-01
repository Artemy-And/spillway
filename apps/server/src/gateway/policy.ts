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
import { isWithin, startOfDay, startOfMonth, usd } from '../lib/time.ts';
import { RULE_IDS, type RuleId, type Settings } from '../settings.ts';

export interface Caller {
  key: ApiKey;
  team: Team | null;
  user: User | null;
}

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
const BLOCKING_PII: PiiKind[] = ['card', 'passport', 'snils', 'inn', 'iban', 'secret'];

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

async function spent(
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
  now?: Date;
}

export async function decide(ctx: AppContext, input: Input): Promise<Decision> {
  const { caller, requestedName, pii, settings } = input;
  const { key, team } = caller;
  const now = input.now ?? new Date();
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
  if (rules.agentRateLimit.enabled && key.kind === 'agent') {
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
    let reroute: { reason: TraceStep; ruleId: RuleId | null; allowed: boolean } | null = null;

    const keyDay =
      key.dailyLimitUsd != null
        ? await spent(ctx.db, requestLogs.keyId, key.id, startOfDay(now))
        : 0;
    const keyMonth =
      key.monthlyLimitUsd != null
        ? await spent(ctx.db, requestLogs.keyId, key.id, startOfMonth(now))
        : 0;
    const teamMonth =
      team?.monthlyBudgetUsd != null
        ? await spent(ctx.db, requestLogs.teamId, team.id, startOfMonth(now))
        : 0;

    if (key.dailyLimitUsd != null && keyDay >= key.dailyLimitUsd) {
      reroute = {
        reason: step(
          'warn',
          `Key ${key.name} reached its ${usd(key.dailyLimitUsd)} daily limit (${usd(keyDay)} spent)`,
          'keyDailyLimit',
          { key: key.name, limit: key.dailyLimitUsd, spent: keyDay },
        ),
        ruleId: null,
        allowed: key.fallbackToLocal,
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
        };
      }
    }
    if (
      !reroute &&
      rules.offHours.enabled &&
      !isWithin(rules.offHours.from, rules.offHours.to, now)
    ) {
      const { from, to } = rules.offHours;
      reroute = {
        reason: step('warn', `Outside working hours ${from}–${to}`, 'offHours', { from, to }),
        ruleId: 'offHours',
        allowed: true,
      };
    }

    if (reroute) {
      trace.push(reroute.reason);
      const local = settings.localModelId
        ? await findModel(ctx.db, eq(models.id, settings.localModelId))
        : null;
      if (!reroute.allowed || !local) {
        const blocked = !reroute.allowed
          ? step(
              'block',
              'Request blocked: this key blocks instead of switching to a local model',
              'blockedKeyNoFallback',
            )
          : step('block', 'Request blocked: no local model is configured', 'blockedNoLocalModel');
        return stop('blocked_budget', 429, blocked, requested, reroute.ruleId);
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
        key.dailyLimitUsd != null ? `key ${usd(keyDay)} of ${usd(key.dailyLimitUsd)} today` : null,
        team?.monthlyBudgetUsd
          ? `${team.name} at ${Math.round((teamMonth / team.monthlyBudgetUsd) * 100)}% of ${usd(team.monthlyBudgetUsd)}`
          : null,
      ].filter(Boolean);
      trace.push(
        parts.length
          ? step('ok', `Within budget: ${parts.join(' · ')}`, 'withinBudget', {
              keySpent: key.dailyLimitUsd != null ? keyDay : null,
              keyLimit: key.dailyLimitUsd,
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
  return { result, status: 200, requested, target, ruleId, trace, message: '' };
}
