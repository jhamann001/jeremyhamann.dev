import { describe, it, expect } from "vitest";
import {
  ACAT_STATUSES,
  ACAT_STATUS_PICKER_OPTIONS,
  AcatStatus,
  CustodianFee,
  RECON_DERIVED_STATUSES,
  mapDirectionToFeeCategory,
  selectApplicableFees,
} from "./types";

function fee(overrides: Partial<CustodianFee> = {}): CustodianFee {
  return {
    id: overrides.id ?? "fee-1",
    custodianId: overrides.custodianId ?? "cust-1",
    feeType: overrides.feeType ?? "Test Fee",
    accountType: overrides.accountType ?? "ANY",
    transferType: overrides.transferType ?? "ANY",
    direction: overrides.direction ?? "ANY",
    amount: overrides.amount ?? 0,
    amountText: overrides.amountText ?? null,
    notes: overrides.notes ?? null,
    documentation: overrides.documentation ?? null,
  };
}

describe("mapDirectionToFeeCategory", () => {
  it("returns ANY for null/undefined/empty", () => {
    expect(mapDirectionToFeeCategory(null)).toBe("ANY");
    expect(mapDirectionToFeeCategory(undefined)).toBe("ANY");
    expect(mapDirectionToFeeCategory("")).toBe("ANY");
  });

  it("normalises In and Out casing", () => {
    expect(mapDirectionToFeeCategory("In")).toBe("IN");
    expect(mapDirectionToFeeCategory("in")).toBe("IN");
    expect(mapDirectionToFeeCategory("Out")).toBe("OUT");
    expect(mapDirectionToFeeCategory("OUT")).toBe("OUT");
  });

  it("returns ANY for unrecognised values", () => {
    expect(mapDirectionToFeeCategory("sideways")).toBe("ANY");
  });
});

describe("selectApplicableFees — residual credits", () => {
  it("returns no fees instead of treating Residual Credit as ANY", () => {
    const rows = [
      fee({ id: "full", transferType: "FULL", amount: 75 }),
      fee({ id: "partial", transferType: "PARTIAL", amount: 25 }),
      fee({ id: "any", transferType: "ANY", amount: 10 }),
    ];

    const summary = selectApplicableFees(
      rows,
      "Individual",
      "Residual Credit",
      "In"
    );

    expect(summary).toEqual({
      fees: [],
      total: 0,
      hasUnknownAmount: false,
    });
  });

  it("normalises surrounding whitespace and casing", () => {
    const rows = [fee({ id: "any", transferType: "ANY", amount: 10 })];

    expect(
      selectApplicableFees(rows, null, "  RESIDUAL CREDIT  ", "In").fees
    ).toEqual([]);
  });
});

describe("selectApplicableFees — direction filter", () => {
  // Core bug being fixed: a CustodianFee row tagged OUT represents a fee
  // the contra charges when it RELEASES assets. On the ACAT record that
  // appears as direction = "In" (assets moving contra -> our firm). The
  // filter is therefore inverted: OUT fees show on In records.

  it("includes an OUT-tagged fee when record direction is In", () => {
    const rows = [fee({ id: "out-fee", direction: "OUT", amount: 95 })];
    const summary = selectApplicableFees(rows, null, null, "In");
    expect(summary.fees.map((f) => f.id)).toEqual(["out-fee"]);
    expect(summary.total).toBe(95);
  });

  it("excludes an OUT-tagged fee when record direction is Out", () => {
    const rows = [fee({ id: "out-fee", direction: "OUT", amount: 95 })];
    const summary = selectApplicableFees(rows, null, null, "Out");
    expect(summary.fees).toEqual([]);
    expect(summary.total).toBe(0);
  });

  it("excludes an IN-tagged fee when record direction is In", () => {
    const rows = [fee({ id: "in-fee", direction: "IN", amount: 25 })];
    const summary = selectApplicableFees(rows, null, null, "In");
    expect(summary.fees).toEqual([]);
  });

  it("includes an IN-tagged fee when record direction is Out", () => {
    const rows = [fee({ id: "in-fee", direction: "IN", amount: 25 })];
    const summary = selectApplicableFees(rows, null, null, "Out");
    expect(summary.fees.map((f) => f.id)).toEqual(["in-fee"]);
  });

  it("always includes ANY-direction fees regardless of record direction", () => {
    const rows = [
      fee({ id: "any-fee", direction: "ANY", amount: 43.5 }),
    ];
    expect(
      selectApplicableFees(rows, null, null, "In").fees.map((f) => f.id)
    ).toEqual(["any-fee"]);
    expect(
      selectApplicableFees(rows, null, null, "Out").fees.map((f) => f.id)
    ).toEqual(["any-fee"]);
    expect(
      selectApplicableFees(rows, null, null, undefined).fees.map((f) => f.id)
    ).toEqual(["any-fee"]);
  });

  it("includes direction-tagged fees when the record direction is missing (legacy guard)", () => {
    // Records created before the Direction field was mandatory must still
    // surface their schedule so maintenance doesn't silently empty out.
    const rows = [
      fee({ id: "out-fee", direction: "OUT", amount: 95 }),
      fee({ id: "in-fee", direction: "IN", amount: 25 }),
    ];
    const summary = selectApplicableFees(rows, null, null, undefined);
    expect(summary.fees.map((f) => f.id).sort()).toEqual([
      "in-fee",
      "out-fee",
    ]);
  });

  it("combines direction + accountType + transferType filters correctly", () => {
    // Realistic Morgan Stanley example: ACAT Out (ANY/ANY/OUT) + IRA
    // Termination Fee (IRA/ANY/ANY). An IRA record moving INTO the firm
    // should show both; an IRA record moving OUT of the firm should show
    // only the termination fee.
    const rows = [
      fee({ id: "ms-acat-out", direction: "OUT", accountType: "ANY", amount: 125 }),
      fee({ id: "ms-ira-term", direction: "ANY", accountType: "IRA", amount: 125 }),
    ];

    const inbound = selectApplicableFees(rows, "Traditional IRA", null, "In");
    expect(inbound.fees.map((f) => f.id).sort()).toEqual([
      "ms-acat-out",
      "ms-ira-term",
    ]);
    expect(inbound.total).toBe(250);

    const outbound = selectApplicableFees(rows, "Traditional IRA", null, "Out");
    expect(outbound.fees.map((f) => f.id)).toEqual(["ms-ira-term"]);
    expect(outbound.total).toBe(125);
  });

  it("preserves the existing transferType filter alongside direction", () => {
    // Schwab-style: Full Transfer ($50, FULL/OUT), Partial Transfer ($0,
    // PARTIAL/OUT). A Partial ACAT into the firm should only match the
    // partial row.
    const rows = [
      fee({ id: "full", transferType: "FULL", direction: "OUT", amount: 50 }),
      fee({ id: "partial", transferType: "PARTIAL", direction: "OUT", amount: 0 }),
    ];
    const summary = selectApplicableFees(rows, null, "Partial", "In");
    expect(summary.fees.map((f) => f.id)).toEqual(["partial"]);
  });

  it("falls back to ANY when a fee row has a missing direction field", () => {
    // Defensive: the TS type says direction is required, but if a row
    // slips in without it (e.g. mid-migration), treat it as ANY rather
    // than dropping it silently. Cast through `unknown` because we're
    // deliberately constructing a row that violates the type contract.
    const rows = [
      { ...fee({ id: "legacy", amount: 10 }), direction: undefined },
    ] as unknown as CustodianFee[];
    const summary = selectApplicableFees(rows, null, null, "Out");
    expect(summary.fees.map((f) => f.id)).toEqual(["legacy"]);
  });
});

describe("ACAT_STATUS_PICKER_OPTIONS (ticket item 4)", () => {
  // The dropdown shown to operators (AcatDetail drawer + NewAcatModal)
  // should only list real ACAT lifecycle statuses. Recon outcome (Matched
  // / Mismatch / Pending) is derived from asset matching and surfaced in
  // its own column — picking it as an ACAT status doesn't make sense.

  it("excludes the recon-derived statuses", () => {
    for (const recon of RECON_DERIVED_STATUSES) {
      expect(ACAT_STATUS_PICKER_OPTIONS).not.toContain(recon);
    }
  });

  it("keeps every non-recon status", () => {
    const expected: AcatStatus[] = ACAT_STATUSES.filter(
      (s) => !RECON_DERIVED_STATUSES.has(s)
    );
    expect(ACAT_STATUS_PICKER_OPTIONS).toEqual(expected);
  });

  it("preserves the ACAT_STATUSES ordering for everything it keeps", () => {
    // The picker is just a filter over ACAT_STATUSES — relative order
    // must be preserved so the dropdown still reads naturally
    // (Waiting → Account Opening → … → Completed).
    let prev = -1;
    for (const s of ACAT_STATUS_PICKER_OPTIONS) {
      const idx = ACAT_STATUSES.indexOf(s);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
  });

  it("contains the canonical lifecycle statuses operators expect", () => {
    // Sanity: a representative sample. If any of these ever leaves the
    // picker the test loudly tells us before users notice.
    expect(ACAT_STATUS_PICKER_OPTIONS).toContain<AcatStatus>("WaitingForApex");
    expect(ACAT_STATUS_PICKER_OPTIONS).toContain<AcatStatus>("AcatReceived");
    expect(ACAT_STATUS_PICKER_OPTIONS).toContain<AcatStatus>("Submitted");
    expect(ACAT_STATUS_PICKER_OPTIONS).toContain<AcatStatus>("Completed");
    expect(ACAT_STATUS_PICKER_OPTIONS).toContain<AcatStatus>("Rejected");
  });
});
