import { z } from "zod";

const text = z.string().nullable();
const number = z.number().finite().nullable();
const count = z.number().int().nonnegative();

export const CUSTODIAN_CONTACT_METHODS = ["EMAIL", "PHONE", "PORTAL", "OTHER"] as const;
export type CustodianContactMethod = (typeof CUSTODIAN_CONTACT_METHODS)[number];

export const CONTACT_METHOD_LABELS: Record<CustodianContactMethod, string> = {
  EMAIL: "Email",
  PHONE: "Phone",
  PORTAL: "Portal",
  OTHER: "Other",
};

// Stored values and display labels match Transfer Tracker PR #181. Existing custom
// free-text values remain readable until an operator picks a replacement.
export const SIGNATURE_OPTIONS = [
  { value: "DocuSign OK", label: "Electronic signature accepted (DocuSign)" },
  { value: "Wet only", label: "Wet signature required" },
  { value: "DocuSign OK / Wet only", label: "Varies by account / transfer — see Watchouts" },
  { value: "Not required", label: "Not required" },
  { value: "Unknown", label: "Unknown / needs confirmation" },
  { value: "Other — see Watchouts", label: "Other — see Watchouts" },
] as const;

export const REQUIREMENT_OPTIONS = [
  { value: "Required", label: "Required" },
  { value: "Not required", label: "Not required" },
  { value: "Not required / Required", label: "Required in some cases — see Watchouts" },
  { value: "Unknown", label: "Unknown / needs confirmation" },
  { value: "Other — see Watchouts", label: "Other — see Watchouts" },
] as const;

export const LIQUIDATION_OPTIONS = [
  "Check", "Wire", "ACH", "Phone order", "Multiple methods — see Watchouts",
  "Not applicable", "Unknown", "Other — see Watchouts",
].map((value) => ({ value, label: value }));

export const RETURN_METHOD_OPTIONS = [
  { value: "E-Mail", label: "Email" },
  { value: "Fax", label: "Fax" },
  { value: "Mail", label: "Mail" },
  { value: "Portal", label: "Portal" },
  { value: "Email, fax", label: "Email or fax" },
  { value: "Apex Service Request", label: "Apex Service Request" },
  { value: "N/A for a standard ACAT", label: "Not applicable — standard ACAT" },
  { value: "Multiple methods — see Watchouts", label: "Multiple methods — see Watchouts" },
  { value: "Unknown", label: "Unknown / needs confirmation" },
  { value: "Other — see Watchouts", label: "Other — see Watchouts" },
] as const;

export function playbookOptionLabel(
  value: string | null | undefined,
  options: ReadonlyArray<{ value: string; label: string }>,
): string | null {
  if (value == null || !value.trim()) return null;
  return options.find((option) => option.value === value)?.label ?? value;
}

export const custodianFeeSchema = z.object({
  id: z.string().min(1), feeType: z.string(), accountType: z.string(),
  transferType: z.string(), direction: z.string(), amount: number,
  amountText: text, notes: text, documentation: text,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});

export const feeScheduleMetadataSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
  byteSize: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().datetime(),
});

export const custodianProfileSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), reviewStatus: z.string(),
  acatFeeAmount: number, transferType: text, documentationStatus: text,
  dtcNumber: text, receivingAccountNumber: text, signature: text,
  letterOfAcceptance: text, medallionRequired: text, liquidationMethod: text,
  returnMethod: text, watchouts: text, paperworkOnFile: z.boolean().nullable(),
  transfersToDate: count.nullable(), contactEmail: text,
  // Optional so a Tracker revision before PR #181 still validates. After that
  // deploy the fields are always present (null when unset).
  contactMethod: z.enum(CUSTODIAN_CONTACT_METHODS).nullable().optional(),
  contactDetails: text.optional(),
  configuredExpectedProcessingDays: number,
  observedAvgProcessingBusinessDays: number,
  observedCompletedTransfers: count,
  fees: z.array(custodianFeeSchema),
  feeSchedules: z.array(feeScheduleMetadataSchema).optional(),
  observedTimingAvailable: z.boolean().optional(),
});

// Strip unknown fields at both levels. A future source field must be reviewed
// explicitly before reaching the browser; do not silently forward raw JSON.
export const custodianLibrarySchema = z.object({
  schemaVersion: z.literal(1), retrievedAt: z.string().datetime(),
  custodians: z.array(custodianProfileSchema),
}).superRefine(({ custodians }, ctx) => {
  if (new Set(custodians.map((c) => c.id)).size !== custodians.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate custodian ids" });
  }
  for (const c of custodians) {
    if (new Set(c.fees.map((f) => f.id)).size !== c.fees.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate fee ids" });
    }
  }
});

export type CustodianProfile = z.infer<typeof custodianProfileSchema>;
export type CustodianFee = z.infer<typeof custodianFeeSchema>;
export type CustodianLibrary = z.infer<typeof custodianLibrarySchema>;

/** Old email-only rows show as Email until an operator edits Contact. */
export function resolveCustodianContact(profile: Pick<
  CustodianProfile, "contactMethod" | "contactDetails" | "contactEmail"
>): { contactMethod: CustodianContactMethod | null; contactDetails: string | null } {
  if (profile.contactMethod) {
    return {
      contactMethod: profile.contactMethod,
      contactDetails: profile.contactDetails ?? null,
    };
  }
  if (profile.contactEmail) {
    return { contactMethod: "EMAIL", contactDetails: profile.contactEmail };
  }
  return { contactMethod: null, contactDetails: null };
}

export function canReadCustodianLibrary(role: string | null | undefined): boolean {
  return role === "ADMIN" || role === "OPERATIONS";
}

export function filterCustodians(custodians: CustodianProfile[], query: string) {
  const term = query.trim().toLocaleLowerCase();
  return custodians.filter((c) => {
    const contact = resolveCustodianContact(c);
    return [c.name, c.dtcNumber, c.transferType, c.contactEmail, contact.contactDetails,
      c.documentationStatus, ...c.fees.map((f) => f.feeType)]
      .some((value) => value?.toLocaleLowerCase().includes(term));
  });
}

/** Stored direction is relative to this custodian; labels match Tracker PR #181. */
export function feeDirectionLabel(direction: string): string {
  if (direction === "OUT") return "Transfer into Apex";
  if (direction === "IN") return "Transfer out of Apex";
  if (direction === "ANY") return "Both directions";
  return direction || "Not recorded";
}
