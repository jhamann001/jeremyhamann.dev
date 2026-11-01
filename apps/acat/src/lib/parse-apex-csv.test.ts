import { describe, it, expect } from "vitest";
import {
  parseApexCsv,
  parseApexActivitiesCsv,
  parseApexFile,
  detectApexFormat,
} from "./parse-apex-csv";

const VALID_CSV = `CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason
037833100,AAPL,Apple Inc.,Equity,1000,175000,DTC,Standard
88160R101,TSLA,Tesla Inc.,Equity,190,47500,DTC,Standard`;

const SINGLE_ROW_CSV = `CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason
922908363,VOO,Vanguard S&P 500 ETF,ETF,500,225000,DTC,Standard`;

describe("parseApexCsv", () => {
  it("parses a valid multi-row CSV", () => {
    const result = parseApexCsv(VALID_CSV);
    expect(result).toHaveLength(2);

    expect(result[0].cusip).toBe("037833100");
    expect(result[0].symbol).toBe("AAPL");
    expect(result[0].qty).toBe(1000);
    expect(result[0].amount).toBe(175000);
    expect(result[0].assetClass).toBe("Equity");
    expect(result[0].settlingLocation).toBe("DTC");

    expect(result[1].symbol).toBe("TSLA");
    expect(result[1].qty).toBe(190);
  });

  it("parses a single-row CSV", () => {
    const result = parseApexCsv(SINGLE_ROW_CSV);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("VOO");
    expect(result[0].qty).toBe(500);
  });

  it("throws on missing required columns", () => {
    const badCsv = "Name,Price\nAAPL,175";
    expect(() => parseApexCsv(badCsv)).toThrow("Missing expected column");
  });

  it("throws on header-only CSV (no data rows)", () => {
    const headerOnly = "CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason";
    expect(() => parseApexCsv(headerOnly)).toThrow("at least one data row");
  });

  it("throws on empty input", () => {
    expect(() => parseApexCsv("")).toThrow();
  });

  it("handles quoted fields with commas", () => {
    const csv = `CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason
037833100,AAPL,"Apple, Inc.",Equity,100,15000,DTC,Standard`;
    const result = parseApexCsv(csv);
    expect(result[0].description).toBe("Apple, Inc.");
  });

  it("handles Windows-style line endings (CRLF)", () => {
    const csv = "CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason\r\n037833100,AAPL,Apple Inc.,Equity,100,15000,DTC,Standard\r\n";
    const result = parseApexCsv(csv);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("AAPL");
  });

  it("treats non-numeric qty as 0", () => {
    const csv = `CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason
037833100,AAPL,Apple Inc.,Equity,abc,15000,DTC,Standard`;
    const result = parseApexCsv(csv);
    expect(result[0].qty).toBe(0);
  });
});

describe("detectApexFormat", () => {
  it("identifies the ACAT output format by its Settling Location columns", () => {
    expect(
      detectApexFormat([
        "CUSIP",
        "Symbol",
        "Description",
        "Asset Class",
        "Qty",
        "Amount",
        "Settling Location",
        "Settling Location Reason",
      ])
    ).toBe("acat");
  });

  it("identifies the Activities format by Symbol + CUSIP + Quantity", () => {
    expect(
      detectApexFormat([
        "Account Number",
        "Symbol",
        "CUSIP",
        "Description",
        "Quantity",
        "Side",
        "Activity Type",
      ])
    ).toBe("activities");
  });

  it("returns null when only Symbol + Quantity are present (no CUSIP)", () => {
    expect(detectApexFormat(["Symbol", "Quantity", "Activity Type"])).toBeNull();
  });

  it("returns null for an unrecognized header set", () => {
    expect(detectApexFormat(["Name", "Price"])).toBeNull();
  });
});

// Full ~45-column header row from a real Apex Activities export. Only Symbol,
// CUSIP, and Quantity should be consumed; everything else is ignored.
const REAL_ACTIVITIES_HEADERS = [
  "Account ID",
  "Account Number",
  "Accrued Interest",
  "Asset Type",
  "Commissions",
  "Correspondent ID",
  "Correspondent Title",
  "Correspondent Code",
  "Currency Code",
  "Description",
  "Fees",
  "Generation",
  "Gross Amount",
  "Activity ID",
  "Net Amount",
  "Price",
  "Process Date",
  "Quantity",
  "Region Code",
  "Settle Date",
  "Side",
  "Source Application",
  "Source Application ID",
  "State",
  "Sub Type",
  "Symbol",
  "Activity Time",
  "Activity Type",
  "Withholdings",
  "Asset ID",
  "Booking API Trade Allocation ID",
  "Broker Capacity",
  "Client Order ID",
  "CUSIP",
  "Prevailing Market Price",
  "Special Instructions",
  "Memo Location",
  "Mutual Fund Account",
  "Creation Time",
  "Side Modifier",
  "Contribution Year",
  "Contribution Type",
  "Distribution Year",
  "Distribution Type",
  "Activity Date",
  "Title",
];

function rowFor(
  headers: string[],
  values: Record<string, string>
): string {
  return headers.map((h) => values[h] ?? "").join(",");
}

describe("parseApexActivitiesCsv", () => {
  it("parses a real-shape Activities export, consuming only Symbol/CUSIP/Quantity", () => {
    const headerRow = REAL_ACTIVITIES_HEADERS.join(",");
    const row1 = rowFor(REAL_ACTIVITIES_HEADERS, {
      "Account Number": "ABC123",
      Symbol: "AAPL",
      CUSIP: "037833100",
      Quantity: "100",
      Side: "BUY",
      "Activity Type": "BOUGHT",
      "Net Amount": "15000",
      Description: "Apple Inc.",
    });
    const row2 = rowFor(REAL_ACTIVITIES_HEADERS, {
      "Account Number": "ABC123",
      Symbol: "TSLA",
      CUSIP: "88160R101",
      Quantity: "50",
      Side: "BUY",
      "Activity Type": "BOUGHT",
    });
    const csv = [headerRow, row1, row2].join("\n");

    const result = parseApexActivitiesCsv(csv);
    expect(result).toHaveLength(2);

    expect(result[0].symbol).toBe("AAPL");
    expect(result[0].cusip).toBe("037833100");
    expect(result[0].qty).toBe(100);
    // Everything else drops to defaults.
    expect(result[0].description).toBe("");
    expect(result[0].assetClass).toBe("");
    expect(result[0].amount).toBe(0);
    expect(result[0].settlingLocation).toBe("");

    expect(result[1].symbol).toBe("TSLA");
    expect(result[1].cusip).toBe("88160R101");
    expect(result[1].qty).toBe(50);
  });

  // Feature (ticket): ACAT cash arrives as a movement row with a dollar
  // Net Amount but no Symbol/CUSIP and zero Quantity. It must be recovered as
  // a synthetic CASH position instead of being dropped.
  it("captures the ACAT cash movement row (no Symbol/CUSIP, non-zero Net Amount) as CASH", () => {
    const headerRow = REAL_ACTIVITIES_HEADERS.join(",");
    const cashRow = rowFor(REAL_ACTIVITIES_HEADERS, {
      "Asset Type": "TYPE_UNSPECIFIED",
      "Gross Amount": "1936.87000000",
      "Net Amount": "1936.87000000",
      Quantity: "0.00000000",
      "Activity Type": "MOVEMENT",
      "Sub Type": "ACCOUNT_TRANSFER",
      Description: "Full Account Transfer from MORGAN STANLEY",
    });
    const equityRow = rowFor(REAL_ACTIVITIES_HEADERS, {
      Symbol: "NVDA",
      CUSIP: "67066G104",
      Quantity: "107.00000000",
      "Net Amount": "0.00000000",
      "Activity Type": "MOVEMENT",
      "Sub Type": "ACCOUNT_TRANSFER",
    });
    const csv = [headerRow, cashRow, equityRow].join("\n");

    const result = parseApexActivitiesCsv(csv);

    const cash = result.find((p) => p.symbol === "CASH");
    expect(cash).toBeDefined();
    expect(cash!.amount).toBe(1936.87);
    expect(cash!.qty).toBe(0);
    expect(cash!.assetClass).toBe("Cash");

    // Securities still reconcile by quantity; their Net Amount ($0 in an
    // in-kind transfer) is not consumed.
    const nvda = result.find((p) => p.symbol === "NVDA");
    expect(nvda).toBeDefined();
    expect(nvda!.qty).toBe(107);
    expect(nvda!.amount).toBe(0);
  });

  it("does not synthesize cash for a no-identifier row with zero Net Amount", () => {
    const headerRow = REAL_ACTIVITIES_HEADERS.join(",");
    const blankRow = rowFor(REAL_ACTIVITIES_HEADERS, {
      "Net Amount": "0.00000000",
      Quantity: "0.00000000",
    });
    const csv = [headerRow, blankRow].join("\n");
    expect(parseApexActivitiesCsv(csv)).toHaveLength(0);
  });

  it("cannot recover cash when the export lacks a Net Amount column", () => {
    // Narrow exports without Net Amount: the no-identifier cash row is simply
    // dropped (nothing to reconcile against), securities still parse.
    const csv = `Symbol,CUSIP,Quantity
,,0
AAPL,037833100,100`;
    const result = parseApexActivitiesCsv(csv);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("AAPL");
  });

  it("skips rows with zero quantity and rows missing both Symbol and CUSIP", () => {
    const csv = `Symbol,CUSIP,Quantity
AAPL,037833100,100
FEE,,0
,,50
TSLA,88160R101,25`;
    const result = parseApexActivitiesCsv(csv);
    expect(result).toHaveLength(2);
    expect(result[0].symbol).toBe("AAPL");
    expect(result[1].symbol).toBe("TSLA");
  });

  it("keeps a row that has CUSIP but no Symbol", () => {
    const csv = `Symbol,CUSIP,Quantity
,037833100,100`;
    const result = parseApexActivitiesCsv(csv);
    expect(result).toHaveLength(1);
    expect(result[0].cusip).toBe("037833100");
    expect(result[0].symbol).toBe("");
  });

  it("throws when Symbol column is missing", () => {
    const csv = `CUSIP,Quantity
037833100,100`;
    expect(() => parseApexActivitiesCsv(csv)).toThrow(
      'Missing expected column: "Symbol"'
    );
  });

  it("throws when CUSIP column is missing", () => {
    const csv = `Symbol,Quantity
AAPL,100`;
    expect(() => parseApexActivitiesCsv(csv)).toThrow(
      'Missing expected column: "CUSIP"'
    );
  });

  it("throws when Quantity column is missing", () => {
    const csv = `Symbol,CUSIP
AAPL,037833100`;
    expect(() => parseApexActivitiesCsv(csv)).toThrow(
      'Missing expected column: "Quantity"'
    );
  });
});

describe("parseApexFile", () => {
  it("dispatches an ACAT Output file to the ACAT parser", () => {
    const csv = `CUSIP,Symbol,Description,Asset Class,Qty,Amount,Settling Location,Settling Location Reason
037833100,AAPL,Apple Inc.,Equity,100,15000,DTC,Standard`;
    const result = parseApexFile(csv);
    expect(result.format).toBe("acat");
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].settlingLocation).toBe("DTC");
  });

  it("dispatches an Activities export to the Activities parser", () => {
    const csv = `Account Number,Symbol,CUSIP,Quantity,Side,Activity Type
ABC123,AAPL,037833100,100,BUY,BOUGHT`;
    const result = parseApexFile(csv);
    expect(result.format).toBe("activities");
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].symbol).toBe("AAPL");
    expect(result.positions[0].cusip).toBe("037833100");
    expect(result.positions[0].qty).toBe(100);
  });

  it("throws with a helpful message when the format is unrecognized", () => {
    expect(() => parseApexFile("Name,Price\nAAPL,175")).toThrow(
      /Unrecognized Apex CSV format/
    );
  });
});
