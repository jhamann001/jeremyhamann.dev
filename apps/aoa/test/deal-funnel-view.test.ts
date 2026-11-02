import { describe, expect, it } from "vitest";
import {
  AT_RISK_DAYS,
  AT_RISK_DESC,
  AT_RISK_LABEL,
  dealFunnelStages,
  daysSinceLastMovement,
  isAtRisk,
  lastMovementAt,
  type FunnelDealRow,
} from "@/lib/data/deal-funnel-view";
import { STAGE_LABEL, type DealStage } from "@/lib/data/deal-types";

// The Command Center funnel's UI rules. This repo has NO React component-test
// harness, so the bucketer is pure and this file is where the card's behaviour
// is actually pinned: pipeline order, label vocabulary, the two exclusions
// (archived + LOST), and the at-risk overlay's threshold and scope.

const NOW = new Date("2026-07-27T12:00:00.000Z");
const DAY = 86_400_000;

/** A row that last moved exactly `days` before NOW (via created_date only). */
function deal(stage: DealStage, days = 0, extra: Partial<FunnelDealRow> = {}): FunnelDealRow {
  return {
    stage,
    created_date: new Date(NOW.getTime() - days * DAY),
    last_activity_date: null,
    stage_history: [],
    archived_at: null,
    ...extra,
  };
}

describe("dealFunnelStages — shape and vocabulary", () => {
  it("returns the four pipeline buckets in order, then the At-risk overlay", () => {
    const out = dealFunnelStages([], NOW);
    expect(out.map((s) => s.stage)).toEqual([
      STAGE_LABEL.POTENTIAL,
      STAGE_LABEL.COMMITTED,
      STAGE_LABEL.FUNDING,
      STAGE_LABEL.WON,
      AT_RISK_LABEL,
    ]);
  });

  it("uses the CRM display labels from STAGE_LABEL, not hardcoded strings", () => {
    const out = dealFunnelStages([deal("COMMITTED"), deal("FUNDING")], NOW);
    expect(out[1].stage).toBe(STAGE_LABEL.COMMITTED); // "Potential-Committed"
    expect(out[2].stage).toBe(STAGE_LABEL.FUNDING); // "Potential-In Process"
    expect(out[3].stage).toBe(STAGE_LABEL.WON); // "Funded"
  });

  it("keeps the mock card's tone sequence so the card's shape is unchanged", () => {
    expect(dealFunnelStages([], NOW).map((s) => s.tone)).toEqual([
      "blue",
      "gold",
      "amber",
      "green",
      "red",
    ]);
  });

  it("says the At-risk segment is an overlay, not a sixth bucket", () => {
    const out = dealFunnelStages([], NOW);
    expect(out[4].desc).toBe(AT_RISK_DESC);
    expect(out[4].desc).toMatch(/also in the stages above/);
  });

  it("never emits a LOST bucket (not part of an active pipeline)", () => {
    const labels = dealFunnelStages([deal("LOST")], NOW).map((s) => s.stage);
    expect(labels).not.toContain(STAGE_LABEL.LOST);
  });
});

describe("dealFunnelStages — counting", () => {
  it("buckets a normal spread", () => {
    const rows = [
      deal("POTENTIAL"),
      deal("POTENTIAL"),
      deal("POTENTIAL"),
      deal("COMMITTED"),
      deal("COMMITTED"),
      deal("FUNDING"),
      deal("WON"),
      deal("WON"),
      deal("WON"),
      deal("WON"),
    ];
    expect(dealFunnelStages(rows, NOW).map((s) => s.count)).toEqual([3, 2, 1, 4, 0]);
  });

  it("zero-fills every segment on an empty book (no crash, card still renders)", () => {
    const out = dealFunnelStages([], NOW);
    expect(out).toHaveLength(5);
    expect(out.every((s) => s.count === 0)).toBe(true);
  });

  it("excludes archived deals (D7 soft delete leaves the pipeline)", () => {
    const rows = [
      deal("POTENTIAL"),
      deal("POTENTIAL", 400, { archived_at: new Date("2026-07-01T00:00:00.000Z") }),
      deal("WON", 0, { archived_at: new Date("2026-07-02T00:00:00.000Z") }),
    ];
    const out = dealFunnelStages(rows, NOW);
    expect(out[0].count).toBe(1); // Potential
    expect(out[3].count).toBe(0); // Funded
    expect(out[4].count).toBe(0); // an archived stale deal is not "at risk" either
  });

  it("excludes LOST deals from every bucket and from the overlay", () => {
    const rows = [deal("LOST"), deal("LOST", 400), deal("WON")];
    expect(dealFunnelStages(rows, NOW).map((s) => s.count)).toEqual([0, 0, 0, 1, 0]);
  });

  it("drops unknown stage values rather than bucketing them blind", () => {
    const rogue = { ...deal("POTENTIAL"), stage: "PROPOSAL" as unknown as DealStage };
    expect(dealFunnelStages([rogue, deal("POTENTIAL")], NOW).map((s) => s.count)).toEqual([
      1, 0, 0, 0, 0,
    ]);
  });
});

describe("at-risk threshold", () => {
  it("is 30 days", () => {
    expect(AT_RISK_DAYS).toBe(30);
  });

  it("is strictly greater than 30: exactly 30 days is NOT at risk, 31 is", () => {
    expect(isAtRisk(deal("POTENTIAL", 30), NOW)).toBe(false);
    expect(isAtRisk(deal("POTENTIAL", 31), NOW)).toBe(true);
  });

  it("counts only NON-TERMINAL deals — a funded deal is finished, not stuck", () => {
    const rows = [
      deal("POTENTIAL", 45),
      deal("COMMITTED", 45),
      deal("FUNDING", 45),
      deal("WON", 400), // terminal: never at risk however old
      deal("LOST", 400), // excluded entirely
    ];
    expect(dealFunnelStages(rows, NOW)[4].count).toBe(3);
  });

  it("overlays: an at-risk deal is ALSO counted in its own stage bucket", () => {
    const out = dealFunnelStages([deal("COMMITTED", 60)], NOW);
    expect(out[1].count).toBe(1); // Potential-Committed
    expect(out[4].count).toBe(1); // At risk
  });
});

// REGRESSION — "opening stage_history entry is not a stage change".
//
// Live symptom (aoa-dev, 2026-07-27): the At-risk overlay read 0 against 110
// open Potential deals. /api/ingest/deals stamps an OPENING history entry on
// CREATE (`from: existingStage`, and existingStage is null on create), dated at
// the ingest RUN. Because lastMovementAt took the MAX over every entry, that
// always-fresh stamp dominated created_date/last_activity_date and suppressed
// staleness forever. It was missed because the local seed comes from
// lib/deals/import-csv.ts — the ONE write path that never touches
// stage_history — so no local row had the shape that breaks it.
describe("regression: the opening stage_history entry is not a stage change", () => {
  /** Exactly what /api/ingest/deals writes on CREATE: `from: null`, `at` = run. */
  const openingEntryToday = {
    stage: "POTENTIAL" as DealStage,
    from: null,
    at: NOW.toISOString(),
    by: "crm-deals-nightly",
  };

  it("an opening entry dated TODAY over an old created_date IS still at risk", () => {
    const row = deal("POTENTIAL", 180, { stage_history: [openingEntryToday] });
    expect(lastMovementAt(row)?.toISOString()).toBe(
      new Date(NOW.getTime() - 180 * DAY).toISOString(),
    );
    expect(daysSinceLastMovement(row, NOW)).toBe(180);
    expect(isAtRisk(row, NOW)).toBe(true);
  });

  it("a nightly re-ingest cannot zero the overlay for a book of stale deals", () => {
    // The dev shape in miniature: every row freshly stamped, all long stale.
    const rows = [
      deal("POTENTIAL", 200, { stage_history: [openingEntryToday] }),
      deal("POTENTIAL", 90, { stage_history: [openingEntryToday] }),
      deal("COMMITTED", 120, { stage_history: [openingEntryToday] }),
      deal("FUNDING", 45, { stage_history: [openingEntryToday] }),
    ];
    expect(dealFunnelStages(rows, NOW)[4].count).toBe(4);
  });

  it("a REAL transition (non-null `from`) still counts as movement", () => {
    const row = deal("COMMITTED", 200, {
      stage_history: [
        openingEntryToday,
        {
          stage: "COMMITTED",
          from: "POTENTIAL",
          at: new Date(NOW.getTime() - 5 * DAY).toISOString(),
          by: "ops@example.com",
        },
      ],
    });
    expect(daysSinceLastMovement(row, NOW)).toBe(5);
    expect(isAtRisk(row, NOW)).toBe(false);
  });

  it("an OLD real transition does not rescue a deal from the overlay", () => {
    const row = deal("FUNDING", 400, {
      stage_history: [
        { stage: "POTENTIAL", from: null, at: NOW.toISOString(), by: "ingest" },
        {
          stage: "FUNDING",
          from: "COMMITTED",
          at: new Date(NOW.getTime() - 300 * DAY).toISOString(),
          by: "ops@example.com",
        },
      ],
    });
    expect(daysSinceLastMovement(row, NOW)).toBe(300); // the transition, not the stamp
    expect(isAtRisk(row, NOW)).toBe(true);
  });

  it("treats an entry with an ABSENT `from` as an opening stamp too (fail-safe)", () => {
    // Defensive: an entry that cannot prove it was a transition is not one.
    const noFrom = { stage: "POTENTIAL", at: NOW.toISOString(), by: null } as unknown as {
      stage: DealStage;
      from: DealStage | null;
      at: string;
      by: string | null;
    };
    const row = deal("POTENTIAL", 75, { stage_history: [noFrom] });
    expect(daysSinceLastMovement(row, NOW)).toBe(75);
    expect(isAtRisk(row, NOW)).toBe(true);
  });

  it("a recent last_activity_date still wins over an old real transition", () => {
    // The max-of-signals shape is unchanged — only the history filter is new.
    const row = deal("POTENTIAL", 365, {
      last_activity_date: new Date(NOW.getTime() - 3 * DAY),
      stage_history: [
        { stage: "POTENTIAL", from: null, at: NOW.toISOString(), by: "ingest" },
        {
          stage: "POTENTIAL",
          from: "COMMITTED",
          at: new Date(NOW.getTime() - 200 * DAY).toISOString(),
          by: "ops@example.com",
        },
      ],
    });
    expect(daysSinceLastMovement(row, NOW)).toBe(3);
    expect(isAtRisk(row, NOW)).toBe(false);
  });

  it("CSV-imported rows (no stage_history at all) are unaffected", () => {
    // lib/deals/import-csv.ts never writes the column — these must fall through
    // to last_activity_date / created_date exactly as they did before the fix.
    expect(isAtRisk(deal("POTENTIAL", 90, { stage_history: [] }), NOW)).toBe(true);
    expect(isAtRisk(deal("POTENTIAL", 90, { stage_history: null }), NOW)).toBe(true);
    expect(
      isAtRisk(
        deal("POTENTIAL", 90, {
          stage_history: [],
          last_activity_date: new Date(NOW.getTime() - 4 * DAY),
        }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("lastMovementAt — which signal wins", () => {
  it("prefers the newest REAL stage transition when one exists", () => {
    const row = deal("COMMITTED", 200, {
      stage_history: [
        { stage: "POTENTIAL", from: null, at: "2026-01-01T00:00:00.000Z", by: "a" },
        { stage: "COMMITTED", from: "POTENTIAL", at: "2026-07-20T00:00:00.000Z", by: "a" },
      ],
    });
    expect(lastMovementAt(row)?.toISOString()).toBe("2026-07-20T00:00:00.000Z");
    expect(isAtRisk(row, NOW)).toBe(false); // 7 days in stage, not stalled
  });

  it("falls back to CRM's last_activity_date when history is empty", () => {
    const row = deal("FUNDING", 200, {
      last_activity_date: new Date(NOW.getTime() - 10 * DAY),
    });
    expect(daysSinceLastMovement(row, NOW)).toBe(10);
    expect(isAtRisk(row, NOW)).toBe(false);
  });

  it("falls back to created_date (the always-populated floor) when nothing else is set", () => {
    const row = deal("POTENTIAL", 90);
    expect(daysSinceLastMovement(row, NOW)).toBe(90);
    expect(isAtRisk(row, NOW)).toBe(true);
  });

  it("takes the MAX, so an older signal can never re-stale a recently touched deal", () => {
    const row = deal("POTENTIAL", 365, {
      last_activity_date: new Date(NOW.getTime() - 2 * DAY),
      stage_history: [
        { stage: "POTENTIAL", from: "COMMITTED", at: "2025-01-01T00:00:00.000Z", by: null },
      ],
    });
    expect(daysSinceLastMovement(row, NOW)).toBe(2);
    expect(isAtRisk(row, NOW)).toBe(false);
  });

  it("ignores unparseable history timestamps instead of throwing", () => {
    // A REAL transition (non-null `from`) so the entry reaches the date parse —
    // an opening entry would be skipped before it and prove nothing here.
    const row = deal("POTENTIAL", 90, {
      stage_history: [{ stage: "POTENTIAL", from: "COMMITTED", at: "not-a-date", by: null }],
    });
    expect(daysSinceLastMovement(row, NOW)).toBe(90);
  });

  it("fails OPEN on a row with no usable date at all — never accuses it of stalling", () => {
    const row: FunnelDealRow = {
      stage: "POTENTIAL",
      created_date: null,
      last_activity_date: null,
      stage_history: null,
      archived_at: null,
    };
    expect(lastMovementAt(row)).toBeNull();
    expect(daysSinceLastMovement(row, NOW)).toBeNull();
    expect(isAtRisk(row, NOW)).toBe(false);
    expect(dealFunnelStages([row], NOW).map((s) => s.count)).toEqual([1, 0, 0, 0, 0]);
  });
});
