import type { ProviderKind } from '../db/schema.ts';

export const CHECKS = ['manual', 'contains', 'exact', 'json'] as const;
export type Check = (typeof CHECKS)[number];

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: string;
}
export interface ToolStep {
  name: string;
  arguments: string;
  result: string;
}
export interface ToolScenario {
  mode: 'call' | 'loop';
  definitions: ToolDefinition[];
  steps: ToolStep[];
}
export interface ComparisonCase {
  name: string;
  prompt: string;
  check: Check;
  expected: string;
  tools?: ToolScenario;
}

export interface ComparisonInput {
  name: string;
  keyId: string;
  modelIds: string[];
  system: string;
  maxSpendUsd: number;
  maxOutputTokens: number;
  cases: ComparisonCase[];
  taskSet?: { id: string; revision: number };
}
export type TaskSetInput = Pick<ComparisonInput, 'name' | 'system' | 'maxOutputTokens' | 'cases'>;
export interface ReferenceRun {
  id: string;
  name: string;
  createdAt: string;
  models: ComparisonModel[];
  cells: Pick<ComparisonCell, 'caseIndex' | 'modelId' | 'status' | 'costUsd' | 'latencyMs'>[];
}
export interface EvaluationSource {
  id: string;
  name: string;
  revision: number;
  fingerprint: string;
  reference: ReferenceRun | null;
}
export interface ComparisonModel {
  id: string;
  name: string;
  label: string;
  provider: string;
  providerId: string;
  upstreamModel: string;
  isLocal: boolean;
  inputPrice: number | null;
  outputPrice: number | null;
  /** Older reports can be read but need a new run before activating a routing profile. */
  providerKind?: ProviderKind;
  providerUrlHash?: string;
  cacheReadPrice?: number | null;
}
export type CellStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'review'
  | 'error'
  | 'skipped';
export type Reason =
  | 'manual'
  | 'matched'
  | 'mismatch'
  | 'invalidJson'
  | 'truncated'
  | 'noText'
  | 'budget'
  | 'unknownCost'
  | 'rerouted'
  | 'policy'
  | 'upstream'
  | 'cancelled'
  | 'interrupted'
  | 'unavailable'
  | 'timeout'
  | 'toolMissing'
  | 'toolUnexpected'
  | 'toolArguments'
  | 'toolSequence';
export interface ComparisonToolStep {
  index: number;
  phase: 'call' | 'final';
  status: CellStatus;
  reason: Reason | null;
  toolName: string | null;
  requestId: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
}
export interface ComparisonCell {
  caseIndex: number;
  modelId: string;
  status: CellStatus;
  reason: Reason | null;
  output: string | null;
  outputTruncated: boolean;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  requestId: string | null;
  servedModel: string | null;
  httpStatus: number | null;
  toolSteps?: ComparisonToolStep[];
}
export interface ComparisonReport {
  id: string;
  name: string;
  keyId: string;
  keyName: string;
  status: 'running' | 'completed' | 'cancelled' | 'interrupted';
  createdAt: string;
  finishedAt: string | null;
  maxSpendUsd: number;
  estimatedUsd: number;
  spentUsd: number;
  unknownCosts: boolean;
  maxOutputTokens: number;
  storesOutputs: boolean;
  models: ComparisonModel[];
  cases: {
    id: string;
    name: string;
    check: Check;
    toolMode?: ToolScenario['mode'];
    toolContractHash?: string;
  }[];
  cells: ComparisonCell[];
  evaluation?: EvaluationSource;
}
export type ComparisonSummary = Omit<ComparisonReport, 'cells' | 'cases' | 'models'> & {
  total: number;
  done: number;
};
