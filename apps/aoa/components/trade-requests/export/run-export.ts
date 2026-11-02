import { EXPORT_COPY, parseTradeRequestExport, type ExportFormat, type TradeRequestExport } from "@/lib/trade-requests/export-model";
import { QUEUE_COPY } from "@/lib/trade-requests/queue-model";
import type { TradeRequestExporter } from "@/lib/trade-requests/request-types";
import { TRADE_REQUESTS_API } from "@/lib/trade-requests/routes";
import { saveFile } from "./save-file";

type ExportRead = { ok: true; data: TradeRequestExport } | { ok: false; message: string };

// The route answers with the read's outcome; a 401/403 or a redirect means the
// AOA session or role is gone; anything else on this hop has no failure text.
export async function fetchTradeRequestExport(): Promise<ExportRead> {
  let body: unknown;
  try {
    const response = await fetch(TRADE_REQUESTS_API.export, {
      cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" },
    });
    if (response.redirected || response.status === 401 || response.status === 403) return { ok: false, message: QUEUE_COPY.signedOut };
    if (!response.ok) return { ok: false, message: EXPORT_COPY.defaultReason };
    body = await response.json();
  } catch {
    return { ok: false, message: EXPORT_COPY.defaultReason };
  }
  const result = body as { ok?: unknown; message?: unknown; data?: unknown } | null;
  if (result?.ok === true) {
    const data = parseTradeRequestExport(result.data);
    if (data) return { ok: true, data };
  } else if (result?.ok === false && typeof result.message === "string" && result.message) {
    return { ok: false, message: result.message };
  }
  return { ok: false, message: EXPORT_COPY.defaultReason };
}

/**
 * Export Compliance Log: reads every request in the firm, writes the read's
 * warnings into the session messages, then builds and downloads the file.
 * Every failure becomes the "Export failed: …" session message; a failure
 * while building the file carries the default reason, never script error text.
 */
export async function runTradeRequestExport(
  format: ExportFormat,
  exporter: TradeRequestExporter,
  addMessage: (message: string) => void,
): Promise<void> {
  const read = await fetchTradeRequestExport();
  if (!read.ok) {
    addMessage(EXPORT_COPY.failed(read.message));
    return;
  }
  const { requests, standingByClient, accountExclusionsByRequestId, messages } = read.data;
  for (const message of messages) addMessage(message);
  try {
    if (format === "pdf") {
      const { buildCompliancePdf } = await import("./compliance-pdf");
      const built = await buildCompliancePdf(requests, exporter, standingByClient, accountExclusionsByRequestId);
      saveFile(built.bytes as BlobPart, "application/pdf", built.filename);
    } else {
      const { buildComplianceCsv } = await import("./compliance-csv");
      const built = await buildComplianceCsv(requests, exporter, standingByClient, accountExclusionsByRequestId);
      saveFile(built.text, "text/csv;charset=utf-8;", built.filename);
    }
  } catch {
    addMessage(EXPORT_COPY.failed(EXPORT_COPY.defaultReason));
  }
}
