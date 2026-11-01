import { describe, it, expect } from "vitest";
import {
  RECORD_FIELDS,
  RECORD_FIELDS_BY_KEY,
  EXCLUDED_RECORD_KEYS,
  RecordFieldKey,
  defaultColumnOrder,
  defaultVisibleColumns,
  formatFieldValue,
  getField,
  moveColumn,
  normalizeColumnOrder,
  orderedVisibleFields,
} from "./record-fields";
import { mockAcats } from "./mock-data";
import { AcatRecord } from "./types";

describe("record-fields schema", () => {
  it("covers every scalar key on AcatRecord", () => {
    // Build a representative record with every field populated so
    // Object.keys gives the full surface area of AcatRecord.
    const sample: AcatRecord = {
      id: "x",
      deletedAt: null,
      clientName: "x",
      acatTransferId: "x",
      accountType: "x",
      additionalResources: "x",
      apexAccountId: "x",
      apexCompletionDate: "x",
      apexTicket: "x",
      associatedControlNumber: "x",
      controlNumber: "x",
      dtccNumber: "x",
      direction: "x",
      crwEe: "x",
      feeAmount: "x",
      feeCharged: "x",
      feeMemo: "x",
      feeRequestCompleted: "x",
      feeRequestSubmitted: "x",
      feeApexTicket: "x",
      feeCreditRequestId: "x",
      methodRequested: "x",
      transferWorkflow: "ACAT",
      notes: "x",
      opsSubmissionDateToApex: "x",
      originalClientRequestDate: "x",
      residualMonitoringRequired: true,
      residualFollowUpDate: "x",
      crmTicket: "x",
      rejectionReason: "x",
      statementAccountNumber: "x",
      statementAmount: 1,
      status: "PendingReview",
      transferringContra: "x",
      tradeRequestId: "x",
      tradeRequestUrl: "https://example.com/trade-request/x",
      tradeInstructions: "x",
      type: "x",
      wealthAdvisor: "x",
      lastUpdated: "x",
      crmDealId: "x",
      custodianId: "x",
      custodianName: "x",
      acatDate: "x",
      // ticket: completedDate column dropped. reconCompletedAt replaces
      // it as the only auto-managed completion stamp on AcatRecord.
      reconCompletedAt: null,
      slackAlerted: false,
      mappingSource: "x",
      apexSource: "x",
      assets: [],
      custodian: null,
    };

    const recordKeys = Object.keys(sample) as (keyof AcatRecord)[];
    const schemaKeys = new Set(RECORD_FIELDS.map((f) => f.key));

    for (const key of recordKeys) {
      if (EXCLUDED_RECORD_KEYS.has(key)) continue;
      expect(
        schemaKeys.has(key),
        `Missing schema entry for AcatRecord field "${String(key)}"`
      ).toBe(true);
    }
  });

  it("has unique field keys", () => {
    const seen = new Set<string>();
    for (const f of RECORD_FIELDS) {
      expect(seen.has(String(f.key)), `Duplicate field key ${String(f.key)}`).toBe(false);
      seen.add(String(f.key));
    }
  });

  it("has unique labels", () => {
    const seen = new Set<string>();
    for (const f of RECORD_FIELDS) {
      expect(seen.has(f.label), `Duplicate label "${f.label}"`).toBe(false);
      seen.add(f.label);
    }
  });

  it("provides options for every enum and multiselect field", () => {
    for (const f of RECORD_FIELDS) {
      if (f.type === "enum" || f.type === "multiselect") {
        expect(f.options, `${String(f.key)} should have options`).toBeDefined();
        expect((f.options ?? []).length).toBeGreaterThan(0);
      }
    }
  });

  it("makes every registered user-facing field available to filters", () => {
    const intentionallyNotFilterable = new Set(["deletedAt"]);

    for (const field of RECORD_FIELDS) {
      if (intentionallyNotFilterable.has(String(field.key))) continue;
      expect(
        field.filterable,
        `${String(field.key)} should be available in Add filter`
      ).not.toBe(false);
    }
  });

  it("includes the transfer operations fields in Add filter", () => {
    expect(getField("transferWorkflow")).toMatchObject({
      label: "Transfer Workflow",
      type: "enum",
    });
    expect(getField("residualMonitoringRequired")).toMatchObject({
      label: "Monitor for Residual",
      type: "boolean",
    });
    expect(getField("residualFollowUpDate")).toMatchObject({
      label: "Residual Follow-Up Date",
      type: "date",
    });
  });

  it("includes inherited account types as filter options", () => {
    const accountType = getField("accountType")!;
    expect(accountType.options).toEqual(
      expect.arrayContaining([
        "Inherited Roth IRA",
        "Inherited Traditional IRA (w/ beneficiaries)",
      ])
    );
  });

  it("indexes every field in RECORD_FIELDS_BY_KEY", () => {
    expect(RECORD_FIELDS_BY_KEY.size).toBe(RECORD_FIELDS.length);
    for (const f of RECORD_FIELDS) {
      expect(getField(f.key)).toBe(f);
    }
  });

  it("returns sane defaults for visible columns", () => {
    const defaults = defaultVisibleColumns();
    expect(defaults.size).toBeGreaterThan(0);
    // Sanity: client + status are always shown.
    expect(defaults.has("clientName")).toBe(true);
    expect(defaults.has("status")).toBe(true);
  });

  it("formatFieldValue returns a string for every field on every mock record", () => {
    for (const r of mockAcats) {
      for (const f of RECORD_FIELDS) {
        const out = formatFieldValue(f, r);
        expect(typeof out).toBe("string");
      }
    }
  });

  it("formats dates as MM-DD-YYYY", () => {
    const r = mockAcats[1]; // Has lastUpdated as a full ISO string
    const lastUpdated = getField("lastUpdated")!;
    expect(formatFieldValue(lastUpdated, r)).toBe("04-10-2026");
  });

  it("returns numeric values for number fields", () => {
    const stmt = getField("statementAmount")!;
    expect(stmt.value(mockAcats[0])).toBe(26800000);
  });

  it("no longer exposes slackAlerted as a column (ticket)", () => {
    // The "Flag to CS Slack" workflow was replaced by the daily digest,
    // so the per-record toggle column was removed from the field
    // registry. The DB column still exists for historical data.
    expect(getField("slackAlerted")).toBeUndefined();
  });
});

describe("column ordering helpers", () => {
  it("defaultColumnOrder returns every field exactly once in schema order", () => {
    const order = defaultColumnOrder();
    expect(order).toEqual(RECORD_FIELDS.map((f) => f.key));
    expect(new Set(order).size).toBe(order.length);
  });

  describe("normalizeColumnOrder", () => {
    it("appends missing fields at the end so new schema fields stay reachable", () => {
      const partial: RecordFieldKey[] = ["status", "clientName"];
      const out = normalizeColumnOrder(partial);
      expect(out.slice(0, 2)).toEqual(["status", "clientName"]);
      // Every schema field is present.
      expect(new Set(out)).toEqual(new Set(RECORD_FIELDS.map((f) => f.key)));
    });

    it("drops unknown keys (stale persisted entries)", () => {
      const stale: RecordFieldKey[] = [
        "clientName",
        // `completedDate` was removed in ticket; cast through `unknown` so
        // the test exercises the unknown-key code path even though TS knows
        // it no longer matches the live RecordFieldKey union.
        "completedDate" as unknown as RecordFieldKey,
        "status",
      ];
      const out = normalizeColumnOrder(stale);
      expect(out).not.toContain("completedDate" as unknown as RecordFieldKey);
      expect(out.indexOf("clientName")).toBe(0);
      expect(out.indexOf("status")).toBe(1);
    });

    it("dedupes accidental duplicates", () => {
      const dup: RecordFieldKey[] = ["clientName", "status", "clientName"];
      const out = normalizeColumnOrder(dup);
      const occurrences = out.filter((k) => k === "clientName").length;
      expect(occurrences).toBe(1);
    });
  });

  describe("orderedVisibleFields", () => {
    it("returns only visible fields in the supplied order", () => {
      const order: RecordFieldKey[] = [
        "status",
        "clientName",
        "acatDate",
        "wealthAdvisor",
      ];
      const visible = new Set<RecordFieldKey>(["clientName", "status"]);
      const out = orderedVisibleFields(order, visible);
      expect(out.map((f) => f.key)).toEqual(["status", "clientName"]);
    });

    it("appends visible fields missing from order at the end (schema order)", () => {
      // clientName is omitted from the order array but is visible — it
      // should reappear at the end so the column never disappears.
      const order: RecordFieldKey[] = ["status"];
      const visible = new Set<RecordFieldKey>(["clientName", "status"]);
      const out = orderedVisibleFields(order, visible).map((f) => f.key);
      expect(out[0]).toBe("status");
      expect(out).toContain("clientName");
    });

    it("ignores unknown keys silently", () => {
      const order = [
        "completedDate" as RecordFieldKey,
        "clientName",
      ] as RecordFieldKey[];
      const visible = new Set<RecordFieldKey>(["clientName"]);
      const out = orderedVisibleFields(order, visible).map((f) => f.key);
      expect(out).toEqual(["clientName"]);
    });
  });

  describe("moveColumn", () => {
    it("moves a key to a later position (post-removal index)", () => {
      const order: RecordFieldKey[] = [
        "clientName",
        "status",
        "acatDate",
        "wealthAdvisor",
      ];
      // Move clientName so it lands at the end.
      const out = moveColumn(order, "clientName", 3);
      expect(out).toEqual([
        "status",
        "acatDate",
        "wealthAdvisor",
        "clientName",
      ]);
    });

    it("moves a key to an earlier position", () => {
      const order: RecordFieldKey[] = [
        "clientName",
        "status",
        "acatDate",
        "wealthAdvisor",
      ];
      const out = moveColumn(order, "wealthAdvisor", 1);
      expect(out).toEqual([
        "clientName",
        "wealthAdvisor",
        "status",
        "acatDate",
      ]);
    });

    it("clamps out-of-range indices and never mutates the input", () => {
      const order: RecordFieldKey[] = ["clientName", "status", "acatDate"];
      const big = moveColumn(order, "clientName", 99);
      expect(big[big.length - 1]).toBe("clientName");
      const neg = moveColumn(order, "acatDate", -5);
      expect(neg[0]).toBe("acatDate");
      // Input untouched.
      expect(order).toEqual(["clientName", "status", "acatDate"]);
    });

    it("returns a copy unchanged when the key is unknown", () => {
      const order: RecordFieldKey[] = ["clientName", "status"];
      const out = moveColumn(order, "neverHeardOfIt" as RecordFieldKey, 0);
      expect(out).toEqual(order);
      expect(out).not.toBe(order);
    });
  });
});
