import { describe, expect, it } from "vitest";
import {
  summarizeChange,
  formatValue,
  CHANGE_VALUE_MAX,
} from "@/components/audit/row-change-detail";

// Field-change display model (tkt-audit-row-change-ui): shapes the trigger's
// `changed` jsonb per op; never throws on empty / malformed input.

describe("formatValue", () => {
  it("renders null / undefined as an em dash", () => {
    expect(formatValue(null)).toBe("—");
    expect(formatValue(undefined)).toBe("—");
  });

  it("passes strings, numbers and booleans through readably", () => {
    expect(formatValue("COMMITTED")).toBe("COMMITTED");
    expect(formatValue(42)).toBe("42");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(false)).toBe("false");
  });

  it("renders an empty string as quotes (a real value, not a dash)", () => {
    expect(formatValue("")).toBe('""');
  });

  it("renders objects / arrays as compact JSON", () => {
    expect(formatValue({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(formatValue([1, 2, 3])).toBe("[1,2,3]");
  });

  it("truncates very long values with an ellipsis", () => {
    const s = formatValue("y".repeat(200));
    expect(s.length).toBe(CHANGE_VALUE_MAX);
    expect(s.endsWith("…")).toBe(true);
  });

  it("respects a custom max", () => {
    expect(formatValue("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("summarizeChange — UPDATE", () => {
  it("maps each {from,to} column to a readable diff", () => {
    const s = summarizeChange("UPDATE", {
      stage: { from: "POTENTIAL", to: "COMMITTED" },
      amount: { from: "1000.00", to: "2500.00" },
    });
    expect(s).toEqual({
      kind: "updated",
      fields: [
        { field: "stage", from: "POTENTIAL", to: "COMMITTED" },
        { field: "amount", from: "1000.00", to: "2500.00" },
      ],
    });
  });

  it("renders null → value and value → null", () => {
    const s = summarizeChange("UPDATE", {
      close_date: { from: null, to: "2026-07-01" },
      note: { from: "old", to: null },
    });
    expect(s.kind).toBe("updated");
    if (s.kind !== "updated") throw new Error("expected updated");
    expect(s.fields).toEqual([
      { field: "close_date", from: "—", to: "2026-07-01" },
      { field: "note", from: "old", to: "—" },
    ]);
  });

  it("renders object-valued from/to as compact JSON", () => {
    const s = summarizeChange("UPDATE", {
      meta: { from: { a: 1 }, to: { a: 2, b: 3 } },
    });
    if (s.kind !== "updated") throw new Error("expected updated");
    expect(s.fields[0]).toEqual({
      field: "meta",
      from: '{"a":1}',
      to: '{"a":2,"b":3}',
    });
  });

  it("defensively handles a non-{from,to} value (shows it as the new value)", () => {
    const s = summarizeChange("UPDATE", { stage: "COMMITTED" });
    if (s.kind !== "updated") throw new Error("expected updated");
    expect(s.fields[0]).toEqual({ field: "stage", from: "—", to: "COMMITTED" });
  });

  it("empty changed → an empty field list", () => {
    expect(summarizeChange("UPDATE", {})).toEqual({ kind: "updated", fields: [] });
  });
});

describe("summarizeChange — INSERT / DELETE", () => {
  it("INSERT → created with the full snapshot as field/value pairs", () => {
    const s = summarizeChange("INSERT", {
      id: "DEAL-1",
      name: "Acme",
      stage: "POTENTIAL",
      amount: null,
    });
    expect(s).toEqual({
      kind: "created",
      fields: [
        { field: "id", value: "DEAL-1" },
        { field: "name", value: "Acme" },
        { field: "stage", value: "POTENTIAL" },
        { field: "amount", value: "—" },
      ],
    });
  });

  it("DELETE → deleted with the OLD snapshot as field/value pairs", () => {
    const s = summarizeChange("DELETE", { id: "DEAL-9", stage: "LOST" });
    expect(s).toEqual({
      kind: "deleted",
      fields: [
        { field: "id", value: "DEAL-9" },
        { field: "stage", value: "LOST" },
      ],
    });
  });

  it("is case-insensitive on the op verb", () => {
    expect(summarizeChange("insert", { id: "1" }).kind).toBe("created");
    expect(summarizeChange("delete", { id: "1" }).kind).toBe("deleted");
    expect(summarizeChange("update", { s: { from: "a", to: "b" } }).kind).toBe("updated");
  });

  it("empty snapshot → an empty field list", () => {
    expect(summarizeChange("INSERT", {})).toEqual({ kind: "created", fields: [] });
    expect(summarizeChange("DELETE", {})).toEqual({ kind: "deleted", fields: [] });
  });
});

describe("summarizeChange — edge input", () => {
  it("null / undefined changed → an empty list (never throws)", () => {
    expect(summarizeChange("UPDATE", null)).toEqual({ kind: "updated", fields: [] });
    expect(summarizeChange("INSERT", undefined)).toEqual({ kind: "created", fields: [] });
  });

  it("an unknown op falls back to a created-style value list", () => {
    const s = summarizeChange("TRUNCATE", { id: "1" });
    expect(s.kind).toBe("created");
  });
});
