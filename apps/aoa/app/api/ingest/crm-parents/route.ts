import type { Prisma } from "@prisma/client";
import { INGEST_CRM_PARENTS, writeAudit } from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import type {
  CrmParentItem,
  IngestDryRunResponse,
  IngestErrorBody,
  IngestLiveResponse,
  RejectedItem,
} from "@/lib/ingest/types";
import { validateCrmParentItem, validateEnvelope } from "@/lib/ingest/validate";
import { logIngestSuccess } from "@/lib/observability/structured-log";

export const runtime = "nodejs";

const MAX_ITEMS = 5000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const err = (error: IngestErrorBody["error"], status: number) =>
  Response.json({ error } satisfies IngestErrorBody, { status });

function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

export async function POST(req: Request): Promise<Response> {
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) return err("too_large", 413);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("bad_request", 400);
  }
  if (Buffer.byteLength(JSON.stringify(body ?? null)) > MAX_BODY_BYTES) {
    return err("too_large", 413);
  }

  const parsed = validateEnvelope(body);
  if (!parsed.ok) return err("bad_request", 400);
  const { source, run_id, items } = parsed.envelope;
  if (items.length > MAX_ITEMS) return err("too_large", 413);

  const rejected: RejectedItem[] = [];
  const okItems: CrmParentItem[] = [];
  items.forEach((item, index) => {
    const rejection = validateCrmParentItem(item, index);
    if (rejection) rejected.push(rejection);
    else okItems.push(item as CrmParentItem);
  });

  // One source coordinate per Salesforce 15-character canonical key. A batch
  // can contain both the 15- and 18-character forms; last accepted item wins.
  // The database repeats this invariant with a generated-key primary key.
  const parents = new Map<string, CrmParentItem>();
  for (const item of okItems) {
    parents.set(`${item.parent_type}|${item.source_key.slice(0, 15)}`, item);
  }
  const parentJson = JSON.stringify([...parents.values()]);
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  try {
    await withIngestScope(async (tx) => {
      if (!dryRun && parents.size > 0) {
        // Batch-shaped by design: one statement for up to 5,000 items. Do not
        // regress this to a per-row loop; ingest transactions have a tight
        // timeout and prior large feeds have hit P2028.
        await tx.$executeRaw`
          INSERT INTO mirror.crm_parent_source
            (parent_type, source_key, synced_at)
          SELECT p.parent_type, p.source_key, now()
            FROM jsonb_to_recordset(${parentJson}::jsonb)
              AS p(parent_type text, source_key text)
          ON CONFLICT (parent_type, normalized_key) DO UPDATE SET
            source_key = EXCLUDED.source_key,
            synced_at = now()
        `;
      }

      await writeAudit(
        tx as Prisma.TransactionClient,
        { role: "INGEST", email: null },
        {
          action: INGEST_CRM_PARENTS,
          entityType: "ingest_run",
          entityId: run_id,
          detail: {
            source,
            endpoint: "crm-parents",
            received: items.length,
            upserted: parents.size,
            rejected: rejected.length,
            dry_run: dryRun,
          },
        },
      );
    });
  } catch {
    // Keep request-derived values out of failure logs. The successful audit
    // record carries the run ID; a rolled-back transaction gets only a stable,
    // non-tainted endpoint marker.
    console.error("[ingest] crm-parents tx_failed");
    return err("internal", 500);
  }

  if (dryRun) {
    return Response.json({
      would_upsert: parents.size,
      rejected,
      run_id,
    } satisfies IngestDryRunResponse);
  }
  if (rejected.length === 0) logIngestSuccess("crm-parents");
  return Response.json({
    upserted: parents.size,
    rejected,
    run_id,
  } satisfies IngestLiveResponse);
}
