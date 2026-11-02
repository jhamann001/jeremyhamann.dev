import type { FormDefinition } from "./form-definition";
import { isDefinitionEligibleForAccountType } from "./form-definition";
import { IRA_BENEFICIARY_DEFINITION } from "./ira-beneficiary-definition";
import { ACAT_DEFINITION } from "./acat-definition";
import { MAPPED_FORM_SPECS } from "./mapped-forms";

export const FORM_DEFINITIONS = [IRA_BENEFICIARY_DEFINITION, ACAT_DEFINITION, ...MAPPED_FORM_SPECS.map(spec => spec.definition)] as const satisfies readonly FormDefinition[];

export type FormId = (typeof FORM_DEFINITIONS)[number]["id"];

const definitionsById = new Map<string, FormDefinition>(
  FORM_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function getFormDefinition(formId: string): FormDefinition | null {
  return definitionsById.get(formId) ?? null;
}

export function getEligibleFormDefinitions(accountTypes: readonly (string | null | undefined)[]) {
  return FORM_DEFINITIONS.filter((definition) =>
    definition.status !== "retired" && accountTypes.some((accountType) => isDefinitionEligibleForAccountType(definition, accountType)),
  );
}
