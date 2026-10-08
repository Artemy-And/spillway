import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { estimateRequest } from '../budget/estimate.ts';
import type { AppContext } from '../context.ts';
import { models, requestLogs, users } from '../db/schema.ts';
import { callerForKey, handleGateway } from '../gateway/handler.ts';
import { findModel, type Target } from '../gateway/policy.ts';
import type { OAIMessage } from '../gateway/types.ts';
import { speaksResponses } from '../gateway/upstream.ts';
import { sha256 } from '../lib/crypto.ts';
import { maskPii } from '../lib/pii.ts';
import { checkAnswer } from './checks.ts';
import { buildToolDefinitions, validateToolCall } from './tools.ts';
import type {
  ComparisonCase,
  ComparisonCell,
  ComparisonInput,
  ComparisonModel,
  ComparisonReport,
  ComparisonToolStep,
  Reason,
} from './types.ts';

export const maximumTaskCalls = (task: ComparisonCase) =>
  task.tools?.mode === 'loop' ? task.tools.steps.length + 1 : 1;

function requestBody(
  input: ComparisonInput,
  task: ComparisonCase,
  target: Target,
  messages: OAIMessage[],
): Record<string, unknown> {
  return {
    model: target.model.name,
    stream: false,
    [speaksResponses(target.provider) ? 'max_completion_tokens' : 'max_tokens']:
      input.maxOutputTokens,
    messages,
    tools: buildToolDefinitions(task.tools!),
    tool_choice: 'auto',
    parallel_tool_calls: false,
  };
}

function initialMessages(system: string, task: ComparisonCase): OAIMessage[] {
  return [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    { role: 'user', content: task.prompt },
  ];
}

/** Quotes budget the full bounded sequence; actual admission re-estimates the actual history each turn. */
export function estimateToolTask(
  target: Target,
  input: ComparisonInput,
  task: ComparisonCase,
): number {
  const messages = initialMessages(input.system, task);
  let total = 0;
  for (let index = 0; index < maximumTaskCalls(task); index++) {
    total += estimateRequest(target, 'openai', requestBody(input, task, target, messages)) ?? 0;
    const expected = task.tools!.steps[index];
    if (expected) {
      // Account for possible whitespace in arguments and assistant text up to the per-turn bound.
      messages.push(
        {
          role: 'assistant',
          content: 'x'.repeat(8000),
          tool_calls: [
            {
              id: 'x'.repeat(200),
              type: 'function',
              function: { name: expected.name, arguments: 'x'.repeat(8000) },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'x'.repeat(200), content: expected.result },
      );
    }
  }
  return total;
}

function unchanged(target: Target, saved: ComparisonModel) {
  return (
    target.model.name === saved.name &&
    target.model.providerId === saved.providerId &&
    target.model.upstreamModel === saved.upstreamModel &&
    target.provider.isLocal === saved.isLocal &&
    target.provider.kind === saved.providerKind &&
    sha256(target.provider.baseUrl) === saved.providerUrlHash &&
    target.model.inputPrice === saved.inputPrice &&
    target.model.outputPrice === saved.outputPrice &&
    target.model.cacheReadPrice === saved.cacheReadPrice
  );
}

/** Executes model requests only. Tool results are fixed strings; no function, shell or HTTP tool executes. */
export async function runToolTask(
  ctx: AppContext,
  input: ComparisonInput,
  report: ComparisonReport,
  cell: ComparisonCell,
  createdBy: string,
  abort: AbortController,
  save: () => Promise<void>,
) {
  const task = input.cases[cell.caseIndex]!;
  const scenario = task.tools!;
  const saved = report.models.find((model) => model.id === cell.modelId)!;
  const messages = initialMessages(input.system, task);
  const usedIds = new Set<string>();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]);
  const started = Date.now();
  const transcript: string[] = [];
  let transcriptCut = false;
  const appendOutput = (raw: string) => {
    const masked = maskPii(raw).text;
    transcriptCut ||= masked.length > 8000;
    transcript.push(masked.slice(0, 8000));
  };
  let charged = 0;
  let unknown = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let tokensKnown = true;
  cell.toolSteps = [];
  cell.status = 'running';
  cell.costUsd = 0;
  await save();

  const finishStep = async (
    entry: ComparisonToolStep,
    status: ComparisonCell['status'],
    reason: Reason,
    continuing = false,
  ) => {
    entry.status = status;
    entry.reason = reason;
    cell.status = continuing ? 'running' : status;
    cell.reason = continuing ? null : reason;
    cell.costUsd = unknown ? null : charged;
    cell.inputTokens = tokensKnown ? inputTokens : null;
    cell.outputTokens = tokensKnown ? outputTokens : null;
    cell.latencyMs = Date.now() - started;
    const store = (await ctx.settings.get()).storePrompts;
    if (report.storesOutputs && store && transcript.length) {
      const masked = maskPii(transcript.join('\n\n')).text;
      cell.output = masked.slice(0, 8000);
      cell.outputTruncated = transcriptCut || masked.length > 8000;
    } else cell.output = null;
    await save();
  };

  for (let index = 0; index < maximumTaskCalls(task); index++) {
    const expected = scenario.steps[index];
    const entry: ComparisonToolStep = {
      index,
      phase: expected ? 'call' : 'final',
      status: 'queued',
      reason: null,
      toolName: null,
      requestId: null,
      costUsd: 0,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
    };
    cell.toolSteps.push(entry);
    const target = await findModel(ctx.db, eq(models.id, cell.modelId));
    const caller = await callerForKey(ctx, input.keyId);
    const admin = await ctx.db.query.users.findFirst({ where: eq(users.id, createdBy) });
    if (signal.aborted) {
      await finishStep(entry, 'skipped', abort.signal.aborted ? 'cancelled' : 'timeout');
      break;
    }
    if (
      !target ||
      !caller ||
      !admin ||
      admin.disabledAt ||
      admin.role !== 'admin' ||
      !unchanged(target, saved)
    ) {
      await finishStep(entry, 'skipped', 'unavailable');
      break;
    }
    const body = requestBody(input, task, target, messages);
    const estimate = estimateRequest(target, 'openai', body);
    if (!target.provider.isLocal && (report.unknownCosts || estimate === null)) {
      await finishStep(entry, 'skipped', 'unknownCost');
      break;
    }
    if (estimate !== null && estimate > Math.max(0, report.maxSpendUsd - report.spentUsd)) {
      await finishStep(entry, 'skipped', 'budget');
      break;
    }
    entry.status = 'running';
    entry.costUsd = null;
    cell.costUsd = null;
    await save();
    const turnStarted = Date.now();
    const gateway = new Hono().post('/call', (c) => handleGateway(ctx, c, 'openai', caller));
    let accounted = false;
    try {
      const response = await gateway.request(
        new Request('http://spillway.internal/call', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          signal,
          body: JSON.stringify(body),
        }),
      );
      cell.httpStatus = response.status;
      cell.requestId = response.headers.get('x-spillway-request-id');
      cell.servedModel = response.headers.get('x-spillway-model');
      entry.requestId = cell.requestId;
      entry.latencyMs = Date.now() - turnStarted;
      const log = cell.requestId
        ? await ctx.db.query.requestLogs.findFirst({ where: eq(requestLogs.id, cell.requestId) })
        : undefined;
      const blocked =
        !!log &&
        ['blocked_budget', 'blocked_model', 'blocked_pii', 'rate_limited'].includes(log.result);
      const known = !!log && log.costKnown !== false && Number.isFinite(log.costUsd);
      const cost = log && Number.isFinite(log.costUsd) ? log.costUsd : 0;
      charged += cost;
      report.spentUsd += cost;
      entry.costUsd = known || blocked ? cost : null;
      if (!known && !blocked) {
        unknown = true;
        report.unknownCosts = true;
      }
      accounted = true;
      const usageKnown =
        response.headers.get('x-spillway-usage-known') !== 'false' &&
        !!log &&
        (log.servedLocal || log.costKnown === true) &&
        Number.isSafeInteger(log.inputTokens) &&
        log.inputTokens >= 0 &&
        Number.isSafeInteger(log.outputTokens) &&
        log.outputTokens >= 0;
      if (usageKnown) {
        entry.inputTokens = log.inputTokens;
        entry.outputTokens = log.outputTokens;
        inputTokens += log.inputTokens;
        outputTokens += log.outputTokens;
      } else if (!blocked) tokensKnown = false;
      if (!response.ok) {
        await finishStep(
          entry,
          blocked ? 'skipped' : 'error',
          blocked
            ? 'policy'
            : signal.aborted
              ? abort.signal.aborted
                ? 'cancelled'
                : 'timeout'
              : 'upstream',
        );
        break;
      }
      if (cell.servedModel !== target.model.name || log?.servedModelId !== target.model.id) {
        await finishStep(entry, 'skipped', 'rerouted');
        break;
      }
      if (log.trace.some((step) => step.code === 'promptCut')) {
        await finishStep(entry, 'failed', 'truncated');
        break;
      }
      const answer = (await response.json()) as {
        choices?: {
          message?: { role?: unknown; content?: unknown; tool_calls?: unknown };
          finish_reason?: unknown;
        }[];
      };
      const choice = answer.choices?.[0];
      const message = choice?.message;
      const content = message?.content;
      if (typeof content === 'string') appendOutput(content);
      const calls = message?.tool_calls;
      if (Array.isArray(calls))
        appendOutput(
          JSON.stringify(calls, (key, value: unknown) => {
            if (typeof value !== 'string') return value;
            let text = value;
            if (key === 'arguments') {
              try {
                text = JSON.stringify(JSON.parse(value));
              } catch {
                /* Malformed calls remain inspectable. */
              }
            }
            // Masking escaped personal data is independent of argument validation.
            return maskPii(
              text.replace(/\\+u([0-9a-f]{4})/gi, (_match, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              ),
            ).text;
          }),
        );
      if (answer.choices?.length !== 1 || message?.role !== 'assistant') {
        await finishStep(entry, 'failed', expected ? 'toolUnexpected' : 'noText');
        break;
      }
      if (choice?.finish_reason === 'length' || choice?.finish_reason === 'content_filter') {
        await finishStep(entry, 'failed', 'truncated');
        break;
      }
      if (expected) {
        if (calls === undefined || (Array.isArray(calls) && calls.length === 0)) {
          await finishStep(entry, 'failed', 'toolMissing');
          break;
        }
        if (!Array.isArray(calls) || calls.length !== 1 || choice?.finish_reason !== 'tool_calls') {
          await finishStep(entry, 'failed', 'toolUnexpected');
          break;
        }
        const checked = validateToolCall(calls[0], expected, usedIds);
        if (!checked.call) {
          await finishStep(entry, 'failed', checked.reason!);
          break;
        }
        entry.toolName = maskPii(checked.call.function.name).text;
        if (
          content !== null &&
          content !== undefined &&
          (typeof content !== 'string' || content.length > 8000)
        ) {
          await finishStep(entry, 'failed', 'truncated');
          break;
        }
        messages.push(
          {
            role: 'assistant',
            content: typeof content === 'string' ? content : null,
            tool_calls: [checked.call],
          },
          { role: 'tool', tool_call_id: checked.call.id, content: expected.result },
        );
        await finishStep(entry, 'passed', 'matched', scenario.mode === 'loop');
        if (scenario.mode === 'call') break;
      } else {
        if (calls !== undefined && (!Array.isArray(calls) || calls.length > 0)) {
          await finishStep(entry, 'failed', 'toolSequence');
          break;
        }
        if (choice?.finish_reason !== 'stop') {
          await finishStep(entry, 'failed', 'truncated');
          break;
        }
        if (typeof content !== 'string' || !content.trim()) {
          await finishStep(entry, 'failed', 'noText');
          break;
        }
        const verdict = checkAnswer(task.check, task.expected, content);
        await finishStep(entry, verdict.status, verdict.reason);
        break;
      }
    } catch {
      if (!accounted) {
        unknown = true;
        report.unknownCosts = true;
      }
      entry.latencyMs = Date.now() - turnStarted;
      await finishStep(
        entry,
        'error',
        signal.aborted ? (abort.signal.aborted ? 'cancelled' : 'timeout') : 'upstream',
      );
      break;
    }
  }
}
