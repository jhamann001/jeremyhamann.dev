import type { ScanResult } from "./documents-model";

// Browser calls to the documents route handlers. Route handlers, not server
// actions: Next runs a page's server actions one at a time, so a scan or a PDF
// as an action would queue household loads, the schedule poll, and edits.

/** Just over the route's 300 s pipeline wait, so the route's failure arrives first. */
export const DOCUMENT_CLIENT_WAIT_MS = 305_000;
/** Over the route's 1180 s scan wait and under AoA's 1200 s Cloud Run limit. */
export const SCAN_CLIENT_WAIT_MS = 1_190_000;

export type DocumentFailure = { ok: false; forbidden: boolean; status: number | null };
export type PdfResult = { ok: true; filename: string; blob: Blob } | DocumentFailure;
export type DriveResult = { ok: true; filename: string; webViewLink: string; reviewedAt: string; reviewer: string | null } | DocumentFailure;

type Fetcher = typeof fetch;

function init(method: "GET" | "POST", waitMs: number): RequestInit {
  return { method, signal: AbortSignal.timeout(waitMs), cache: "no-store", credentials: "same-origin", redirect: "error" };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await res.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function failure(res: Response): Promise<DocumentFailure> {
  const b = await json(res);
  const forbidden = res.status === 401 || res.status === 403 || res.status === 404;
  return { ok: false, forbidden, status: typeof b.status === "number" ? b.status : null };
}

function filenameOf(res: Response, fallback: string): string {
  const m = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "");
  return m ? m[1] : fallback;
}

async function pdf(url: string, fallback: string, fetcher: Fetcher): Promise<PdfResult> {
  try {
    const res = await fetcher(url, init("GET", DOCUMENT_CLIENT_WAIT_MS));
    if (res.status !== 200) return failure(res);
    return { ok: true, filename: filenameOf(res, fallback), blob: await res.blob() };
  } catch {
    return { ok: false, forbidden: false, status: null };
  }
}

export function requestHouseholdPdf(householdId: string, fetcher: Fetcher = fetch): Promise<PdfResult> {
  return pdf(`/api/asset-mapping/households/${encodeURIComponent(householdId)}/pdf`, "export_report.pdf", fetcher);
}

export function requestAllClientsPdf(fetcher: Fetcher = fetch): Promise<PdfResult> {
  return pdf("/api/asset-mapping/export-pdf", "all_clients_report.pdf", fetcher);
}

export async function requestSaveToDrive(householdId: string, fetcher: Fetcher = fetch): Promise<DriveResult> {
  try {
    const res = await fetcher(`/api/asset-mapping/households/${encodeURIComponent(householdId)}/save-to-drive`, init("POST", DOCUMENT_CLIENT_WAIT_MS));
    if (res.status !== 200) return failure(res);
    const b = await json(res);
    if (typeof b.filename !== "string" || typeof b.reviewedAt !== "string") return { ok: false, forbidden: false, status: null };
    return {
      ok: true,
      filename: b.filename,
      webViewLink: typeof b.webViewLink === "string" ? b.webViewLink : "",
      reviewedAt: b.reviewedAt,
      reviewer: typeof b.reviewer === "string" ? b.reviewer : null,
    };
  } catch {
    return { ok: false, forbidden: false, status: null };
  }
}

export async function requestScan(fetcher: Fetcher = fetch): Promise<ScanResult> {
  try {
    const res = await fetcher("/api/asset-mapping/scan", init("POST", SCAN_CLIENT_WAIT_MS));
    const b = await json(res);
    if (res.status === 200) return { kind: "finished", clientsProcessed: typeof b.clientsProcessed === "number" ? b.clientsProcessed : 0 };
    if (res.status === 409) return { kind: "busy" };
    if (res.status === 401 || res.status === 403 || res.status === 404) return { kind: "forbidden" };
    return { kind: "failed", status: typeof b.status === "number" ? b.status : null, detail: typeof b.detail === "string" ? b.detail : null };
  } catch {
    return { kind: "failed", status: null, detail: null };
  }
}
