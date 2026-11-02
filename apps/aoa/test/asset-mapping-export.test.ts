import { describe, expect, it } from "vitest";
import type { AssetMapAccountView, AssetMapHouseholdView, AssetMapPositionView } from "@/lib/data/asset-map";
import type { AssetMapDestination, AssetMapDestinationsView } from "@/lib/data/asset-map-destinations";
import { buildHouseholdSpreadsheet, householdSpreadsheetFilename } from "@/components/asset-mapping/workspace/export";

const ACC = "66666666-6666-4666-8666-666666666666";
const ACC2 = "77777777-7777-4777-8777-777777777777";
const D1 = "22222222-2222-4222-8222-222222222222";
const D2 = "33333333-3333-4333-8333-333333333333";
const L1 = "44444444-4444-4444-8444-444444444444";
const L2 = "55555555-5555-4555-8555-555555555555";

const POSITION_HEADER =
  "Client Name,Custodian,Account Type,Account Owner,Account Number,Symbol,Description,Shares,Market Value,Cost Basis,Cost Basis Granularity,Cost Basis Status,Classification,Transfer Status,Transferring,Routing Notes,Has Override";
const DESTINATION_HEADER =
  "Transferring In - Account #,Transferring In - Account Type,Transferring In - Owner,Transfers To - Owner,Transfers To - Account Type,Transfers To - Apex #,Needs to be Opened at Apex,Statement Status";

function position(id: string, extra: Partial<AssetMapPositionView> = {}): AssetMapPositionView {
  return {
    id, symbol: "SYNA", description: "Synthetic Fund", assetType: "ETF", quantity: 10, marketValue: 1234.5,
    transferEligible: "ACAT", effectiveStatus: null, transferNotes: null, effectiveNotes: null,
    costBasis: 50, costBasisGranularity: "position", transferring: null, lots: [], ...extra,
  };
}

function account(id: string, extra: Partial<AssetMapAccountView> = {}): AssetMapAccountView {
  return {
    id, custodian: "Synthetic Custodian", accountType: "Individual", accountTypeOther: null,
    accountNumberMasked: "••••1234", accountHolder: "Synthetic Holder", statementDate: "2026-09-01",
    statementAgeDays: 5, isStale: false, totalValue: 100, isRollover: false, isInherited: false,
    inheritedNotes: null, apexRestriction: null, costBasisStatus: "Complete", validationStatus: null,
    validationIssues: [], custodianIntel: null, positions: [], ...extra,
  };
}

function household(accounts: AssetMapAccountView[], clientName: string | null = "Synthetic Client Name"): AssetMapHouseholdView {
  return { id: "hh-1", clientName, processedAt: null, docsTotal: null, docsExtracted: null, accounts };
}

function destination(id: string, extra: Partial<AssetMapDestination> = {}): AssetMapDestination {
  return {
    id, owner: "Synthetic Owner", targetAccountType: "Roth IRA", existingApexNumber: null, needsToBeOpened: true,
    existingCount: 0, suggestedApexNumber: null, sources: [], ...extra,
  };
}

function destinations(list: AssetMapDestination[]): AssetMapDestinationsView {
  return { destinations: list, accountNumbers: { [ACC]: "••••••••1234", [ACC2]: "••••5678" }, overriddenPositionIds: [] };
}

const rows = (csv: string) => csv.split("\n");

describe("household spreadsheet export", () => {
  it("the first row is the AC-41 position header in order", () => {
    const csv = buildHouseholdSpreadsheet(household([]), destinations([]), new Set());
    expect(rows(csv)[0]).toBe(POSITION_HEADER);
  });

  it("one row per position with the pipeline's values", () => {
    const acc = account(ACC, {
      positions: [
        position("p1", { effectiveStatus: "LIQUIDATE", transferring: true, effectiveNotes: "Synthetic routing", transferNotes: "Ignored note" }),
        position("p2", { transferring: false, transferNotes: "Synthetic transfer note", costBasisGranularity: "lot" }),
        position("p3", { symbol: null, description: null, quantity: null, marketValue: null, costBasis: null, assetType: null, transferEligible: null }),
      ],
    });
    const csv = buildHouseholdSpreadsheet(household([acc]), destinations([]), new Set(["p2"]));
    const out = rows(csv);
    expect(out.slice(1, 4)).toEqual([
      "Synthetic Client Name,Synthetic Custodian,Individual,Synthetic Holder,••••••••1234,SYNA,Synthetic Fund,10,1234.5,50,position,Complete,ETF,LIQUIDATE,Yes,Synthetic routing,No",
      "Synthetic Client Name,Synthetic Custodian,Individual,Synthetic Holder,••••••••1234,SYNA,Synthetic Fund,10,1234.5,50,lot,Complete,ETF,ACAT,No,Synthetic transfer note,Yes",
      "Synthetic Client Name,Synthetic Custodian,Individual,Synthetic Holder,••••••••1234,,,,,,position,Complete,,,,,No",
    ]);
  });

  it("then a blank row, the Accounts to be Opened at Apex heading, and its header row in order", () => {
    const csv = buildHouseholdSpreadsheet(household([account(ACC, { positions: [position("p1")] })]), destinations([]), new Set());
    expect(rows(csv).slice(2, 5)).toEqual(["", "Accounts to be Opened at Apex", DESTINATION_HEADER]);
  });

  it("one row per destination source joined to its account", () => {
    const accounts = [
      account(ACC, { accountType: "Traditional IRA", accountHolder: "Synthetic Holder" }),
      account(ACC2, { accountType: "Individual", accountHolder: "Synthetic Second Holder", isStale: true, statementAgeDays: 120 }),
    ];
    const list = [
      destination(D1, {
        existingApexNumber: "SYN00001", suggestedApexNumber: "SYN99999", needsToBeOpened: false,
        sources: [{ linkId: L1, custodian: "Synthetic Custodian", accountNumberMasked: "••••••••1234", accountId: ACC }],
      }),
      destination(D2, {
        owner: "Synthetic Second", targetAccountType: "Individual", suggestedApexNumber: "SYN00002",
        sources: [{ linkId: L2, custodian: "Synthetic Custodian", accountNumberMasked: "••••5678", accountId: ACC2 }],
      }),
    ];
    const out = rows(buildHouseholdSpreadsheet(household(accounts), destinations(list), new Set()));
    const start = out.indexOf(DESTINATION_HEADER) + 1;
    expect(out.slice(start)).toEqual([
      "••••••••1234,Traditional IRA,Synthetic Holder,Synthetic Owner,Roth IRA,SYN00001,No,Current",
      "••••5678,Individual,Synthetic Second Holder,Synthetic Second,Individual,SYN00002,Yes,NEW STATEMENT NEEDED (120d old)",
    ]);
  });

  it("a destination with no sources gets one row with only its destination columns", () => {
    const out = rows(buildHouseholdSpreadsheet(household([]), destinations([destination(D1)]), new Set()));
    expect(out[out.length - 1]).toBe(",,,Synthetic Owner,Roth IRA,,Yes,");
  });

  it("keeps the second table's heading and header row when there are no destinations", () => {
    const out = rows(buildHouseholdSpreadsheet(household([]), destinations([]), new Set()));
    expect(out).toEqual([POSITION_HEADER, "", "Accounts to be Opened at Apex", DESTINATION_HEADER]);
  });

  it("escapes commas, quotes, and newlines", () => {
    const list = [destination(D1, { owner: 'Synthetic, "Owner"', targetAccountType: "Line\nBreak" })];
    const csv = buildHouseholdSpreadsheet(household([]), destinations(list), new Set());
    expect(csv).toContain('"Synthetic, ""Owner"""');
    expect(csv).toContain('"Line\nBreak"');
  });

  it("uses only masked account numbers", () => {
    const acc = account(ACC, { positions: [position("p1")] });
    const list = [destination(D1, { sources: [{ linkId: L1, custodian: "Synthetic Custodian", accountNumberMasked: "••••••••1234", accountId: ACC }] })];
    const csv = buildHouseholdSpreadsheet(household([acc]), destinations(list), new Set());
    expect(csv).not.toContain("000000001234");
    expect(csv).toContain("••••••••1234");
    expect(rows(csv)[1].split(",")[4]).toBe("••••••••1234");
  });

  it("names the file after the client and the date", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    expect(householdSpreadsheetFilename("Synthetic Client Name", now)).toBe("Synthetic_Client_Name_positions_2026-10-04.csv");
    expect(householdSpreadsheetFilename(null, now)).toBe("export_positions_2026-10-04.csv");
  });
});
