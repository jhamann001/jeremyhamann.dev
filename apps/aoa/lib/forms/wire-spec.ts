import type { FormFieldDefinition } from "./form-definition";
import type { MappedFormSection, MappedFormSpec } from "./mapped-form-spec";

const sections: readonly MappedFormSection[] = [
  {
    title: "Wire Request Details",
    description: "Prepare known details only. A form does not authorize or initiate a wire. The request date and all approvals remain blank.",
    fields: [
      { key: "apexAccountNumber", label: "Sending Apex account number", kind: "text", source: "accountNumber", pdfFields: ["APEX ACCOUNT NO"] },
      { key: "wireAmount", label: "Wire amount", kind: "money", pdfFields: ["WIRE AMOUNT"], hint: "Optional when preparing the form. Enter an amount only when supplied for this specific request; do not infer it from account balances." },
      { key: "transferReason", label: "Reason for transfer", kind: "text", pdfFields: ["Reason for Transfer"], maxLength: 140 },
    ],
  },
  {
    title: "Receiving Bank Information",
    description: "Use the recipient's verified wire instructions. These fields are separate from the sending Apex account and the ultimate-recipient section below.",
    fields: [
      { key: "receivingRoutingNumber", label: "Receiving bank routing / transfer number", kind: "routing", pdfFields: ["Bank Routing Transfer No"], hint: "Nine digits when provided. A format check is not verification of wire instructions." },
      { key: "receivingBankName", label: "Receiving bank name", kind: "text", pdfFields: ["Bank Name Required"], maxLength: 100 },
      { key: "bankSectionBeneficiaryAddress", label: "Beneficiary address in bank-information section", kind: "text", pdfFields: ["Beneficiary Address City State Zip Country Required"], maxLength: 200, hint: "Address, city, state, ZIP and country. The supplied form labels this as the beneficiary address, not the bank's street address; copy the matching information from the verified instructions." },
      { key: "receivingAccountNumber", label: "Receiving account number (bank-information section)", kind: "text", pdfFields: ["Account No"], maxLength: 50, hint: "Preserve leading zeros. Do not copy the sending Apex account number." },
      { key: "forCreditTo", label: "For credit to", kind: "text", pdfFields: ["For Credit To"], maxLength: 120 },
    ],
  },
  {
    title: "Ultimate Recipient / For Further Credit",
    description: "Use only the ultimate-recipient details specified in the verified wire instructions. No names, addresses or account numbers are copied from another section.",
    fields: [
      { key: "ultimateRecipientName", label: "Beneficiary / recipient / for further credit to name", kind: "text", pdfFields: ["BeneficiaryRecipientFor Further Credit to Name"], maxLength: 120 },
      { key: "ultimateRecipientAccount", label: "Ultimate beneficiary account number", kind: "text", pdfFields: ["Beneficiary Account No"], maxLength: 50 },
      { key: "ultimateRecipientAddress", label: "Ultimate beneficiary address, city, state, ZIP, country", kind: "text", pdfFields: ["Beneficiary Address City State Zip Country Required_2"], maxLength: 200 },
    ],
  },
  {
    title: "Intermediary Bank, Only if Instructed",
    collapsed: true,
    description: "Optional bank through which the wire must pass. Do not populate this section unless the verified instructions require it.",
    fields: [
      { key: "intermediaryRoutingNumber", label: "Intermediary / correspondent bank ABA", kind: "routing", pdfFields: ["Correspondent Bank ABA"] },
      { key: "intermediaryBankName", label: "Intermediary bank name", kind: "text", pdfFields: ["Bank Name Required_2"], maxLength: 100 },
      { key: "intermediarySectionBankAddress", label: "Bank address in intermediary section", kind: "text", pdfFields: ["Beneficiary Bank Address City State Zip Country Required"], maxLength: 200, hint: "The template labels this 'Beneficiary Bank Address.' Verify the intended bank address against the intermediary instructions; do not copy another section's address." },
    ],
  },
];

const fields: FormFieldDefinition[] = sections.flatMap(section => section.fields).map(field => ({
  canonicalKey: field.key, label: field.label, pdfFieldIds: field.pdfFields ?? [], requirement: "conditional",
  source: field.source ? "aoa" : "manual",
  sourcePath: field.source ? "mirror.client_account_aum.apex_account_number" : null,
  sensitivity: field.key.toLowerCase().includes("account") ? "restricted_pii" : "pii",
  transformation: field.kind === "routing" ? "nine-digit format only; no bank verification" : null,
}));

export const WIRE_SPEC = {
  preserveFields: ["Logo Placement_af_image"],
  definition: {
    id: "apex-domestic-wire", code: "APEX-WIRE", name: "Domestic Wire Request",
    version: "supplied-2026-09-18", effectiveOn: null, retiresOn: null,
    status: "internal_pilot", reviewState: "ready_for_human_review", entryPathSegment: "domestic-wire",
    summary: "Add known wire details for verification and approval. No wire is initiated.",
    callToAction: "Prepare Form",
    template: { relativePath: "assets/forms/apex/domestic-wire/supplied-2026-09-18/template.pdf", sha256: "9ab3af2efedb201541e600c34a7e5f6084e5c4a10a000bc0752005b573fcdc9d", pageCount: 1, fieldCount: 30 },
    eligibility: { context: "single_account", accountTypeIncludes: [], description: "Requires an authorized account with a confirmed Apex number. Account eligibility and suitability of this wire request must be verified by CS before use." },
    limits: {}, fields,
    rules: [
      "Use the selected server-authorized Apex identifier only in the sending Apex account field.",
      "Receiving-bank, ultimate-recipient and intermediary information are independent optional manual inputs; never infer or copy values between those roles.",
      "An entered amount is a form field, not authority to move funds.",
      "Keep the request date, every signature, and all investment-advisor, registered-principal and compliance-approval names, titles and dates blank.",
    ],
    warnings: [
      "Supplied template snapshot: printed PF10101R-DWRE 08/17/2018. Current custodian acceptance must be confirmed before use.",
      "The form's two address labels within bank sections must be checked against verified wire instructions; no address is inferred.",
      "Routing-number formatting is not bank, ownership, recipient or wire-instruction verification.",
      "Generating this form does not sign, approve, send, submit or initiate a wire.",
      "Entered values are transient and are not saved to the client profile.",
    ],
    outputFilenamePattern: "APEX-WIRE-{accountLast4}.pdf",
  },
  accountLabel: "Sending Apex account",
  confirmation: "I have confirmed the sending Apex account. The recipient, bank instructions, amount, eligibility and approvals still require the existing verification process before any wire is acted on.",
  sections,
  completionChecklist: [
    "Confirm current custodian template acceptance, account eligibility, request date, amount and purpose with the client.",
    "Complete and independently verify receiving-bank and ultimate-recipient details through the approved wire-verification process. Include intermediary instructions only if required.",
    "Verify the intended addresses for each printed bank-section label; do not assume the sending client is the recipient.",
    "Collect client/joint-holder signatures and all required advisor, principal and compliance approvals through the existing process. Those areas are intentionally blank.",
    "Missing fields remain for completion and human review. No wire or financial action is created by this form.",
  ],
} as const satisfies MappedFormSpec;
