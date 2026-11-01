import { z } from "zod";
import { normalizeDateToIso, normalizeMoneyStringExact } from "./format";
import { normalizeDtccNumber } from "./dtcc-suggestion";
import { CLIENT_SEARCH_MAX_LENGTH, CLIENT_SEARCH_MIN_LENGTH, CLIENT_SEARCH_MAX_RESULTS, CLIENT_IDENTITY_REASON_MAX_LENGTH, CLIENT_IDENTITY_MAX_CLIENTS } from "./client-identity-contract";

// Free-text length caps. Rationale:
//   - 2000 chars for true long-form fields (notes, memos, reasons). Big
//     enough for a paragraph or two; small enough to cap DB bloat and
//     response payloads.
//   - 500 chars for ticket / resource links (multiple URLs fit).
//   - 120 chars for everything else (short labels, identifiers, enums
//     delivered as strings).
const LONG_TEXT_MAX = 2000;
const MID_TEXT_MAX = 500;
const SHORT_TEXT_MAX = 120;

const shortStr = z.string().max(SHORT_TEXT_MAX);
const midStr = z.string().max(MID_TEXT_MAX);
const longStr = z.string().max(LONG_TEXT_MAX);
const dateStr = shortStr
  .refine((value) => !value.trim() || normalizeDateToIso(value) != null, "Use a valid date")
  .transform((value) => value.trim() ? normalizeDateToIso(value)! : "");
const moneyStr = shortStr
  .refine((value) => !value.trim() || normalizeMoneyStringExact(value) != null, "Use a valid dollar amount")
  .transform((value) => value.trim() ? normalizeMoneyStringExact(value)! : "");
const dtccStr = shortStr
  .refine((value) => !value.trim() || normalizeDtccNumber(value) != null, "DTC number must contain up to four digits")
  .transform((value) => value.trim() ? normalizeDtccNumber(value)! : "");
const httpUrl = midStr
  .url("Must be a valid URL")
  .refine((url) => /^https?:\/\//i.test(url), {
    message: "Must start with http:// or https://",
  });

const transferWorkflow = z.enum([
  "ACAT",
  "MANUAL",
  "DRS",
  "RESIDUAL",
  "UNCLASSIFIED",
]);

const TOO_MANY = Symbol("too many items");

/**
 * An array schema that checks the length before the items. Zod checks every item first and records an
 * issue for each one before `.max()` runs, so an oversized array of bad values costs memory in proportion
 * to its length: 100,000 items made 100,001 issues and about 70 MB.
 */
export function boundedArray<T extends z.ZodType>(item: T, max: number, min = 0) {
  return z.preprocess(
    (value) => (Array.isArray(value) && value.length > max ? TOO_MANY : value),
    z.array(item, { error: (issue) => (issue.input === TOO_MANY ? `Too many items: at most ${max}` : undefined) }).min(min).max(max)
  );
}

export const cedarRidgeUserIdSchema = z.string().regex(/^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "Use a valid Cedar Ridge user ID");
export const cedarRidgeUserIdsSchema = boundedArray(cedarRidgeUserIdSchema, CLIENT_IDENTITY_MAX_CLIENTS, 1)
  .refine((ids) => new Set(ids).size === ids.length, "Select each person only once");
const identityVersionSchema = z.number().int().min(0).max(2147483647);

/** Old single-person callers remain readable; plural requests are authoritative. */
export function requestedClientIds(input: { cedarRidgeUserId?: string; cedarRidgeUserIds?: string[] }): string[] {
  return input.cedarRidgeUserIds ? [...input.cedarRidgeUserIds].sort() : input.cedarRidgeUserId ? [input.cedarRidgeUserId] : [];
}

export const clientSearchSchema = z.object({
  query: z.string().trim().min(CLIENT_SEARCH_MIN_LENGTH).max(CLIENT_SEARCH_MAX_LENGTH),
  limit: z.number().int().min(1).max(CLIENT_SEARCH_MAX_RESULTS).optional(),
}).strict();

export const clientIdentityRelinkSchema = z.object({
  cedarRidgeUserId: cedarRidgeUserIdSchema.optional(),
  cedarRidgeUserIds: cedarRidgeUserIdsSchema.optional(),
  expectedIdentityVersion: identityVersionSchema,
  reason: z.string().trim().min(1).max(CLIENT_IDENTITY_REASON_MAX_LENGTH),
  apexAccountId: shortStr.transform((value) => value.trim()).optional(),
  replaceDisplayName: z.boolean().default(false),
  acknowledgeMappingInvalidation: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.cedarRidgeUserId) === Boolean(value.cedarRidgeUserIds)) {
    ctx.addIssue({ code: "custom", path: ["cedarRidgeUserIds"], message: "Supply exactly one client selection format" });
  }
});

export const createAcatSchema = z.object({
  cedarRidgeUserId: cedarRidgeUserIdSchema.optional(),
  cedarRidgeUserIds: cedarRidgeUserIdsSchema.optional(),
  clientName: shortStr.default(""),
  apexAccountId: shortStr.default(""),
  acatTransferId: shortStr.optional(),
  accountType: shortStr.optional(),
  additionalResources: longStr.optional(),
  apexCompletionDate: dateStr.optional(),
  apexTicket: shortStr.optional(),
  associatedControlNumber: shortStr.optional(),
  controlNumber: shortStr.optional(),
  dtccNumber: dtccStr.optional(),
  direction: shortStr.optional(),
  crwEe: shortStr.optional(),
  feeAmount: moneyStr.optional(),
  feeCharged: shortStr.optional(),
  feeMemo: longStr.optional(),
  feeRequestCompleted: dateStr.optional(),
  feeRequestSubmitted: dateStr.optional(),
  feeApexTicket: shortStr.optional(),
  feeCreditRequestId: shortStr.optional(),
  methodRequested: shortStr.optional(),
  transferWorkflow: transferWorkflow.optional(),
  notes: longStr.optional(),
  opsSubmissionDateToApex: dateStr.optional(),
  originalClientRequestDate: dateStr.optional(),
  residualMonitoringRequired: z.boolean().optional(),
  residualFollowUpDate: dateStr.optional(),
  crmTicket: midStr.optional(),
  rejectionReason: longStr.optional(),
  statementAccountNumber: shortStr.optional(),
  // Negatives are valid: an ACAT Out / transfer reduces the account, so the
  // statement amount can be entered as a negative figure.
  statementAmount: z.number().int().optional(),
  status: z.enum(["WaitingForApex", "PendingAccountOpening", "WaitingOnClient", "WaitingForStatement", "AcatReceived", "ToCome", "Submitted", "PendingReview", "PendingContraResponse", "Accepted", "PendingSettlement", "PendingBookkeeping", "Completed", "Rejected", "Purged", "Canceled", "Deferred"]).optional(),
  transferringContra: shortStr.optional(),
  tradeRequestId: shortStr.optional(),
  tradeRequestUrl: httpUrl.optional(),
  tradeInstructions: longStr.optional(),
  type: shortStr.optional(),
  wealthAdvisor: shortStr.optional(),

  // Legacy fields
  crmDealId: shortStr.optional(),
  custodianId: shortStr.optional(),
  custodianName: shortStr.optional(),
  acatDate: dateStr.optional(),
}).superRefine((value, ctx) => {
  if (value.cedarRidgeUserId && value.cedarRidgeUserIds) {
    ctx.addIssue({ code: "custom", path: ["cedarRidgeUserIds"], message: "Supply exactly one client selection format" });
  }
  const selected = requestedClientIds(value);
  if (!selected.length && !value.clientName.trim()) {
    ctx.addIssue({ code: "custom", path: ["clientName"], message: "Client name is required" });
  }
  if ((!selected.length || selected.length > 1) && !value.apexAccountId.trim()) {
    ctx.addIssue({ code: "custom", path: ["apexAccountId"], message: "Apex account ID is required" });
  }
});

// Fields a logged-in USER may update via PATCH /api/acats/[id].
//
// Excluded intentionally (system-managed / must not be client-settable):
//   deletedAt, createdAt, updatedAt, id, mappingSource, custodianId,
//   custodianName, slackAlerted.
//
// ticket: `slackAlerted` was previously the toggle behind the "Flag
// to CS Slack" button — that workflow is replaced by the daily digest
// (see /api/cron/daily-digest), so the field is no longer writable
// from the UI. The schema column is kept for historical data.
// Included but constrained:
//   apexSource    -> narrow enum; set to "Uploaded" by the SecurityReconTab
//                    flow after a successful CSV reconciliation.
//
// `.strict()` (no `.catchall`) makes the schema reject any unknown key so
// mass-assignment attacks cannot smuggle them in.
export const updateAcatSchema = z
  .object({
    expectedIdentityVersion: identityVersionSchema.optional(),
    clientName: z.string().min(1).max(SHORT_TEXT_MAX).optional(),
    apexAccountId: shortStr.optional(),
    acatTransferId: shortStr.optional().nullable(),
    accountType: shortStr.optional().nullable(),
    additionalResources: longStr.optional().nullable(),
    apexCompletionDate: dateStr.optional().nullable(),
    apexTicket: shortStr.optional().nullable(),
    associatedControlNumber: shortStr.optional().nullable(),
    controlNumber: shortStr.optional().nullable(),
    dtccNumber: dtccStr.optional().nullable(),
    direction: shortStr.optional().nullable(),
    crwEe: shortStr.optional().nullable(),
    feeAmount: moneyStr.optional().nullable(),
    feeCharged: shortStr.optional().nullable(),
    feeMemo: longStr.optional().nullable(),
    feeRequestCompleted: dateStr.optional().nullable(),
    feeRequestSubmitted: dateStr.optional().nullable(),
    feeApexTicket: shortStr.optional().nullable(),
    feeCreditRequestId: shortStr.optional().nullable(),
    methodRequested: shortStr.optional().nullable(),
    transferWorkflow: transferWorkflow.optional(),
    notes: longStr.optional().nullable(),
    opsSubmissionDateToApex: dateStr.optional().nullable(),
    originalClientRequestDate: dateStr.optional().nullable(),
    residualMonitoringRequired: z.boolean().optional(),
    residualFollowUpDate: dateStr.optional().nullable(),
    crmTicket: midStr.optional().nullable(),
    rejectionReason: longStr.optional().nullable(),
    statementAccountNumber: shortStr.optional().nullable(),
    // Negatives are valid for ACAT Out / transfers (see createAcatSchema).
    statementAmount: z.number().int().nullable().optional(),
    status: z.enum(["WaitingForApex", "PendingAccountOpening", "WaitingOnClient", "WaitingForStatement", "AcatReceived", "ToCome", "Submitted", "PendingReview", "PendingContraResponse", "Accepted", "PendingSettlement", "PendingBookkeeping", "Completed", "Rejected", "Purged", "Canceled", "Deferred", "Matched", "Mismatch", "Pending"]).optional(),
    transferringContra: shortStr.optional().nullable(),
    tradeRequestId: shortStr.optional().nullable(),
    tradeRequestUrl: httpUrl.optional().nullable(),
    tradeInstructions: longStr.optional().nullable(),
    type: shortStr.optional().nullable(),
    wealthAdvisor: shortStr.optional().nullable(),
    // Editable from the UI. `.nullable()` lets the client clear the field
    // (sends explicit `null`); the PATCH handler coerces null back to "" since
    // the column is NOT NULL with a default of "" in Prisma.
    crmDealId: shortStr.optional().nullable(),
    acatDate: dateStr.optional(),
    apexSource: z.enum(["Uploaded", "Pending Upload"]).optional(),
    // Set server-side by the recon auto-complete logic. Accepting it on
    // the wire is intentional so the SecurityReconTab "Save Recon Results"
    // flow can clear or stamp it directly when the heuristic short-circuits
    // (e.g. user manually overrode rows to bring the rate above 90%).
    reconCompletedAt: shortStr.optional().nullable(),
  })
  .strict();

// Exported so the PATCH handler can use it as an allow-list when writing to
// Prisma (defense in depth on top of `.strict()`).
export const UPDATE_ACAT_ALLOWED_FIELDS = Object.freeze(
  Object.keys(updateAcatSchema.shape).filter((key) => key !== "expectedIdentityVersion")
) as readonly (keyof typeof updateAcatSchema.shape)[];

export const dataQualityReviewSchema = z
  .object({
    acatRecordId: shortStr.min(1),
    ruleKey: shortStr.min(1),
    fingerprint: midStr.min(1),
    status: z.enum(["OPEN", "IN_REVIEW", "CLOSED"]),
    resolution: z
      .enum([
        "CORRECTED",
        "RESOLVED_MANUALLY",
        "FALSE_POSITIVE",
        "NOT_APPLICABLE",
        "ACKNOWLEDGED_UNRESOLVED",
        "DUPLICATE",
      ])
      .optional()
      .nullable(),
    note: longStr.optional().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "CLOSED" && !value.resolution) {
      ctx.addIssue({ code: "custom", path: ["resolution"], message: "Resolution is required when closing an exception" });
    }
    if (
      ["FALSE_POSITIVE", "ACKNOWLEDGED_UNRESOLVED"].includes(value.resolution ?? "") &&
      !value.note?.trim()
    ) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "A note is required for this resolution" });
    }
  });

// Schemas for the `assets` / `newAssets` arrays in PATCH /api/acats/[id].
//
// `updateAssetSchema` validates patches to existing rows; `id` is required so
// the route can authorize each entry against the parent ACAT before writing.
// `createAssetSchema` validates new positions the user opted to materialize
// from the recon screen (typically Apex-only "Unexpected" rows the GCP sync
// didn't know about). `expectedQty` defaults to 0 because, by definition,
// there's no expectation for these rows; ops is recording what showed up.
const mapStatusEnum = z.enum(["Mapped", "Unmapped", "Pending", "Expected"]);

export const updateAssetSchema = z
  .object({
    id: z.string().min(1).max(SHORT_TEXT_MAX),
    actualQty: z.number().finite().optional(),
    mapStatus: mapStatusEnum.optional(),
    issue: longStr.optional().nullable(),
    notes: longStr.optional().nullable(),
  })
  .strict();

export const createAssetSchema = z
  .object({
    symbol: z.string().trim().min(1).max(SHORT_TEXT_MAX),
    description: z.string().max(SHORT_TEXT_MAX).default(""),
    cusip: shortStr.optional().nullable(),
    expectedQty: z.number().finite().min(0).default(0),
    actualQty: z.number().finite().default(0),
    mapStatus: mapStatusEnum.default("Unmapped"),
    issue: longStr.optional().nullable(),
    notes: longStr.optional().nullable(),
    amount: z.number().finite().optional().nullable(),
    assetClass: shortStr.optional().nullable(),
  })
  .strict();

export const deleteAcatSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Reason must be at least 3 characters")
    .max(500, "Reason must be 500 characters or fewer"),
});

export const restoreAcatSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500, "Reason must be 500 characters or fewer")
    .optional(),
});

export const createFeeSchema = z.object({
  clientName: z.string().min(1, "Client name is required").max(SHORT_TEXT_MAX),
  feeAmount: z.coerce.number().positive("Fee amount must be positive"),
  accountNumber: z.string().min(1, "Account number is required").max(SHORT_TEXT_MAX),
  clientUserId: shortStr.optional().nullable(),
  feeType: shortStr.optional(),
  waiverReason: longStr.optional().nullable(),
  apexRequest: midStr.optional().nullable(),
  userRole: shortStr.optional().nullable(),
});

export const createCustodianSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
  contactEmail: z.string().email("Valid email is required").max(254).optional().nullable(),
  avgProcessingDays: z.number().int().min(0).max(365).optional(),
});

export const updateCustodianBaseSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  contactEmail: z.string().email().max(254).optional().nullable(),
  contactMethod: z.enum(["EMAIL", "PHONE", "PORTAL", "OTHER"]).optional().nullable(),
  contactDetails: longStr.optional().nullable(),
  avgProcessingDays: z.number().int().min(0).max(365).optional(),
  // ticket: "Mark reviewed" flips a NEEDS_SETUP card to VERIFIED.
  reviewStatus: z.enum(["NEEDS_SETUP", "VERIFIED"]).optional(),
  // ticket: contra transfer-playbook fields (all optional/nullable so a
  // PATCH can set or clear any of them). signature/LOA/medallion/liquidation
  // are multi-value TEXT in the source, so they are capped strings, not enums.
  transferType: z.enum(["ACAT_API", "MANUAL", "MIXED", "INTERNAL", "UNCONFIRMED"]).optional().nullable(),
  documentationStatus: z.enum(["DOCUMENTED", "PARTIAL", "NEEDS_CALL"]).optional().nullable(),
  dtcNumber: shortStr.optional().nullable(),
  receivingAccountNumber: shortStr.optional().nullable(),
  signature: midStr.optional().nullable(),
  letterOfAcceptance: midStr.optional().nullable(),
  medallionRequired: midStr.optional().nullable(),
  liquidationMethod: midStr.optional().nullable(),
  returnMethod: midStr.optional().nullable(),
  watchouts: longStr.optional().nullable(),
  paperworkOnFile: z.boolean().optional().nullable(),
  transfersToDate: z.number().int().min(0).max(1_000_000).optional().nullable(),
  recentClients: midStr.optional().nullable(),
});

// Shared by the human and machine admin schemas. Keep the unrefined shape
// separate so the machine boundary can omit client history before refining.
export function validateCustodianContactUpdate(
  data: z.infer<typeof updateCustodianBaseSchema>,
  ctx: z.RefinementCtx
) {
  const hasMethod = data.contactMethod !== undefined;
  const hasDetails = data.contactDetails !== undefined;
  if (hasMethod !== hasDetails) {
    ctx.addIssue({
      code: "custom",
      path: [hasMethod ? "contactDetails" : "contactMethod"],
      message: "Contact method and details must be updated together",
    });
    return;
  }
  if (!hasMethod) return;

  if (data.contactMethod === null && data.contactDetails !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["contactDetails"],
      message: "Contact details must be cleared when no contact method is selected",
    });
  }
  if (
    data.contactMethod === "EMAIL" &&
    data.contactDetails !== null &&
    !z.string().email().max(254).safeParse(data.contactDetails).success
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["contactDetails"],
      message: "Use a valid email address for Email contact details",
    });
  }
  if (
    data.contactEmail !== undefined &&
    (data.contactMethod === "EMAIL" || data.contactMethod === null) &&
    data.contactEmail !== data.contactDetails
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["contactEmail"],
      message: "Contact email must match Email contact details or be cleared with Contact",
    });
  }
}

export const updateCustodianSchema = updateCustodianBaseSchema
  .superRefine(validateCustodianContactUpdate);

// ticket: body for POST /api/custodians/[id]/merge — repoint records from
// this (source) custodian onto the target, then delete the source.
export const mergeCustodianSchema = z.object({
  targetCustodianId: z.string().min(1),
});

const custodianFeeAccountType = z.enum(["ANY", "IRA", "BROKERAGE"]);
const custodianFeeTransferType = z.enum(["ANY", "FULL", "PARTIAL"]);
const custodianFeeDirection = z.enum(["ANY", "IN", "OUT"]);

export const createCustodianFeeSchema = z.object({
  feeType: z.string().trim().min(1, "Fee type is required").max(SHORT_TEXT_MAX),
  accountType: custodianFeeAccountType.default("ANY"),
  transferType: custodianFeeTransferType.default("ANY"),
  direction: custodianFeeDirection.default("ANY"),
  amount: z.number().finite().min(0).max(1_000_000).optional().nullable(),
  amountText: shortStr.optional().nullable(),
  notes: midStr.optional().nullable(),
  documentation: midStr.optional().nullable(),
});

export const updateCustodianFeeSchema = z.object({
  feeType: z.string().trim().min(1).max(SHORT_TEXT_MAX).optional(),
  accountType: custodianFeeAccountType.optional(),
  transferType: custodianFeeTransferType.optional(),
  direction: custodianFeeDirection.optional(),
  amount: z.number().finite().min(0).max(1_000_000).optional().nullable(),
  amountText: shortStr.optional().nullable(),
  notes: midStr.optional().nullable(),
  documentation: midStr.optional().nullable(),
});

// ticket: ADVISOR added as a third role option. Validation surface lives
// in two places (admin invite, admin update) so it has to stay in sync
// with src/lib/auth-jwt.ts `AppRole` and prisma/schema.prisma `UserRole`.
const userRoleEnum = z.enum(["ADMIN", "USER", "ADVISOR"]);

export const inviteUserSchema = z.object({
  email: z.string().email("Valid email is required").max(254),
  name: shortStr.optional(),
  role: userRoleEnum.default("USER"),
});

export const updateUserSchema = z.object({
  id: z.string().min(1, "User ID is required").max(SHORT_TEXT_MAX),
  role: userRoleEnum.optional(),
  active: z.boolean().optional(),
  mcpEnabled: z.boolean().optional(),
  name: shortStr.optional().nullable(),
});

/** The first few issues, so a request with many bad items can't make a large response. */
export function formatZodError(error: z.ZodError): string {
  const shown = error.issues.slice(0, 5).map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
  const more = error.issues.length - shown.length;
  return [...shown, ...(more > 0 ? [`and ${more} more`] : [])].join("; ");
}
