import type { FormDefinition } from "./form-definition";

export const IRA_BENEFICIARY_ACCOUNT_FIELDS = {
  accountHolderName: "Name",
  accountHolderTaxId: "Social Security Number",
  accountNumber: "Account Number",
  certifyNotMarried: "If you are not married certify here",
} as const;

export type IraBeneficiaryPdfRow = {
  fullName: string;
  relationship: string;
  dateOfBirth: string;
  telephoneNumber: string;
  sharePercentage: string;
  address: string;
  emailAddress: string;
  taxId: string;
};

// Apex uses suffixes 2-6 for the five Primary rows and 7-11 for the five
// Contingent rows. Keep this exact, version-pinned mapping out of UI code.
export function iraBeneficiaryRowFields(index: number, kind: "primary" | "contingent") {
  const offset = kind === "primary" ? 2 : 7;
  const suffix = offset + index;
  return {
    fullName: `Name_${suffix}`,
    relationship: `Relationship_${suffix}`,
    dateOfBirth: `Date of Birth_${suffix}`,
    telephoneNumber: `Telephone Number_${suffix}`,
    sharePercentage: `Share Percentage_${suffix}`,
    address: `Address_${suffix}`,
    emailAddress: `Email Address_${suffix}`,
    taxId: `Social Security Number_${suffix}`,
  } satisfies Record<keyof IraBeneficiaryPdfRow, string>;
}

function beneficiaryFieldIds(
  kind: "primary" | "contingent",
  key: keyof IraBeneficiaryPdfRow,
) {
  return Array.from({ length: 5 }, (_, index) => iraBeneficiaryRowFields(index, kind)[key]);
}

const manualBeneficiaryFields = (kind: "primary" | "contingent") => [
  {
    canonicalKey: `beneficiaries.${kind}[].full_legal_name`,
    label: `${kind} beneficiary legal name`,
    pdfFieldIds: beneficiaryFieldIds(kind, "fullName"),
    requirement: "required_when_row_used",
    source: "manual",
    sourcePath: null,
    sensitivity: "pii",
    transformation: "trim-collapse-whitespace",
  },
  {
    canonicalKey: `beneficiaries.${kind}[].relationship`,
    label: `${kind} beneficiary relationship`,
    pdfFieldIds: beneficiaryFieldIds(kind, "relationship"),
    requirement: "required_when_row_used",
    source: "manual",
    sourcePath: null,
    sensitivity: "pii",
    transformation: "trim-collapse-whitespace",
  },
  {
    canonicalKey: `beneficiaries.${kind}[].date_of_birth`,
    label: `${kind} beneficiary date of birth`,
    pdfFieldIds: beneficiaryFieldIds(kind, "dateOfBirth"),
    requirement: "required_when_row_used",
    source: "manual",
    sourcePath: null,
    sensitivity: "restricted_pii",
    transformation: "validate-MM/DD/YYYY",
  },
  {
    canonicalKey: `beneficiaries.${kind}[].phone`,
    label: `${kind} beneficiary telephone number`,
    pdfFieldIds: beneficiaryFieldIds(kind, "telephoneNumber"),
    requirement: "required_when_row_used",
    source: "manual",
    sourcePath: null,
    sensitivity: "pii",
    transformation: "trim-collapse-whitespace",
  },
  {
    canonicalKey: `beneficiaries.${kind}[].share_percent`,
    label: `${kind} beneficiary share percentage`,
    pdfFieldIds: beneficiaryFieldIds(kind, "sharePercentage"),
    requirement: "required_when_row_used",
    source: "manual",
    sourcePath: null,
    sensitivity: "pii",
    transformation: "whole-number-percent",
  },
  {
    canonicalKey: `beneficiaries.${kind}[].address`,
    label: `${kind} beneficiary address`,
    pdfFieldIds: beneficiaryFieldIds(kind, "address"),
    requirement: "required_when_row_used",
    source: "manual",
    sourcePath: null,
    sensitivity: "pii",
    transformation: "trim-collapse-whitespace",
  },
  {
    canonicalKey: `beneficiaries.${kind}[].email`,
    label: `${kind} beneficiary email address`,
    pdfFieldIds: beneficiaryFieldIds(kind, "emailAddress"),
    requirement: "required_when_row_used",
    source: "manual",
    sourcePath: null,
    sensitivity: "pii",
    transformation: "validate-email",
  },
  {
    canonicalKey: `beneficiaries.${kind}[].tax_id`,
    label: `${kind} beneficiary SSN or TIN`,
    pdfFieldIds: beneficiaryFieldIds(kind, "taxId"),
    requirement: "required_when_row_used",
    source: "manual",
    sourcePath: null,
    sensitivity: "restricted_pii",
    transformation: "digits-only",
  },
] as const;

export const IRA_BENEFICIARY_DEFINITION = {
  id: "ira_beneficiary_designation",
  code: "5050P-UBEN",
  name: "IRA Beneficiary Designation",
  version: "2025-07-17",
  effectiveOn: "2025-07-17",
  retiresOn: null,
  status: "internal_pilot",
  reviewState: "ready_for_human_review",
  entryPathSegment: "ira-beneficiary",
  summary:
    "Add account-holder and known beneficiary details. Leave the rest for the client.",
  callToAction: "Prepare Form",
  template: {
    relativePath: "assets/forms/apex/5050P-UBEN/2025-07-17/template.pdf",
    sha256: "d9020a1c19d9e825fb82fa9308a1098ff7ca7ca0dffa9d31a57648c7cbc6e328",
    pageCount: 2,
    fieldCount: 91,
  },
  eligibility: {
    context: "single_account",
    accountTypeIncludes: ["IRA"],
    description: "Available only when the selected authorized account type contains IRA.",
  },
  limits: {
    primaryBeneficiaries: 5,
    contingentBeneficiaries: 5,
  },
  fields: [
    {
      canonicalKey: "account.owner.full_legal_name",
      label: "Account-holder name",
      pdfFieldIds: [IRA_BENEFICIARY_ACCOUNT_FIELDS.accountHolderName],
      requirement: "required",
      source: "aoa",
      sourcePath: "mirror.client.first_name + mirror.client.last_name",
      sensitivity: "pii",
      transformation: "trim-collapse-whitespace",
    },
    {
      canonicalKey: "account.owner.tax_id",
      label: "Account-holder SSN or TIN",
      pdfFieldIds: [IRA_BENEFICIARY_ACCOUNT_FIELDS.accountHolderTaxId],
      requirement: "conditional",
      source: "manual",
      sourcePath: null,
      sensitivity: "restricted_pii",
      transformation: "remove-spaces-and-hyphens",
    },
    {
      canonicalKey: "account.apex_account_number",
      label: "Apex account number",
      pdfFieldIds: [IRA_BENEFICIARY_ACCOUNT_FIELDS.accountNumber],
      requirement: "required",
      source: "aoa",
      sourcePath: "mirror.client_account_aum.apex_account_number",
      sensitivity: "confidential",
      transformation: null,
    },
    ...manualBeneficiaryFields("primary"),
    ...manualBeneficiaryFields("contingent"),
    {
      canonicalKey: "consent.not_married_certification",
      label: "Not-married certification",
      pdfFieldIds: [IRA_BENEFICIARY_ACCOUNT_FIELDS.certifyNotMarried],
      requirement: "conditional",
      source: "manual",
      sourcePath: null,
      sensitivity: "pii",
      transformation: "boolean-to-checkbox",
    },
    {
      canonicalKey: "signatures.primary_owner",
      label: "Account-holder signature and date",
      pdfFieldIds: ["Signature of Account Holder", "Date_3"],
      requirement: "leave_blank",
      source: "human_signature",
      sourcePath: null,
      sensitivity: "restricted_pii",
      transformation: null,
    },
    {
      canonicalKey: "signatures.spouse",
      label: "Spouse signature and date",
      pdfFieldIds: ["Signature of Spouse", "Date"],
      requirement: "leave_blank",
      source: "human_signature",
      sourcePath: null,
      sensitivity: "restricted_pii",
      transformation: null,
    },
    {
      canonicalKey: "signatures.witness",
      label: "Witness signature and date",
      pdfFieldIds: ["Signature of Witness", "Date_2"],
      requirement: "leave_blank",
      source: "human_signature",
      sourcePath: null,
      sensitivity: "restricted_pii",
      transformation: null,
    },
  ],
  rules: [
    "A client-completion form requires the account-holder name and authorized account number and leaves all beneficiary rows blank for the client.",
    "Account-holder SSN or TIN is optional for form generation in every completion mode; when blank, the client must complete it before signing.",
    "Any supplied account-holder SSN or TIN must contain nine digits with only normal spaces or hyphens as separators; never use last four digits or masked values.",
    "Staff completion requires at least one complete primary beneficiary before generating a form; omitting the completion mode keeps these rules.",
    "Partial completion accepts only known beneficiary information; omitted fields remain blank for the client and are never inferred from account-holder data.",
    "Partially completed forms preserve beneficiary row positions and mark missing fields in each used row as required; entirely unused rows stay optional, except the first primary row when no primary is provided.",
    "Supplied partial share percentages must be whole numbers from 1 to 100 and each category must not exceed 100%; missing shares stay blank and totals below 100% require client completion.",
    "Before signing, at least one primary beneficiary must be complete and primary beneficiary shares must total 100%.",
    "If contingent beneficiaries are used, every used row must be complete and their shares must independently total 100%.",
    "Every additional primary beneficiary row used must be complete.",
    "Client-completion PDFs mark the first primary row as required; these PDF flags do not enforce DocuSign recipient fields or validate completion and share totals.",
    "A blank account-holder SSN or TIN is editable and marked required in the PDF in every mode; signer-field assignment and completion enforcement still belong to the signing workflow.",
    "The selected account must be an IRA visible to the authenticated user and belong to the selected client.",
  ],
  warnings: [
    "The AoA client name is a display name and must be confirmed as the legal account-holder name.",
    "Tax IDs and beneficiary values are transient and are not persisted by this pilot.",
    "Account-holder SSN or TIN is entered manually or left blank for the client; it is never prefilled from an AoA source or last-four value.",
    "Account-holder, spouse, and witness signature fields remain blank for human review and signing.",
    "Generating a form does not authorize sending or submission.",
  ],
  outputFilenamePattern: "5050P-UBEN-{accountLast4}.pdf",
} as const satisfies FormDefinition;
