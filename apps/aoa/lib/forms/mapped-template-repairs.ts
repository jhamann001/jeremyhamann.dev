import type { PDFDocument } from "pdf-lib";
import { TOD_TEMPLATE_REPAIR } from "./mapped-repairs/tod";

export type MappedTemplateRepair = { id: string; repair: (pdf: PDFDocument) => void };
export const MAPPED_TEMPLATE_REPAIRS: readonly MappedTemplateRepair[] = [
  TOD_TEMPLATE_REPAIR,
].filter((repair): repair is MappedTemplateRepair => repair !== null);
