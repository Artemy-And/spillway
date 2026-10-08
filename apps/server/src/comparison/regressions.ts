import type { ComparisonModel, ComparisonReport } from './types.ts';

function configuration(model: ComparisonModel) {
  return JSON.stringify([
    model.providerId,
    model.upstreamModel,
    model.providerKind,
    model.providerUrlHash,
    model.isLocal,
    model.inputPrice,
    model.outputPrice,
    model.cacheReadPrice,
  ]);
}

/** Match immutable task fingerprints and logical model IDs; unavailable answers are not quality failures. */
export function regressionReport(report: ComparisonReport) {
  const source = report.evaluation;
  const reference = source?.reference;
  if (!reference) return null;
  return {
    reference: { id: reference.id, name: reference.name, createdAt: reference.createdAt },
    taskSet: { id: source.id, name: source.name, revision: source.revision },
    models: report.models.map((model) => {
      const previous = reference.models.find((item) => item.id === model.id);
      let compared = 0;
      let improved = 0;
      let inconclusive = 0;
      let operationalFailures = 0;
      let previousCost = 0;
      let currentCost = 0;
      let costPairs = 0;
      let previousLatency = 0;
      let currentLatency = 0;
      let latencyPairs = 0;
      const regressions: { caseIndex: number; name: string }[] = [];
      for (const cell of report.cells.filter((item) => item.modelId === model.id)) {
        if (cell.status === 'error') operationalFailures++;
        const before = reference.cells.find(
          (item) => item.modelId === model.id && item.caseIndex === cell.caseIndex,
        );
        if (!before || !['passed', 'failed'].includes(before.status)) {
          inconclusive++;
          continue;
        }
        if (!['passed', 'failed'].includes(cell.status)) {
          inconclusive++;
          continue;
        }
        compared++;
        if (before.status === 'passed' && cell.status === 'failed')
          regressions.push({ caseIndex: cell.caseIndex, name: report.cases[cell.caseIndex]!.name });
        if (before.status === 'failed' && cell.status === 'passed') improved++;
        if (before.costUsd !== null && cell.costUsd !== null) {
          costPairs++;
          previousCost += before.costUsd;
          currentCost += cell.costUsd;
        }
        if (before.latencyMs !== null && cell.latencyMs !== null) {
          latencyPairs++;
          previousLatency += before.latencyMs;
          currentLatency += cell.latencyMs;
        }
      }
      return {
        modelId: model.id,
        label: model.label,
        newModel: !previous,
        configurationChanged: !!previous && configuration(previous) !== configuration(model),
        compared,
        improved,
        inconclusive,
        operationalFailures,
        regressions,
        cost: costPairs
          ? { pairs: costPairs, previousUsd: previousCost, currentUsd: currentCost }
          : null,
        latency: latencyPairs
          ? {
              pairs: latencyPairs,
              previousMs: previousLatency / latencyPairs,
              currentMs: currentLatency / latencyPairs,
            }
          : null,
      };
    }),
  };
}
