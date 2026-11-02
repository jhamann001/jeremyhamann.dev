import { toCsv } from "@/lib/deals/import-csv";
import { resolveAcatBookStatus, trackerCellText, type AcatBookRow, type TransferTrackerColumn } from "./acat-book";

type ExportColumn = { id: string; label: string };

function legacyCellText(id: string, row: AcatBookRow): string {
  switch (id) {
    case "client": return row.clientName ?? "";
    case "account": return [row.apexAccountId, row.statementAccountNumber].filter(Boolean).join(" · ");
    case "status": return resolveAcatBookStatus(row.status).label;
    case "contra": return row.transferringContra ?? "";
    case "direction": return row.direction ?? "";
    case "type": return row.type ?? "";
    case "date": return row.acatDate ?? "";
    default: return "";
  }
}

export function buildAcatBookCsv({ rows, columns, tracker, linkedFor }: {
  rows: readonly AcatBookRow[];
  columns: readonly ExportColumn[];
  tracker: boolean;
  linkedFor: (row: AcatBookRow) => boolean;
}): string {
  const cellText = (column: ExportColumn, row: AcatBookRow): string => {
    if (column.id === "link") return linkedFor(row) ? "Linked" : "Not linked";
    if (tracker) {
      const text = trackerCellText(column.id as Exclude<TransferTrackerColumn, "link">, row);
      return text === "—" ? "" : text;
    }
    return legacyCellText(column.id, row);
  };
  return toCsv([
    columns.map((c) => c.label),
    ...rows.map((row) => columns.map((c) => cellText(c, row))),
  ]);
}

export function acatBookCsvFilename(now: Date): string {
  return `acat-records-${now.toISOString().slice(0, 10)}.csv`;
}
