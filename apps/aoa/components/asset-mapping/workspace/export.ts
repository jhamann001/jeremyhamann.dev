import type { AssetMapAccountView, AssetMapHouseholdView } from "@/lib/data/asset-map";
import type { AssetMapDestinationsView } from "@/lib/data/asset-map-destinations";
import { positionStatus } from "./workspace-model";

/** Epic AC-41, first table (pipeline App.jsx lines 114–118). */
export const POSITION_HEADERS = [
  "Client Name", "Custodian", "Account Type", "Account Owner", "Account Number",
  "Symbol", "Description", "Shares", "Market Value",
  "Cost Basis", "Cost Basis Granularity", "Cost Basis Status", "Classification",
  "Transfer Status", "Transferring", "Routing Notes", "Has Override",
] as const;
export const DESTINATION_HEADING = "Accounts to be Opened at Apex";
/** Epic AC-41, second table (pipeline App.jsx lines 157–161). */
export const DESTINATION_HEADERS = [
  "Transferring In - Account #", "Transferring In - Account Type", "Transferring In - Owner",
  "Transfers To - Owner", "Transfers To - Account Type", "Transfers To - Apex #",
  "Needs to be Opened at Apex", "Statement Status",
] as const;

type Cell = string | number | null | undefined;

function cell(v: Cell): string {
  if (v == null) return "";
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = (values: readonly Cell[]) => values.map(cell).join(",");

function statementStatus(acc: AssetMapAccountView | undefined): string {
  return acc?.isStale
    ? `NEW STATEMENT NEEDED${acc.statementAgeDays != null ? ` (${acc.statementAgeDays}d old)` : ""}`
    : "Current";
}

/** The pipeline's exportHouseholdCSV, over the household on screen. Account numbers
 *  are the pipeline's masked form only. */
export function buildHouseholdSpreadsheet(
  household: AssetMapHouseholdView,
  destinations: AssetMapDestinationsView,
  overridden: ReadonlySet<string>,
): string {
  const rows = [row(POSITION_HEADERS)];
  for (const acc of household.accounts) {
    const number = destinations.accountNumbers[acc.id] ?? null;
    for (const p of acc.positions) {
      rows.push(row([
        household.clientName, acc.custodian, acc.accountType, acc.accountHolder, number,
        p.symbol, p.description, p.quantity, p.marketValue,
        p.costBasis, p.costBasisGranularity, acc.costBasisStatus, p.assetType,
        positionStatus(p),
        p.transferring === true ? "Yes" : p.transferring === false ? "No" : "",
        p.effectiveNotes || p.transferNotes,
        overridden.has(p.id) ? "Yes" : "No",
      ]));
    }
  }
  rows.push("", DESTINATION_HEADING, row(DESTINATION_HEADERS));
  const byId = new Map(household.accounts.map((a) => [a.id, a]));
  for (const d of destinations.destinations) {
    const apex = d.existingApexNumber || d.suggestedApexNumber || "";
    const needs = d.needsToBeOpened ? "Yes" : "No";
    if (d.sources.length === 0) {
      rows.push(row(["", "", "", d.owner, d.targetAccountType, apex, needs, ""]));
      continue;
    }
    for (const s of d.sources) {
      const acc = s.accountId ? byId.get(s.accountId) : undefined;
      rows.push(row([
        s.accountNumberMasked || (acc ? destinations.accountNumbers[acc.id] : ""),
        acc ? acc.accountType : "", acc ? acc.accountHolder : "",
        d.owner, d.targetAccountType, apex, needs, statementStatus(acc),
      ]));
    }
  }
  return rows.join("\n");
}

export function householdSpreadsheetFilename(clientName: string | null, now: Date): string {
  return `${(clientName || "export").replace(/\s+/g, "_")}_positions_${now.toISOString().slice(0, 10)}.csv`;
}

/** Browser only. */
export function downloadHouseholdSpreadsheet(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
