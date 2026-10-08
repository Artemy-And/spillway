import type { ProviderKind } from '../db/schema.ts';

export interface ModelFingerprint {
  name: string;
  providerId: string;
  providerKind: ProviderKind;
  providerUrlHash: string;
  upstreamModel: string;
  isLocal: boolean;
  inputPrice: number | null;
  outputPrice: number | null;
  cacheReadPrice: number | null;
}

/** Evidence is retained even after the source report expires. It contains no task text. */
export interface RoutingEvidence {
  mode?: 'text' | 'tools';
  toolContracts?: string[];
  comparisonName: string;
  caseCount: number;
  baselineLabel: string;
  candidateLabel: string;
  baselineCostUsd: number;
  candidateCostUsd: number;
  baseline: ModelFingerprint;
  candidate: ModelFingerprint;
}

export const ROUTING_OUTCOMES = ['selected', 'fallback', 'policy', 'skipped'] as const;
export type RoutingSkipReason = 'unsupported' | 'unavailable' | 'changed' | 'permission';
