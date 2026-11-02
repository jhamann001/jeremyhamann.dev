import "server-only";
import { ServiceAuth } from "@/lib/demo/service-auth";
import { Prisma } from "@prisma/client";

// In-app asset-mapping documents. The statement-pipeline generates the
// PDFs, files them to Drive, stamps the review, and runs scans; these call its
// four routes that accept AoA's allowlisted service account. The token
// audience is the pipeline base URL (lib/data/asset-map.ts assetMapBaseUrl).
// NO-LOG: never the url, token, filename, or body — static markers and
// status codes only.

const auth = new ServiceAuth();
const LOG_TAG = "asset-map";

/** PDFs and Save to Drive (owner ruling 2026-10-04). */
export const DOCUMENT_TIMEOUT_MS = 300_000;
/** Manual scan. Under AoA's 1200 s Cloud Run limit, so the route still
 *  answers (and audits) before Cloud Run ends the request. */
export const SCAN_TIMEOUT_MS = 1_180_000;

export type AssetMapDocumentFailure = { ok: false; reason: "failed"; status: number | null };
export type AssetMapPdf = { filename: string; bytes: Uint8Array<ArrayBuffer> };
export type AssetMapDriveSave = { filename: string; webViewLink: string; reviewedAt: string };
export type AssetMapScanOutcome =
  | { ok: true; clientsProcessed: number }
  | { ok: false; reason: "busy" }
  | { ok: false; reason: "failed"; status: number | null; detail: string | null };

type Res = { status: number; data: unknown; headers: unknown };

async function call(baseUrl: string, method: "GET" | "POST", path: string, timeout: number, binary: boolean): Promise<Res | null> {
  try {
    const client = await auth.getIdTokenClient(baseUrl);
    return (await client.request({
      url: `${baseUrl}${path}`,
      method,
      timeout,
      responseType: binary ? "arraybuffer" : "json",
      validateStatus: () => true,
    })) as Res;
  } catch {
    console.error(`[${LOG_TAG}] documents_transport_failed`);
    return null;
  }
}

function header(headers: unknown, name: string): string | null {
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get: (n: string) => string | null }).get(name);
  }
  const v = (headers as Record<string, unknown> | null)?.[name];
  return typeof v === "string" ? v : null;
}

/** The pipeline's filename, reduced to characters safe in a header value. */
export function pdfFilename(disposition: string | null, fallback: string): string {
  const m = /filename="([^"]+)"/.exec(disposition ?? "");
  const safe = (m ? m[1] : fallback).replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.toLowerCase().endsWith(".pdf") ? safe : fallback;
}

function body(res: Res): Record<string, unknown> {
  return res.data && typeof res.data === "object" && !Array.isArray(res.data) ? (res.data as Record<string, unknown>) : {};
}

async function pdf(baseUrl: string, path: string, fallback: string): Promise<{ ok: true; data: AssetMapPdf } | AssetMapDocumentFailure> {
  const res = await call(baseUrl, "GET", path, DOCUMENT_TIMEOUT_MS, true);
  if (res == null) return { ok: false, reason: "failed", status: null };
  if (res.status !== 200) {
    console.error(`[${LOG_TAG}] pdf_status=${res.status}`);
    return { ok: false, reason: "failed", status: res.status };
  }
  return {
    ok: true,
    data: {
      filename: pdfFilename(header(res.headers, "content-disposition"), fallback),
      bytes: new Uint8Array(res.data as ArrayBuffer),
    },
  };
}

export function fetchAssetMapHouseholdPdf(baseUrl: string, householdId: string) {
  return pdf(baseUrl, `/api/households/${encodeURIComponent(householdId)}/pdf`, "export_report.pdf");
}

export function fetchAssetMapAllClientsPdf(baseUrl: string) {
  return pdf(baseUrl, "/api/households/export/pdf", "all_clients_report.pdf");
}

export async function saveAssetMapHouseholdToDrive(baseUrl: string, householdId: string): Promise<{ ok: true; data: AssetMapDriveSave } | AssetMapDocumentFailure> {
  const res = await call(baseUrl, "POST", `/api/households/${encodeURIComponent(householdId)}/save-to-drive`, DOCUMENT_TIMEOUT_MS, false);
  if (res == null) return { ok: false, reason: "failed", status: null };
  const b = body(res);
  if (res.status !== 200 || typeof b.filename !== "string" || typeof b.reviewed_at !== "string" || b.reviewed_at === "") {
    console.error(`[${LOG_TAG}] drive_status=${res.status}`);
    return { ok: false, reason: "failed", status: res.status };
  }
  return {
    ok: true,
    data: { filename: b.filename, webViewLink: typeof b.web_view_link === "string" ? b.web_view_link : "", reviewedAt: b.reviewed_at },
  };
}

export async function runAssetMapScan(baseUrl: string): Promise<AssetMapScanOutcome> {
  const res = await call(baseUrl, "POST", "/api/scan", SCAN_TIMEOUT_MS, false);
  if (res == null) return { ok: false, reason: "failed", status: null, detail: null };
  if (res.status === 409) return { ok: false, reason: "busy" };
  const b = body(res);
  if (res.status !== 200) {
    console.error(`[${LOG_TAG}] scan_status=${res.status}`);
    const detail = typeof b.detail === "string" && b.detail.length <= 200 ? b.detail : null;
    return { ok: false, reason: "failed", status: res.status, detail };
  }
  return { ok: true, clientsProcessed: typeof b.clients_processed === "number" ? b.clients_processed : 0 };
}

/** The latest AoA Drive-save audit row for one household: who saved, and the
 *  review time the pipeline returned for that save. */
export async function readAssetMapDriveSaveAudit(
  tx: Prisma.TransactionClient,
  householdId: string,
): Promise<{ reviewedAt: string; reviewer: string } | null> {
  const rows = await tx.$queryRaw<{ actorEmail: string | null; detail: string | null }[]>(
    Prisma.sql`SELECT "actorEmail", detail FROM audit."AuditLog"
      WHERE action = ${"asset_map_documents.drive_save"}
        AND "entityType" = ${"asset_map_household"} AND "entityId" = ${householdId}
      ORDER BY at DESC, id DESC LIMIT 1`,
  );
  const row = rows[0];
  if (!row?.actorEmail || !row.detail) return null;
  try {
    const d = JSON.parse(row.detail) as { reviewedAt?: unknown };
    return typeof d.reviewedAt === "string" ? { reviewedAt: d.reviewedAt, reviewer: row.actorEmail } : null;
  } catch {
    return null;
  }
}
