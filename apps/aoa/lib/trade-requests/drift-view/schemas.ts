// Ported verbatim from trade-request d41b6c9 client/src/api/schemas.ts lines 283-305, 354-358, 376-385,
// 412-425 and 437-634 (ticket): response validation for the Drift screens.
import { z } from "zod";

/**
 * Firm-wide exclusions export. Client- and account-level rows share one shape;
 * `scope` says which. The name/number fields are best-effort enrichment and can
 * legitimately be empty, so they're plain strings with no min length.
 */
export const exclusionExportResponseSchema = z.object({
  data: z.array(
    z.object({
      scope: z.enum(['client', 'account']),
      clientId: z.string(),
      clientName: z.string(),
      accountId: z.string(),
      accountNumber: z.string(),
      ticker: z.string(),
      kind: z.enum(['advisor', 'client']),
      reason: z.string(),
      noBuy: z.boolean(),
      noSell: z.boolean(),
      createdByName: z.string(),
      createdAt: z.string(),
    }),
  ),
});

export const driftAllowListReasonSchema = z.enum([
  'awaiting_mirror_mode',
  'awaiting_within_type_spread',
  'awaiting_per_account_risk',
]);

export const driftAllowListEntrySchema = z.object({
  householdName: z.string(),
  reason: driftAllowListReasonSchema,
  unblocksWhenPlanShips: z.string(),
  notes: z.string(),
});

export const driftAllowListResponseSchema = z.object({
  entries: z.array(driftAllowListEntrySchema),
});

// ─── Drift v2 (per-account) ─────────────────────────────────────────────────

// `negligible` (R1, <=$5) and `template_invalid` (R2, template sum != 100%)
// are non-actionable data-quality lanes — keep in lockstep with the
// `AccountDriftStatus` union in @trade-request/shared.
export const accountDriftStatusSchema = z.enum([
  'in',
  'out',
  'uninvested',
  'no_template',
  'negligible',
  'template_invalid',
]);
export const accountDriftCoverageSchema = z.enum(['both', 'positions_only', 'template_only', 'unmapped']);

// Manual, sticky, per-account status override (human-judgment acceptance).
export const driftOverrideReasonSchema = z.enum([
  'asset_location',
  'tax_constraint',
  'active_transition',
  'intentional_cash',
  'concentrated_position',
  'template_error',
  'direct_index_noise',
  'other',
]);

export const accountDriftOverrideSchema = z.object({
  reason: driftOverrideReasonSchema,
  note: z.string(),
  expiresOn: z.string().nullable(),
  setByName: z.string(),
  setAt: z.string(),
});

// ─── Cost-basis tax layer ───────────────────────────────────────────────────

export const costBasisFreshnessSummarySchema = z.object({
  level: z.enum(['ok', 'warn', 'critical', 'missing']),
  fullProcessDate: z.string().nullable(),
  fullAgeDays: z.number().nullable(),
  dailyProcessDate: z.string().nullable(),
  dailyAgeDays: z.number().nullable(),
  pipelineLatest: z.string().nullable(),
  pipelineAgeDays: z.number().nullable(),
  message: z.string(),
});

export const symbolTaxDetailSchema = z.object({
  symbol: z.string(),
  marketValueUsd: z.number(),
  costBasisUsd: z.number(),
  unrealizedGainUsd: z.number(),
  unrealizedShortTermGainUsd: z.number(),
  unrealizedLongTermGainUsd: z.number(),
  transferInPct: z.number(),
  hasMissingBasis: z.boolean(),
});

export const accountTaxSummarySchema = z.object({
  investableValueUsd: z.number(),
  basisCoveragePct: z.number(),
  cashEquivalentValueUsd: z.number().optional(),
  unrealizedGainUsd: z.number(),
  unrealizedShortTermGainUsd: z.number(),
  unrealizedLongTermGainUsd: z.number(),
  transferInValueUsd: z.number(),
  transferInPct: z.number(),
  hasMissingBasis: z.boolean(),
  transitionCandidate: z.boolean(),
  transitionConfirmed: z.boolean().optional(),
  transitionTargetName: z.string().nullable().optional(),
  transitionEstRealizedGainUsd: z.number().nullable().optional(),
  transitionUpdatedAt: z.string().nullable().optional(),
  realizedGainYtdUsd: z.number().optional(),
  realizedShortTermYtdUsd: z.number().optional(),
  realizedLongTermYtdUsd: z.number().optional(),
  symbols: z.array(symbolTaxDetailSchema),
});

export const accountDriftHistoryRowSchema = z.object({
  runDateLocal: z.string(),
  accountId: z.string(),
  accountTitle: z.string(),
  householdName: z.string(),
  status: accountDriftStatusSchema,
  worstBucket: z.enum(['cash', 'fixed', 'equity']).nullable(),
  // `null` ONLY for `status === 'no_template'` rows.
  maxBucketDeltaPct: z.number().nullable(),
  symbolBreachCount: z.number(),
  totalValueUsd: z.number(),
  coverage: accountDriftCoverageSchema,
  snapshotSource: z.string(),
  snapshotAsOf: z.string().nullable(),
  schemaVersion: z.number(),
  // Cost-basis tax layer (optional — present once the feed is wired).
  unrealizedGainUsd: z.number().nullable().optional(),
  realizedGainYtdUsd: z.number().nullable().optional(),
  transferInPct: z.number().nullable().optional(),
  taxable: z.boolean().nullable().optional(),
  templateName: z.string().nullable().optional(),
  templateTotalPct: z.number().nullable().optional(),
  transitionCandidate: z.boolean().optional(),
  transitionConfirmed: z.boolean().optional(),
  costBasisFreshness: costBasisFreshnessSummarySchema.nullable().optional(),
  override: accountDriftOverrideSchema.nullable().optional(),
});

export const setDriftOverrideResponseSchema = z.object({
  accountId: z.string(),
  override: accountDriftOverrideSchema,
});

export const accountDriftHistoryResponseSchema = z.object({
  days: z.number(),
  runs: z.array(accountDriftHistoryRowSchema),
});

const accountDriftBucketSchema = z.object({
  positionPct: z.number(),
  templatePct: z.number(),
  deltaPct: z.number(),
});

export const sectorAllocationSchema = z.object({
  slices: z.array(
    z.object({
      label: z.string(),
      kind: z.enum(['sector', 'assetClass', 'unclassified']),
      pct: z.number(),
    }),
  ),
  classifiedPct: z.number(),
  unclassifiedPct: z.number(),
});
export type SectorAllocation = z.infer<typeof sectorAllocationSchema>;

const accountDriftSymbolDetailSchema = z.object({
  symbol: z.string(),
  bucket: z.enum(['cash', 'fixed', 'equity']),
  positionPct: z.number(),
  targetPct: z.number().optional(),
  deltaPct: z.number().optional(),
  breach: z.boolean().optional(),
});

export const accountDriftDetailsSchema = z
  .object({
    buckets: z.object({
      cash: accountDriftBucketSchema,
      fixed: accountDriftBucketSchema,
      equity: accountDriftBucketSchema,
    }),
    symbolsWithTargets: z.array(accountDriftSymbolDetailSchema),
    equityHoldings: z.array(z.object({ symbol: z.string(), positionPct: z.number() })),
    positionOnlySymbols: z.array(
      z.object({
        symbol: z.string(),
        bucket: z.enum(['cash', 'fixed', 'equity']),
        positionPct: z.number(),
      }),
    ),
    suspectedCashEquivMisclassified: z.array(z.string()),
    notes: z.string().optional(),
    tax: accountTaxSummarySchema.optional(),
    costBasisFreshness: costBasisFreshnessSummarySchema.optional(),
    sectorAllocation: sectorAllocationSchema.optional(),
  })
  .passthrough();

export const accountDriftRunRowSchema = accountDriftHistoryRowSchema.extend({
  details: accountDriftDetailsSchema,
});

export const accountDriftRunResponseSchema = z.object({
  runDateLocal: z.string(),
  runStartedAt: z.string(),
  snapshotSource: z.string(),
  snapshotAsOf: z.string().nullable(),
  tolerancePct: z.number(),
  uninvestedCashThresholdPct: z.number(),
  accounts: z.array(accountDriftRunRowSchema),
});

export const exclusionOverlapCountsSchema = z.object({
  actionable: z.number(),
  locked_blanket: z.number(),
  locked_dnb_under: z.number(),
  locked_dns_over: z.number(),
  sign_mismatch_unlocked: z.number(),
});

export const exclusionOverlapAccountSummarySchema = z.object({
  accountId: z.string(),
  accountTitle: z.string(),
  household: z.string(),
  status: accountDriftStatusSchema,
  maxDelta: z.number().nullable(),
  breachCount: z.number(),
  lockedCount: z.number(),
});

export const exclusionOverlapReportSchema = z.object({
  runDateLocal: z.string(),
  totalAccounts: z.number(),
  outAccounts: z.number(),
  totalExclusions: z.number(),
  totalBreaches: z.number(),
  lockedTotal: z.number(),
  lockedSharePct: z.number(),
  counts: exclusionOverlapCountsSchema,
  worstAccounts: z.array(exclusionOverlapAccountSummarySchema),
});
