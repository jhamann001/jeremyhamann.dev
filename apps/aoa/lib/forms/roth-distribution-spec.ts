import type { MappedFormSpec } from "./mapped-form-spec";
import { distributionFieldDefinitions, distributionSections } from "./distribution-fields";

const sections = distributionSections(true);

export const ROTH_DISTRIBUTION_SPEC = {
  definition: {
    id: "roth_ira_distribution_request", code: "ROTH-IRA-DISTRIBUTION", name: "Roth IRA Distribution Request",
    version: "source-2026-09-18", effectiveOn: null, retiresOn: null, status: "internal_pilot",
    reviewState: "ready_for_human_review", entryPathSegment: "roth-ira-distribution",
    summary: "Add known Roth IRA withdrawal details for review and client completion.",
    callToAction: "Prepare Form",
    template: { relativePath: "assets/forms/apex/roth-ira-distribution/source-2026-09-18/template.pdf", sha256: "3a19bfdef0fda96f662f231ccde10f237b64fbb81a404384c18df07b28fa8957", pageCount: 7, fieldCount: 105 },
    eligibility: { context: "single_account", accountTypeIncludes: ["IRA", "Roth"], description: "Select the authorized distributing Roth IRA. Account labeling does not establish distribution eligibility." },
    limits: {}, fields: distributionFieldDefinitions(sections),
    rules: [
      "The selected authorized account is the distributing Roth IRA; all destination accounts are separate manual inputs.",
      "Both printed tax-ID labels request the last four digits only; never populate a full tax ID in those fields.",
      "Known beneficiary or former-spouse information can be entered independently and is never inferred from owner details.",
      "Every manual field except the confirmed legal owner name is optional for form generation; omitted values remain blank.",
      "Distribution method is selected only from an explicit input. Reasons, tax withholding and payment delivery remain for human review.",
      "Client, notary, investment-advisor and internal approval signatures and dates remain blank.",
    ],
    warnings: [
      "Use only for a Roth IRA; this form does not determine whether a distribution is qualified or taxable.",
      "The source PDF's internal tax-ID field names differ from its printed last-four-only labels; this mapping follows the visible labels.",
      "No tax withholding, delivery, or distribution-reason election is inferred.",
      "All seven source pages, including instructions and approvals, remain in the packet.",
    ],
    outputFilenamePattern: "roth-ira-distribution-{accountLast4}.pdf",
  },
  accountLabel: "Distributing Roth IRA account",
  confirmation: "I confirm the selected Apex account is the distributing Roth IRA, and the name shown is its legal owner.",
  sections,
  preserveFields: ["Image27_af_image"],
  completionChecklist: [
    "Confirm the legal owner and distributing Roth IRA account; complete tax-ID last four digits if missing.",
    "Complete beneficiary or former-spouse information only if applicable; this section does not designate beneficiaries.",
    "Select the distribution reason after review; no qualification or tax conclusion is inferred from the account type or date of birth.",
    "Confirm the distribution method and amount, then complete securities, frequency, and scheduling elections if applicable.",
    "Review and complete federal and state withholding and any excess-contribution or recharacterization calculations.",
    "Select delivery instructions and independently verify any payee, address, journal account, or wire destination.",
    "Obtain client signature/date and any required notary, signature guarantee, advisor or internal approvals after review.",
  ],
} as const satisfies MappedFormSpec;
