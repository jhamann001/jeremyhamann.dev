// Thin browser wrapper around the shared PDF builders. All rendering lives in
// `@trade-request/shared/pdf` so the server (MCP tools) and the browser produce
// byte-identical documents from one source of truth. This file only adds the
// browser-only `doc.save(...)` download step.
import {
  buildCompliancePdf,
  buildRequestPdf,
  type ExportAccountExclusion,
  type ExportIdentity,
} from '@trade-request/shared/pdf';
import type { ClientExclusion, TradeRequest } from '@trade-request/shared';

// Re-exported so existing client call sites can keep importing these from here.
export type { ExportAccountExclusion, ExportIdentity };

export async function exportRequestPdf(
  request: TradeRequest,
  exporter: ExportIdentity,
  accountExclusions: ExportAccountExclusion[] = [],
): Promise<void> {
  const { doc, filename } = buildRequestPdf(request, exporter, accountExclusions);
  doc.save(filename);
}

export async function exportCompliancePdf(
  requests: TradeRequest[],
  exporter: ExportIdentity,
  standingExclusionsByClient: Record<string, ClientExclusion[]> = {},
  accountExclusionsByRequestId: Record<string, ExportAccountExclusion[]> = {},
): Promise<void> {
  const { doc, filename } = buildCompliancePdf(
    requests,
    exporter,
    standingExclusionsByClient,
    accountExclusionsByRequestId,
  );
  doc.save(filename);
}
