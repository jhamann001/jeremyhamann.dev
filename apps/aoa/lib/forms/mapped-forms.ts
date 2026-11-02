import type { MappedFormSpec } from "./mapped-form-spec";
import { TOD_REGISTRATION } from "./mapped-registrations/tod";
import { ACH_REGISTRATION } from "./mapped-registrations/ach";
import { CONVERSION_REGISTRATION } from "./mapped-registrations/conversion";
import { IRA_DISTRIBUTION_REGISTRATION } from "./mapped-registrations/ira-distribution";
import { ROTH_DISTRIBUTION_REGISTRATION } from "./mapped-registrations/roth-distribution";
import { WIRE_REGISTRATION } from "./mapped-registrations/wire";

// Each form owns its registration slot so adding or reverting one form does not
// edit another form's imports. The foundation can run with every slot disabled.
export const MAPPED_FORM_SPECS: readonly MappedFormSpec[] = [
  TOD_REGISTRATION,
  ACH_REGISTRATION,
  CONVERSION_REGISTRATION,
  IRA_DISTRIBUTION_REGISTRATION,
  ROTH_DISTRIBUTION_REGISTRATION,
  WIRE_REGISTRATION,
].filter((spec): spec is MappedFormSpec => spec !== null);
export const getMappedFormSpec = (formId: string) => MAPPED_FORM_SPECS.find(spec => spec.definition.id === formId) ?? null;
export const getMappedFormSpecBySlug = (slug: string) => MAPPED_FORM_SPECS.find(spec => spec.definition.entryPathSegment === slug) ?? null;
