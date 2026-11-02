import { householdLabel, type PdfAccountExclusion } from "@/lib/trade-requests/detail-view";
import type { TradeRequestClientExclusion } from "@/lib/trade-requests/export-model";
import { formatAccountStanding } from "@/lib/trade-requests/request-pdf";
import type { TradeRequest, TradeRequestAuditEntry, TradeRequestExporter } from "@/lib/trade-requests/request-types";
import { formatClientStanding } from "./compliance-pdf";

// Port of the standalone compliance CSV (trade-request
// client/src/components/TradingQueue.tsx exportComplianceReport and
// client/src/utils/csv.ts): always quoted, formula guard, "\n" line breaks.

const MAX_STRATEGY_COLUMNS = 3;

/** Quotes every value; a leading = + - @, tab or CR gets a "'" so spreadsheets never run it as a formula. */
export function csvEscape(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function csvNormalize(text: string): string {
  return text.replace(/\r\n/g, " ").replace(/[\r\n]/g, " ").replace(/\s{2,}/g, " ").trim();
}

const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0"));

/** SHA-256 chained over each entry ("{previous}|{date}|{user}|{action}|{notes}"), "EMPTY" for none. */
export async function hashAuditChain(entries: TradeRequestAuditEntry[]): Promise<string> {
  if (entries.length === 0) return "EMPTY";
  const encoder = new TextEncoder();
  let previous = "";
  for (const entry of entries) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${previous}|${entry.date}|${entry.user}|${entry.action}|${entry.notes}`)));
    previous = Array.from(digest, (byte) => HEX[byte]).join("");
  }
  return previous;
}

function actor(auditLog: TradeRequestAuditEntry[], action: RegExp): string {
  const entry = auditLog.find((item) => action.test(item.action));
  return entry ? `${entry.user} (${entry.date})` : "";
}

const HEADERS = [
  "Request ID", "Client ID", "Client Name", "Advisor", "Submitted By", "Trade Type", "Trade Amount", "Deposit Account",
  "Status", "Total Value", "Selected Accounts", "Residence", "Liquidation Approval", "Advisor Exclusions", "Client Exclusions",
  "Standing Advisor Exclusions (current)", "Standing Client Exclusions (current)",
  "Standing Account Advisor Exclusions (current)", "Standing Account Client Exclusions (current)",
  "ESG Filters", "Risk Profile", "Base Allocation",
  ...Array.from({ length: MAX_STRATEGY_COLUMNS }, (_, index) => [
    `Strategy ${index + 1} Benchmark`, `Strategy ${index + 1} Allocation %`, `Strategy ${index + 1} Rationale`,
  ]).flat(),
  "Created At (ISO)", "Updated At (ISO)", "Initiated By", "Reviewed By", "Audit Trail", "Audit Hash",
];

export type BuiltComplianceCsv = { text: string; filename: string };

export async function buildComplianceCsv(
  requests: TradeRequest[],
  exporter: TradeRequestExporter,
  standingByClient: Record<string, TradeRequestClientExclusion[]> = {},
  accountExclusionsByRequestId: Record<string, PdfAccountExclusion[]> = {},
  now: Date = new Date(),
): Promise<BuiltComplianceCsv> {
  const exportTimestamp = now.toISOString();
  const rows = [
    `# Report Exported By: ${exporter.name} (${exporter.email}) | Exported At: ${exportTimestamp} | Record Count: ${requests.length}`,
    HEADERS.join(","),
  ];
  const auditHashes = await Promise.all(requests.map((req) => hashAuditChain(req.auditLog)));

  requests.forEach((req, index) => {
    const esg = Object.entries(req.esgFilters ?? {}).filter(([key, value]) => value && key !== "none").map(([key]) => key).join("; ") || "None";
    const baseAllocation = req.baseAllocation
      ? `Eq: ${req.baseAllocation.equity}% | Fix: ${req.baseAllocation.fixed}% | Csh: ${req.baseAllocation.cash}%`
      : "N/A";
    const strategies = req.equityStrategies ?? [];
    const strategyCells = Array.from({ length: MAX_STRATEGY_COLUMNS }, (_, slot) => {
      const strategy = strategies[slot];
      return strategy
        ? [csvEscape(strategy.benchmark), csvEscape(String(strategy.allocation)), csvEscape(csvNormalize(strategy.rationale))]
        : [csvEscape(""), csvEscape(""), csvEscape("")];
    }).flat();
    const standing = formatClientStanding(standingByClient[req.clientId]);
    const accountStanding = formatAccountStanding(accountExclusionsByRequestId[req.id] ?? []);
    const auditTrail = req.auditLog.map((entry) => `[${entry.date}] ${entry.user} (${entry.action}): ${entry.notes}`).join(" || ");

    rows.push([
      csvEscape(req.id),
      csvEscape(req.clientId),
      csvEscape(householdLabel(req)),
      csvEscape(req.advisor),
      csvEscape(req.submittedBy || req.advisor),
      csvEscape(req.tradeType),
      csvEscape(req.tradeAmount || "N/A"),
      csvEscape(req.depositAccount || "N/A"),
      csvEscape(req.status),
      csvEscape(String(req.totalValue)),
      csvEscape(req.selectedAccounts.join("; ")),
      csvEscape(req.residence),
      csvEscape(req.liquidationApproval || "N/A"),
      csvEscape(req.advisorExclusions || ""),
      csvEscape(req.clientExclusions || ""),
      csvEscape(standing.advisor),
      csvEscape(standing.client),
      csvEscape(accountStanding.advisor),
      csvEscape(accountStanding.client),
      csvEscape(esg),
      csvEscape(String(req.riskProfile ?? "N/A")),
      csvEscape(baseAllocation),
      ...strategyCells,
      csvEscape(new Date(req.date).toISOString()),
      csvEscape(new Date(req.updatedAt).toISOString()),
      csvEscape(actor(req.auditLog, /^(Created|Submitted)/i)),
      csvEscape(actor(req.auditLog, /^Status changed to (Approved|Rejected)/i)),
      csvEscape(auditTrail),
      csvEscape(auditHashes[index]),
    ].join(","));
  });

  return { text: rows.join("\n"), filename: `Compliance_Export_${exportTimestamp.split("T")[0]}.csv` };
}
