import type { FormDefinition } from "./form-definition";
import type { MappedFormInput, MappedFormSection, MappedFormSpec } from "./mapped-form-spec";

export function todBeneficiaryFields(kind: "primary" | "contingent", row: number): readonly MappedFormInput[] {
  if (!Number.isInteger(row) || row < 1 || row > 6) throw new Error("TOD beneficiary row must be 1–6.");
  const prefix = kind === "primary" ? "Beneficiary" : "ConBeneficiary";
  const key = `${kind}${row}`;
  const field = (suffix: string) => [`${prefix} ${row} - ${suffix}`];
  return [
    { key: `${key}Name`, label: "Beneficiary name", kind: "text", pdfFields: field("Name"), maxLength: 120 },
    { key: `${key}Relationship`, label: "Relationship", kind: "text", pdfFields: field("Relationship"), maxLength: 60 },
    { key: `${key}Share`, label: "Share percentage", kind: "percent", pdfFields: field("Percentage"), min: 1, wholeNumber: true, hint: "Whole percentages only. Leave unknown shares blank; the client must complete the allocation before signing." },
    { key: `${key}Address`, label: "Address", kind: "text", pdfFields: field("Address"), maxLength: 220 },
    { key: `${key}Phone`, label: "Telephone number", kind: "phone", pdfFields: field("Telephone Number") },
    { key: `${key}Dob`, label: "Date of birth", kind: "date", pdfFields: field("Date of Birth") },
    { key: `${key}TaxId`, label: "SSN or tax ID", kind: "taxId", pdfFields: field("SSN"), hint: "Optional when preparing the form. Leave blank for the client; never enter only the last four digits." },
  ];
}

const sections: readonly MappedFormSection[] = [
  {
    title: "Account Information",
    description: "Use the actual account registration. Confirm TOD eligibility for this registration and jurisdiction separately; a form does not establish eligibility.",
    fields: [
      { key: "accountHolderName", label: "Primary account-holder name", kind: "text", source: "clientName", requiredForDraft: true, pdfFields: ["Primary - Account Holder Name"], maxLength: 120 },
      { key: "accountNumber", label: "Apex account number", kind: "text", source: "accountNumber", pdfFields: ["Primary - Apex Account Number"] },
      { key: "accountHolderTaxId", label: "Primary account-holder SSN or tax ID", kind: "taxId", pdfFields: ["Primary - SSN/Tax ID"], hint: "Optional when preparing the form. The client can supply sensitive information directly." },
      { key: "accountHolderDob", label: "Primary account-holder date of birth", kind: "date", pdfFields: ["Primary - Date of Birth"] },
      { key: "jointHolderName", label: "Joint account-holder or trustee name", kind: "text", pdfFields: ["Joint - Account Holder Name"], maxLength: 140 },
      { key: "jointHolderTaxId", label: "Joint account-holder SSN or tax ID", kind: "taxId", pdfFields: ["Joint - SSN/Tax ID"] },
      { key: "jointHolderDob", label: "Joint account-holder date of birth", kind: "date", pdfFields: ["Joint - Date of Birth"] },
      {
        key: "designationType", label: "Designation type", kind: "choice",
        hint: "Leave blank if the client has not confirmed whether this is an original or changed designation.",
        options: [
          { value: "original", label: "Original TOD designation", pdfFields: ["Group 1"], pdfValue: "New" },
          { value: "change", label: "Change to an existing TOD designation", pdfFields: ["Group 1"], pdfValue: "Update" },
        ],
      },
    ],
  },
  ...(["primary", "contingent"] as const).flatMap((kind) => Array.from({ length: 6 }, (_, index) => ({
    title: `${kind === "primary" ? "Primary" : "Contingent"} Beneficiary ${index + 1}`,
    description: "Enter only known information. Missing details stay blank for the client. For a trust, follow the form's instructions for the trust name, trustees and establishment date.",
    collapsed: true,
    fields: todBeneficiaryFields(kind, index + 1),
  }))),
];

const definition = {
  id: "apex-transfer-on-death",
  code: "69448P",
  name: "Transfer on Death",
  version: "user-supplied-2026-09-18",
  effectiveOn: null,
  retiresOn: null,
  status: "internal_pilot",
  reviewState: "ready_for_human_review",
  entryPathSegment: "transfer-on-death",
  summary: "Add account and known beneficiary details for a Transfer on Death designation.",
  callToAction: "Prepare Form",
  template: {
    relativePath: "assets/forms/apex/transfer-on-death/user-supplied-2026-09-18/template.pdf",
    sha256: "13b9365e1d1736e35aab3b1274d2916eed0b3aabe96b38a9c8f8eed87dd970cb",
    pageCount: 5,
    fieldCount: 107,
  },
  eligibility: {
    context: "single_account",
    accountTypeIncludes: [],
    accountTypeAny: ["individual", "joint", "jtwros", "jtic", "tod"],
    accountTypeExcludes: ["ira", "roth", "sep", "simple", "401", "401k", "403", "403b", "457", "457b", "retirement", "pension", "keogh", "trust", "custodial", "ugma", "utma"],
    description: "Known individual or joint non-retirement account only; CS must separately confirm the account registration and jurisdiction permit TOD designation.",
  },
  limits: { primaryBeneficiaries: 6, contingentBeneficiaries: 6 },
  fields: sections.flatMap((section) => section.fields).map((field) => ({
    canonicalKey: field.key,
    label: field.label,
    pdfFieldIds: field.pdfFields ?? Array.from(new Set(field.options?.flatMap((option) => option.pdfFields) ?? [])),
    requirement: field.requiredForDraft || field.source === "accountNumber" ? "required" : "conditional",
    source: field.source ? "aoa" : "manual",
    sourcePath: field.source === "accountNumber" ? "mirror.client_account_aum.apex_account_number" : field.source === "clientName" ? "mirror.client.first_name + mirror.client.last_name" : null,
    sensitivity: field.kind === "taxId" || field.kind === "date" ? "restricted_pii" : field.source === "accountNumber" ? "confidential" : "pii",
    transformation: field.kind === "taxId" ? "optional; nine digits when supplied" : field.kind === "percent" ? "optional; whole number percentage" : field.kind === "choice" ? "explicit election only" : null,
  })),
  rules: [
    "Use only the server-authorized Apex account number for the selected client's account.",
    "Require explicit account-registration and TOD-eligibility confirmation; no automatic legal or jurisdiction eligibility determination.",
    "Allow partial beneficiary rows and blank SSNs for client completion. Never infer beneficiaries, relationships, allocations, dates or tax IDs.",
    "Entered shares are whole percentages and may not exceed 100 within either beneficiary category. Incomplete allocation totals must be completed before signing.",
    "Only an explicitly selected original/change election may populate the designation radio group.",
    "Repair the duplicated primary-beneficiary 3/6 address widgets and misplaced radio-group flag in the generated copy only.",
    "Leave every signature-area field, signature, signature date, instruction annotation and logo unchanged or blank as appropriate.",
  ],
  warnings: [
    "This is the user-supplied five-page Apex snapshot, not an asserted latest custodian revision. Page 1 prints 05/27/2025 and pages 2–5 print 04/23/2025; both are retained.",
    "The client must complete applicable missing beneficiary details and each applicable category's 100% allocation before signing.",
    "CS must check TOD availability, registration, trust instructions and any applicable joint-owner or spousal-signature requirements before sending.",
    "Entered values are transient and are not saved to the client profile. This form is not signed, sent, submitted or accepted by Apex.",
  ],
  outputFilenamePattern: "APEX-TOD-{accountLast4}.pdf",
} satisfies FormDefinition;

export const TOD_SPEC: MappedFormSpec = {
  definition,
  accountLabel: "TOD account",
  confirmation: "I confirm this is the correct account registration and that TOD designation is eligible for this account type and jurisdiction. I have reviewed the account-holder name.",
  sections,
  repair: "tod-beneficiary-address",
  preserveFields: ["Logo Placement_af_image"],
  percentageGroups: (["primary", "contingent"] as const).map((kind) => Array.from({ length: 6 }, (_, index) => `${kind}${index + 1}Share`)),
  completionChecklist: [
    "Client completes missing account-holder and beneficiary information, including full SSNs or tax IDs where applicable.",
    "Client confirms the original/change designation and completes primary and any contingent allocations to 100% each.",
    "CS verifies registration and jurisdiction eligibility, and checks trust, joint-owner and spouse requirements on the supplied form.",
    "Configure all applicable completion and signature fields in the signing tool. This form does not enforce signing-tool requirements.",
    "Review all five pages, obtain the required signatures and dates, then follow the established manual submission process.",
  ],
};
