import type { ProviderKind } from '../db/schema.ts';

export const CHECKS = ['manual', 'contains', 'exact', 'json'] as const;
export type Check = (typeof CHECKS)[number];

export interface ComparisonInput {
  name: string;
  keyId: string;
  modelIds: string[];
  system: string;
  maxSpendUsd: number;
  maxOutputTokens: number;
  cases: { name: string; prompt: string; check: Check; expected: string }[];
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
  | 'timeout';
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
  cases: { id: string; name: string; check: Check }[];
  cells: ComparisonCell[];
}
export type ComparisonSummary = Omit<ComparisonReport, 'cells' | 'cases' | 'models'> & {
  total: number;
  done: number;
};
