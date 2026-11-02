import type { Prisma } from "@prisma/client";
import { INGEST_CRM_PARENT_ORPHANS, writeAudit } from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import type {
  CrmParentOrphanItem,
  IngestDryRunResponse,
  IngestErrorBody,
  IngestLiveResponse,
  RejectedItem,
} from "@/lib/ingest/types";
import {
  validateCrmParentOrphanItem,
  validateEnvelope,
} from "@/lib/ingest/validate";

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
  const okItems: CrmParentOrphanItem[] = [];
  items.forEach((item, index) => {
    const rejection = validateCrmParentOrphanItem(item, index);
    if (rejection) rejected.push(rejection);
    else okItems.push(item as CrmParentOrphanItem);
  });

  const evidence = new Map<string, CrmParentOrphanItem>();
  for (const item of okItems) {
    evidence.set(`${item.parent_type}|${item.source_key.slice(0, 15)}`, item);
  }
  const evidenceJson = JSON.stringify([...evidence.values()]);
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  try {
    await withIngestScope(async (tx) => {
      if (!dryRun && evidence.size > 0) {
        await tx.$executeRaw`
          INSERT INTO mirror.crm_parent_orphan_evidence
            (parent_type, source_key, evidence_type, replacement_key, observed_at)
          SELECT p.parent_type, p.source_key, p.parent_state,
                 p.replacement_key, now()
            FROM jsonb_to_recordset(${evidenceJson}::jsonb)
              AS p(
                parent_type text,
                source_key text,
                parent_state text,
                replacement_key text
              )
          ON CONFLICT (parent_type, normalized_key) DO UPDATE SET
            source_key = EXCLUDED.source_key,
            evidence_type = EXCLUDED.evidence_type,
            replacement_key = EXCLUDED.replacement_key,
            observed_at = now()
        `;
      }

      await writeAudit(
        tx as Prisma.TransactionClient,
        { role: "INGEST", email: null },
        {
          action: INGEST_CRM_PARENT_ORPHANS,
          entityType: "ingest_run",
          entityId: run_id,
          detail: {
            source,
            endpoint: "crm-parent-orphans",
            received: items.length,
            upserted: evidence.size,
            rejected: rejected.length,
            dry_run: dryRun,
          },
        },
      );
    });
  } catch {
    console.error("[ingest] crm-parent-orphans tx_failed");
    return err("internal", 500);
  }

  if (dryRun) {
    return Response.json({
      would_upsert: evidence.size,
      rejected,
      run_id,
    } satisfies IngestDryRunResponse);
  }
  return Response.json({
    upserted: evidence.size,
    rejected,
    run_id,
  } satisfies IngestLiveResponse);
}
