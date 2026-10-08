import { and, desc, eq, gt, lt, or, sql } from 'drizzle-orm';
import type { AppContext } from '../context.ts';
import { taskSets, users } from '../db/schema.ts';
import { sha256 } from '../lib/crypto.ts';
import { maskPii } from '../lib/pii.ts';
import { comparisonRunner } from './runner.ts';
import type { ComparisonInput, EvaluationSource, ReferenceRun, TaskSetInput } from './types.ts';

export class TaskSetError extends Error {
  status: 400 | 403 | 404 | 409;
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

// Check the persisted setting in the write itself, including a concurrent settings change.
const storageEnabled = sql`coalesce((select json_extract(s.value, '$.storePrompts')
  from settings s where s.key = 'app'), 1) = 1`;

/** Name is presentation; task order, checks, expected answers and generation cap are evidence. */
export function taskFingerprint(input: TaskSetInput): string {
  return sha256(
    JSON.stringify({
      system: input.system,
      maxOutputTokens: input.maxOutputTokens,
      cases: input.cases.map(({ name, prompt, check, expected, tools }) => ({
        name,
        prompt,
        check,
        expected,
        ...(tools
          ? {
              tools: {
                mode: tools.mode,
                definitions: tools.definitions.map(({ name, description, parameters }) => ({
                  name,
                  description,
                  parameters,
                })),
                steps: tools.steps.map(({ name, arguments: args, result }) => ({
                  name,
                  arguments: args,
                  result,
                })),
              },
            }
          : {}),
      })),
    }),
  );
}

async function storageSettings(ctx: AppContext) {
  const settings = await ctx.settings.get();
  if (!settings.storePrompts)
    throw new TaskSetError('Enable text storage to save or load task sets', 403);
  return settings;
}

function safeTemplate(input: TaskSetInput) {
  const decodedJson = (text: string) => {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      return text;
    }
  };
  const texts = [
    input.name,
    input.system,
    ...input.cases.flatMap((task) => [
      task.name,
      task.prompt,
      task.expected,
      ...(task.tools
        ? [
            JSON.stringify(task.tools),
            ...task.tools.definitions.map((tool) => decodedJson(tool.parameters)),
            ...task.tools.steps.flatMap((step) => [
              decodedJson(step.arguments),
              decodedJson(step.result),
            ]),
          ]
        : []),
    ]),
  ];
  if (texts.some((text) => Object.keys(maskPii(text).found).length)) {
    throw new TaskSetError(
      'Use synthetic placeholders instead of personal data or secrets in saved tasks',
    );
  }
}

export async function forgetTaskSets(ctx: AppContext) {
  const settings = await ctx.settings.get();
  if (!settings.storePrompts) {
    await ctx.db.delete(taskSets);
    return;
  }
  const now = new Date();
  await ctx.db
    .delete(taskSets)
    .where(
      or(
        lt(taskSets.expiresAt, now),
        lt(taskSets.updatedAt, new Date(now.getTime() - settings.retentionDays * 86_400_000)),
      ),
    );
}

export async function listTaskSets(ctx: AppContext) {
  await forgetTaskSets(ctx);
  const rows = await ctx.db.select().from(taskSets).orderBy(desc(taskSets.updatedAt)).limit(100);
  // List responses never expose prompt or expected-answer texts.
  return rows.map(({ id, revision, fingerprint, content, reference, updatedAt, expiresAt }) => ({
    id,
    revision,
    fingerprint,
    name: content.name,
    cases: content.cases.length,
    maxOutputTokens: content.maxOutputTokens,
    reference: reference
      ? { id: reference.id, name: reference.name, createdAt: reference.createdAt }
      : null,
    updatedAt,
    expiresAt,
  }));
}

export async function getTaskSet(ctx: AppContext, id: string) {
  const settings = await storageSettings(ctx);
  const now = new Date();
  const row = await ctx.db.query.taskSets.findFirst({
    where: and(
      eq(taskSets.id, id),
      gt(taskSets.expiresAt, now),
      gt(taskSets.updatedAt, new Date(now.getTime() - settings.retentionDays * 86_400_000)),
    ),
  });
  if (!row) throw new TaskSetError('Task set not found or expired', 404);
  return row;
}

export async function saveTaskSet(
  ctx: AppContext,
  input: TaskSetInput,
  createdBy: string,
  update?: { id: string; revision: number },
) {
  const settings = await storageSettings(ctx);
  safeTemplate(input);
  const fingerprint = taskFingerprint(input);
  const now = new Date();
  const values = {
    content: input,
    fingerprint,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + settings.retentionDays * 86_400_000),
  };
  if (!update) {
    const [row] = await ctx.db
      .insert(taskSets)
      .select(
        ctx.db
          .select({
            id: sql<string>`${crypto.randomUUID()}`.as('id'),
            revision: sql<number>`1`.as('revision'),
            content: sql<TaskSetInput>`${JSON.stringify(input)}`.as('content'),
            fingerprint: sql<string>`${fingerprint}`.as('fingerprint'),
            reference: sql<null>`null`.as('reference'),
            createdBy: users.id,
            createdAt: sql<Date>`${now.getTime()}`.as('created_at'),
            updatedAt: sql<Date>`${now.getTime()}`.as('updated_at'),
            expiresAt: sql<Date>`${values.expiresAt.getTime()}`.as('expires_at'),
          })
          .from(users)
          .where(and(eq(users.id, createdBy), storageEnabled)),
      )
      .returning();
    if (!row) {
      await storageSettings(ctx);
      throw new TaskSetError('Task set could not be saved');
    }
    return row;
  }
  await getTaskSet(ctx, update.id);
  const [row] = await ctx.db
    .update(taskSets)
    .set({
      ...values,
      revision: update.revision + 1,
      reference: sql`case when ${taskSets.fingerprint} = ${fingerprint} then ${taskSets.reference} else null end`,
    })
    .where(and(eq(taskSets.id, update.id), eq(taskSets.revision, update.revision), storageEnabled))
    .returning();
  if (!row) {
    await storageSettings(ctx);
    throw new TaskSetError('Task set changed; load the latest revision', 409);
  }
  return row;
}

export async function evaluationSource(
  ctx: AppContext,
  input: ComparisonInput,
): Promise<EvaluationSource | undefined> {
  if (!input.taskSet) return undefined;
  const row = await getTaskSet(ctx, input.taskSet.id);
  if (row.revision !== input.taskSet.revision || row.fingerprint !== taskFingerprint(input)) {
    throw new TaskSetError('Tasks changed; save or load a task set revision before running', 409);
  }
  return {
    id: row.id,
    name: row.content.name,
    revision: row.revision,
    fingerprint: row.fingerprint,
    reference: row.reference,
  };
}

export async function setReference(
  ctx: AppContext,
  id: string,
  revision: number,
  reportId: string | null,
) {
  const current = await getTaskSet(ctx, id);
  let reference: ReferenceRun | null = null;
  if (reportId) {
    const report = await comparisonRunner(ctx).get(reportId);
    if (
      report?.status !== 'completed' ||
      report.cells.some((cell) => !['passed', 'failed'].includes(cell.status))
    ) {
      throw new TaskSetError(
        'Finish every automatic check and manual review before setting a reference',
      );
    }
    if (report.evaluation?.id !== id || report.evaluation.fingerprint !== current.fingerprint) {
      throw new TaskSetError('Reference must use the same saved tasks and output limit');
    }
    reference = {
      id: report.id,
      name: report.name,
      createdAt: report.createdAt,
      models: report.models,
      cells: report.cells.map(({ caseIndex, modelId, status, costUsd, latencyMs }) => ({
        caseIndex,
        modelId,
        status,
        costUsd,
        latencyMs,
      })),
    };
  }
  const now = new Date();
  const { retentionDays } = await storageSettings(ctx);
  const [row] = await ctx.db
    .update(taskSets)
    .set({
      reference,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + retentionDays * 86_400_000),
    })
    .where(
      and(
        eq(taskSets.id, id),
        eq(taskSets.revision, revision),
        eq(taskSets.fingerprint, current.fingerprint),
        storageEnabled,
      ),
    )
    .returning();
  if (!row) throw new TaskSetError('Task set changed; load the latest revision', 409);
  return row;
}
