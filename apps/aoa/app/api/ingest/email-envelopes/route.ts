import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { writeAudit } from "@/lib/audit";
import { hasForbiddenBccKey, isEmailEnvelope } from "@/lib/email-search/envelope";
import { reconcileEmailEnvelopeBatch, emailEnvelopeReconciliationCoverage, stripLoggedBccBatch, EmailBodyCleanupConflict, type EmailEnvelopeObservation } from "@/lib/ingest/email-envelope-reconciliation";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
const error = (value: string, status: number) => Response.json({ error: value }, { status, headers });
export const GET = () => error("method_not_allowed", 405);
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;

// Historical seam: metadata reconciliation by default; body cleanup requires
// an explicit separate operation. Preview by default; count-only response/audit.
export async function POST(request: Request): Promise<Response> {
  if (!requireIngestToken(request).ok) return error("unauthorized", 401);
  let payload: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 1024 * 1024) return error("too_large", 413);
    payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some(key => !["source", "run_id", "items", "mode", "operation", "expected_remaining"].includes(key)) ||
      typeof payload.source !== "string" || payload.source !== "crm" ||
      typeof payload.run_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.run_id) ||
      !Array.isArray(payload.items) || payload.items.length > 500 ||
      ![undefined, "preview", "apply"].includes(payload.mode as undefined | string) || hasForbiddenBccKey(payload)) return error("bad_request", 400);
    const cleanup = payload.operation === "strip_logged_bcc";
    if (![undefined, "metadata", "strip_logged_bcc"].includes(payload.operation as undefined | string) ||
      (cleanup ? payload.items.length !== 0 || (payload.mode === "apply"
        ? !Number.isSafeInteger(payload.expected_remaining) || (payload.expected_remaining as number) < 0
        : payload.expected_remaining !== undefined) : payload.expected_remaining !== undefined)) return error("bad_request", 400);
    for (const item of payload.items) {
      if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).sort().join(",") !== "email_envelope,household_sf_id,sf_id" ||
        typeof item.sf_id !== "string" || typeof item.household_sf_id !== "string" ||
        !/^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(item.household_sf_id) ||
        !isEmailEnvelope(item.email_envelope, item.sf_id)) return error("bad_request", 400);
    }
  } catch { return error("bad_request", 400); }
  try {
    const apply = payload.mode === "apply";
    const result = await withIngestScope(async tx => {
      if (payload.operation === "strip_logged_bcc") {
        const counts = await stripLoggedBccBatch(tx, apply, payload.expected_remaining as number | undefined);
        const coverage = await emailEnvelopeReconciliationCoverage(tx);
        const result = { operation: "strip_logged_bcc", dry_run: !apply, ...counts, coverage };
        await writeAudit(tx, { role: "INGEST", email: null }, {
          action: "ingest.email_body_cleanup", entityType: "ingest_run", entityId: payload.run_id as string,
          detail: { source: "crm", ...result },
        });
        return result;
      }
      const counts = await reconcileEmailEnvelopeBatch(tx, payload.items as EmailEnvelopeObservation[], apply);
      const coverage = await emailEnvelopeReconciliationCoverage(tx);
      await writeAudit(tx, { role: "INGEST", email: null }, {
        action: "ingest.email_envelopes", entityType: "ingest_run", entityId: payload.run_id as string,
        detail: { source: "crm", dry_run: !apply, ...counts, coverage },
      });
      return { dry_run: !apply, ...counts, coverage };
    });
    return Response.json(result, { headers });
  } catch (cause) { return cause instanceof EmailBodyCleanupConflict ? error("cleanup_scope_changed", 409) : error("internal", 500); }
}
