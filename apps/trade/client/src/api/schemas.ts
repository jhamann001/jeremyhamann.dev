import { z } from 'zod';

const holdingsSchema = z.object({
  cash: z.number(),
  fixed: z.number(),
  equity: z.number(),
});

const accountSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  accountNumber: z.string(),
  accountType: z.enum(['Taxable', 'Joint', 'Traditional IRA', 'Roth IRA']),
  balance: z.number(),
  holdings: holdingsSchema,
});

export const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
  accounts: z.array(accountSchema),
});

export const authUserSchema = z.object({
  id: z.string(),
  googleId: z.string().nullable(),
  email: z.string(),
  name: z.string(),
  picture: z.string().nullable(),
  role: z.enum(['advisor', 'trader']),
  slackUserId: z.string().nullable(),
  themePreference: z.enum(['light', 'dark', 'system']),
  isActive: z.boolean(),
  lastLogin: z.string().nullable(),
  createdAt: z.string(),
  demo: z.boolean().optional(),
  canDemo: z.boolean().optional(),
  outbox: z.boolean().optional(),
});

export const tradeRequestSchema = z
  .object({
    id: z.string(),
    clientId: z.string(),
    clientName: z.string(),
    clientIds: z.array(z.string()).optional(),
    clientNames: z.array(z.string()).optional(),
    advisor: z.string(),
    submittedBy: z.string().nullable().optional(),
    status: z.enum([
      'Pending Review',
      'Needs Info',
      'Pending Current Asset Liquidation',
      'Approved',
      'Rejected',
      'Completed',
    ]),
    tradeType: z.enum(['Initial Funding', 'Rebalance', 'Cash Deposit', 'Raise Cash', 'Liquidate']),
    tradeAmount: z.string(),
    depositAccount: z.string().nullable().default(null),
    rebalanceAll: z.boolean(),
    date: z.string(),
    updatedAt: z.string(),
    selectedAccounts: z.array(z.string()),
    totalValue: z.number(),
    priority: z.union([z.enum(['Urgent', 'Standard', 'Low']), z.literal('')]),
    advisorNotes: z.string().nullable().default(null),
    residence: z.enum(['NY', 'CA', 'Other']).nullable().default(null),
    liquidationApproval: z.string().nullable().default(null),
    advisorExclusions: z.string().nullable().default(null),
    clientExclusions: z.string().nullable().default(null),
    esgFilters: z
      .object({
        fossilFuels: z.boolean(),
        tobacco: z.boolean(),
        weapons: z.boolean(),
        alcohol: z.boolean(),
        gambling: z.boolean(),
        other: z.boolean(),
        otherDescription: z.string(),
        none: z.boolean(),
      })
      .nullable()
      .optional(),
    riskProfile: z.number().nullable().default(null),
    baseAllocation: z.object({ equity: z.number(), fixed: z.number(), cash: z.number() }).nullable().default(null),
    equityStrategies: z
      .array(
        z.object({
          id: z.number(),
          benchmark: z.string(),
          allocation: z.number(),
          rationale: z.string(),
        }),
      )
      .nullable()
      .default(null),
    raiseCashReason: z.string().nullable().default(null),
    liquidityDeadline: z.string().nullable().default(null),
    liquidateOption: z
      .union([z.enum(['Entire Account', 'Specific Positions']), z.literal('')])
      .nullable()
      .default(null),
    liquidatePositions: z.string().nullable().default(null),
    executionPlan: z.array(z.unknown()).nullable().default(null),
    accountMetadata: z.array(z.unknown()).nullable().default(null),
    householdId: z.number().int().positive().nullable().optional(),
    householdName: z.string().min(1).nullable().optional(),
    auditLog: z
      .array(
        z.object({
          id: z.string(),
          date: z.string(),
          user: z.string(),
          action: z.string(),
          notes: z.string(),
          channel: z.enum(['standalone', 'opsPortal']).default('standalone'),
        }),
      )
      .default([]),
  })
  .passthrough();

export const singleRequestResponseSchema = z.object({
  data: tradeRequestSchema,
});

export const paginatedRequestsSchema = z.object({
  data: z.array(tradeRequestSchema),
  nextCursor: z.string().nullable().optional(),
  truncated: z.boolean().optional(),
});

export const clientsResponseSchema = z.object({
  data: z.array(clientSchema),
});

export const usersResponseSchema = z.object({
  data: z.array(authUserSchema),
});

export const appConfigSchema = z.object({
  allowedDomains: z.array(z.string()),
  sessionTtlMs: z.number(),
});

export const serviceModeSchema = z.object({
  mode: z.enum(['active', 'frozen', 'mcp-only']),
});

export const notificationsListResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      message: z.string(),
      isRead: z.boolean(),
      date: z.string(),
      requestId: z.string().nullable().optional(),
    }),
  ),
  unreadCount: z.number().int(),
});

export const classifiedHoldingsResponseSchema = z.object({
  data: z.record(z.string(), 
    z.object({
      cash: z.number(),
      fixed: z.number(),
      equity: z.number(),
    }),
  ),
  source: z.string(),
});

const accountTypeSchema = z.enum(['Taxable', 'Joint', 'Traditional IRA', 'Roth IRA']);
const driftBucketSchema = z.enum(['cash', 'fixed', 'equity']);

export const householdSiblingHoldingSchema = z.object({
  accountId: z.string(),
  accountNumber: z.string().nullable(),
  accountTitle: z.string(),
  accountType: accountTypeSchema.nullable(),
  balance: z.number(),
  status: z.enum(['in', 'out', 'uninvested', 'no_template', 'negligible', 'template_invalid']).nullable(),
  positionCashPct: z.number().nullable(),
  positionFixedPct: z.number().nullable(),
  positionEquityPct: z.number().nullable(),
  templateCashPct: z.number().nullable(),
  templateFixedPct: z.number().nullable(),
  templateEquityPct: z.number().nullable(),
  maxBucketDeltaPct: z.number().nullable(),
  worstBucket: driftBucketSchema.nullable(),
  hasDrift: z.boolean(),
});

export const householdHoldingsResponseSchema = z.object({
  data: z.object({
    siblings: z.array(householdSiblingHoldingSchema),
    driftRunDate: z.string().nullable(),
  }),
  source: z.enum(['drift', 'demo', 'unavailable']),
});

export const lastAllocationSchema = z
  .object({
    riskProfile: z.number(),
    baseAllocation: z.object({ equity: z.number(), fixed: z.number(), cash: z.number() }),
    equityStrategies: z.array(
      z.object({
        id: z.number(),
        benchmark: z.string(),
        allocation: z.number(),
        rationale: z.string(),
      }),
    ),
  })
  .nullable();

export const mcpSessionSchema = z.object({
  familyId: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  registeredAt: z.string(),
  lastRefreshedAt: z.string(),
  lastAccessTokenAt: z.string().nullable(),
  refreshExpiresAt: z.string(),
});

export const mcpSessionsResponseSchema = z.object({
  data: z.array(mcpSessionSchema),
});

export const mcpPatMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export const mcpPatsResponseSchema = z.object({
  data: z.array(mcpPatMetadataSchema),
});

export const createMcpPatResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  token: z.string(),
  createdAt: z.string(),
});

// ─── Client exclusions (per-client standing list) ──────────────────────────

export const clientExclusionKindSchema = z.enum(['advisor', 'client']);

export const clientExclusionSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  ticker: z.string(),
  kind: clientExclusionKindSchema,
  reason: z.string(),
  // v3.4: structured DNB / DNS sides. Server backfills existing rows to
  // true/true (blanket); the schema accepts the boolean pair without
  // defaults so any server response missing these would fail validation
  // loudly rather than silently coercing.
  noBuy: z.boolean(),
  noSell: z.boolean(),
  createdByName: z.string(),
  createdAt: z.string(),
});

export const clientExclusionsListResponseSchema = z.object({
  data: z.array(clientExclusionSchema),
});

export const clientExclusionResponseSchema = z.object({
  data: clientExclusionSchema,
});

export const clientExclusionDeleteResponseSchema = z.object({
  data: z.object({ deleted: z.boolean() }),
});

export const bulkClientExclusionsResponseSchema = z.object({
  data: z.record(z.string(), z.array(clientExclusionSchema)),
});

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

export const clientExclusionsBatchResponseSchema = z.object({
  data: z.object({
    exclusions: z.array(clientExclusionSchema),
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    // v3.4: edited count. Older server revisions (v3.3) would omit this field
    // entirely; .default(0) keeps client validation green during a partial
    // rollout where v3.4 client code hits a v3.3 server.
    edited: z.number().int().min(0).default(0),
  }),
});

export const accountExclusionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  ticker: z.string(),
  kind: clientExclusionKindSchema,
  reason: z.string(),
  noBuy: z.boolean(),
  noSell: z.boolean(),
  createdByName: z.string(),
  createdAt: z.string(),
});

export const bulkAccountExclusionsResponseSchema = z.object({
  data: z.record(z.string(), z.array(accountExclusionSchema)),
});

export const accountExclusionsBatchResponseSchema = z.object({
  data: z.object({
    exclusions: z.array(accountExclusionSchema),
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    edited: z.number().int().min(0).default(0),
  }),
});

// ─── Registry drift dashboard ────────────────────────────────────────────────

export const driftCoverageStatusSchema = z.enum([
  'full',
  'partial',
  'engine_only',
  'meridian_only',
  'unmapped_account',
]);

export const driftAllowListReasonSchema = z.enum([
  'awaiting_mirror_mode',
  'awaiting_within_type_spread',
  'awaiting_per_account_risk',
]);

export const driftHistoryRowSchema = z.object({
  runDateLocal: z.string(),
  householdName: z.string(),
  maxDeltaPct: z.number(),
  breach: z.boolean(),
  coverageStatus: driftCoverageStatusSchema,
  schemaVersion: z.number(),
  snapshotSource: z.string(),
  snapshotAsOf: z.string().nullable(),
});

export const driftHistoryResponseSchema = z.object({
  days: z.number(),
  runs: z.array(driftHistoryRowSchema),
});

export const driftAllowListEntrySchema = z.object({
  householdName: z.string(),
  reason: driftAllowListReasonSchema,
  unblocksWhenPlanShips: z.string(),
  notes: z.string(),
});

export const driftAllowListResponseSchema = z.object({
  entries: z.array(driftAllowListEntrySchema),
});

/**
 * Loose validator for the JSONB `details` blob persisted by
 * `registryDriftRunner.ts:111-117`. The route forwards the JSONB as-is and
 * the v1 UI only consumes a tiny subset (`worstSymbol`, `accounts.length`).
 * `passthrough()` keeps the rest of the payload reachable without forcing
 * the schema to keep up with future additions to the runner's detail shape.
 */
export const driftRunDetailDetailsSchema = z
  .object({
    accountCount: z.number().optional(),
    worstSymbol: z.string().nullable().optional(),
    accounts: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const driftRunDetailSchema = driftHistoryRowSchema.extend({
  runStartedAt: z.string(),
  accountCount: z.number(),
  details: driftRunDetailDetailsSchema,
});

export const driftRunDetailResponseSchema = z.object({
  run: driftRunDetailSchema,
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

// Pre-approval checklist (per trade request)
export const checklistItemStateSchema = z.object({
  checked: z.boolean(),
  value: z.string().optional(),
  by: z.string().nullable().optional(),
  at: z.string().nullable().optional(),
});
export const preapprovalChecklistSchema = z.record(z.string(), checklistItemStateSchema);
export const checklistResponseSchema = z.object({ checklist: preapprovalChecklistSchema });

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

// ─── Household resolve (firm-of-record from active_accounts.json) ────────────

const householdResolutionAccountSchema = z.object({
  accountId: z.string(),
  accountNumber: z.string().nullable(),
  accountTitle: z.string(),
  clientId: z.string().nullable(),
  accountType: z.enum(['Taxable', 'Joint', 'Traditional IRA', 'Roth IRA']).nullable(),
  balance: z.number(),
});

const householdResolutionSchema = z.object({
  householdId: z.number().int().positive(),
  householdName: z.string(),
  accounts: z.array(householdResolutionAccountSchema),
  selectedAccountIds: z.array(z.string()),
  clientIds: z.array(z.string()),
});

export const householdResolveResponseSchema = z.object({
  data: z.object({
    households: z.array(householdResolutionSchema),
    unresolvedClientIds: z.array(z.string()),
    unresolvedAccountIds: z.array(z.string()),
  }),
});

// ─── Demo outbox ─────────────────────────────────────────────────────

export const outboxMessageSchema = z.object({
  id: z.string(),
  transport: z.enum(['slack', 'email']),
  destination: z.string(),
  destinationLabel: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
});
export type OutboxMessage = z.infer<typeof outboxMessageSchema>;

export const outboxResponseSchema = z.object({ data: z.array(outboxMessageSchema) });

// ─── Sign-in options (Google and/or the demo's personas) ─────────────────────

export const personaSchema = z.object({
  email: z.string(),
  name: z.string(),
  role: z.enum(['advisor', 'trader']),
  title: z.string(),
});
export type Persona = z.infer<typeof personaSchema>;

export const signInOptionsSchema = z.object({ google: z.boolean(), personas: z.array(personaSchema) });
export type SignInOptions = z.infer<typeof signInOptionsSchema>;
