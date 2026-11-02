"use server";

import { tradeRequestsDriftViewEnabled, tradeRequestsWorkspaceEnabled } from "@/lib/flags";
import { callTradeRequestService } from "@/lib/trade-requests/client";
import { DRIFT_COPY } from "@/lib/trade-requests/drift-view/api";
import type { ExclusionExportRow } from "@/lib/trade-requests/drift-view/model";
import { exclusionExportResponseSchema } from "@/lib/trade-requests/drift-view/schemas";
import { isAoaServed } from "@/lib/trade-requests/serving-state";

export type DriftExclusionsExport = { ok: true; rows: ExclusionExportRow[] } | { ok: false; message: string };

// The Drift screen's firm-wide standing-exclusions export (standalone GET /clients/exclusions/export).
// The client confirms the signed-in person and their workspace role on every call.
export async function exportDriftExclusions(): Promise<DriftExclusionsExport> {
  if (!tradeRequestsWorkspaceEnabled() || !tradeRequestsDriftViewEnabled() || !(await isAoaServed())) {
    return { ok: false, message: DRIFT_COPY.unavailable };
  }
  const result = await callTradeRequestService<unknown>({
    operation: "exportExclusions", method: "GET", path: "/clients/exclusions/export", defaultMessage: DRIFT_COPY.exportExclusionsFailed,
  });
  if (!result.ok) return { ok: false, message: result.message };
  const parsed = exclusionExportResponseSchema.safeParse(result.data);
  return parsed.success ? { ok: true, rows: parsed.data.data } : { ok: false, message: DRIFT_COPY.exportExclusionsFailed };
}
