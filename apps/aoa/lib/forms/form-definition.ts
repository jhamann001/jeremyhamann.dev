export type FormStatus = "internal_pilot" | "active" | "retired";

export type FormSensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "pii"
  | "restricted_pii";

export type FormFieldSource = "aoa" | "manual" | "derived" | "human_signature";

export type FormFieldRequirement =
  | "required"
  | "required_when_row_used"
  | "conditional"
  | "leave_blank";

export type FormFieldDefinition = {
  canonicalKey: string;
  label: string;
  pdfFieldIds: readonly string[];
  requirement: FormFieldRequirement;
  source: FormFieldSource;
  sourcePath: string | null;
  sensitivity: FormSensitivity;
  transformation: string | null;
};

export type FormDefinition = {
  id: string;
  code: string;
  name: string;
  version: string;
  effectiveOn: string | null;
  retiresOn: string | null;
  status: FormStatus;
  reviewState: "ready_for_human_review";
  entryPathSegment: string;
  summary: string;
  callToAction: string;
  template: {
    relativePath: string;
    sha256: string;
    pageCount: number;
    fieldCount: number;
  };
  eligibility: {
    context: "single_account";
    accountTypeIncludes: readonly string[];
    accountTypeAny?: readonly string[];
    accountTypeExcludes?: readonly string[];
    description: string;
  };
  limits: Readonly<Record<string, number>>;
  fields: readonly FormFieldDefinition[];
  rules: readonly string[];
  warnings: readonly string[];
  outputFilenamePattern: string;
};

export type FormFieldProvenance = {
  canonicalKey: string;
  pdfFieldIds: readonly string[];
  source: FormFieldSource;
  sourcePath: string | null;
  sensitivity: FormSensitivity;
  transformation: string | null;
  overridden: boolean;
  valueRetention: "transient_only";
};

export function isDefinitionEligibleForAccountType(
  definition: FormDefinition,
  accountType: string | null | undefined,
): boolean {
  const words = (accountType ?? "").toLowerCase().split(/[^a-z0-9]+/);
  if (definition.eligibility.accountTypeExcludes?.some(token => words.includes(token.toLowerCase()))) return false;
  if (definition.eligibility.accountTypeAny?.length && !definition.eligibility.accountTypeAny.some(token => words.includes(token.toLowerCase()))) return false;
  // An empty include list means any type subject to the explicit restrictions above.
  // Account existence, ownership and the Apex number are checked separately.
  if (definition.eligibility.accountTypeIncludes.length === 0) return true;
  if (!accountType) return false;
  return definition.eligibility.accountTypeIncludes.every((token) =>
    words.includes(token.toLowerCase()),
  );
}
