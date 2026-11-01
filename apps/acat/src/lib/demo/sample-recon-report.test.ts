// @vitest-environment node

import { describe, expect, it } from "vitest";
import { parseApexFile } from "../parse-apex-csv";
import { sampleReconReportCsv } from "./sample-recon-report";

const assets = [
  { symbol: "VTI", description: "Vanguard Total Stock Market ETF", cusip: null, expectedQty: 812, amount: 236616.8, assetClass: "us-equity" },
  { symbol: "BND", description: "Vanguard Total Bond Market ETF", cusip: null, expectedQty: 420, amount: 30702, assetClass: "us-bond" },
  { symbol: "BBGLX", description: "Bridge Builder Large Cap Growth Fund", cusip: null, expectedQty: 2104.33, amount: 66538.91, assetClass: "us-equity" },
  { symbol: "CASH", description: "Cash and money market", cusip: null, expectedQty: 3912.69, amount: 3912.69, assetClass: "cash" },
];

describe("sample Apex report", () => {
  it("is an ACAT Output file the app's own parser reads", () => {
    const { format, positions } = parseApexFile(sampleReconReportCsv(assets));
    expect(format).toBe("acat");
    expect(positions.map((p) => p.symbol)).toEqual(["VTI", "BND", "BBGLX", "CASH"]);
  });

  it("delivers everything in full except a fund's fractional share", () => {
    const { positions } = parseApexFile(sampleReconReportCsv(assets));
    const qty = Object.fromEntries(positions.map((p) => [p.symbol, p.qty]));
    expect(qty).toMatchObject({ VTI: 812, BND: 420, BBGLX: 2104, CASH: 3912.69 });
    expect(positions.find((p) => p.symbol === "BBGLX")?.settlingLocationReason).toBe("Fractional share paid as cash in lieu");
  });

  it("quotes text that contains commas", () => {
    expect(sampleReconReportCsv(assets)).toContain('"Bridge Builder Large Cap Growth Fund"');
  });
});

describe("sample report cells typed by visitors", () => {
  it("keeps a description with a line break on one row, and escapes a formula", () => {
    const csv = sampleReconReportCsv([
      { symbol: "VTI", description: "Line one\nINJECTED,ROW,1", cusip: "922908769", expectedQty: 10, amount: 2500, assetClass: "equity" },
      { symbol: "BND", description: '=HYPERLINK("https://x.example","open")', cusip: "921937835", expectedQty: 5, amount: 400, assetClass: "bond" },
    ]);
    const rows = csv.trim().split(/\r?\n/);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('"Line one INJECTED,ROW,1"');
    expect(rows[2]).toContain(`"'=HYPERLINK(""https://x.example"",""open"")"`);
  });
});
