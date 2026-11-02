import type { FormDefinition } from "./form-definition";

export const ACAT_ACCOUNT_FIELDS = {
  accountHolderName: "ACCOUNT TITLE",
  accountNumber: "APEX CLEARING ACCOUNT NO",
  accountHolderTaxId: "SSNTAX ID NO",
} as const;

export const ACAT_DEFINITION = {
  id: "apex-acat-generic",
  code: "APEX-ACAT",
  name: "ACAT Transfer",
  // Snapshot of the existing Tracker template, not an asserted custodian revision.
  version: "tracker-baseline-2026-09-17",
  effectiveOn: null,
  retiresOn: null,
  status: "internal_pilot",
  reviewState: "ready_for_human_review",
  entryPathSegment: "acat",
  summary: "Add receiving-account details, then complete and review the transfer instructions.",
  callToAction: "Prepare Form",
  template: {
    relativePath: "assets/forms/apex/customer-account-transfer-request/tracker-baseline-2026-09-17/template.pdf",
    sha256: "2eab2ec7d9d6fc244a1ea8e0b665273844b7df7482fffa21ce1dc111b61cd814",
    pageCount: 2,
    fieldCount: 95,
  },
  eligibility: {
    context: "single_account",
    accountTypeIncludes: [],
    description: "Requires one authorized client account with a confirmed Apex account number; no account-type restriction.",
  },
  limits: {},
  fields: [
    {
      canonicalKey: "account.registration_title",
      label: "Receiving account title",
      pdfFieldIds: [ACAT_ACCOUNT_FIELDS.accountHolderName],
      requirement: "required",
      source: "aoa",
      sourcePath: "mirror.client.first_name + mirror.client.last_name",
      sensitivity: "pii",
      transformation: "trim-collapse-whitespace; explicit registration-title confirmation",
    },
    {
      canonicalKey: "account.apex_account_number",
      label: "Receiving Apex account number",
      pdfFieldIds: [ACAT_ACCOUNT_FIELDS.accountNumber],
      requirement: "required",
      source: "aoa",
      sourcePath: "mirror.client_account_aum.apex_account_number",
      sensitivity: "confidential",
      transformation: null,
    },
    {
      canonicalKey: "account.owner.tax_id",
      label: "Receiving account SSN or tax ID",
      pdfFieldIds: [ACAT_ACCOUNT_FIELDS.accountHolderTaxId],
      requirement: "conditional",
      source: "manual",
      sourcePath: null,
      sensitivity: "restricted_pii",
      transformation: "optional; nine digits when provided",
    },
  ],
  rules: [
    "Confirm the receiving account title explicitly; the AoA display name is only a suggestion.",
    "The selected account must be visible to the authenticated user and belong to the selected client.",
    "Use only the server-authorized receiving Apex account number.",
    "Leave all delivering-account information, transfer elections, assets, dates, checkboxes, and signatures blank.",
    "Leave the entire conditional letter of authorization blank, including its receiving-account fields.",
    "Reject transfer instructions or other unsupported values instead of adding them to this form.",
  ],
  warnings: [
    "This template version identifies a Tracker baseline snapshot, not a verified current custodian revision.",
    "CS must complete and review transfer information and applicable sections before signing or submission.",
    "The receiving account title must not be reused as the delivering account title without separate verification.",
    "Entered values are transient and are not saved to the client profile.",
    "Generating this form does not create, initiate, sign, send, or submit a transfer.",
  ],
  outputFilenamePattern: "APEX-ACAT-{accountLast4}.pdf",
} as const satisfies FormDefinition;
