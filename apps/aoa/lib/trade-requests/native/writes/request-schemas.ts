// Validation schemas ported verbatim from trade-request d41b6c9 server/src/routes/requests.ts:77-299 (ticket).
// Keep messages unchanged: they reach the user through the delegated error text.
import { z } from "zod";

// Zod 4's missing-value text is not the delegated "Required" line.
const requiredWhenMissing = {
  error: (issue: { input?: unknown }) => (issue.input === undefined ? "Required" : undefined),
};

const accountDataSchema = z.object({
  accountNumber: z.string().min(1, 'Account number is required').max(100),
  accountType: z.enum(['Taxable', 'Joint', 'Traditional IRA', 'Roth IRA']),
  balance: z.coerce.number().min(0, 'Balance cannot be negative'),
});

export const ALLOCATION_TRADE_TYPES = ['Initial Funding', 'Rebalance', 'Cash Deposit'] as const;

export const createRequestSchema = z
  .object({
    clientId: z.string(requiredWhenMissing).min(1).max(100),
    clientName: z.string(requiredWhenMissing).min(1).max(255),
    clientIds: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
    clientNames: z.array(z.string().min(1).max(255)).min(1).max(50).optional(),
    tradeType: z.enum(['Initial Funding', 'Rebalance', 'Cash Deposit', 'Raise Cash', 'Liquidate'], requiredWhenMissing),
    tradeAmount: z.string().max(100).default(''),
    depositAccount: z.string().max(100).default(''),
    rebalanceAll: z.boolean().default(false),
    selectedAccounts: z.array(z.string().max(100), requiredWhenMissing).min(1).max(50),
    priority: z.enum(['Urgent', 'Standard', 'Low'], requiredWhenMissing),
    advisorNotes: z.string().max(5000).default(''),
    residence: z.enum(['NY', 'CA', 'Other']).default('Other'),
    liquidationApproval: z.enum(['Yes', 'No', '']).default(''),
    advisorExclusions: z.string().max(2000).default(''),
    clientExclusions: z.string().max(2000).default(''),
    esgFilters: z
      .object({
        fossilFuels: z.boolean(),
        tobacco: z.boolean(),
        weapons: z.boolean(),
        alcohol: z.boolean(),
        gambling: z.boolean(),
        other: z.boolean().default(false),
        otherDescription: z.string().max(500).default(''),
        none: z.boolean(),
      })
      .default({
        fossilFuels: false,
        tobacco: false,
        weapons: false,
        alcohol: false,
        gambling: false,
        other: false,
        otherDescription: '',
        none: true,
      }),
    riskProfile: z.number().int().min(1).max(25).nullable().default(null),
    equityStrategies: z
      .array(
        z.object({
          id: z.coerce.number(),
          benchmark: z.string().max(255),
          allocation: z.coerce.number().min(0).max(100),
          rationale: z.string().max(5000),
        }),
      )
      .max(3)
      .default([]),
    raiseCashReason: z.string().max(2000).default(''),
    liquidityDeadline: z
      .string()
      .refine((val) => !val || !isNaN(new Date(val).getTime()), {
        message: 'liquidityDeadline must be a valid date string',
      })
      .nullable()
      .default(null),
    liquidateOption: z.enum(['Entire Account', 'Specific Positions', '']).default(''),
    liquidatePositions: z.string().max(2000).default(''),
    accountsData: z.array(accountDataSchema).optional(),
    manualEntry: z.boolean().optional(),
    manualAccounts: z.array(accountDataSchema).optional(),
    idempotencyKey: z.string().uuid().optional(),
    assetLocationMode: z.enum(['priority', 'mirror']).default('priority'),
    // Decision log #5: persisted only at submit time when the resolved
    // selection lives in a single firm household, otherwise both null.
    // `createRequestSchema` is shared between POST and PUT; the PUT
    // handler (`requests.ts:956`) deliberately omits these from its
    // UPDATE so the submit-time tag is immutable after creation.
    householdId: z.number().int().positive().nullable().optional(),
    householdName: z.string().min(1).max(255).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    const isFullForm = (ALLOCATION_TRADE_TYPES as readonly string[]).includes(data.tradeType);

    if (isFullForm) {
      if (data.riskProfile == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Risk profile is required for this trade type',
          path: ['riskProfile'],
        });
      }
      if (!data.residence) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Residence is required for this trade type',
          path: ['residence'],
        });
      }
      if (!data.liquidationApproval) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Liquidation approval is required for this trade type',
          path: ['liquidationApproval'],
        });
      }
      if (data.equityStrategies.length > 0) {
        const totalAlloc = data.equityStrategies.reduce((sum, s) => sum + s.allocation, 0);
        if (Math.abs(totalAlloc - 100) > 0.01) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Equity strategy allocations must sum to 100% (got ${totalAlloc}%)`,
            path: ['equityStrategies'],
          });
        }
        for (let i = 0; i < data.equityStrategies.length; i++) {
          if (!data.equityStrategies[i].benchmark.trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Each equity strategy must have a benchmark',
              path: ['equityStrategies', i, 'benchmark'],
            });
          }
        }
      }
      if (data.tradeType === 'Cash Deposit') {
        if (!data.tradeAmount) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Deposit amount is required', path: ['tradeAmount'] });
        }
        if (!data.depositAccount) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Deposit account is required',
            path: ['depositAccount'],
          });
        }
      }
    }

    if (data.tradeType === 'Raise Cash') {
      if (!data.tradeAmount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Cash amount is required for Raise Cash',
          path: ['tradeAmount'],
        });
      }
      if (!data.raiseCashReason.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Reason is required for Raise Cash',
          path: ['raiseCashReason'],
        });
      }
    }

    if (data.tradeType === 'Liquidate') {
      if (!data.liquidateOption) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Liquidation option is required',
          path: ['liquidateOption'],
        });
      }
      if (data.liquidateOption === 'Specific Positions' && !data.liquidatePositions.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Positions to liquidate must be specified',
          path: ['liquidatePositions'],
        });
      }
    }

    if (data.clientIds && !data.clientNames) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clientNames is required when clientIds is provided',
        path: ['clientNames'],
      });
    }
    if (!data.clientIds && data.clientNames) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clientIds is required when clientNames is provided',
        path: ['clientIds'],
      });
    }
    if (data.clientIds && data.clientNames && data.clientIds.length !== data.clientNames.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clientIds and clientNames must have the same length',
        path: ['clientNames'],
      });
    }
  });

export type CreateRequestBody = z.infer<typeof createRequestSchema>;

export const updateStatusSchema = z.object({
  status: z.enum([
    'Pending Review',
    'Needs Info',
    'Pending Current Asset Liquidation',
    'Approved',
    'Rejected',
    'Completed',
  ]),
  note: z.string().max(2000).default(''),
  expectedUpdatedAt: z
    .string()
    .refine((val) => !isNaN(new Date(val).getTime()), { message: 'expectedUpdatedAt must be a valid ISO timestamp' }),
});

const isoTimestamp = z.string().refine((val) => !isNaN(new Date(val).getTime()), {
  message: 'expectedUpdatedAt must be a valid ISO timestamp',
});

// Resubmission's optimistic-concurrency token. Required on the AOA
// channel; optional on standalone sessions, whose client does not send it.
export const delegatedResubmitConcurrencySchema = z.object({ expectedUpdatedAt: isoTimestamp });

export const paramId = z.string().min(1, 'ID is required').max(50, 'ID is too long');
