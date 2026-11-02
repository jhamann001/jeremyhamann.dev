import { describe, expect, it } from "vitest";
import type { DealRow } from "@/lib/data/deal-types";
import {
  EXPORT_HEADERS,
  dealsToCsv,
  dealsToCsvRows,
  exportFilename,
} from "@/components/deals/deal-export";
import {
  mapReportRow,
  parseCsv,
  recordsFromCsv,
} from "@/lib/deals/import-csv";

// Pure row→CSV mapping behind the /deals "Export CSV" button (WO ticket).
// All data invented (PII rule). Quoting is proven HERE (comma/quote/newline
// round-trips) because the 24-row seed deliberately has no comma-bearing
// names — this suite carries that live-check clause.

const row = (over: Partial<DealRow> = {}): DealRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  source: "IMPORT",
  sf_deal_id: "DEMO-0001",
  name: "Jordan Sample - Fidelity - Roth IRA - 1234",
  client_first_name: "Jordan",
  client_last_name: "Sample",
  household_name: "Sample Household",
  household_sf_id: "HH-0001",
  client_sf_id: "003DEMO0001CLIENT1",
  amount: 250000,
  stage: "WON",
  stage_raw: "Closed Won",
  created_date: new Date("2026-05-04T00:00:00.000Z"),
  close_date: new Date("2026-06-15T00:00:00.000Z"),
  last_activity_date: new Date("2026-06-20T00:00:00.000Z"),
  owner_name: "Avery Stone",
  owner_sf_user_id: "USR-AVERY",
  secondary_owner: "Gwen Kuhlman",
  person_aum: 1234567.89,
  potential_aum: 2000000,
  cedar_ridge_user_id: "EU-0001",
  cedar_ridge_user_id_masked: false,
  statements: true,
  asset_mapped: false,
  plaid_linked: true, // present on the row — must NOT reach the CSV
  account_last4: "1234",
  account_type: "Roth IRA",
  transferring_firm: "Fidelity",
  employer: null,
  rolling_into: null,
  lost_from: null,
  archived_reason: null,
  stage_history: [],
  created_by: "seed",
  updated_by: null,
  created_at: new Date("2026-05-04T12:00:00.000Z"),
  updated_at: new Date("2026-06-20T12:00:00.000Z"),
  archived_at: null, // D7 (WO ticket): fixtures are active deals
  archived_by: null,
  ...over,
});

describe("EXPORT_HEADERS", () => {
  it("is the exact round-trip-friendly column contract — no plaid, no audit metadata", () => {
    expect(EXPORT_HEADERS).toEqual([
      "Deal: ID",
      "Deal: Deal Name",
      "Person: First Name",
      "Person: Last Name",
      "Person: Primary Entity",
      "Household SF ID (Person: Entity ID)",
      "AUM",
      "AoA - New Stage",
      "Stage",
      "Deal: Created Date",
      "Close Date",
      "Deal: Last Activity Date",
      "Person: Entity Owner",
      "Owner SF User ID",
      "Person: Secondary Owner",
      "Person: AUM",
      "Person: Potential AUM",
      "Person: Cedar Ridge User ID",
      "Statements",
      "Asset mapped",
      "Source",
      "Transferring Firm",
      "Funding Type", // D8 relabel (WO ticket)
      "Account Last4",
    ]);
    const joined = EXPORT_HEADERS.join("|").toLowerCase();
    expect(joined).not.toContain("plaid");
    expect(joined).not.toContain("created_at");
  });
});

describe("dealsToCsvRows", () => {
  it("maps a fully-populated row: ISO UTC dates, plain amounts, Yes/No booleans", () => {
    const rows = dealsToCsvRows([row()]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([...EXPORT_HEADERS]);
    expect(rows[1]).toEqual([
      "DEMO-0001",
      "Jordan Sample - Fidelity - Roth IRA - 1234",
      "Jordan",
      "Sample",
      "Sample Household",
      "HH-0001",
      "250000", // plain number — no $, no thousands separators
      "WON",
      "Closed Won",
      "2026-05-04", // UTC-midnight date must not shift a day
      "2026-06-15",
      "2026-06-20",
      "Avery Stone",
      "USR-AVERY",
      "Gwen Kuhlman",
      "1234567.89",
      "2000000",
      "EU-0001",
      "Yes",
      "No", // Asset mapped — the fixture row() defaults asset_mapped: false
      "IMPORT",
      "Fidelity",
      "Roth IRA",
      "1234",
    ]);
  });

  it("renders nulls as empty cells and false statements as No", () => {
    const rows = dealsToCsvRows([
      row({
        sf_deal_id: null,
        household_name: null,
        household_sf_id: null,
        stage_raw: null,
        close_date: null,
        last_activity_date: null,
        owner_name: null,
        owner_sf_user_id: null,
        secondary_owner: null,
        person_aum: null,
        potential_aum: null,
        cedar_ridge_user_id: null,
        statements: false,
        transferring_firm: null,
        account_type: null,
        account_last4: null,
      }),
    ]);
    const data = rows[1];
    const at = (h: string) => data[EXPORT_HEADERS.indexOf(h)];
    expect(at("Deal: ID")).toBe("");
    expect(at("Person: Primary Entity")).toBe("");
    expect(at("Stage")).toBe("");
    expect(at("Close Date")).toBe("");
    expect(at("Person: Entity Owner")).toBe("");
    expect(at("Person: AUM")).toBe("");
    expect(at("Statements")).toBe("No");
    expect(at("Transferring Firm")).toBe("");
    // Required fields still present.
    expect(at("Person: First Name")).toBe("Jordan");
    expect(at("AUM")).toBe("250000");
  });

  it("preserves the caller's (filtered) row order", () => {
    const rows = dealsToCsvRows([
      row({ sf_deal_id: "DEMO-0003" }),
      row({ sf_deal_id: "DEMO-0001" }),
    ]);
    expect(rows[1][0]).toBe("DEMO-0003");
    expect(rows[2][0]).toBe("DEMO-0001");
  });
});

describe("dealsToCsv — RFC-4180 quoting (D4's writer, verbatim)", () => {
  it("round-trips commas, double-quotes, and embedded newlines through parseCsv", () => {
    const tricky = row({
      name: 'Sample, Jordan - "Big Firm" - Roth IRA - 1234',
      client_last_name: "Sample, Jr.",
      household_name: 'The "Sample" Household',
      transferring_firm: "Line1\nLine2",
    });
    const parsed = parseCsv(dealsToCsv([tricky]));
    expect(parsed).toHaveLength(2);
    const at = (h: string) => parsed[1][EXPORT_HEADERS.indexOf(h)];
    expect(at("Deal: Deal Name")).toBe(
      'Sample, Jordan - "Big Firm" - Roth IRA - 1234',
    );
    expect(at("Person: Last Name")).toBe("Sample, Jr.");
    expect(at("Person: Primary Entity")).toBe('The "Sample" Household');
    expect(at("Transferring Firm")).toBe("Line1\nLine2");
  });

  it("emits a header-only CSV for an empty row set (pure fn stays total)", () => {
    const text = dealsToCsv([]);
    expect(parseCsv(text)).toEqual([[...EXPORT_HEADERS]]);
  });

  it("re-imports through the D4 mapping unchanged (round-trip friendliness)", () => {
    const r = row();
    const records = recordsFromCsv(dealsToCsv([r]));
    expect(records).toHaveLength(1);
    const { input } = mapReportRow(records[0]);
    expect(input.sf_deal_id).toBe(r.sf_deal_id);
    expect(input.name).toBe(r.name);
    expect(input.client_first_name).toBe(r.client_first_name);
    expect(input.client_last_name).toBe(r.client_last_name);
    expect(input.household_name).toBe(r.household_name);
    expect(input.household_sf_id).toBe(r.household_sf_id);
    expect(input.amount).toBe(r.amount);
    expect(input.stage).toBe(r.stage);
    expect(input.stage_raw).toBe(r.stage_raw);
    expect(input.created_date).toBe("2026-05-04");
    expect(input.close_date).toBe("2026-06-15");
    expect(input.last_activity_date).toBe("2026-06-20");
    expect(input.owner_name).toBe(r.owner_name);
    expect(input.person_aum).toBe(r.person_aum);
    expect(input.potential_aum).toBe(r.potential_aum);
    expect(input.cedar_ridge_user_id).toBe(r.cedar_ridge_user_id);
    expect(input.statements).toBe(true);
  });
});

describe("exportFilename", () => {
  it("names the file from LOCAL clock fields, zero-padded", () => {
    // new Date(y, m, d) is a LOCAL date — exactly what the button passes.
    expect(exportFilename(new Date(2026, 6, 1))).toBe(
      "deals-export-2026-07-01.csv",
    );
    expect(exportFilename(new Date(2026, 11, 31))).toBe(
      "deals-export-2026-12-31.csv",
    );
  });
});
