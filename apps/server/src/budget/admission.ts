import type { AppContext } from '../context.ts';
import { callerForKey } from '../gateway/handler.ts';
import { type Caller, step, type Target } from '../gateway/policy.ts';
import { speaksResponses } from '../gateway/upstream.ts';
import { allowed, routingTarget } from '../routing/resolve.ts';
import { calendarOf, type Settings } from '../settings.ts';
import { cappedBody, estimateRequest } from './estimate.ts';
import { reserve } from './ledger.ts';

export async function admit(
  ctx: AppContext,
  input: {
    caller: Caller;
    target: Target;
    requestedModelId: string;
    requestId: string;
    sessionId?: string;
    body: Record<string, unknown>;
    format: string;
    settings: Settings;
    allowLocal?: boolean;
  },
) {
  const { caller, target, settings } = input;
  const limited =
    caller.key.dailyLimitUsd !== null ||
    caller.key.monthlyLimitUsd !== null ||
    caller.team?.monthlyBudgetUsd != null;
  const body = cappedBody(
    input.format,
    input.body,
    limited && !target.provider.isLocal,
    input.format === 'openai' && speaksResponses(target.provider),
  );
  if (target.provider.isLocal)
    return { target, body, reservation: null, trace: [], denied: false, status: 200 } as const;
  const estimate = estimateRequest(target, input.format, body);
  const reservation = await reserve(ctx.db, { ...input, estimate, cal: calendarOf(settings) });
  if (reservation)
    return {
      target,
      body,
      reservation,
      denied: false,
      status: 200,
      trace: [
        step('info', 'Reserved estimated API cost before calling the provider', 'budgetReserved', {
          amount: reservation.estimatedUsd,
        }),
      ],
    } as const;
  const fresh = await callerForKey(ctx, caller.key.id);
  const reason =
    estimate === null
      ? 'Cannot estimate this cloud request: configure prices and use bounded text input'
      : 'The remaining key or team budget cannot cover this request and existing reservations';
  const trace = [
    step('warn', reason, estimate === null ? 'budgetEstimateUnknown' : 'budgetReservationDenied'),
  ];
  if (
    fresh &&
    allowed(fresh, input.requestedModelId) &&
    input.allowLocal !== false &&
    fresh.key.fallbackToLocal &&
    settings.localModelId
  ) {
    const local = await routingTarget(ctx, settings.localModelId);
    if (local?.provider.isLocal && allowed(fresh, local.model.id)) {
      return {
        target: local,
        body: input.body,
        reservation: null,
        denied: false,
        status: 200,
        trace: [
          ...trace,
          step('info', `Sent to ${local.model.name} · local`, 'sentToLocal', {
            model: local.model.name,
            rule: null,
          }),
        ],
      } as const;
    }
  }
  return {
    target,
    body,
    reservation: null,
    denied: true,
    status: fresh ? 429 : 401,
    trace,
    message: fresh ? reason : 'Missing or invalid Spillway key',
  } as const;
}
