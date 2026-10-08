import { regressionReport } from './regressions.ts';
import type { ComparisonReport, TaskSetInput } from './types.ts';

export interface CIInput {
  taskSetId: string;
  revision: number;
  keyId: string;
  modelIds: string[];
  maxSpendUsd: number;
}

/** One explicit, bounded replay. Neither a reference nor a production profile is mutated. */
export async function runCI(
  base: string,
  cookie: string,
  input: CIInput,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  timeoutMs = 180_000,
) {
  if (
    !cookie ||
    !Number.isFinite(input.maxSpendUsd) ||
    input.maxSpendUsd < 0 ||
    input.maxSpendUsd > 50 ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    !input.keyId ||
    !input.taskSetId ||
    !Array.isArray(input.modelIds) ||
    input.modelIds.length < 2 ||
    input.modelIds.length > 4 ||
    new Set(input.modelIds).size !== input.modelIds.length
  )
    throw new Error('Invalid CI configuration or missing admin cookie');
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Use the gateway origin as the CI URL');
  const origin = url.origin;
  const deadline = Date.now() + timeoutMs;
  const request = async (path: string, body?: unknown, cancel = false) => {
    const response = await fetcher(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(cancel ? 5000 : Math.max(1, deadline - Date.now())),
    });
    if (!response.ok) throw new Error(`CI API request failed (HTTP ${response.status})`);
    return response.json();
  };
  const saved = (await request(`/admin/api/task-sets/${encodeURIComponent(input.taskSetId)}`)) as {
    revision: number;
    content: TaskSetInput;
    reference: unknown;
  };
  if (saved.revision !== input.revision || !saved.reference)
    throw new Error('Pin the current saved revision and choose a reference run before CI');
  if (saved.content.cases.some((task) => task.check === 'manual' && task.tools?.mode !== 'call'))
    throw new Error('CI requires automatic final-answer checks');
  const body = {
    ...saved.content,
    keyId: input.keyId,
    modelIds: input.modelIds,
    maxSpendUsd: input.maxSpendUsd,
    taskSet: { id: input.taskSetId, revision: input.revision },
  };
  const quote = (await request('/admin/api/comparisons/quote', body)) as {
    estimatedUsd: number | null;
  };
  if (
    quote.estimatedUsd === null ||
    !Number.isFinite(quote.estimatedUsd) ||
    quote.estimatedUsd > input.maxSpendUsd
  )
    throw new Error('CI estimate exceeds the explicit budget or is unknown');
  let report: ComparisonReport | undefined;
  try {
    report = (await request('/admin/api/comparisons', body)) as ComparisonReport;
    while (report.status === 'running') {
      if (Date.now() >= deadline) throw new Error('CI evaluation timed out');
      await new Promise((resolve) => setTimeout(resolve, 100));
      report = (await request(
        `/admin/api/comparisons/${encodeURIComponent(report.id)}`,
      )) as ComparisonReport;
    }
    const regression = regressionReport(report);
    const passed =
      report.status === 'completed' &&
      !report.unknownCosts &&
      report.spentUsd <= input.maxSpendUsd &&
      report.cells.length === input.modelIds.length * report.cases.length &&
      report.cells.every((cell) => cell.status === 'passed' && cell.costUsd !== null) &&
      !!regression &&
      regression.models.every(
        (model) =>
          !model.newModel &&
          model.compared === report!.cases.length &&
          !model.inconclusive &&
          !model.operationalFailures &&
          !model.regressions.length,
      );
    return {
      passed,
      reportId: report.id,
      status: report.status,
      spentUsd: report.spentUsd,
      unknownCosts: report.unknownCosts,
      regression,
    };
  } catch (error) {
    if (report?.status === 'running') {
      await request(
        `/admin/api/comparisons/${encodeURIComponent(report.id)}/cancel`,
        {},
        true,
      ).catch(() => {});
    }
    throw error;
  }
}
