import { describe, expect, it } from "vitest";
import {
  accountNumbersMatch,
  parseAssetMappingCsv,
} from "./parse-asset-mapping-csv";

const HEADER =
  "Client Name,Custodian,Account Type,Account Owner,Account Number,Symbol,Description,Shares,Market Value,Classification,Include in Partial Transfer";

describe("parseAssetMappingCsv", () => {
  it("isolates the matching account and parses partial-transfer decisions", () => {
    const csv = [
      HEADER,
      'Client,Morgan Stanley,IRA,Client,•••••••••6-287,AAPL,Apple Inc,10,"$1,000",Equity,Yes',
      'Client,Morgan Stanley,Joint,Client,•••••••••1-287,MSFT,Microsoft,20,"$2,000",Equity,No',
      "Client,Morgan Stanley,IRA,Client,•••••••••6-287,BND,Vanguard Bond,5,$500,ETF,No",
    ].join("\n");

    const result = parseAssetMappingCsv(csv, "MS123456287");
    expect(result.positions.map((position) => position.symbol)).toEqual([
      "AAPL",
      "BND",
    ]);
    expect(result.includedCount).toBe(1);
    expect(result.excludedCount).toBe(1);
    expect(result.undecidedCount).toBe(0);
  });

  it("leaves selections undecided when the optional column is absent", () => {
    const csv = [
      "Account Number,Symbol,Description,Shares,Market Value,Classification",
      "••••6-287,AAPL,Apple Inc,10,1000,Equity",
    ].join("\n");
    const result = parseAssetMappingCsv(csv, "6287");
    expect(result.hasTransferSelections).toBe(false);
    expect(result.positions[0].includeInTransfer).toBeNull();
  });

  it("combines duplicate lot rows instead of dropping quantity", () => {
    const csv = [
      HEADER,
      "Client,Firm,IRA,Client,••••6-287,AAPL,Apple,10,1000,Equity,Yes",
      "Client,Firm,IRA,Client,••••6-287,AAPL,Apple,2,200,Equity,Yes",
    ].join("\n");
    const result = parseAssetMappingCsv(csv, "6287");
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toEqual(
      expect.objectContaining({ qty: 12, amount: 1200 })
    );
  });

  it("preserves an identified-by-description position with no symbol", () => {
    const csv = [
      HEADER,
      "Client,Firm,IRA,Client,••••6-287,,CONTRA CYBERARK SOFTWA,9,0,Other,No",
    ].join("\n");
    const result = parseAssetMappingCsv(csv, "6287");
    expect(result.positions[0]).toEqual(
      expect.objectContaining({
        symbol: "",
        description: "CONTRA CYBERARK SOFTWA",
        qty: 9,
      })
    );
  });

  it("rejects a file without positions for the tracker account", () => {
    const csv = [HEADER, "Client,Firm,IRA,Client,••••1-287,AAPL,Apple,10,1000,Equity,Yes"].join("\n");
    expect(() => parseAssetMappingCsv(csv, "6287")).toThrow(/No position rows matched/);
  });
});

describe("accountNumbersMatch", () => {
  it("matches masked account suffixes with punctuation", () => {
    expect(accountNumbersMatch("•••••••••6-287", "MS000006287")).toBe(true);
    expect(accountNumbersMatch("•••••••••1-287", "MS000006287")).toBe(false);
  });
});
