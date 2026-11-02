import { z } from "zod";

export const acatLegacyDiagnosticSchema = z.object({
  legacyOnlyCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  archivedLegacyOnlyCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  candidateTransferId: z.string().min(1).max(200).nullable(),
}).strict().refine((value) =>
  value.archivedLegacyOnlyCount <= value.legacyOnlyCount &&
  (value.legacyOnlyCount === 0) === (value.candidateTransferId === null),
);

export type AcatLegacyDiagnostic = z.infer<typeof acatLegacyDiagnosticSchema>;
