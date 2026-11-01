/**
 * GET /api/compliance/audit/export — CSV export of the audit ledger.
 *
 * Order is the control: authenticate (401) → authorize `audit:export` (denial recorded, 403) → parse the
 * filters → count → write AUDIT_LOG_EXPORTED (newValue = total, metadata = filters) → ONLY THEN stream.
 * The export row is awaited before the first byte leaves, so a download can never exist without its
 * ledger entry. Cells go through `auditRowsToCsv` (RFC 4180 + formula-injection guard) and the file
 * carries seq / prevHash / hash so the chain can be re-verified offline.
 */
import { actorFromViewer, recordDenied, writeAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { UnauthorizedError } from "@/lib/errors";
import { canExportAudit } from "@/lib/rbac";
import { csvExportFilename } from "@/lib/export-filename";
import { getRequestContextFromRequest } from "@/lib/request-context";
import { requireViewerOrThrow } from "@/lib/session";
import { auditRowsToCsv, countAuditRows, iterateAuditRows, maxAuditSeq } from "@/server/audit-export";
import { parseAuditQuery } from "@/server/validation";
import type { Viewer } from "@/types/domain";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: Request): Promise<Response> {
  let viewer: Viewer;
  try {
    viewer = await requireViewerOrThrow();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
    }
    throw e;
  }

  const ctx = getRequestContextFromRequest(req);
  const actor = actorFromViewer(viewer);

  if (!canExportAudit(viewer.groups)) {
    // I5: every denial is evidence. If the denial row cannot be written the request fails (500) rather
    // than answering with an unrecorded 403.
    await recordDenied(actor, ctx, "audit:export");
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const q = parseAuditQuery(new URL(req.url).searchParams);
  // Snapshot the ledger at the current maximum seq: count and stream are both bounded by
  // `seq <= toSeq`, read BEFORE the export row is inserted, so the export's own row (seq > toSeq) is excluded
  // from both. The recorded total therefore equals the file's row count, and the file is a snapshot as-of toSeq.
  const toSeq = await maxAuditSeq();
  const total = await countAuditRows(q, toSeq);

  // I14: the export is recorded BEFORE any CSV byte is produced.
  await writeAudit(prisma, actor, ctx, {
    action: "AUDIT_LOG_EXPORTED",
    entityType: "AUDIT_LOG",
    newValue: String(total),
    metadata: { filters: q, toSeq: toSeq === undefined ? null : toSeq.toString() },
  });

  const encoder = new TextEncoder();
  const pages = iterateAuditRows(q, undefined, toSeq);
  let wroteHeader = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await pages.next();
      if (next.done) {
        // Zero matching rows still yields a well-formed file with the header line.
        if (!wroteHeader) {
          controller.enqueue(encoder.encode(auditRowsToCsv([], true)));
          wroteHeader = true;
        }
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(auditRowsToCsv(next.value, !wroteHeader)));
      wroteHeader = true;
    },
    async cancel() {
      await pages.return(undefined);
    },
  });

  // Filesystem-safe stamp: a raw ISO timestamp puts colons in the name, which Windows refuses and
  // Finder rewrites — and this file's name gets quoted back in examiner correspondence.
  const filename = csvExportFilename("audit-export", null, new Date());
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...NO_STORE,
    },
  });
}
