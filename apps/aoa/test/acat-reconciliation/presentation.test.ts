import { describe, expect, it } from "vitest";
import { reviewCoverage, reviewDecisionLabel } from "@/lib/data/acat-reconciliation/presentation";
import { matchAcatPopulation } from "@/lib/data/acat-match";
import { snapshot, sourceRecord, targetRecord, TEST_AT, decision } from "./fixtures";

describe("saved review population presentation", () => {
  it("accounts for 247 transfers and 644 records without calling 886 bookkeeping rows pending matches", () => {
    const records = Array.from({ length: 644 }, (_, i) => sourceRecord(`record-${i}`));
    const targets = Array.from({ length: 247 }, (_, i) => ({ ...targetRecord(`target-${i}`),
      existingRecordId: i < 5 ? records[i].recordId : null, existingTransferUuid: i < 5 ? records[i].acatTransferId : null,
      hold: i >= 5,
    }));
    const decisions = matchAcatPopulation(snapshot(records), targets, { now: TEST_AT });
    expect(decisions).toHaveLength(886);
    const result = reviewCoverage({ decisions, targetCount: targets.length, sourceCount: records.length })!;
    expect(result.aoa).toEqual({ total: 247, categories: { linked: 5, held: 242, proposed: 0, review: 0, excluded: 0, no_counterpart: 0 } });
    expect(result.tracker).toEqual({ total: 644, categories: { linked: 5, held: 0, proposed: 0, review: 0, excluded: 0, no_counterpart: 639 } });
    for (const population of [result.aoa, result.tracker]) expect(Object.values(population.categories).reduce((a, b) => a + b, 0)).toBe(population.total);
  });

  it("counts a shared Tracker record once and puts competing decisions in review", () => {
    const decisions = [decision(), { ...decision(), transferId: "other", action: "review" as const, reason: "reserved_link" as const }];
    const result = reviewCoverage({ decisions, sourceCount: 1, targetCount: 2 })!;
    expect(result.tracker.categories.review).toBe(1);
    expect(result.aoa.categories).toMatchObject({ proposed: 1, review: 1 });
    decisions[0] = { ...decision(), action: "preserve", reason: "existing_link" };
    expect(reviewCoverage({ decisions, sourceCount: 1, targetCount: 2 })?.tracker.categories.linked).toBe(1);
  });

  it("keeps holds, missing evidence, exclusions and no counterpart distinct", () => {
    const decisions = [
      { ...decision(), transferId: "held", recordId: null, action: "exclude" as const, reason: "manual_hold" as const },
      { ...decision(), transferId: "review", recordId: null, action: "review" as const, reason: "missing_identity" as const },
      { ...decision(), transferId: "excluded", action: "exclude" as const, reason: "pair_rejected" as const },
      { ...decision(), transferId: null, recordId: "unmatched", action: "no_counterpart" as const, reason: "no_counterpart" as const },
    ];
    const result = reviewCoverage({ decisions, targetCount: 3, sourceCount: 2 })!;
    expect(result.aoa.categories).toMatchObject({ held: 1, review: 1, excluded: 1 });
    expect(result.tracker.categories).toMatchObject({ excluded: 1, no_counterpart: 1 });
  });

  it("withholds counts for incomplete or duplicate populations", () => {
    for (const input of [
      { decisions: [decision()], sourceCount: 2, targetCount: 1 },
      { decisions: [decision()], sourceCount: 1, targetCount: 2 },
      { decisions: [decision(), decision()], sourceCount: 1, targetCount: 1 },
      { decisions: [{ ...decision(), transferId: null, recordId: null }], sourceCount: 0, targetCount: 0 },
      { decisions: [], sourceCount: -1, targetCount: 0 },
    ]) expect(reviewCoverage(input)).toBeNull();
  });

  it("does not convert a default PENDING result into actionable work", () => {
    const row = { action: "preserve", reason: "existing_link", outcome: "PENDING", disposition: "PENDING" };
    expect(reviewDecisionLabel(row)).toBe("Existing links");
    expect(reviewDecisionLabel({ ...row, action: "exclude", reason: "manual_hold" })).toBe("Automatic linking on hold");
    expect(reviewDecisionLabel({ ...row, action: "no_counterpart", reason: "no_counterpart" })).toBe("Not yet matched in this run");
    expect(reviewDecisionLabel({ ...row, action: "propose", disposition: "REJECT" })).toBe("Pair rejected");
    expect(reviewDecisionLabel({ ...row, action: "review", disposition: "ACCEPT" })).toBe("Pair confirmed — not applied");
    expect(reviewDecisionLabel({ ...row, outcome: "NOOP" })).toBe("Link already satisfied");
    expect(reviewDecisionLabel({ ...row, outcome: "APPLIED" })).toBe("Link applied");
    expect(reviewDecisionLabel({ ...row, outcome: "UNDONE" })).toBe("Link undone");
    expect(reviewDecisionLabel({ ...row, outcome: "BLOCKED" })).toBe("Link attempt blocked");
  });
});
