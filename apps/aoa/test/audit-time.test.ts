import { describe, expect, it } from "vitest";
import { fmtDateOnly, fmtWhen, relTime } from "@/components/audit/audit-time";

// When-column helpers (WO ticket), mirroring the mockup's fmtT / rel.
// Local-time construction keeps fmtWhen assertions timezone-safe.

const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi, 0).toISOString();

describe("fmtWhen", () => {
  it("formats afternoon times in the mockup shape", () => {
    expect(fmtWhen(at(2026, 6, 23, 14, 41))).toBe("Jun 23 · 2:41 PM");
  });

  it("formats morning times with zero-padded minutes", () => {
    expect(fmtWhen(at(2026, 1, 5, 9, 7))).toBe("Jan 5 · 9:07 AM");
  });

  it("renders 12-hour edges correctly (midnight and noon)", () => {
    expect(fmtWhen(at(2026, 12, 31, 0, 0))).toBe("Dec 31 · 12:00 AM");
    expect(fmtWhen(at(2026, 7, 2, 12, 30))).toBe("Jul 2 · 12:30 PM");
  });
});

describe("relTime", () => {
  const now = new Date("2026-07-02T12:00:00Z").getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("says 'just now' under a minute", () => {
    expect(relTime(ago(0), now)).toBe("just now");
    expect(relTime(ago(29_000), now)).toBe("just now");
  });

  it("uses minutes under an hour", () => {
    expect(relTime(ago(12 * 60_000), now)).toBe("12m ago");
  });

  it("uses hours under a day", () => {
    expect(relTime(ago(3 * 3_600_000), now)).toBe("3h ago");
  });

  it("uses days beyond that", () => {
    expect(relTime(ago(2 * 86_400_000), now)).toBe("2d ago");
  });
});

describe("fmtDateOnly", () => {
  it("renders a source calendar date without a local-time-zone shift", () => {
    expect(fmtDateOnly("2026-08-17")).toBe("Aug 17, 2026");
  });

  it("leaves an unexpected value visible instead of inventing a date", () => {
    expect(fmtDateOnly("unknown")).toBe("unknown");
  });
});
