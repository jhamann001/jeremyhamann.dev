import type { MappedFormSpec } from "./mapped-form-spec";
import { distributionFieldDefinitions, distributionSections } from "./distribution-fields";

const sections = distributionSections(false);

export const IRA_DISTRIBUTION_SPEC = {
  definition: {
    id: "ira_distribution_request", code: "IRA-DISTRIBUTION", name: "Traditional IRA Distribution Request",
    version: "source-2026-09-18", effectiveOn: null, retiresOn: null, status: "internal_pilot",
    reviewState: "ready_for_human_review", entryPathSegment: "ira-distribution",
    summary: "Add known withdrawal details for a Traditional, SEP, or SIMPLE IRA.",
    callToAction: "Prepare Form",
    template: { relativePath: "assets/forms/apex/ira-distribution/source-2026-09-18/template.pdf", sha256: "a1f84fb74e1d2a252d2de97075babc94d0781165bcd72f8bf0e2376e663e4934", pageCount: 14, fieldCount: 112 },
    eligibility: { context: "single_account", accountTypeIncludes: ["IRA"], accountTypeExcludes: ["Roth"], description: "Select the authorized distributing non-Roth IRA. Account labeling does not establish distribution eligibility." },
    limits: {}, fields: distributionFieldDefinitions(sections),
    rules: [
      "The authorized selected account is the distributing IRA; all destination accounts are separate manual inputs.",
      "Beneficiary or former-spouse details remain blank unless independently supplied.",
      "Every manual field except the confirmed legal owner name is optional for form generation.",
      "Distribution method and account type are set only when explicitly selected.",
      "Distribution reason, withholding, payment delivery, securities, schedules, signatures and approvals require human completion where applicable.",
    ],
    warnings: [
      "This form is for non-Roth IRAs; use the separate Roth distribution form for a Roth IRA.",
      "The form does not determine distribution eligibility, tax treatment, or withholding.",
      "A blank withholding section does not elect zero withholding. Review the source form's instructions.",
      "All fourteen source pages, including instructions and authorization pages, remain in the packet.",
    ],
    outputFilenamePattern: "ira-distribution-{accountLast4}.pdf",
  },
  accountLabel: "Distributing Traditional / SEP / SIMPLE IRA",
  confirmation: "I confirm the selected Apex account is the distributing non-Roth IRA, and the name shown is its legal owner.",
  sections,
  preserveFields: ["Logo Placement_af_image"],
  completionChecklist: [
    "Confirm the legal account holder, distributing IRA number, account type, and any beneficiary or former-spouse details.",
    "Complete missing tax IDs and select the correct distribution reason using current instructions and supporting documents.",
    "Confirm the distribution method and amount; complete securities, frequency, and scheduling elections if applicable.",
    "Review and complete federal and state withholding. No withholding election is inferred by this form.",
    "Select the delivery instruction and independently verify any alternate payee, address, journal account, or wire destination.",
    "Complete an alternate payee's state manually; the source form's state widget is too narrow for reliable automated entry.",
    "Complete any excess-contribution, recharacterization, or employer-plan details manually when applicable.",
    "Obtain the client signature and date, any required notary, and advisor/internal approvals after review.",
  ],
} as const satisfies MappedFormSpec;
