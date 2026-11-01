/**
 * The single AuditQuery → URLSearchParams serializer (shared convention 12).
 *
 * `AuditFilters`, `AuditTable` ("Load more") and `ExportButton` all encode through this function so the
 * three surfaces cannot drift: multi-value `action` travels as REPEATED BARE KEYS
 * (`?action=TICKET_VIEWED&action=AUTHZ_DENIED`) via `URLSearchParams.append`, never `action[]` and never
 * a comma-joined value. The reader (`parseAuditQuery`) accepts exactly this shape.
 *
 * Pure and browser-safe: imports only types.
 */
import type { AuditQuery } from "@/types/domain";

export function auditQueryToParams(q: AuditQuery, opts?: { includeCursor?: boolean }): URLSearchParams {
  const includeCursor = opts?.includeCursor ?? true;
  const params = new URLSearchParams();

  if (q.from !== undefined) params.set("from", q.from);
  if (q.to !== undefined) params.set("to", q.to);
  if (q.actorEmail !== undefined && q.actorEmail !== "") params.set("actorEmail", q.actorEmail);
  if (q.action !== undefined) {
    for (const action of q.action) params.append("action", action);
  }
  if (q.entityType !== undefined) params.set("entityType", q.entityType);
  if (q.ticketNumber !== undefined && Number.isInteger(q.ticketNumber) && q.ticketNumber >= 1) {
    params.set("ticketNumber", String(q.ticketNumber));
  }
  if (includeCursor && q.cursor !== undefined) params.set("cursor", q.cursor);
  if (Number.isInteger(q.limit) && q.limit > 0) params.set("limit", String(q.limit));

  return params;
}
