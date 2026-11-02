import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildComplianceCsv, csvEscape, hashAuditChain } from "@/components/trade-requests/export/compliance-csv";
import { SYNTHETIC_EXPORTER, syntheticRequest } from "./helpers/export-requests";

// ticket: the CSV follows the standalone exportComplianceReport and csvEscape
// (trade-request client/src/components/TradingQueue.tsx, client/src/utils/csv.ts).

const NOW = new Date("2026-10-17T05:30:00.000Z");
const HEADER = [
  "Request ID", "Client ID", "Client Name", "Advisor", "Submitted By", "Trade Type", "Trade Amount", "Deposit Account",
  "Status", "Total Value", "Selected Accounts", "Residence", "Liquidation Approval", "Advisor Exclusions", "Client Exclusions",
  "Standing Advisor Exclusions (current)", "Standing Client Exclusions (current)",
  "Standing Account Advisor Exclusions (current)", "Standing Account Client Exclusions (current)",
  "ESG Filters", "Risk Profile", "Base Allocation",
  "Strategy 1 Benchmark", "Strategy 1 Allocation %", "Strategy 1 Rationale",
  "Strategy 2 Benchmark", "Strategy 2 Allocation %", "Strategy 2 Rationale",
  "Strategy 3 Benchmark", "Strategy 3 Allocation %", "Strategy 3 Rationale",
  "Created At (ISO)", "Updated At (ISO)", "Initiated By", "Reviewed By", "Audit Trail", "Audit Hash",
].join(",");

function chain(entries: Array<{ date: string; user: string; action: string; notes: string }>): string {
  let previous = "";
  for (const entry of entries) {
    previous = createHash("sha256").update(`${previous}|${entry.date}|${entry.user}|${entry.action}|${entry.notes}`).digest("hex");
  }
  return previous;
}

describe("compliance CSV (ticket, AC-112, AC-54)", () => {
  it("escapes like the standalone writer: always quoted, quotes doubled, formula prefixes guarded", () => {
    expect(csvEscape("plain")).toBe('"plain"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) expect(csvEscape(`${lead}SUM(A1)`)).toBe(`"'${lead}SUM(A1)"`);
    expect(csvEscape("a=b")).toBe('"a=b"');
  });

  it("hashes the audit chain with SHA-256, EMPTY for none", async () => {
    const entries = [
      { date: "2026-10-15T14:00:00.000Z", user: "Avery Stone", action: "Request Created", notes: "" },
      { date: "2026-10-15T15:00:00.000Z", user: "Dana Admin", action: "Status changed to Approved", notes: "ok" },
    ];
    expect(await hashAuditChain(entries)).toBe(chain(entries));
    expect(await hashAuditChain([])).toBe("EMPTY");
  });

  it("writes the exporter line, the headers in the standalone order, and one row per request", async () => {
    const audit = [
      { id: "a1", date: "2026-10-15T14:00:00.000Z", user: "Avery Stone", action: "Created Request", notes: "Initial submission" },
      { id: "a2", date: "2026-10-15T16:00:00.000Z", user: "Dana Admin", action: "Status changed to Approved", notes: "Synthetic, \"quoted\"" },
    ];
    const first = syntheticRequest({
      id: "REQ-SYN0002", clientId: "HH-901", clientIds: ["HH-901", "HH-902"], clientNames: ["Synthetic Family", "Sample Person"],
      submittedBy: "", tradeAmount: "", depositAccount: "SYN-1001", status: "Pending Current Asset Liquidation", liquidationApproval: "",
      selectedAccounts: ["SYN-1001", "SYN-2002"], advisorExclusions: "=SYNX", clientExclusions: "SYNY",
      esgFilters: { fossilFuels: true, tobacco: true, weapons: false, none: false }, riskProfile: null, baseAllocation: null,
      equityStrategies: [{ id: 1, benchmark: "Synthetic Core", allocation: 60, rationale: "Line one\r\nline   two\n" }, { id: 2, benchmark: "Synthetic Value", allocation: 40, rationale: "" }],
      auditLog: audit,
    });
    const second = syntheticRequest({ id: "REQ-SYN0001", clientId: "HH-903", clientIds: ["HH-903"], auditLog: [] });
    const built = await buildComplianceCsv([first, second], SYNTHETIC_EXPORTER, {
      "HH-901": [
        { id: "x1", clientId: "HH-901", ticker: "SYNA", kind: "advisor", reason: "Synthetic hold", noBuy: true, noSell: false },
        { id: "x2", clientId: "HH-901", ticker: "SYNB", kind: "advisor", reason: "", noBuy: false, noSell: true },
        { id: "x3", clientId: "HH-901", ticker: "SYNC", kind: "client", reason: "", noBuy: true, noSell: true },
      ],
    }, {
      "REQ-SYN0002": [
        { accountNumber: "SYN-1001", kind: "advisor", ticker: "SYND", reason: "", noBuy: true, noSell: true },
        { accountNumber: "SYN-1001", kind: "advisor", ticker: "SYNE", reason: "r", noBuy: true, noSell: false },
        { accountNumber: "SYN-2002", kind: "advisor", ticker: "SYNF", reason: "", noBuy: false, noSell: true },
      ],
    }, NOW);

    expect(built.filename).toBe("Compliance_Export_2026-10-17.csv");
    const lines = built.text.split("\n");
    expect(lines).toHaveLength(4);
    expect(built.text).not.toContain("\r");
    expect(lines[0]).toBe("# Report Exported By: Riley Ops (ops@example.invalid) | Exported At: 2026-10-17T05:30:00.000Z | Record Count: 2");
    expect(lines[1]).toBe(HEADER);
    expect(lines[2]).toBe([
      '"REQ-SYN0002"', '"HH-901"', '"Synthetic Family & Sample Person"', '"Rachel Moss"', '"Rachel Moss"', '"Initial Funding"',
      '"N/A"', '"SYN-1001"', '"Pending Current Asset Liquidation"', '"1125000"', '"SYN-1001; SYN-2002"', '"NY"', '"N/A"',
      `"'=SYNX"`, '"SYNY"', '"SYNA (DNB - Synthetic hold); SYNB (DNS)"', '"SYNC (DNB+DNS)"',
      '"SYN-1001: SYND (DNB+DNS); SYNE (DNB - r) || SYN-2002: SYNF (DNS)"', '""',
      '"fossilFuels; tobacco"', '"N/A"', '"N/A"',
      '"Synthetic Core"', '"60"', '"Line one line two"', '"Synthetic Value"', '"40"', '""', '""', '""', '""',
      '"2026-10-15T14:00:00.000Z"', '"2026-10-15T15:00:00.000Z"',
      '"Avery Stone (2026-10-15T14:00:00.000Z)"', '"Dana Admin (2026-10-15T16:00:00.000Z)"',
      '"[2026-10-15T14:00:00.000Z] Avery Stone (Created Request): Initial submission || [2026-10-15T16:00:00.000Z] Dana Admin (Status changed to Approved): Synthetic, ""quoted"""',
      `"${chain(audit)}"`,
    ].join(","));
    expect(lines[3]).toBe([
      '"REQ-SYN0001"', '"HH-903"', '"Synthetic Family"', '"Rachel Moss"', '"Avery Stone"', '"Initial Funding"', '"250000"', '"N/A"',
      '"Pending Review"', '"1125000"', '"SYN-1001"', '"NY"', '"Yes"', '""', '""', '""', '""', '""', '""', '"None"', '"14"',
      '"Eq: 67% | Fix: 29.5% | Csh: 3.5%"', '""', '""', '""', '""', '""', '""', '""', '""', '""',
      '"2026-10-15T14:00:00.000Z"', '"2026-10-15T15:00:00.000Z"', '""', '""', '""', '"EMPTY"',
    ].join(","));
  });

  it("an empty export is the exporter line and headers only", async () => {
    const built = await buildComplianceCsv([], SYNTHETIC_EXPORTER, {}, {}, NOW);
    expect(built.text.split("\n")).toEqual([
      "# Report Exported By: Riley Ops (ops@example.invalid) | Exported At: 2026-10-17T05:30:00.000Z | Record Count: 0", HEADER,
    ]);
  });
});
