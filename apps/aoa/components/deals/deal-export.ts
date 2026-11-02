import type { DealRow } from "@/lib/data/deal-types";
import { MASKED_CEDAR_RIDGE_ID } from "@/lib/data/deal-types";
import { toCsv } from "@/lib/deals/import-csv";

// Pure row→CSV mapping for the /deals "Export CSV" button (WO ticket) —
// extracted from DealsTable so vitest exercises it without CSS-module imports
// (the deal-filter.ts idiom). The CSV writer is D4's hand-rolled RFC-4180
// `toCsv`/`csvEscape` (lib/deals/import-csv.ts) — ONE writer in the codebase,
// so export quoting is the import's quoting by construction.
//
// Round-trip friendliness (WO): every field D4's import reads from a column
// uses that mapping's CANONICAL header (REPORT_HEADERS[key][0]), so an export
// re-enters cleanly through `recordsFromCsv` → `mapReportRow`. The four
// fields the importer does NOT read from columns (source; the three account
// fields, which it derives from the deal name / review CSV) get plain
// headers — unknown columns are ignored by its header resolution, so they
// are round-trip-harmless.
//
// Value rules (mirroring what the importer accepts): dates → ISO YYYY-MM-DD
// in UTC (DB `date` columns arrive as UTC-midnight Dates — format in UTC or
// the local offset shifts them a day; same trap DealsTable documents);
// amounts → plain String(n), no "$"/thousands separators; booleans → Yes/No
// (what `parseBool` reads back); nulls → empty field.
//
// NO `plaid_linked` column — the D3 UI removal carries into the export
// (explicit AC). Row-identity/audit metadata (id, created_by/updated_by,
// created_at/updated_at) is deliberately excluded: not a table column, not in
// the WO field list, meaningless outside this DB.

const isoDay = (d: Date | null): string =>
  d == null ? "" : d.toISOString().slice(0, 10);

const num = (n: number | null): string => (n == null ? "" : String(n));

const text = (s: string | null): string => s ?? "";

const yesNo = (b: boolean): string => (b ? "Yes" : "No");

type ExportColumn = {
  header: string;
  cell: (r: DealRow) => string;
};

export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  { header: "Deal: ID", cell: (r) => text(r.sf_deal_id) },
  { header: "Deal: Deal Name", cell: (r) => r.name },
  { header: "Person: First Name", cell: (r) => r.client_first_name },
  { header: "Person: Last Name", cell: (r) => r.client_last_name },
  { header: "Person: Primary Entity", cell: (r) => text(r.household_name) },
  {
    header: "Household SF ID (Person: Entity ID)",
    cell: (r) => text(r.household_sf_id),
  },
  { header: "AUM", cell: (r) => num(r.amount) },
  { header: "AoA - New Stage", cell: (r) => r.stage },
  { header: "Stage", cell: (r) => text(r.stage_raw) },
  { header: "Deal: Created Date", cell: (r) => isoDay(r.created_date) },
  { header: "Close Date", cell: (r) => isoDay(r.close_date) },
  {
    header: "Deal: Last Activity Date",
    cell: (r) => isoDay(r.last_activity_date),
  },
  { header: "Person: Entity Owner", cell: (r) => text(r.owner_name) },
  { header: "Owner SF User ID", cell: (r) => text(r.owner_sf_user_id) },
  { header: "Person: Secondary Owner", cell: (r) => text(r.secondary_owner) },
  { header: "Person: AUM", cell: (r) => num(r.person_aum) },
  { header: "Person: Potential AUM", cell: (r) => num(r.potential_aum) },
  {
    header: "Person: Cedar Ridge User ID",
    // The explicit export endpoint serializes rows the seam already masked,
    // so an unauthorized browser never holds the real value. Emit the masked
    // constant when a value was withheld; otherwise the (role-correct) value.
    cell: (r) =>
      r.cedar_ridge_user_id_masked ? MASKED_CEDAR_RIDGE_ID : text(r.cedar_ridge_user_id),
  },
  { header: "Statements", cell: (r) => yesNo(r.statements) },
  { header: "Asset mapped", cell: (r) => yesNo(r.asset_mapped) },
  { header: "Source", cell: (r) => r.source },
  { header: "Transferring Firm", cell: (r) => text(r.transferring_firm) },
  // D8 relabel (WO ticket): "Account Type" → "Funding Type". Round-trip
  // safe — the importer never read this column (it derives account fields
  // from the deal name / review CSV; unknown headers are ignored).
  { header: "Funding Type", cell: (r) => text(r.account_type) },
  { header: "Account Last4", cell: (r) => text(r.account_last4) },
];

export const EXPORT_HEADERS: readonly string[] = EXPORT_COLUMNS.map(
  (c) => c.header,
);

/** Header row + one row per deal, order preserved (the caller's filtered view). */
export function dealsToCsvRows(rows: readonly DealRow[]): string[][] {
  return [
    EXPORT_HEADERS.slice(),
    ...rows.map((r) => EXPORT_COLUMNS.map((c) => c.cell(r))),
  ];
}

/** The full CSV text (RFC-4180 via D4's writer — quoting, "" escapes, CRLF). */
export function dealsToCsv(rows: readonly DealRow[]): string {
  return toCsv(dealsToCsvRows(rows));
}

/**
 * `deals-export-YYYY-MM-DD.csv` from the LOCAL clock fields (the WO's
 * "client clock at click time") — not toISOString(), which is UTC and names
 * the file for tomorrow during an evening export in the US.
 */
export function exportFilename(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `deals-export-${y}-${m}-${d}.csv`;
}
