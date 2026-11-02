import "server-only";
import { auth } from "@/auth";
import { withUserScope } from "@/lib/rls";
import { writeAudit, type AuditEntry } from "@/lib/audit";
import { assetMappingDocumentsEnabled } from "@/lib/flags";
import { canReviewAssetMapLinks, canViewAssetMapping } from "@/lib/data/asset-map-review-authz";

// Cross-site, session, flag, and role gate for the documents route handlers.
// "view" (both PDFs) admits the workspace's view roles, as statement-pipeline lets
// `advisor` download them; "operate" (scan, Drive save) is Admin and
// Operations only (ticket).
export type DocumentsRouteAccess = "view" | "operate";

export const DOCUMENTS_NO_STORE = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};

export type DocumentsIdentity = { role: string; email: string | null };

export function documentsJson(status: number, payload: Record<string, unknown>): Response {
  return Response.json(payload, { status, headers: DOCUMENTS_NO_STORE });
}

export async function documentsRouteIdentity(request: Request, access: DocumentsRouteAccess): Promise<DocumentsIdentity | Response> {
  if (request.headers.get("sec-fetch-site") === "cross-site") return documentsJson(403, { error: "forbidden" });
  let session;
  try { session = await auth(); }
  catch { return documentsJson(503, { error: "unavailable" }); }
  if (!session?.user) return documentsJson(401, { error: "unauthorized" });
  if (!assetMappingDocumentsEnabled()) return documentsJson(404, { error: "not_found" });
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const permitted = access === "view" ? canViewAssetMapping(role) : canReviewAssetMapLinks(role);
  if (!permitted) return documentsJson(403, { error: "forbidden" });
  return { role, email: session.user.email ?? null };
}

/** Audit is attribution, not a gate: a failed write is logged, never fatal. */
export async function auditDocuments(identity: DocumentsIdentity, entry: AuditEntry): Promise<void> {
  try {
    await withUserScope(identity, (tx) => writeAudit(tx, identity, entry));
  } catch {
    console.error("[asset-mapping] documents_audit_failed");
  }
}
