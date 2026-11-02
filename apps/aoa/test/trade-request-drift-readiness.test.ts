import { describe, it, expect } from "vitest";
import { compareHashes, readinessVerdict, type ReadinessDate } from "@/lib/trade-requests/drift/readiness";

// ticket (WO-AC-9): the readiness comparison and verdict, without a database.
const same = { aoa: 2, standalone: 2, missing: 0, differing: 0, extra: 0 };
const day = (date: string, over: Partial<ReadinessDate> = {}): ReadinessDate => ({ date, household: same, account: same, ...over });
const FIVE = ["2026-05-18", "2026-05-15", "2026-05-14", "2026-05-13", "2026-05-12"].map((d) => day(d));

describe("drift readiness", () => {
  it("counts missing, differing and extra keys", () => {
    const aoa = new Map([["a", "1"], ["b", "2"], ["x", "9"]]);
    const standalone = new Map([["a", "1"], ["b", "3"], ["c", "4"]]);
    expect(compareHashes(aoa, standalone)).toEqual({ aoa: 3, standalone: 3, missing: 1, differing: 1, extra: 1 });
  });
  it("is ready only with five matching weekday runs", () => {
    expect(readinessVerdict(FIVE)).toBe("ready");
    expect(readinessVerdict(FIVE.slice(0, 4))).toBe("not_ready");
  });
  it("is not ready when any date differs in either table", () => {
    expect(readinessVerdict([...FIVE.slice(0, 4), day("2026-05-12", { account: { ...same, differing: 1 } })])).toBe("not_ready");
    expect(readinessVerdict([...FIVE.slice(0, 4), day("2026-05-12", { household: { ...same, missing: 1 } })])).toBe("not_ready");
  });
  it("is not ready when the standalone service recorded nothing for a date", () => {
    const empty = { aoa: 0, standalone: 0, missing: 0, differing: 0, extra: 0 };
    expect(readinessVerdict([...FIVE.slice(0, 4), day("2026-05-12", { household: empty, account: empty })])).toBe("not_ready");
  });
});
