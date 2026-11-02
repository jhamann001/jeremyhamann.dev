import {
  SAVED_NOTICE_MS, SCAN_MESSAGE_MS, failureAlert, scanMessageFor,
  type DocumentsAction, type ScanResult,
} from "./documents-model";
import type { DriveResult, PdfResult } from "./documents-client";

export type DocumentsDeps = {
  client: {
    householdPdf: (householdId: string) => Promise<PdfResult>;
    allClientsPdf: () => Promise<PdfResult>;
    saveToDrive: (householdId: string) => Promise<DriveResult>;
    scan: () => Promise<ScanResult>;
  };
  dispatch: (action: DocumentsAction) => void;
  /** Returns a function that cancels the scheduled call. */
  schedule: (fn: () => void, ms: number) => () => void;
  /** The pending scan-message clear, so a newer scan message is never cleared by an older timer. */
  scanClear: { cancel: (() => void) | null };
  download: (blob: Blob, filename: string) => void;
};

export async function performPdf(kind: "pdf" | "allPdf", householdId: string | null, deps: DocumentsDeps): Promise<void> {
  deps.dispatch({ type: "start", kind });
  const res = kind === "pdf" && householdId != null ? await deps.client.householdPdf(householdId) : await deps.client.allClientsPdf();
  if (!res.ok) {
    deps.dispatch({ type: "failed", kind, householdId: kind === "pdf" ? householdId : null, text: failureAlert(kind, res.status, res.forbidden) });
    return;
  }
  deps.download(res.blob, res.filename);
  deps.dispatch({ type: "pdfDone", kind });
}

export async function performDriveSave(kind: "markCompleted" | "saveToDrive", householdId: string, deps: DocumentsDeps): Promise<void> {
  deps.dispatch({ type: "start", kind });
  const res = await deps.client.saveToDrive(householdId);
  if (!res.ok) {
    deps.dispatch({ type: "failed", kind, householdId, text: failureAlert(kind, res.status, res.forbidden) });
    return;
  }
  deps.dispatch({
    type: "driveSaved", kind, householdId,
    filename: res.filename, webViewLink: res.webViewLink, reviewedAt: res.reviewedAt, reviewer: res.reviewer,
  });
  deps.schedule(() => deps.dispatch({ type: "clearNotice", householdId }), SAVED_NOTICE_MS);
}

function cancelScanClear(deps: DocumentsDeps): void {
  deps.scanClear.cancel?.();
  deps.scanClear.cancel = null;
}

/**
 * onFinished runs once the scan response has arrived. With the on-demand import
 * flag on it runs the import and then refreshes the open household (ticket,
 * owner approval 2026-10-05); with the flag off it only re-reads the stored list.
 */
export async function performScan(onFinished: () => void, deps: DocumentsDeps): Promise<void> {
  cancelScanClear(deps);
  deps.dispatch({ type: "start", kind: "scan" });
  const res = await deps.client.scan();
  deps.dispatch({ type: "scanDone", message: scanMessageFor(res) });
  if (res.kind === "finished") onFinished();
  cancelScanClear(deps);
  deps.scanClear.cancel = deps.schedule(() => deps.dispatch({ type: "clearScanMessage" }), SCAN_MESSAGE_MS);
}
