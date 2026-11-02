import type { AssetMapReviewState } from "@/lib/data/asset-map";

export const DOC_COPY = {
  exportPdf: "Export PDF", exportAll: "Export All Clients PDF", generating: "Generating…", generatingAll: "Generating...",
  markCompleted: "Mark as Completed", saveToDrive: "Save to Drive", saving: "Saving…",
  savedToDrive: "Saved to Drive", openInDrive: "Open in Drive",
  runScan: "Run scan", runScanTitle: "Run Drive input folder scan now",
  scanBusy: "A scan is already in progress.", scanRequestFailed: "Scan request failed", dismiss: "Dismiss",
} as const;
export const SAVED_NOTICE_MS = 8000;
export const SCAN_MESSAGE_MS = 6000;

/** Exact review instant to the microsecond, offset-normalized; null when unparseable. */
export function reviewInstantKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/.exec(iso);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}${m[3] ?? "Z"}`);
  return Number.isNaN(ms) ? null : `${ms / 1000}.${(m[2] ?? "").padEnd(6, "0")}`;
}

/** The mapping app's rule (App.jsx line 2425). Unknown state is not current. */
export function isReviewCurrent(review: Pick<AssetMapReviewState, "reviewedAt" | "updatedAt"> | null): boolean {
  if (!review?.reviewedAt) return false;
  const reviewed = Date.parse(review.reviewedAt);
  if (Number.isNaN(reviewed)) return false;
  if (!review.updatedAt) return true;
  const updated = Date.parse(review.updatedAt);
  return Number.isNaN(updated) || updated <= reviewed;
}

export type AuditReviewer = { reviewedAt: string; reviewer: string };

/** Owner ruling 2026-10-04: the AoA person only when the audit row's review
 *  time equals the pipeline's current review time; else the pipeline reviewer. */
export function resolveReviewer(review: AssetMapReviewState | null, audit: AuditReviewer | null): string | null {
  if (!review?.reviewedAt) return null;
  const current = reviewInstantKey(review.reviewedAt);
  if (audit && current != null && reviewInstantKey(audit.reviewedAt) === current) return audit.reviewer;
  return review.reviewedBy;
}

export type SavedReview = { householdId: string; reviewedAt: string; reviewer: string | null };
export type EffectiveReview = { current: boolean; reviewedAt: string | null; reviewer: string | null };

export function effectiveReview(
  householdId: string | null,
  live: AssetMapReviewState | null,
  saved: SavedReview | null,
  audit: AuditReviewer | null,
): EffectiveReview {
  if (saved && saved.householdId === householdId) {
    return { current: isReviewCurrent({ reviewedAt: saved.reviewedAt, updatedAt: live?.updatedAt ?? null }), reviewedAt: saved.reviewedAt, reviewer: saved.reviewer };
  }
  if (live == null) return { current: false, reviewedAt: null, reviewer: null };
  return { current: isReviewCurrent(live), reviewedAt: live.reviewedAt, reviewer: resolveReviewer(live, audit) };
}

export function reviewedLabel(reviewer: string | null, reviewedAt: string): string {
  const short = (reviewer ?? "").split("@")[0] || "ops";
  const at = new Date(reviewedAt).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York",
  });
  return `Reviewed by ${short} at ${at}`;
}

export type DocumentKind = "pdf" | "allPdf" | "markCompleted" | "saveToDrive";
const FAILURE_LABEL: Record<DocumentKind, string> = {
  pdf: "PDF export failed", allPdf: "Export failed", markCompleted: "Mark as Completed failed", saveToDrive: "Save to Drive failed",
};
export function failureAlert(kind: DocumentKind, status: number | null, forbidden = false): string {
  return `${FAILURE_LABEL[kind]} (${forbidden ? "not allowed" : status == null ? "no response" : status})`;
}

export type ScanResult =
  | { kind: "finished"; clientsProcessed: number }
  | { kind: "busy" }
  | { kind: "forbidden" }
  | { kind: "failed"; status: number | null; detail: string | null };

export type ScanMessage = { text: string; variant: "success" | "warn" | "error" };

export function scanMessageFor(r: ScanResult): ScanMessage {
  switch (r.kind) {
    case "finished":
      return { text: `Scan finished — ${r.clientsProcessed} client(s) processed.`, variant: "success" };
    case "busy":
      return { text: DOC_COPY.scanBusy, variant: "warn" };
    case "forbidden":
      return { text: "Operations role required", variant: "error" };
    case "failed":
      if (r.detail) return { text: r.detail, variant: "error" };
      return { text: r.status == null ? DOC_COPY.scanRequestFailed : `Scan failed (${r.status})`, variant: "error" };
  }
}

export type DocumentsState = {
  busy: Record<DocumentKind | "scan", boolean>;
  alert: { householdId: string | null; text: string } | null;
  notice: { householdId: string; filename: string; webViewLink: string; reviewer: string | null } | null;
  saved: SavedReview | null;
  audit: AuditReviewer | null;
  scanMessage: ScanMessage | null;
};

export type DocumentsAction =
  | { type: "start"; kind: DocumentKind | "scan" }
  | { type: "pdfDone"; kind: "pdf" | "allPdf" }
  | { type: "failed"; kind: DocumentKind; householdId: string | null; text: string }
  | { type: "driveSaved"; kind: "markCompleted" | "saveToDrive"; householdId: string; filename: string; webViewLink: string; reviewedAt: string; reviewer: string | null }
  | { type: "scanDone"; message: ScanMessage }
  | { type: "auditLoaded"; audit: AuditReviewer | null }
  | { type: "clearNotice"; householdId: string } | { type: "clearScanMessage" } | { type: "dismissAlert" } | { type: "reset" };

export function initialDocumentsState(): DocumentsState {
  return {
    busy: { pdf: false, allPdf: false, markCompleted: false, saveToDrive: false, scan: false },
    alert: null, notice: null, saved: null, audit: null, scanMessage: null,
  };
}

export function documentsReducer(state: DocumentsState, action: DocumentsAction): DocumentsState {
  switch (action.type) {
    case "start":
      return {
        ...state,
        busy: { ...state.busy, [action.kind]: true },
        alert: action.kind === "scan" ? state.alert : null,
        scanMessage: action.kind === "scan" ? null : state.scanMessage,
      };
    case "pdfDone":
      return { ...state, busy: { ...state.busy, [action.kind]: false } };
    case "failed":
      return { ...state, busy: { ...state.busy, [action.kind]: false }, alert: { householdId: action.householdId, text: action.text } };
    case "driveSaved":
      return {
        ...state,
        busy: { ...state.busy, [action.kind]: false },
        notice: { householdId: action.householdId, filename: action.filename, webViewLink: action.webViewLink, reviewer: action.reviewer },
        saved: { householdId: action.householdId, reviewedAt: action.reviewedAt, reviewer: action.reviewer },
      };
    case "scanDone":
      return { ...state, busy: { ...state.busy, scan: false }, scanMessage: action.message };
    case "auditLoaded":
      return { ...state, audit: action.audit };
    case "clearNotice":
      return state.notice?.householdId === action.householdId ? { ...state, notice: null } : state;
    case "clearScanMessage":
      return { ...state, scanMessage: null };
    case "dismissAlert":
      return { ...state, alert: null };
    case "reset": {
      const fresh = initialDocumentsState();
      return { ...fresh, busy: { ...fresh.busy, scan: state.busy.scan, allPdf: state.busy.allPdf }, scanMessage: state.scanMessage };
    }
  }
}

/** A household failure that arrives after a switch never shows on the new household; an all-clients failure (null) shows anywhere. */
export function visibleAlert(state: DocumentsState, householdId: string | null): string | null {
  if (state.alert == null) return null;
  return state.alert.householdId == null || state.alert.householdId === householdId ? state.alert.text : null;
}

/** A save that finishes after the user switched household never shows on the new one. */
export function visibleNotice(state: DocumentsState, householdId: string | null): DocumentsState["notice"] {
  return state.notice != null && state.notice.householdId === householdId ? state.notice : null;
}
