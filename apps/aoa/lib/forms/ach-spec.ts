import type { FormFieldDefinition } from "./form-definition";
import type { MappedFormSection, MappedFormSpec } from "./mapped-form-spec";

const sections: readonly MappedFormSection[] = [
  {
    title: "Apex Account",
    description: "The selected Apex identifier supplies the three branch characters and five account digits. The separate T and C boxes remain blank for review.",
    fields: [
      { key: "apexBranch", label: "Apex branch", kind: "text", source: "accountNumber", accountPart: "branch", characterBoxes: true, pdfFields: ["Branch 1", "Branch 2", "Branch 3"] },
      { key: "apexNumber", label: "Apex account number", kind: "text", source: "accountNumber", accountPart: "number", characterBoxes: true, pdfFields: ["Digit 1", "Digit 2", "Digit 3", "Digit 4", "Digit 5"] },
      { key: "primaryOwnerName", label: "Primary account owner name", kind: "text", source: "clientName", requiredForDraft: true, pdfFields: ["PRIMARY ACCOUNT OWNER NAME"], maxLength: 100, hint: "Confirm the account owner's full name; the client display name is only a suggestion." },
    ],
  },
  {
    title: "Bank Account Information",
    description: "Enter only bank details supplied and verified through the approved CS process. Leave unknown details blank for the client; no bank information is inferred from the Apex account.",
    fields: [
      { key: "bankAccountTitle", label: "Bank account title", kind: "text", pdfFields: ["Account Title"], maxLength: 100, hint: "Use the bank account registration. Do not assume it matches the Apex account title." },
      { key: "bankName", label: "Bank name", kind: "text", pdfFields: ["Name of Bank"], maxLength: 100 },
      { key: "bankRoutingNumber", label: "Bank ABA routing number", kind: "routing", characterBoxes: true, pdfFields: ["ABA NO. 1", "ABA NO. 2", "ABA NO. 3", "ABA NO. 4", "ABA NO. 5", "ABA NO. 6", "ABA NO. 7", "ABA NO. 8", "ABA NO. 9"], hint: "Optional when preparing the form. Nine digits when provided; formatting checks do not verify the bank or its instructions." },
      { key: "bankAccountNumber", label: "Bank account number", kind: "text", pdfFields: ["Bank Account No"], maxLength: 34, hint: "Leave blank if the client will provide this sensitive information. Preserve any leading zeros." },
      { key: "bankAccountType", label: "Bank account type", kind: "choice", options: [{ value: "checking", label: "Checking", pdfFields: ["Checking"] }, { value: "savings", label: "Savings", pdfFields: ["Savings"] }], hint: "Select only if confirmed; no default is selected." },
    ],
  },
  {
    title: "Primary Owner Address",
    fields: [
      { key: "primaryAddress", label: "Primary owner street address", kind: "text", pdfFields: ["ADDRESS"], maxLength: 120 },
      { key: "primaryCity", label: "Primary owner city", kind: "text", pdfFields: ["CITY"], maxLength: 60 },
      { key: "primaryState", label: "Primary owner state", kind: "text", pdfFields: ["STATE"], maxLength: 20 },
      { key: "primaryZip", label: "Primary owner ZIP code", kind: "text", pdfFields: ["ZIP CODE"], maxLength: 10 },
    ],
  },
  {
    title: "Joint Owner, if Applicable",
    collapsed: true,
    description: "Leave this section blank for an individual account. Do not copy the primary owner's details into the joint owner's fields.",
    fields: [
      { key: "jointOwnerName", label: "Joint account owner name", kind: "text", pdfFields: ["JOINT ACCOUNT OWNER NAME"], maxLength: 100 },
      { key: "jointAddress", label: "Joint owner street address", kind: "text", pdfFields: ["ADDRESS_2"], maxLength: 120 },
      { key: "jointCity", label: "Joint owner city", kind: "text", pdfFields: ["CITY_2"], maxLength: 60 },
      { key: "jointState", label: "Joint owner state", kind: "text", pdfFields: ["STATE_2"], maxLength: 20 },
      { key: "jointZip", label: "Joint owner ZIP code", kind: "text", pdfFields: ["ZIP CODE_2"], maxLength: 10 },
    ],
  },
];

const fields: FormFieldDefinition[] = sections.flatMap(section => section.fields).map(field => ({
  canonicalKey: field.key,
  label: field.label,
  pdfFieldIds: field.pdfFields ?? field.options?.flatMap(option => option.pdfFields) ?? [],
  requirement: field.requiredForDraft ? "required" : "conditional",
  source: field.source ? "aoa" : "manual",
  sourcePath: field.source ? field.source === "accountNumber" ? "mirror.client_account_aum.apex_account_number" : "mirror.client.first_name + mirror.client.last_name" : null,
  sensitivity: field.key === "bankAccountNumber" ? "restricted_pii" : field.source === "accountNumber" ? "confidential" : "pii",
  transformation: field.accountPart ? "exact three-character branch and five-digit account split; no truncation or T/C inference" : field.kind === "routing" ? "nine digits into separate character boxes; no bank verification" : null,
}));

export const ACH_SPEC = {
  preserveFields: ["Logo Placement_af_image"],
  definition: {
    id: "apex-ach-agreement", code: "APEX-ACH", name: "ACH Agreement",
    version: "supplied-2026-09-18", effectiveOn: null, retiresOn: null,
    status: "internal_pilot", reviewState: "ready_for_human_review", entryPathSegment: "ach-agreement",
    summary: "Add bank and account-owner details for the client to review and authorize.",
    callToAction: "Prepare Form",
    template: { relativePath: "assets/forms/apex/ach-agreement/supplied-2026-09-18/template.pdf", sha256: "6fb4ba455e7df40bf51733fe922ba199e2af2c572ccde0125724be6f2d2ba3be", pageCount: 1, fieldCount: 59 },
    eligibility: { context: "single_account", accountTypeIncludes: [], description: "Requires an authorized Apex account whose confirmed identifier fits this template's three-character branch and five-digit account boxes. Suitability and ACH eligibility require CS review." },
    limits: {}, fields,
    rules: [
      "Use only the selected server-authorized Apex number and reject unsupported identifier layouts rather than truncating them.",
      "The T/C boxes are distinct from the eight-character branch/account identifier and are never guessed.",
      "Bank details and bank account type are optional manual inputs. Checking or savings is selected only by explicit input.",
      "All electronic-transfer profile choices, income frequencies, recurring amounts and schedules remain blank for client/CS completion.",
      "All signatures, authorization dates, and correspondent approval remain blank.",
    ],
    warnings: [
      "Supplied template snapshot: printed 69196P-UACH 08/17/2018. Current custodian acceptance must be confirmed before use.",
      "This prepares an editable form, not an ACH enrollment or instruction to move money.",
      "A nine-digit routing number is not evidence that bank details or ownership have been verified.",
      "Entered values are transient and are not saved to the client profile.",
    ],
    outputFilenamePattern: "APEX-ACH-{accountLast4}.pdf",
  },
  accountLabel: "Apex account to link",
  confirmation: "I have confirmed the selected Apex account and primary owner name. Bank details must be separately verified before use.",
  sections,
  completionChecklist: [
    "Confirm current template acceptance, account eligibility, the bank account title/ownership, and any required T/C values.",
    "Client/CS must complete missing bank and owner details and explicitly choose the electronic-transfer profile, any income frequency, and any recurring direction, amount, frequency and day. These elections are intentionally blank in this pilot.",
    "Provide the bank evidence requested on the form: a voided check for checking, or a recent bank statement or official bank letter for savings.",
    "Review all details, configure any required fields in the signing tool, and obtain applicable owner signatures/dates and correspondent authorization through the existing process.",
    "No enrollment, signature, sending, submission, or transfer is performed by generating this form.",
  ],
} as const satisfies MappedFormSpec;
