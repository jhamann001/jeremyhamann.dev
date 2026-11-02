import type { FormFieldDefinition } from "./form-definition";
import type { MappedFormInput, MappedFormSection } from "./mapped-form-spec";

/** The two source forms share sections, but their widget IDs and ID rules differ. */
export function distributionSections(roth: boolean): readonly MappedFormSection[] {
  const text = (key: string, label: string, pdfField: string, maxLength = 80): MappedFormInput => ({ key, label, kind: "text", pdfFields: [pdfField], maxLength });
  return [
    {
      title: "Account Holder",
      description: "Confirm the account holder's legal name. Every other manual entry is optional when preparing the form.",
      fields: [
        { key: "accountHolderName", label: "Account holder legal name", kind: "text", source: "clientName", requiredForDraft: true, pdfFields: ["Full Legal Name"], maxLength: 100 },
        { key: "accountNumber", label: "Distributing IRA account number", kind: "text", source: "accountNumber", pdfFields: ["Account No"] },
        { key: "accountHolderTaxId", label: roth ? "Account holder tax ID — last 4 digits" : "Account holder SSN / ITIN / tax ID", kind: roth ? "taxIdLast4" : "taxId", pdfFields: ["SSNITINTax ID Required by the IRS"], hint: roth ? "This source form asks for the last four digits only. Leave blank if unknown." : "Leave blank if unknown; do not enter masked or incomplete identifiers." },
        { key: "accountHolderDateOfBirth", label: "Account holder date of birth", kind: "date", pdfFields: ["Date of Birth Optional"] },
        ...(roth ? [{ key: "accountHolderPhone", label: "Account holder phone", kind: "phone" as const, pdfFields: ["Phone Number Optional"] }] : [{
          key: "accountType", label: "Account type, if confirmed", kind: "choice" as const, options: [
            { value: "traditional", label: "Traditional IRA", pdfFields: ["Check Box1"] },
            { value: "simple", label: "SIMPLE IRA", pdfFields: ["Check Box2"] },
            { value: "sep", label: "SEP IRA", pdfFields: ["Check Box3"] },
          ],
        }]),
      ],
    },
    {
      title: "Beneficiary or Former Spouse, Only When Applicable",
      description: "For a beneficiary withdrawal, inherited-IRA transfer, or applicable divorce distribution. This section does not name or change beneficiaries. Information is never copied from the account holder.",
      collapsed: true,
      fields: [
        text("recipientName", "Beneficiary / former spouse legal name", "Full Legal Name_2", 100),
        text("recipientAccountNumber", "Beneficiary / former spouse account number", "Account No_2", 60),
        { key: "recipientTaxId", label: roth ? "Beneficiary / former spouse tax ID — last 4 digits" : "Beneficiary / former spouse SSN / ITIN / tax ID", kind: roth ? "taxIdLast4" : "taxId", pdfFields: ["SSNITINTax ID Required by the IRS_2"] },
        { key: "recipientDateOfBirth", label: "Beneficiary / former spouse date of birth", kind: "date", pdfFields: ["Date of Birth Optional_2"] },
        text("recipientRelationship", "Relationship", "Relationship", 60),
      ],
    },
    {
      title: "Confirmed Distribution Details",
      description: "Optional request details. Distribution reason, tax withholding, and delivery elections remain blank for review in the PDF.",
      collapsed: true,
      fields: [
        { key: "distributionMethod", label: "Distribution method", kind: "choice", options: [
          { value: "one_time", label: "One-time distribution", pdfFields: [roth ? "Check Box110" : "Check Box75"] },
          { value: "scheduled", label: "Scheduled distribution", pdfFields: [roth ? "Check Box111" : "Check Box76"] },
          { value: "total", label: "Total account distribution (account will be closed)", pdfFields: [roth ? "Check Box112" : "Check Box77"] },
        ] },
        { key: "oneTimeAmount", label: "One-time payment amount", kind: "money", pdfFields: ["PAYMENT IN THE AMOUNT OF"], allowedWhen: { key: "distributionMethod", values: ["one_time"] } },
        { key: "scheduledAmount", label: "Scheduled payment amount", kind: "money", pdfFields: [roth ? "Text94" : "Text44"], allowedWhen: { key: "distributionMethod", values: ["scheduled"] } },
        { key: "scheduledBeginningDate", label: "Scheduled beginning date", kind: "date", pdfFields: ["BEGINNING DATE"], allowFutureDate: true, allowedWhen: { key: "distributionMethod", values: ["scheduled"] } },
      ],
    },
    {
      title: "Alternate Payee / Address Details",
      description: "Enter only if this delivery destination is intended. Complete the delivery election and any required notarization during review.",
      collapsed: true,
      fields: [
        text("alternatePayeeName", "Alternate payee name", "NAME", 80),
        text("alternateAddress", "Alternate address", roth ? "ADDRESS" : "ADDRESS_2", 55),
        text("alternateCity", "Alternate city", roth ? "CITY" : "CITY_2", 30),
        // The non-Roth source's STATE widget is only 12 PDF points wide and
        // cannot render an ordinary two-letter state at a legible size.
        ...(roth ? [text("alternateState", "Alternate state", "STATE", 2)] : []),
        text("alternateZip", "Alternate ZIP code", "ZIP CODE", 10),
      ],
    },
    {
      title: "Journal or Wire Destination Details",
      description: "These optional details do not select a payment route. Confirm the destination independently and complete the matching delivery election in the PDF.",
      collapsed: true,
      fields: [
        text("journalAccountNumber", "Receiving Apex account number for journal", "ACCOUNT NO", 60),
        { key: "wireRoutingNumber", label: "Wire ABA routing number", kind: "routing", pdfFields: ["ABA NO"] },
        text("wireAccountNumber", "Wire bank account number", roth ? "ACCT NO" : "ACCOUNT NO_2", 30),
        text("wireBankName", "Wire bank name", "BANK NAME", 45),
        text("wireBankAddress", "Wire bank address", roth ? "ADDRESS_2" : "ADDRESS_3", 55),
        text("wireBankCity", "Wire bank city", roth ? "CITY_2" : "CITY_3", 30),
        text("wireBankState", "Wire bank state", roth ? "ST" : "STATE_2", 2),
        ...(roth ? [text("wireBankZip", "Wire bank ZIP code", "ZIP", 10)] : []),
        text("wireForCreditTo", "Wire for credit to", "FOR CREDIT TO", 50),
        text("wireReceivingIraType", "Receiving IRA account type", roth ? "IRA ACCT TYPE RECEIV NG" : "TYPE OF IRA ACCOUNT RECEIVING", 45),
        text("wireBeneficiaryAccount", "Wire beneficiary account number", "BENEFICIARY ACCOUNT NO", 30),
        text("wireFurtherCreditTo", "Wire further credit to", "FURTHER CREDIT TO", 50),
        text("specialPaymentInstructions", "Special payment instructions", roth ? "Special Payment Instructions" : "INSTRUCTIONS", roth ? 160 : 100),
      ],
    },
  ];
}

export function distributionFieldDefinitions(sections: readonly MappedFormSection[]): FormFieldDefinition[] {
  return sections.flatMap(section => section.fields).map(field => ({
    canonicalKey: field.key, label: field.label,
    pdfFieldIds: field.options?.flatMap(option => option.pdfFields) ?? field.pdfFields ?? [],
    requirement: field.requiredForDraft ? "required" : "conditional",
    source: field.source ? "aoa" : "manual",
    sourcePath: field.source ? (field.source === "accountNumber" ? "mirror.client_account_aum.apex_account_number" : "mirror.client.first_name + mirror.client.last_name") : null,
    sensitivity: field.kind === "taxId" || field.kind === "taxIdLast4" ? "restricted_pii" : "pii",
    transformation: field.kind === "choice" ? "explicit-choice-to-checkbox" : null,
  }));
}
