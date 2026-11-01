import { z } from "zod";
import { clientIdentityRelinkSchema, formatZodError, updateAcatSchema } from "@/lib/validators";

// ticket: the trusted transfer-drawer contract. The routes behind it stay
// dark (opaque 404) unless BOTH exact-value switches are on in the deployment.
export function drawerContractEnabled(): boolean {
  return (
    process.env.EPIC_ACAT_TRANSFER_DRAWER === "1" &&
    process.env.ROLLOUT_ACAT_TRANSFER_DRAWER === "1"
  );
}

/** Reveal options passed to `redactAcatForMachine` while the contract is on. */
export function drawerRedactionOptions(): { revealDtcc: boolean; includeIdentityVersion: boolean } {
  const enabled = drawerContractEnabled();
  return { revealDtcc: enabled, includeIdentityVersion: enabled };
}

/** The named transfer-detail fields the drawer may change, by update-schema key. */
export const DRAWER_FIELDS = [
  "associatedControlNumber",
  "acatTransferId",
  "transferWorkflow",
  "direction",
  "type",
  "accountType",
  "methodRequested",
  "wealthAdvisor",
  "crwEe",
  "apexAccountId",
  "statementAccountNumber",
  "transferringContra",
  "dtccNumber",
  "statementAmount",
  "originalClientRequestDate",
  "opsSubmissionDateToApex",
  "apexCompletionDate",
  "residualMonitoringRequired",
  "residualFollowUpDate",
  "crmTicket",
  "crmDealId",
  "apexTicket",
  "additionalResources",
  "tradeRequestId",
  "tradeRequestUrl",
  "rejectionReason",
] as const;

export type DrawerField = (typeof DRAWER_FIELDS)[number];

const identityVersion = z.number().int().min(0).max(2147483647);

const changeSchema = z
  .object({
    action: z.literal("change"),
    field: z.enum(DRAWER_FIELDS),
    value: z.unknown(),
    expectedIdentityVersion: identityVersion.optional(),
  })
  .strict();

const completeSchema = z
  .object({
    action: z.literal("complete"),
    apexCompletionDate: z.string(),
    controlNumber: z.string().nullable().optional(),
  })
  .strict();

const rejectSchema = z
  .object({
    action: z.literal("reject"),
    reason: z.string(),
  })
  .strict();

const replaceClientSchema = z
  .object({
    action: z.literal("replaceClient"),
    relink: clientIdentityRelinkSchema,
  })
  .strict();

export type ClientRelinkInput = z.infer<typeof clientIdentityRelinkSchema>;

export type DrawerRequest =
  | { action: "change" | "complete" | "reject"; patch: Record<string, unknown> }
  | { action: "replaceClient"; relink: ClientRelinkInput };

export type DrawerParseResult =
  | { ok: true; request: DrawerRequest }
  | { ok: false; error: string };

function fieldIssue(field: string, value: unknown): string | null {
  const validator = (updateAcatSchema.shape as Record<string, z.ZodType>)[field];
  const parsed = validator.safeParse(value);
  return parsed.success ? null : formatZodError(parsed.error);
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

/**
 * Accept exactly one drawer action. Everything else (status, notes, fees,
 * arrays, several changes) is refused. Values are validated with the same
 * per-field validators `applyAcatPatch` uses; the original value is forwarded
 * so the shared writer performs the one normalization.
 */
export function parseDrawerRequest(body: unknown): DrawerParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Send one drawer action as a JSON object" };
  }
  const action = (body as { action?: unknown }).action;

  if (action === "change") {
    const parsed = changeSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
    const { field, value, expectedIdentityVersion } = parsed.data;
    if (isBlank(value)) return { ok: false, error: `${field} cannot be blank` };
    const issue = fieldIssue(field, value);
    if (issue) return { ok: false, error: issue };
    return {
      ok: true,
      request: {
        action: "change",
        patch: {
          [field]: typeof value === "string" ? value.trim() : value,
          ...(expectedIdentityVersion !== undefined ? { expectedIdentityVersion } : {}),
        },
      },
    };
  }

  if (action === "complete") {
    const parsed = completeSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
    const { apexCompletionDate, controlNumber } = parsed.data;
    if (isBlank(apexCompletionDate)) return { ok: false, error: "Apex Completion Date is required to complete a transfer" };
    const dateIssue = fieldIssue("apexCompletionDate", apexCompletionDate);
    if (dateIssue) return { ok: false, error: dateIssue };
    const patch: Record<string, unknown> = { status: "Completed", apexCompletionDate: apexCompletionDate.trim() };
    if (controlNumber !== undefined) {
      const control = controlNumber === null || !controlNumber.trim() ? null : controlNumber.trim();
      const controlIssue = fieldIssue("controlNumber", control);
      if (controlIssue) return { ok: false, error: controlIssue };
      patch.controlNumber = control;
    }
    return { ok: true, request: { action: "complete", patch } };
  }

  if (action === "reject") {
    const parsed = rejectSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
    const reason = parsed.data.reason.trim();
    if (!reason) return { ok: false, error: "A rejection reason is required" };
    const issue = fieldIssue("rejectionReason", reason);
    if (issue) return { ok: false, error: issue };
    return { ok: true, request: { action: "reject", patch: { status: "Rejected", rejectionReason: reason } } };
  }

  if (action === "replaceClient") {
    const parsed = replaceClientSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
    return { ok: true, request: { action: "replaceClient", relink: parsed.data.relink } };
  }

  return { ok: false, error: "Unsupported drawer action" };
}
