import { desc, eq, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppContext } from '../context.ts';
import { comparisons, models, requestLogs, users } from '../db/schema.ts';
import { callerForKey, handleGateway } from '../gateway/handler.ts';
import { findModel, type Target } from '../gateway/policy.ts';
import { sha256 } from '../lib/crypto.ts';
import { maskPii } from '../lib/pii.ts';
import { checkAnswer } from './checks.ts';
import { evaluationSource } from './task-sets.ts';
import { estimateToolTask, maximumTaskCalls, runToolTask } from './tool-runner.ts';
import type {
  ComparisonCell,
  ComparisonInput,
  ComparisonModel,
  ComparisonReport,
  ComparisonSummary,
  Reason,
} from './types.ts';

export function comparisonSummary(report: ComparisonReport): ComparisonSummary {
  const { models: _models, cases: _cases, cells, ...summary } = report;
  return {
    ...summary,
    total: cells.length,
    done: cells.filter((cell) => cell.status !== 'queued' && cell.status !== 'running').length,
  };
}

export class ComparisonError extends Error {}
export const OUTPUT_LIMIT = 8000;
const runners = new WeakMap<AppContext, ComparisonRunner>();

export function comparisonRunner(ctx: AppContext): ComparisonRunner {
  let runner = runners.get(ctx);
  if (!runner) {
    runner = new ComparisonRunner(ctx);
    runners.set(ctx, runner);
  }
  return runner;
}

function viewModel(target: Target): ComparisonModel {
  const { model, provider } = target;
  return {
    id: model.id,
    name: model.name,
    label: model.label ?? model.name,
    provider: provider.name,
    providerId: provider.id,
    upstreamModel: model.upstreamModel,
    isLocal: provider.isLocal,
    inputPrice: model.inputPrice,
    outputPrice: model.outputPrice,
    providerKind: provider.kind,
    providerUrlHash: sha256(provider.baseUrl),
    cacheReadPrice: model.cacheReadPrice,
  };
}

/** Byte count deliberately overestimates ordinary tokenization. This is a planning estimate, not a bill cap. */
export function estimateCall(
  target: Target,
  system: string,
  prompt: string,
  outputTokens: number,
): number {
  if (target.provider.isLocal) return 0;
  const input = new TextEncoder().encode(system + prompt).length + 256;
  const price = Math.max((target.model.inputPrice ?? 0) * 2, target.model.cacheReadPrice ?? 0);
  return (input * price + outputTokens * (target.model.outputPrice ?? 0)) / 1_000_000;
}

export class ComparisonRunner {
  #ctx: AppContext;
  #ready: Promise<void> | null = null;
  #active: { id: string; abort: AbortController } | null = null;
  #starting = false;
  #reviews: Promise<unknown> = Promise.resolve();

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  ready(): Promise<void> {
    this.#ready ??= this.#recover();
    return this.#ready;
  }

  async #recover() {
    const rows = await this.#ctx.db
      .select()
      .from(comparisons)
      .where(sql`json_extract(${comparisons.report}, '$.status') = 'running'`);
    for (const row of rows) {
      if (row.report.status !== 'running') continue;
      const report = row.report;
      report.status = 'interrupted';
      report.finishedAt = new Date().toISOString();
      for (const cell of report.cells) {
        if (cell.status === 'running') {
          cell.costUsd = null;
          report.unknownCosts = true;
        }
        if (cell.status === 'queued' || cell.status === 'running') {
          cell.status = 'skipped';
          cell.reason = 'interrupted';
        }
        for (const step of cell.toolSteps ?? []) {
          if (step.status === 'running') step.costUsd = null;
          if (step.status === 'queued' || step.status === 'running') {
            step.status = 'skipped';
            step.reason = 'interrupted';
          }
        }
      }
      await this.#save(report);
    }
  }

  async prepare(input: ComparisonInput) {
    const evaluation = await evaluationSource(this.#ctx, input);
    const caller = await callerForKey(this.#ctx, input.keyId);
    if (!caller) throw new ComparisonError('Choose an active gateway key');
    const targets: Target[] = [];
    for (const modelId of input.modelIds) {
      const target = await findModel(this.#ctx.db, eq(models.id, modelId));
      if (!target) throw new ComparisonError('Choose enabled models');
      if (
        (caller.key.allowedModelIds && !caller.key.allowedModelIds.includes(modelId)) ||
        (caller.team?.allowedModelIds && !caller.team.allowedModelIds.includes(modelId))
      ) {
        throw new ComparisonError('The selected key does not allow these models');
      }
      if (
        !target.provider.isLocal &&
        (target.model.inputPrice === null || target.model.outputPrice === null)
      ) {
        throw new ComparisonError('Set input and output prices for cloud models first');
      }
      targets.push(target);
    }
    const estimatedUsd = targets.reduce(
      (sum, target) =>
        sum +
        input.cases.reduce(
          (subtotal, task) =>
            subtotal +
            (task.tools
              ? estimateToolTask(target, input, task)
              : estimateCall(target, input.system, task.prompt, input.maxOutputTokens)),
          0,
        ),
      0,
    );
    return {
      caller,
      targets,
      estimatedUsd,
      evaluation,
      calls: targets.length * input.cases.reduce((sum, task) => sum + maximumTaskCalls(task), 0),
    };
  }

  async start(input: ComparisonInput, createdBy: string): Promise<ComparisonReport> {
    await this.ready();
    if (this.#active || this.#starting)
      throw new ComparisonError('A comparison is already running');
    this.#starting = true;
    try {
      const { caller, targets, estimatedUsd, evaluation } = await this.prepare(input);
      const settings = await this.#ctx.settings.get();
      const id = crypto.randomUUID();
      const report: ComparisonReport = {
        id,
        name: maskPii(input.name).text,
        keyId: input.keyId,
        keyName: caller.key.name,
        status: 'running',
        createdAt: new Date().toISOString(),
        finishedAt: null,
        maxSpendUsd: input.maxSpendUsd,
        estimatedUsd,
        spentUsd: 0,
        unknownCosts: false,
        maxOutputTokens: input.maxOutputTokens,
        storesOutputs: settings.storePrompts,
        ...(evaluation ? { evaluation } : {}),
        models: targets.map(viewModel),
        cases: input.cases.map((task) => ({
          id: crypto.randomUUID(),
          name: maskPii(task.name).text,
          check: task.check,
          ...(task.tools ? { toolMode: task.tools.mode } : {}),
        })),
        cells: input.cases.flatMap((_, caseIndex) =>
          targets.map(
            (target): ComparisonCell => ({
              caseIndex,
              modelId: target.model.id,
              status: 'queued',
              reason: null,
              output: null,
              outputTruncated: false,
              costUsd: 0,
              inputTokens: null,
              outputTokens: null,
              latencyMs: null,
              requestId: null,
              servedModel: null,
              httpStatus: null,
            }),
          ),
        ),
      };
      await this.#ctx.db.insert(comparisons).values({
        id,
        createdBy,
        report,
        summary: comparisonSummary(report),
        expiresAt: new Date(Date.now() + settings.retentionDays * 86_400_000),
      });
      const abort = new AbortController();
      this.#active = { id, abort };
      // Work starts after the response. Prompts/expected answers stay in this closure, not the database.
      setTimeout(() => {
        void this.#run(input, report, createdBy, abort).catch((error: unknown) => {
          console.error('Failed to finish comparison', error);
        });
      }, 0);
      return structuredClone(report);
    } finally {
      this.#starting = false;
    }
  }

  async #save(report: ComparisonReport) {
    await this.#ctx.db
      .update(comparisons)
      .set({ report, summary: comparisonSummary(report) })
      .where(eq(comparisons.id, report.id));
  }

  async #run(
    input: ComparisonInput,
    report: ComparisonReport,
    createdBy: string,
    abort: AbortController,
  ) {
    try {
      for (const cell of report.cells) {
        if (abort.signal.aborted) break;
        const task = input.cases[cell.caseIndex]!;
        if (task.tools) {
          await runToolTask(this.#ctx, input, report, cell, createdBy, abort, () =>
            this.#save(report),
          );
          continue;
        }
        const metadata = report.models.find((model) => model.id === cell.modelId)!;
        const target = await findModel(this.#ctx.db, eq(models.id, cell.modelId));
        const caller = await callerForKey(this.#ctx, input.keyId);
        const admin = await this.#ctx.db.query.users.findFirst({ where: eq(users.id, createdBy) });
        let skip: Reason | null = null;
        if (
          !caller ||
          !admin ||
          admin.disabledAt ||
          admin.role !== 'admin' ||
          !target ||
          target.model.name !== metadata.name ||
          target.model.providerId !== metadata.providerId ||
          target.model.upstreamModel !== metadata.upstreamModel ||
          target.provider.isLocal !== metadata.isLocal
        )
          skip = 'unavailable';
        else if (
          !target.provider.isLocal &&
          (target.model.inputPrice === null || target.model.outputPrice === null)
        ) {
          skip = 'unknownCost';
        } else if (!target.provider.isLocal && report.unknownCosts) skip = 'unknownCost';
        else if (
          estimateCall(target, input.system, task.prompt, input.maxOutputTokens) >
          Math.max(0, report.maxSpendUsd - report.spentUsd)
        )
          skip = 'budget';
        if (skip || !target || !caller) {
          cell.status = 'skipped';
          cell.reason = skip ?? 'unavailable';
          await this.#save(report);
          continue;
        }
        if (abort.signal.aborted) break;
        cell.status = 'running';
        cell.costUsd = null;
        await this.#save(report);
        const started = Date.now();
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]);
        const gateway = new Hono().post('/call', (c) =>
          handleGateway(this.#ctx, c, 'openai', caller),
        );
        try {
          const response = await gateway.request(
            new Request('http://spillway.internal/call', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
              signal,
              body: JSON.stringify({
                model: target.model.name,
                stream: false,
                max_tokens: input.maxOutputTokens,
                messages: [
                  ...(input.system ? [{ role: 'system', content: input.system }] : []),
                  { role: 'user', content: task.prompt },
                ],
              }),
            }),
          );
          cell.httpStatus = response.status;
          cell.requestId = response.headers.get('x-spillway-request-id');
          cell.servedModel = response.headers.get('x-spillway-model');
          const log = cell.requestId
            ? await this.#ctx.db.query.requestLogs.findFirst({
                where: eq(requestLogs.id, cell.requestId),
              })
            : undefined;
          const served =
            log?.servedModelId === target.model.id
              ? target
              : log?.servedModelId
                ? await findModel(this.#ctx.db, eq(models.id, log.servedModelId))
                : null;
          const pricesKnown = served?.model.inputPrice != null && served.model.outputPrice != null;
          const body = (await response.json()) as {
            choices?: { message?: { content?: unknown }; finish_reason?: string | null }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const inputTokens = body.usage?.prompt_tokens;
          const outputTokens = body.usage?.completion_tokens;
          const usageKnown =
            response.headers.get('x-spillway-usage-known') !== 'false' &&
            Number.isSafeInteger(inputTokens) &&
            Number.isSafeInteger(outputTokens) &&
            inputTokens! >= 0 &&
            outputTokens! >= 0;
          const blocked =
            !!log &&
            ['blocked_budget', 'blocked_model', 'blocked_pii', 'rate_limited'].includes(log.result);
          cell.inputTokens = usageKnown ? inputTokens! : null;
          cell.outputTokens = usageKnown ? outputTokens! : null;
          cell.costUsd = blocked
            ? 0
            : log?.costKnown === false
              ? null
              : target.provider.isLocal && !log?.servedModelId
                ? 0
                : log?.servedLocal
                  ? 0
                  : usageKnown && pricesKnown && log && Number.isFinite(log.costUsd)
                    ? log.costUsd
                    : null;
          if (log?.trace.some((step) => step.code === 'providerFailed')) report.unknownCosts = true;
          if (cell.costUsd === null) report.unknownCosts = true;
          else report.spentUsd += cell.costUsd;
          if (!response.ok) {
            cell.status = blocked ? 'skipped' : 'error';
            cell.reason = blocked
              ? 'policy'
              : signal.aborted
                ? abort.signal.aborted
                  ? 'cancelled'
                  : 'timeout'
                : 'upstream';
          } else if (
            cell.servedModel !== target.model.name ||
            log?.servedModelId !== target.model.id
          ) {
            cell.status = 'skipped';
            cell.reason = 'rerouted';
          } else if (log?.trace.some((step) => step.code === 'promptCut')) {
            cell.status = 'failed';
            cell.reason = 'truncated';
          } else {
            const choice = body.choices?.[0];
            const output = choice?.message?.content;
            if (typeof output !== 'string' || !output.trim()) {
              cell.status = 'failed';
              cell.reason = 'noText';
            } else {
              const verdict =
                choice?.finish_reason === 'stop'
                  ? checkAnswer(task.check, task.expected, output)
                  : { status: 'failed' as const, reason: 'truncated' as const };
              Object.assign(cell, verdict);
              const store = (await this.#ctx.settings.get()).storePrompts;
              if (report.storesOutputs && store) {
                const masked = maskPii(output).text;
                cell.output = masked.slice(0, OUTPUT_LIMIT);
                cell.outputTruncated = masked.length > OUTPUT_LIMIT;
              }
            }
          }
        } catch {
          cell.status = 'error';
          cell.reason = signal.aborted
            ? abort.signal.aborted
              ? 'cancelled'
              : 'timeout'
            : 'upstream';
          cell.costUsd = null;
          report.unknownCosts = true;
        }
        cell.latencyMs = Date.now() - started;
        await this.#save(report);
      }
      report.status = abort.signal.aborted ? 'cancelled' : 'completed';
    } catch {
      report.status = 'interrupted';
    } finally {
      for (const cell of report.cells) {
        if (cell.status === 'queued' || cell.status === 'running') {
          if (cell.status === 'running') {
            report.unknownCosts = true;
            cell.costUsd = null;
          }
          cell.status = 'skipped';
          cell.reason = report.status === 'cancelled' ? 'cancelled' : 'interrupted';
        }
        for (const step of cell.toolSteps ?? []) {
          if (step.status === 'running') step.costUsd = null;
          if (step.status === 'queued' || step.status === 'running') {
            step.status = 'skipped';
            step.reason = report.status === 'cancelled' ? 'cancelled' : 'interrupted';
          }
        }
      }
      report.finishedAt = new Date().toISOString();
      try {
        await this.#save(report);
      } finally {
        this.#active = null;
      }
    }
  }

  async list() {
    await this.ready();
    const rows = await this.#ctx.db
      .select({ summary: comparisons.summary })
      .from(comparisons)
      .orderBy(desc(comparisons.createdAt))
      .limit(30);
    return rows.map((row) => row.summary);
  }

  async get(id: string) {
    await this.ready();
    const row = await this.#ctx.db.query.comparisons.findFirst({ where: eq(comparisons.id, id) });
    if (!row) return null;
    const report = row.report;
    // Turning off text storage also hides outputs retained from earlier runs.
    if (!(await this.#ctx.settings.get()).storePrompts) {
      report.storesOutputs = false;
      for (const cell of report.cells) cell.output = null;
    }
    return report;
  }

  async cancel(id: string) {
    await this.ready();
    if (this.#active?.id !== id) return false;
    this.#active.abort.abort();
    return true;
  }

  review(id: string, caseIndex: number, modelId: string, status: 'passed' | 'failed' | 'review') {
    const operation = this.#reviews.then(async () => {
      const report = await this.get(id);
      if (!report) throw new ComparisonError('Comparison not found');
      if (report.status === 'running')
        throw new ComparisonError('Wait for the comparison to finish');
      const cell = report.cells.find(
        (cell) => cell.caseIndex === caseIndex && cell.modelId === modelId,
      );
      const task = report.cases[caseIndex];
      const final = cell?.toolSteps?.at(-1);
      if (
        !cell ||
        cell.output === null ||
        cell.outputTruncated ||
        task?.check !== 'manual' ||
        task.toolMode === 'call' ||
        (task.toolMode === 'loop' &&
          (final?.phase !== 'final' ||
            final.reason !== 'manual' ||
            !cell.toolSteps
              ?.slice(0, -1)
              .every((step) => step.phase === 'call' && step.status === 'passed'))) ||
        !['passed', 'failed', 'review'].includes(cell.status)
      ) {
        throw new ComparisonError('Only manual answers can be reviewed');
      }
      cell.status = status;
      cell.reason = 'manual';
      if (task.toolMode === 'loop' && final) {
        final.status = status;
        final.reason = 'manual';
      }
      await this.#save(report);
      return report;
    });
    this.#reviews = operation.catch(() => undefined);
    return operation;
  }

  async remove(id: string) {
    await this.ready();
    if (this.#active?.id === id) throw new ComparisonError('Cancel the running comparison first');
    await this.#ctx.db.delete(comparisons).where(eq(comparisons.id, id));
  }
}

export async function forgetComparisons(ctx: AppContext) {
  await comparisonRunner(ctx).ready();
  // An active run must survive cleanup long enough to write its final report.
  const rows = await ctx.db.select().from(comparisons).where(lt(comparisons.expiresAt, new Date()));
  for (const row of rows) {
    if (row.report.status !== 'running')
      await ctx.db.delete(comparisons).where(eq(comparisons.id, row.id));
  }
}
