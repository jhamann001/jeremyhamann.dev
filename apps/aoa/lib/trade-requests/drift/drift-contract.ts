import type { AssetCategory } from '@/lib/trade-requests/sources/data/instruments';
import type { DriftCoverageStatus } from '@/lib/trade-requests/shared-types';

/** Schema version persisted with each drift run (unchanged value). */
export const REGISTRY_SCHEMA_VERSION = 1;

/** Default per-template tolerance for the weekday drift check (unchanged value). */
export const DEFAULT_TOLERANCE_PCT = 5.0;

export interface DriftAccountDetail {
  accountNumber: string;
  maxDeltaPct: number;
  worstSymbol: string | null;
  perSymbolDelta: Record<string, { engine?: number; positions?: number; meridian: number; delta: number }>;
  perBucketDelta: Partial<
    Record<AssetCategory, { engine?: number; positions?: number; meridian: number; delta: number }>
  >;
  coverage: 'both' | 'engine_only' | 'meridian_only' | 'positions_only' | 'template_only';
  flags: string[];
}

export interface DriftHouseholdResult {
  householdName: string;
  coverageStatus: DriftCoverageStatus;
  accountCount: number;
  maxDeltaPct: number;
  breach: boolean;
  worstSymbol: string | null;
  details: {
    accounts: DriftAccountDetail[];
    source?: 'meridian_only_unmapped';
  };
}

export interface DriftAlertResult {
  sent: boolean;
  alertingHouseholds: string[];
  suppressedAllowListed: string[];
}
