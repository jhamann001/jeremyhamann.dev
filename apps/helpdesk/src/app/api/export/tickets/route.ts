/**
 * GET /api/export/tickets — the Ops Portal mirror feed.
 *
 * OPS_PORTAL's household view is fed today by a nightly n8n job that reads the legacy help desk. When new tickets stop
 * arriving in the legacy help desk that view goes stale on cutover day unless this desk exposes an equivalent
 * read, so this is the replacement: `?updatedSince=<iso>&cursor=<opaque>&limit=<n>`, keyset-paged on
 * `(updatedAt, id)` over the index built for it, polled by the same sync into OPS_PORTAL's idempotent ingest.
 *
 * What it is allowed to carry:
 *  - PUBLIC comments only. INTERNAL notes are excluded in the WHERE clause AND re-checked on the way
 *    out — the mirror is a client-facing artefact once it is inside OPS_PORTAL.
 *  - Sanitized bodies and subjects; a held inbound message (`SuspendedIntake`) has no ticket and is
 *    structurally absent.
 *  - No attachment content, no delivery state, no requester phone.
 *
 * A page of the mirror is a READ OF CLIENT MATERIAL, so its `TICKET_EXPORT_READ` row is awaited
 * BEFORE the response body is produced (§3 rule 3). If the row cannot be written, nothing is
 * served.
 */
import { NextResponse } from "next/server";
import { recordMaterialRead } from "@/lib/audit";
import {
  authorizeMachineRequest,
  enforceMachineRateLimit,
  integrationActor,
  machineAuthMetadata,
  recordIntegrationDenied,
} from "@/lib/integration-auth";
import type { IntegrationScope } from "@/lib/integration-scope";
import { getRequestContextFromRequest } from "@/lib/request-context";
import { exportTicketsPage, parseTicketExportQuery, toMachineErrorResponse } from "@/server/ingest";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const ROUTE = "/api/export/tickets";
/**
 * This route is the machine READ surface (the Ops Portal mirror). With `EXPORT_API_TOKEN` set it accepts ONLY that key;
 * unset, it falls back to the shared `INTEGRATION_API_TOKEN` (src/lib/integration-scope.ts).
 */
const SCOPE: IntegrationScope = "export";

export async function GET(req: Request): Promise<Response> {
  const ctx = getRequestContextFromRequest(req);

  // A `ClientApiToken` carrying this surface's scope, else the legacy env bearer, in that
  // order. Database-first is deliberate: a consumer that has been issued a
  // real credential should be attributed to it even while INTEGRATION_API_TOKEN is still set.
  const machineAuth = await authorizeMachineRequest(req.headers, SCOPE);
  if (machineAuth === null) {
    await recordIntegrationDenied(ctx, ROUTE, "integration:unauthenticated");
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  // Per credential (per surface for the legacy bearer). The refusal is audited at most once per
  // key per window — Decision #71's coalescing, arriving through a different door.
  const refused = await enforceMachineRateLimit(ctx, ROUTE, machineAuth, SCOPE);
  if (refused !== null) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(refused.retryAfterSeconds) } },
    );
  }

  try {
    const actor = await integrationActor();
    const url = new URL(req.url);
    const query = parseTicketExportQuery(url.searchParams);
    const page = await exportTicketsPage(query);

    // I3: the read is recorded before the content exists as a response. `newValue` is the row count in
    // THIS page, so the ledger reconstructs exactly how much of the book left through the mirror.
    await recordMaterialRead(actor, ctx, {
      action: "TICKET_EXPORT_READ",
      entityType: "TICKET",
      entityId: null,
      ticketId: null,
      newValue: String(page.rows.length),
      metadata: {
        via: "api",
        route: ROUTE,
        // Which machine credential opened this read. Once EXPORT_API_TOKEN is in use the ledger says
        // "the mirror's own key", not just "a machine" — the point of splitting the bearer at all.
        scope: SCOPE,
        // WHICH consumer read this page, when it presented a per-consumer credential. Absent for the
        // shared env bearer, which is exactly how the ledger says "still on the old key".
        ...machineAuthMetadata(machineAuth),
        updatedSince: query.updatedSince?.toISOString() ?? null,
        cursor: url.searchParams.get("cursor"),
        limit: query.limit,
        messages: page.rows.reduce((n, r) => n + r.messages.length, 0),
      },
    });

    return NextResponse.json(page, { status: 200, headers: NO_STORE });
  } catch (e) {
    const mapped = toMachineErrorResponse("export.tickets", e);
    return NextResponse.json(mapped.body, { status: mapped.status, headers: NO_STORE });
  }
}
