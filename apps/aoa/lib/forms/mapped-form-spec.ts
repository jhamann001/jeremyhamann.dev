import type { FormDefinition } from "./form-definition";

/** Deliberate allowlist: request payloads never choose PDF field names. */
export type MappedInputKind = "text" | "date" | "phone" | "email" | "taxId" | "taxIdLast4" | "routing" | "money" | "percent" | "choice";
export type MappedFormInput = {
  key: string;
  label: string;
  kind: MappedInputKind;
  pdfFields?: readonly string[];
  /** Only accountNumber is server owned. clientName is an editable suggestion. */
  source?: "accountNumber" | "clientName";
  requiredForDraft?: boolean;
  hint?: string;
  maxLength?: number;
  min?: number;
  wholeNumber?: boolean;
  allowFutureDate?: boolean;
  /** Reject a conflicting explicit election, while still allowing an unknown election. */
  allowedWhen?: { key: string; values: readonly string[] };
  options?: readonly { value: string; label: string; pdfFields: readonly string[]; pdfValue?: string }[];
  /** Used only for printing the authorized segmented Apex identifier. */
  accountPart?: "branch" | "number";
  characterBoxes?: boolean;
};
export type MappedFormSection = {
  title: string;
  description?: string;
  collapsed?: boolean;
  fields: readonly MappedFormInput[];
};
export type MappedFormSpec = {
  definition: FormDefinition;
  accountLabel: string;
  confirmation: string;
  sections: readonly MappedFormSection[];
  completionChecklist: readonly string[];
  /** Optional registered, server-side repair applied to the output only. */
  repair?: string;
  /** Static artwork masquerading as a form widget; never an input mapping. */
  preserveFields?: readonly string[];
  /** Optional grouping for entered beneficiary percentages (draft total may be below 100). */
  percentageGroups?: readonly (readonly string[])[];
};

export const mappedInputs = (spec: MappedFormSpec) => spec.sections.flatMap(section => section.fields);
