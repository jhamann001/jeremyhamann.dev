import { describe, expect, it } from "vitest";
import {
  ARCHIVE_BY,
  CARRY_BY,
  planDedupe,
  type DedupeRow,
} from "../lib/data/deal-dedupe";

// tkt-deals-dedupe: the PURE decision logic behind the one-time dedupe. The
// script's dry-run and live paths both call planDedupe, so pinning the plan
// pins what the live run writes. All ids synthetic; a 15-char id is the first
// 15 chars of its 18-char twin (the real Salesforce-id relationship).
const NOW = "2026-07-09T12:00:00.000Z";

// Base 15-char keys; the 18-char twin is the key + a 3-char checksum.
const K1 = "001A402218MPKD1";
const K2 = "001D179751IXVL1";
const K3 = "001H983106OKKL9";
const K4 = "001E668185QDRM2";

const legacy = (sf: string, stage: DedupeRow["stage"]): DedupeRow => ({
  id: `legacy_${sf}`,
  sf_deal_id: sf,
  stage,
});
const current = (sf18: string, stage: DedupeRow["stage"]): DedupeRow => ({
  id: `cur_${sf18}`,
  sf_deal_id: sf18,
  stage,
});

describe("planDedupe", () => {
  it("carries a COMMITTED legacy promotion onto its POTENTIAL twin", () => {
    const l = legacy(K1, "COMMITTED");
    const c = current(K1 + "IAB", "POTENTIAL");
    const plan = planDedupe([l], [c], NOW);

    expect(plan.carries).toHaveLength(1);
    expect(plan.carries[0]).toMatchObject({
      twinId: c.id,
      legacyId: l.id,
      key15: K1,
      fromStage: "POTENTIAL",
      toStage: "COMMITTED",
      entry: { stage: "COMMITTED", from: "POTENTIAL", at: NOW, by: CARRY_BY },
    });
    // The twinned legacy row is still archived.
    expect(plan.archives).toEqual([{ id: l.id, sf_deal_id: K1 }]);
    expect(plan.orphans).toHaveLength(0);
    expect(plan.terminalSkips).toBe(0);
  });

  it("carries a FUNDING legacy promotion too", () => {
    const l = legacy(K2, "FUNDING");
    const c = current(K2 + "IAB", "POTENTIAL");
    const plan = planDedupe([l], [c], NOW);
    expect(plan.carries[0].toStage).toBe("FUNDING");
    expect(plan.carries[0].entry.stage).toBe("FUNDING");
  });

  it("skips the carry when the twin is terminal (WON), but still archives", () => {
    const l = legacy(K1, "COMMITTED");
    const c = current(K1 + "IAB", "WON");
    const plan = planDedupe([l], [c], NOW);

    expect(plan.carries).toHaveLength(0);
    expect(plan.terminalSkips).toBe(1);
    expect(plan.archives).toEqual([{ id: l.id, sf_deal_id: K1 }]);
  });

  it("skips the carry when the twin is terminal (LOST), but still archives", () => {
    const l = legacy(K2, "FUNDING");
    const c = current(K2 + "IAB", "LOST");
    const plan = planDedupe([l], [c], NOW);
    expect(plan.carries).toHaveLength(0);
    expect(plan.terminalSkips).toBe(1);
    expect(plan.archives).toHaveLength(1);
  });

  it("treats a legacy row with no twin as an orphan — never archived", () => {
    const l = legacy(K3, "COMMITTED");
    const plan = planDedupe([l], [], NOW);

    expect(plan.orphans).toEqual([{ id: l.id, sf_deal_id: K3, stage: "COMMITTED" }]);
    expect(plan.archives).toHaveLength(0);
    expect(plan.carries).toHaveLength(0);
  });

  it("archives a WON legacy with a WON twin and carries nothing", () => {
    const l = legacy(K4, "WON");
    const c = current(K4 + "IAB", "WON");
    const plan = planDedupe([l], [c], NOW);

    expect(plan.archives).toEqual([{ id: l.id, sf_deal_id: K4 }]);
    expect(plan.carries).toHaveLength(0);
    expect(plan.terminalSkips).toBe(0); // WON legacy is not a promotion to carry
  });

  it("does not carry when the twin is already promoted (no skip, no carry)", () => {
    const l = legacy(K1, "COMMITTED");
    const c = current(K1 + "IAB", "FUNDING"); // twin already ahead
    const plan = planDedupe([l], [c], NOW);
    expect(plan.carries).toHaveLength(0);
    expect(plan.terminalSkips).toBe(0);
    expect(plan.archives).toHaveLength(1);
  });

  it("does NOT carry a FUNDING legacy when the twin is already COMMITTED (non-terminal, off POTENTIAL) — still archives", () => {
    const l = legacy(K2, "FUNDING");
    const c = current(K2 + "IAB", "COMMITTED"); // twin off POTENTIAL, not terminal
    const plan = planDedupe([l], [c], NOW);
    expect(plan.carries).toHaveLength(0); // no double-append / no overwrite
    expect(plan.terminalSkips).toBe(0); // not a terminal skip either
    expect(plan.archives).toEqual([{ id: l.id, sf_deal_id: K2 }]); // legacy still archived
  });

  it("carries a twin at most once when two legacy rows point at it", () => {
    const l1 = { id: "legacy_a", sf_deal_id: K1, stage: "COMMITTED" as const };
    const l2 = { id: "legacy_b", sf_deal_id: K1, stage: "FUNDING" as const };
    const c = current(K1 + "IAB", "POTENTIAL");
    const plan = planDedupe([l1, l2], [c], NOW);
    expect(plan.carries).toHaveLength(1); // first promotion wins
    expect(plan.carries[0].toStage).toBe("COMMITTED");
    expect(plan.archives).toHaveLength(2); // both legacy rows archived
  });

  it("reports the top-level counts", () => {
    const plan = planDedupe(
      [legacy(K1, "COMMITTED"), legacy(K3, "POTENTIAL")],
      [current(K1 + "IAB", "POTENTIAL"), current(K2 + "IAB", "WON")],
      NOW,
    );
    expect(plan.legacy15Count).toBe(2);
    expect(plan.current18Count).toBe(2);
    expect(plan.twinsMatched).toBe(1); // only K1 legacy has a twin
    expect(plan.orphans).toHaveLength(1); // K3 has none
  });

  it("exposes stable provenance constants", () => {
    expect(CARRY_BY).toBe("dedupe-legacy-migration");
    expect(ARCHIVE_BY).toBe("dedupe-legacy-15char");
  });
});
