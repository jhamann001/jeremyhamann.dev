import type { MappedTemplateRepair } from "../mapped-template-repairs";
import { repairTodTemplate } from "../tod-template-repair";

export const TOD_TEMPLATE_REPAIR: MappedTemplateRepair | null = {
  id: "tod-beneficiary-address",
  repair: repairTodTemplate,
};
