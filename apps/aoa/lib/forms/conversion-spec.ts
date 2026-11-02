import type { FormFieldDefinition } from "./form-definition";
import type { MappedFormSection, MappedFormSpec } from "./mapped-form-spec";

const sections: readonly MappedFormSection[] = [
  {
    title: "Receiving Roth IRA and Account Holder",
    description: "The selected AoA account is the receiving Roth IRA. Confirm its legal owner name; enter the delivering account separately.",
    fields: [
      { key: "accountHolderName", label: "Roth IRA holder legal name", kind: "text", source: "clientName", requiredForDraft: true, pdfFields: ["Full Legal Name"], maxLength: 100 },
      { key: "receivingAccountNumber", label: "Receiving Roth IRA account number", kind: "text", source: "accountNumber", pdfFields: ["Receiving Roth IRA Account No"] },
      { key: "accountHolderTaxId", label: "Roth IRA holder SSN / ITIN / tax ID", kind: "taxId", pdfFields: ["SSNITINTax ID Requ red by the IRS"], hint: "Optional when preparing the form. Leave unknown information blank for the client." },
      { key: "accountHolderDateOfBirth", label: "Roth IRA holder date of birth", kind: "date", pdfFields: ["Date of Birth Optional"] },
    ],
  },
  {
    title: "Accepting Roth IRA Custodian",
    description: "Use confirmed receiving-custodian information. These details are not inferred from the account number.",
    collapsed: true,
    fields: [
      { key: "receivingCustodianName", label: "Accepting trustee / custodian", kind: "text", pdfFields: ["TrusteeCustodian Name"], maxLength: 100 },
      { key: "receivingAddress1", label: "Accepting custodian address line 1", kind: "text", pdfFields: ["Address Line 1"], maxLength: 100 },
      { key: "receivingAddress2", label: "Accepting custodian address line 2", kind: "text", pdfFields: ["Address Line 2"], maxLength: 100 },
      { key: "receivingCityStateZip", label: "Accepting custodian city / state / ZIP", kind: "text", pdfFields: ["CityStateZip"], maxLength: 100 },
    ],
  },
  {
    title: "Delivering Traditional / SIMPLE IRA",
    description: "This is the account being converted. Enter its number and custodian from current documentation; it is distinct from the selected receiving Roth IRA.",
    fields: [
      { key: "deliveringAccountNumber", label: "Delivering Traditional / SIMPLE IRA account number", kind: "text", pdfFields: ["Delivering TradSIMPLE Account No"], maxLength: 60 },
      { key: "deliveringCustodianName", label: "Current trustee / custodian", kind: "text", pdfFields: ["TrusteeCustodian Name_2"], maxLength: 100 },
      { key: "deliveringAddress1", label: "Current custodian address line 1", kind: "text", pdfFields: ["Address Line 1_2"], maxLength: 100 },
      { key: "deliveringAddress2", label: "Current custodian address line 2", kind: "text", pdfFields: ["Address Line 2_2"], maxLength: 100 },
      { key: "deliveringCityStateZip", label: "Current custodian city / state / ZIP", kind: "text", pdfFields: ["CityStateZip_2"], maxLength: 100 },
      { key: "deliveringAccountType", label: "Current IRA account type, if confirmed", kind: "choice", options: [
        { value: "traditional", label: "Traditional IRA (including SEP and Rollover)", pdfFields: ["Check Box88"] },
        { value: "simple", label: "SIMPLE IRA (after 2 years)", pdfFields: ["Check Box89"] },
      ], hint: "Selecting the printed account type does not establish conversion eligibility." },
    ],
  },
  {
    title: "Confirmed Conversion Instructions",
    description: "Enter only instructions already provided for this request. All choices are optional and start blank.",
    collapsed: true,
    fields: [
      { key: "conversionInstruction", label: "Conversion instruction", kind: "choice", options: [
        { value: "total_keep_open", label: "Total conversion — leave current IRA open", pdfFields: ["undefined_5"] },
        { value: "total_close", label: "Total conversion — close current IRA", pdfFields: ["undefined_6"] },
        { value: "partial_cash", label: "Partial conversion — cash only", pdfFields: ["undefined_7"] },
        { value: "partial_cash_and_securities", label: "Partial conversion — cash and securities", pdfFields: ["undefined_8"] },
        { value: "partial_securities", label: "Partial conversion — securities only", pdfFields: ["undefined_9"] },
      ] },
      // The labeled CASH AMOUNT widget lies in the table's label column. The
      // unlabeled widget below is the actual entry line beside the dollar sign.
      { key: "conversionCashAmount", label: "Cash amount to convert", kind: "money", pdfFields: ["undefined_10"], allowedWhen: { key: "conversionInstruction", values: ["partial_cash", "partial_cash_and_securities"] } },
    ],
  },
];

const fields: FormFieldDefinition[] = sections.flatMap(section => section.fields).map(field => ({
  canonicalKey: field.key, label: field.label,
  pdfFieldIds: field.options?.flatMap(option => option.pdfFields) ?? field.pdfFields ?? [],
  requirement: field.requiredForDraft ? "required" : "conditional",
  source: field.source ? "aoa" : "manual",
  sourcePath: field.source ? (field.source === "accountNumber" ? "mirror.client_account_aum.apex_account_number" : "mirror.client.first_name + mirror.client.last_name") : null,
  sensitivity: field.kind === "taxId" ? "restricted_pii" : "pii",
  transformation: field.kind === "choice" ? "explicit-choice-to-checkbox" : null,
}));

export const CONVERSION_SPEC = {
  definition: {
    id: "direct_conversion_request", code: "DIRECT-CONVERSION", name: "Direct Conversion Request",
    version: "source-2026-09-18", effectiveOn: null, retiresOn: null, status: "internal_pilot",
    reviewState: "ready_for_human_review", entryPathSegment: "direct-conversion",
    summary: "Add receiving Roth IRA and delivering IRA details for a conversion request.",
    callToAction: "Prepare Form",
    template: { relativePath: "assets/forms/apex/direct-conversion/source-2026-09-18/template.pdf", sha256: "a3a4e6df3cd1a27a4caf77423c3efc55cc5fd92e1bbcdc750f41bd3140ba216c", pageCount: 5, fieldCount: 41 },
    eligibility: { context: "single_account", accountTypeIncludes: ["IRA", "Roth"], description: "Select the authorized receiving Roth IRA; the delivering Traditional or SIMPLE IRA is supplied separately." },
    limits: {}, fields,
    rules: [
      "The selected authorized Apex account populates only the receiving Roth IRA account number.",
      "Delivering account and custodian details are manual; receiving and delivering accounts are not interchangeable.",
      "Known information may be entered independently. Omitted optional values remain blank.",
      "Conversion and current-account-type checkboxes are set only by an explicit choice; no tax withholding election is generated.",
      "Signature fields, signature dates, and the accepting custodian authorization remain blank.",
    ],
    warnings: [
      "Confirm the exact receiving Roth IRA owner and account, and independently verify the delivering IRA.",
      "This form does not determine conversion eligibility, tax treatment, or withholding.",
      "Complete federal and state withholding and any shares-in-kind instructions during human review.",
      "All five source pages, including withholding instructions, remain in the packet.",
    ],
    outputFilenamePattern: "direct-conversion-{accountLast4}.pdf",
  },
  accountLabel: "Receiving Roth IRA account",
  confirmation: "I confirm that the selected Apex account is the receiving Roth IRA, and the name shown is its legal owner.",
  sections,
  preserveFields: ["Image28_af_image"],
  completionChecklist: [
    "Verify both account numbers and the accepting and current custodian details against current documents.",
    "Confirm current IRA type and conversion eligibility with the appropriate reviewer; the form does not establish eligibility.",
    "Complete the owner's tax ID if missing, and confirm the conversion instruction and cash amount.",
    "Complete the shares-in-kind table for any securities included; no holdings or quantities are inferred.",
    "Review and complete federal and state tax withholding instructions; blank withholding fields do not express a zero-withholding election.",
    "Obtain the IRA owner's signature and date and any required accepting-custodian authorization after review.",
  ],
} as const satisfies MappedFormSpec;
