/**
 * CSV export of the audit ledger — node only, layer L4, a plain module (not a server-action file) (docs/ARCHITECTURE.md
 * §g S3; I14). The export route writes AUDIT_LOG_EXPORTED BEFORE it starts streaming; this module supplies
 * the count, the row iterator and an RFC 4180 writer with a spreadsheet formula-injection guard.
 * The file carries seq / prevHash / hash so the chain can be re-verified offline.
 */
import type { AuditQuery, AuditRow } from "@/types/domain";
import { prisma } from "@/lib/db";
import { AUDIT_ROW_INCLUDE, auditWhere, toAuditRow } from "@/server/audit-log";

export const AUDIT_CSV_COLUMNS = [
  "seq",
  "occurredAt",
  "actorEmail",
  "actorGroups",
  "action",
  "entityType",
  "entityId",
  "ticketNumber",
  "fieldChanged",
  "oldValue",
  "newValue",
  "ipAddress",
  "userAgent",
  "requestId",
  "prevHash",
  "hash",
] as const;

const CRLF = "\r\n";
const FORMULA_LEAD_CHARS: ReadonlySet<string> = new Set(["=", "+", "-", "@", "\t", "\r"]);
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * null/undefined → "". A leading =, +, -, @, TAB or CR is prefixed with "'" so a spreadsheet never evaluates
 * the cell. Then RFC 4180: quote when the value contains a double quote, comma, LF or CR; escape " as "".
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "number" ? String(value) : value;
  if (s.length > 0 && FORMULA_LEAD_CHARS.has(s.charAt(0))) s = `'${s}`;
  if (NEEDS_QUOTING.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToLine(row: AuditRow): string {
  const cells: string[] = AUDIT_CSV_COLUMNS.map((column) => {
    switch (column) {
      case "actorGroups":
        return csvCell(row.actorGroups.join("|"));
      case "ticketNumber":
        return csvCell(row.ticketNumber);
      default:
        return csvCell(row[column]);
    }
  });
  return cells.join(",");
}

/** CRLF line endings; one line per row; header (AUDIT_CSV_COLUMNS order) when `includeHeader`. */
export function auditRowsToCsv(rows: AuditRow[], includeHeader: boolean): string {
  const lines: string[] = [];
  if (includeHeader) lines.push(AUDIT_CSV_COLUMNS.map((c) => csvCell(c)).join(","));
  for (const row of rows) lines.push(rowToLine(row));
  return lines.length === 0 ? "" : `${lines.join(CRLF)}${CRLF}`;
}

/**
 * Rows matching the export filters, up to the snapshot bound `toSeq` (Decision #54; the value recorded as
 * AUDIT_LOG_EXPORTED.newValue). Bounding the count and the stream by the same `toSeq` — read once, before the
 * export row is written — makes the total equal the file's row count.
 */
export async function countAuditRows(q: AuditQuery, toSeq?: bigint): Promise<number> {
  return prisma.auditLog.count({ where: auditWhere(q, toSeq) });
}

/** Reads the ledger's current maximum seq — the snapshot bound the export pins the count and stream to. */
export async function maxAuditSeq(): Promise<bigint | undefined> {
  const agg = await prisma.auditLog.aggregate({ _max: { seq: true } });
  return agg._max.seq ?? undefined;
}

/** seq desc from q.cursor (and at or below `toSeq`), in pages of `pageSize` (default 500); one page per yield. */
export async function* iterateAuditRows(q: AuditQuery, pageSize = 500, toSeq?: bigint): AsyncGenerator<AuditRow[]> {
  const take = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 500;
  let cursor: string | undefined = q.cursor;
  for (;;) {
    const rows = await prisma.auditLog.findMany({
      where: auditWhere({ ...q, cursor }, toSeq),
      include: AUDIT_ROW_INCLUDE,
      orderBy: { seq: "desc" },
      take,
    });
    if (rows.length === 0) return;
    yield rows.map(toAuditRow);
    if (rows.length < take) return;
    cursor = rows[rows.length - 1].seq.toString();
  }
}
