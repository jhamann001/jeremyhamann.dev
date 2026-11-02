import { describe, expect, it } from "vitest";
import { formatDetail, DETAIL_PREVIEW_MAX } from "@/components/audit/audit-detail";

// Detail formatting (WO ticket): compact single-line preview + expandable
// pretty-printed JSON; never throws on null / non-JSON input.

describe("formatDetail", () => {
  it("renders a dash for null / undefined / empty details", () => {
    for (const v of [null, undefined, "", "   "]) {
      expect(formatDetail(v)).toEqual({ preview: "—", full: null, expandable: false });
    }
  });

  it("compacts a small JSON object and offers the pretty form for expand", () => {
    const d = formatDetail('{"from":"WON","to":"COMMITTED"}');
    expect(d.preview).toBe('{"from":"WON","to":"COMMITTED"}');
    expect(d.expandable).toBe(true);
    expect(d.full).toBe('{\n  "from": "WON",\n  "to": "COMMITTED"\n}');
  });

  it("truncates long payloads at the max with an ellipsis", () => {
    const detail = JSON.stringify({ changes: { note: "x".repeat(200) } });
    const d = formatDetail(detail);
    expect(d.preview.length).toBe(DETAIL_PREVIEW_MAX);
    expect(d.preview.endsWith("…")).toBe(true);
    expect(d.expandable).toBe(true);
    expect(d.full).toContain('"changes"');
    expect(d.full).toContain("\n"); // pretty-printed, not the compact line
  });

  it("respects a custom max", () => {
    const d = formatDetail('{"a":1,"b":2}', 8);
    expect(d.preview).toBe('{"a":1,…');
    expect(d.expandable).toBe(true);
  });

  it("treats JSON scalars as not expandable when short", () => {
    expect(formatDetail('"WON"')).toEqual({ preview: '"WON"', full: null, expandable: false });
    expect(formatDetail("42")).toEqual({ preview: "42", full: null, expandable: false });
  });

  it("falls back to raw text for non-JSON without throwing", () => {
    const d = formatDetail("plain text note");
    expect(d).toEqual({ preview: "plain text note", full: null, expandable: false });
    const long = formatDetail("y".repeat(150));
    expect(long.preview.endsWith("…")).toBe(true);
    expect(long.expandable).toBe(true);
    expect(long.full).toBe("y".repeat(150));
  });
});
