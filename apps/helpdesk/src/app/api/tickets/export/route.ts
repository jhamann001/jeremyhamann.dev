/**
 * GET /api/tickets/export — CSV export of ticket rows.
 *
 * Order is the control, and it is the same order the audit export uses: authenticate (401) → authorize
 * `ticket:export` (denial recorded, 403) → parse the filters → authorize the SCOPE (a `full` export is
 * record content and is compliance-only; its denial is recorded too) → count → write
 * `TICKET_LIST_EXPORTED` with the row count and the filters → ONLY THEN stream. The audit row is
 * awaited before the first byte leaves, so a download can never exist without its ledger entry.
 *
 * TWO ledger rows, not one. The pre-stream row (`phase: "counted"`) is the I14 promise: it exists
 * before any byte does. But a count and a stream are two reads, and for a compliance artefact the
 * ledger row is the evidence of what actually left the building — so when the stream ends the route
 * writes a second `TICKET_LIST_EXPORTED` row carrying the number of data rows it really emitted
 * (`phase: "emitted"`, with `counted` beside it for a one-glance comparison), or `phase: "cancelled"`
 * when the client abandoned the download part-way. `src/server/ticket-export.ts` makes the two numbers
 * agree in every case it can — an immutable keyset key so no ticket is emitted twice, and a
 * `createdAt <= now` bound so a ticket opened mid-export is not picked up — and this row states the
 * outcome for the case it cannot close (a row edited out of the filter mid-stream), instead of leaving
 * a reader to assume.
 *
 * Rows are bounded by the viewer's readable queues inside `countExportRows` / `iterateExportRows`, so
 * "authorized" here means "may export at all"; what the file contains is narrowed again per row.
 * `standard` is built entirely from `TicketListRow`, which carries no record content; `full` adds the
 * original description and the comment bodies and is the only scope that reads them.
 */
import { actorFromViewer, recordDenied, writeAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { UnauthorizedError } from "@/lib/errors";
import { logError } from "@/lib/logger";
import { canExportTickets, canViewAudit } from "@/lib/rbac";
import { csvExportFilename } from "@/lib/export-filename";
import { getRequestContextFromRequest } from "@/lib/request-context";
import { requireViewerOrThrow } from "@/lib/session";
import {
  exportFilters,
  iterateExportRows,
  loadExportExtras,
  ticketRowsToCsv,
  countExportRows,
} from "@/server/ticket-export";
import { parseTicketExportScope, parseTicketListQuery } from "@/server/validation";
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

  if (!canExportTickets(viewer.groups)) {
    // I5: every denial is evidence. If the denial row cannot be written the request fails (500) rather
    // than answering with an unrecorded 403.
    await recordDenied(actor, ctx, "ticket:export");
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const sp = new URL(req.url).searchParams;
  const query = parseTicketListQuery(sp);
  const scope = parseTicketExportScope(sp);

  // The `full` scope is the original description plus every comment body, INTERNAL ones included. That
  // is a compliance extract, not an ops extract, so it takes the compliance capability — and asking for
  // it without holding it is recorded rather than silently downgraded, because "who tried to pull full
  // ticket text" is exactly the question an examiner asks.
  if (scope === "full" && !canViewAudit(viewer.groups)) {
    await recordDenied(actor, ctx, "ticket:export scope=full");
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  // One `now` for the count, every SLA predicate and every computed SLA verdict in the file, so the
  // recorded total and the rows describe the same instant.
  const now = new Date();
  const total = await countExportRows(viewer, query, now);

  const filters = exportFilters(query);

  // I14: the export is recorded BEFORE any CSV byte is produced.
  await writeAudit(prisma, actor, ctx, {
    action: "TICKET_LIST_EXPORTED",
    entityType: "TICKET",
    newValue: String(total),
    metadata: { filters, scope, phase: "counted" },
  });

  const encoder = new TextEncoder();
  const pages = iterateExportRows(viewer, query, undefined, now);
  let wroteHeader = false;
  let emitted = 0;
  let settled = false;

  /**
   * The closing ledger row: how many data rows actually went down the wire. Written once — whether the
   * stream ran to the end or the client walked away — and never allowed to fail the download, because
   * the bytes are already delivered by the time it runs and the I14 row that authorized them is already
   * in the ledger. A failure here is loud in the logs and costs the ledger its second, finer number; it
   * does not cost the caller a truncated file.
   */
  async function settle(phase: "emitted" | "cancelled"): Promise<void> {
    if (settled) return;
    settled = true;
    try {
      await writeAudit(prisma, actor, ctx, {
        action: "TICKET_LIST_EXPORTED",
        entityType: "TICKET",
        newValue: String(emitted),
        metadata: { filters, scope, phase, counted: total, emitted },
      });
    } catch (e) {
      // CWE-209: the caught value goes to the structured logger, which records only its class label
      // (`errorLabel`). Nothing derived from the error is composed at this call site.
      logError("route:/api/tickets/export", e, {
        requestId: ctx.requestId,
        op: "completion-audit-row",
        phase,
        counted: total,
        emitted,
      });
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await pages.next();
      if (next.done) {
        // Zero matching rows still yields a well-formed file with the header line.
        if (!wroteHeader) {
          controller.enqueue(encoder.encode(ticketRowsToCsv([], true, scope)));
          wroteHeader = true;
        }
        await settle("emitted");
        controller.close();
        return;
      }
      const rows = next.value;
      const extras = scope === "full" ? await loadExportExtras(rows.map((r) => r.id)) : undefined;
      controller.enqueue(encoder.encode(ticketRowsToCsv(rows, !wroteHeader, scope, extras)));
      wroteHeader = true;
      emitted += rows.length;
    },
    async cancel() {
      await pages.return(undefined);
      // A part-delivered compliance extract is still an extract: record what left, not what was asked for.
      await settle("cancelled");
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      // Filesystem-safe stamp: a raw ISO timestamp puts colons in the name, which Windows refuses and
      // Finder rewrites.
      "Content-Disposition": `attachment; filename="${csvExportFilename("ticket-export", scope, now)}"`,
      ...NO_STORE,
    },
  });
}
