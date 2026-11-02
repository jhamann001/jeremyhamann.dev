import { loadRequestPdfExclusions } from "@/app/(authenticated)/trade-requests/[id]/actions";
import { REQUEST_DETAIL_COPY, pdfAccountExclusions, uniqueAccountIds } from "@/lib/trade-requests/detail-view";
import type { TradeRequest, TradeRequestAccount, TradeRequestExporter } from "@/lib/trade-requests/request-types";

function saveFile(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Download PDF: the selected accounts' standing exclusions, then the document.
 * Returns the failure text (service text first, as in the standalone app), or
 * null once the file is saved.
 */
export async function downloadRequestPdf(
  request: TradeRequest,
  accounts: TradeRequestAccount[],
  exporter: TradeRequestExporter,
): Promise<string | null> {
  try {
    const lookup = await loadRequestPdfExclusions(uniqueAccountIds(accounts));
    if (!lookup.ok) return lookup.message || REQUEST_DETAIL_COPY.pdfFailed;
    const { buildRequestPdf } = await import("@/lib/trade-requests/request-pdf");
    const { bytes, filename } = await buildRequestPdf(request, exporter, pdfAccountExclusions(accounts, lookup.byAccountId));
    saveFile(bytes, filename);
    return null;
  } catch (error) {
    return error instanceof Error && error.message ? error.message : REQUEST_DETAIL_COPY.pdfFailed;
  }
}
