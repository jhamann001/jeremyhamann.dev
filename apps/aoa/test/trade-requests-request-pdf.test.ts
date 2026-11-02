import { describe, expect, it } from "vitest";
import { buildRequestPdf, formatAccountStanding } from "@/lib/trade-requests/request-pdf";
import type { TradeRequest } from "@/lib/trade-requests/request-types";
import { pdfPageTexts as pageTexts } from "./helpers/pdf-text";

// ticket: the request PDF follows the standalone buildRequestPdf
// (trade-request shared/src/pdf.ts) — header, exporter line, body, standing
// account-level exclusions, audit table, footer and file name. Synthetic data.

function request(overrides: Partial<TradeRequest> = {}): TradeRequest {
  return {
    id: "REQ-SYN0001", clientId: "HH-901", clientName: "Synthetic Family", clientIds: ["HH-901", "HH-902"],
    clientNames: ["Synthetic Family", "Sample Person"], advisor: "Rachel Moss", submittedBy: "Avery Stone",
    tradeType: "Initial Funding", tradeAmount: "250000", depositAccount: "", rebalanceAll: false,
    status: "Pending Current Asset Liquidation", date: "2026-10-15T14:00:00.000Z", updatedAt: "2026-10-15T15:00:00.000Z",
    selectedAccounts: ["SYN-1001", "SYN-2002"], totalValue: 1125000, priority: "Urgent", advisorNotes: "Synthetic advisor note",
    residence: "NY", liquidationApproval: "Yes", advisorExclusions: "SYNX", clientExclusions: "",
    esgFilters: { fossilFuels: true, tobacco: false, weapons: false, alcohol: false, gambling: false, other: false, otherDescription: "", none: false },
    riskProfile: 14, baseAllocation: { equity: 67, fixed: 29.5, cash: 3.5 },
    equityStrategies: [{ id: 1, benchmark: "Synthetic Core", allocation: 100, rationale: "Synthetic rationale." }],
    raiseCashReason: "", liquidityDeadline: null, liquidateOption: "", liquidatePositions: "",
    auditLog: [
      { id: "a2", date: "2026-10-15T15:00:00.000Z", user: "Riley Ops", action: "Status Changed", notes: "Synthetic step", channel: "aoa" },
      { id: "a1", date: "2026-10-15T14:00:00.000Z", user: "Avery Stone", action: "Request Created", notes: "Initial submission", channel: "standalone" },
    ],
    ...overrides,
  };
}

const EXPORTER = { name: "Riley Ops", email: "ops@example.invalid" };
const NOW = new Date("2026-10-17T05:30:00.000Z");

describe("buildRequestPdf (ticket, AC-58)", () => {
  it("prints the standalone header, exporter, body, standing account exclusions, audit table and footer", async () => {
    const built = await buildRequestPdf(request(), EXPORTER, [
      { accountNumber: "SYN-1001", kind: "advisor", ticker: "SYNA", reason: "Synthetic concentrated position", noBuy: true, noSell: false },
      { accountNumber: "SYN-2002", kind: "client", ticker: "SYNB", reason: "", noBuy: true, noSell: true },
    ], NOW);
    expect(built.filename).toBe("Trade_Request_Synthetic_Family_&_Sample_Person_REQ-SYN0001_2026-10-17.pdf");
    const pages = await pageTexts(built.bytes);
    const text = pages.flat();
    expect(text.slice(0, 3)).toEqual([
      "REQ-SYN0001  —  Synthetic Family & Sample Person",
      "PENDING CURRENT ASSET LIQUIDATION",
      "Exported by Riley Ops (ops@example.invalid)",
    ]);
    for (const expected of [
      "Request Details", "Trade Type:  ", "Initial Funding", "Submitted By:  ", "Avery Stone", "Total Value:  ", "$1,125,000",
      "Accounts:  ", "SYN-1001, SYN-2002", "ESG Exclusions:  ", "fossilFuels", "Advisor Exclusions:  ", "SYNX",
      "Standing Account Advisor Exclusions (current):  ", "SYN-1001: SYNA (DNB - Synthetic concentrated position)",
      "Standing Account Client Exclusions (current):  ", "SYN-2002: SYNB (DNB+DNS)", "Advisor Notes:  ", "Synthetic advisor note",
      "Allocation & Strategy Rationale (Reg BI)", "Risk Profile:  ", "14", "Equity 67%  |  Fixed Income 29.5%  |  Cash 3.5%",
      "Synthetic Core  —  100% allocation", "Rationale:", "Synthetic rationale.",
      "Audit Trail", "Date", "User", "Action", "Notes", "Riley Ops", "Status Changed", "Request Created",
    ]) expect(text, expected).toContain(expected);
    expect(text).not.toContain("Client Exclusions:  ");
    expect(text.indexOf("Status Changed")).toBeLessThan(text.indexOf("Request Created"));
    pages.forEach((page, index) => {
      expect(page).toContain("Exported: 2026-10-17T05:30:00.000Z");
      expect(page).toContain(`Page ${index + 1} of ${pages.length}`);
    });
  });

  it("prints the stored status (D-01) and a single client's name", async () => {
    const built = await buildRequestPdf(request({ status: "Needs Info", clientIds: ["HH-901"], clientNames: ["Synthetic Family"] }), EXPORTER, [], NOW);
    expect(built.filename).toBe("Trade_Request_Synthetic_Family_REQ-SYN0001_2026-10-17.pdf");
    const text = (await pageTexts(built.bytes)).flat();
    expect(text[0]).toBe("REQ-SYN0001  —  Synthetic Family");
    expect(text[1]).toBe("NEEDS INFO");
    expect(text.some((line) => line.startsWith("Standing Account"))).toBe(false);
  });

  it("breaks long content across pages with a footer on each and survives non-WinAnsi text", async () => {
    const notes = Array.from({ length: 160 }, (_, i) => `Synthetic note line ${i + 1} 漢字`).join("\n");
    const built = await buildRequestPdf(request({ advisorNotes: notes }), EXPORTER, [], NOW);
    const pages = await pageTexts(built.bytes);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.at(-1)).toContain(`Page ${pages.length} of ${pages.length}`);
    expect(pages.flat()).toContain("Synthetic note line 1 ??");
  });

  it("formats account standing exclusions per account like the standalone export", () => {
    expect(formatAccountStanding([
      { accountNumber: "A1", kind: "advisor", ticker: "T1", reason: "r", noBuy: true, noSell: true },
      { accountNumber: "A1", kind: "advisor", ticker: "T2", reason: "", noBuy: false, noSell: true },
      { accountNumber: "A2", kind: "advisor", ticker: "T3", reason: "", noBuy: true, noSell: false },
    ])).toEqual({ advisor: "A1: T1 (DNB+DNS - r); T2 (DNS) || A2: T3 (DNB)", client: "" });
  });
});
