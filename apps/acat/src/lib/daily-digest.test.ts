import { describe, it, expect } from "vitest";
import {
  AGING_THRESHOLD_DAYS,
  buildDigestSnapshot,
  formatDigestMessage,
} from "./daily-digest";
import type { AcatRecord, AcatStatus } from "./types";

const NOW = new Date("2026-05-20T15:00:00Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgoIso(n: number): string {
  return new Date(NOW - n * DAY_MS).toISOString().slice(0, 10);
}

function makeRecord(overrides: Partial<AcatRecord> = {}): AcatRecord {
  return {
    id: `REC-${Math.random().toString(36).slice(2, 8)}`,
    clientName: "Test Client",
    apexAccountId: "APX-001",
    status: "Submitted" as AcatStatus,
    crmDealId: "CRM-1",
    custodianId: "C1",
    custodianName: "Schwab",
    acatDate: daysAgoIso(2),
    slackAlerted: false,
    mappingSource: "GCP Project API",
    apexSource: "Pending Upload",
    assets: [],
    lastUpdated: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe("buildDigestSnapshot", () => {
  it("counts active vs completed and ignores soft-deleted records", () => {
    const records = [
      makeRecord({ status: "Submitted" }),
      makeRecord({ status: "Completed" }),
      makeRecord({ status: "Completed", deletedAt: new Date(NOW).toISOString() }),
    ];
    const snap = buildDigestSnapshot(records, NOW);
    expect(snap.active).toBe(1);
    expect(snap.completed).toBe(1);
  });

  it("flags records open longer than the threshold as aging", () => {
    const records = [
      // Just opened — not aging.
      makeRecord({ acatDate: daysAgoIso(1) }),
      // Right at the threshold — counted.
      makeRecord({ acatDate: daysAgoIso(AGING_THRESHOLD_DAYS) }),
      // Well past the threshold — counted.
      makeRecord({ acatDate: daysAgoIso(AGING_THRESHOLD_DAYS + 5) }),
      // Old but terminal — doesn't count toward "aging open".
      makeRecord({ acatDate: daysAgoIso(20), status: "Completed" }),
    ];
    const snap = buildDigestSnapshot(records, NOW);
    expect(snap.aging).toBe(2);
  });

  it("counts only active records with unresolved asset issues", () => {
    const records = [
      makeRecord({
        assets: [
          { id: "a1", symbol: "AAPL", description: "", expectedQty: 1, actualQty: 1, mapStatus: "Mapped" },
        ],
      }),
      makeRecord({
        assets: [
          { id: "a2", symbol: "MSFT", description: "", expectedQty: 1, actualQty: 0, mapStatus: "Unmapped" },
        ],
      }),
      // Terminal — never counted as an open issue.
      makeRecord({
        status: "Rejected",
        assets: [
          { id: "a3", symbol: "GOOG", description: "", expectedQty: 1, actualQty: 0, mapStatus: "Unmapped" },
        ],
      }),
    ];
    const snap = buildDigestSnapshot(records, NOW);
    expect(snap.withIssues).toBe(1);
  });

  it("populates openedYesterday from records with acatDate in the last 24h", () => {
    const records = [
      makeRecord({ clientName: "Today", acatDate: daysAgoIso(0) }),
      // Slightly older than 24h — not counted.
      makeRecord({ clientName: "Older", acatDate: daysAgoIso(2) }),
      // Invalid date — not counted, doesn't crash.
      makeRecord({ clientName: "Bad", acatDate: "not-a-date" }),
    ];
    const snap = buildDigestSnapshot(records, NOW);
    expect(snap.openedYesterday.map((r) => r.clientName)).toEqual(["Today"]);
  });

  it("populates completedYesterday only for terminal records that closed in the last 24h", () => {
    const records = [
      // Completed today.
      makeRecord({
        clientName: "Closed today",
        status: "Completed",
        apexCompletionDate: daysAgoIso(0),
      }),
      // Completed last week — not in window.
      makeRecord({
        clientName: "Closed last week",
        status: "Completed",
        apexCompletionDate: daysAgoIso(8),
      }),
      // Still active — never appears in completedYesterday.
      makeRecord({
        clientName: "Still going",
        status: "Submitted",
      }),
      // Terminal but with no apexCompletionDate — falls back to lastUpdated,
      // which we set to NOW above so it lands in the window.
      makeRecord({
        clientName: "Terminal no-stamp",
        status: "Rejected",
        apexCompletionDate: undefined,
      }),
    ];
    const snap = buildDigestSnapshot(records, NOW);
    expect(snap.completedYesterday.map((r) => r.clientName).sort()).toEqual([
      "Closed today",
      "Terminal no-stamp",
    ]);
  });

  it("returns the five oldest open transfers sorted descending by days open", () => {
    const records = [
      makeRecord({ clientName: "A", acatDate: daysAgoIso(2) }),
      makeRecord({ clientName: "B", acatDate: daysAgoIso(20) }),
      makeRecord({ clientName: "C", acatDate: daysAgoIso(5) }),
      makeRecord({ clientName: "D", acatDate: daysAgoIso(12) }),
      makeRecord({ clientName: "E", acatDate: daysAgoIso(8) }),
      makeRecord({ clientName: "F", acatDate: daysAgoIso(3) }),
      // Terminal — should not appear in stalest even though it's old.
      makeRecord({ clientName: "G", acatDate: daysAgoIso(30), status: "Completed" }),
    ];
    const snap = buildDigestSnapshot(records, NOW);
    expect(snap.stalest.map((r) => r.clientName)).toEqual([
      "B",
      "D",
      "E",
      "C",
      "F",
    ]);
  });
});

describe("formatDigestMessage", () => {
  // Plain object (no `as const`) so the readonly-array narrowing
  // doesn't collide with DigestSnapshot's mutable AcatRecord[] fields.
  function emptySnapshot() {
    return {
      active: 0,
      completed: 0,
      aging: 0,
      withIssues: 0,
      openedYesterday: [] as AcatRecord[],
      completedYesterday: [] as AcatRecord[],
      stalest: [] as AcatRecord[],
    };
  }

  it("includes a human-readable fallback text for the notification line", () => {
    const msg = formatDigestMessage(
      { ...emptySnapshot(), active: 4, aging: 2, withIssues: 1 },
      NOW
    );
    expect(msg.text).toContain("4 active");
    expect(msg.text).toContain("2 aging");
    expect(msg.text).toContain("1 with issues");
  });

  it("always emits the header + KPI block, even when everything is empty", () => {
    const msg = formatDigestMessage(emptySnapshot(), NOW);
    expect(msg.blocks).toBeDefined();
    const blocks = msg.blocks as Array<{ type: string }>;
    expect(blocks[0].type).toBe("header");
    expect(blocks[1].type).toBe("section");
  });

  it("labels finalized totals and shows readable status names", () => {
    const open = { id: "O1", clientName: "Ann Lee", status: "PendingContraResponse", acatDate: new Date(NOW - 3 * DAY_MS).toISOString(), assets: [] } as unknown as AcatRecord;
    const msg = formatDigestMessage({ ...emptySnapshot(), completed: 7, openedYesterday: [open], stalest: [open] }, NOW);
    const text = JSON.stringify(msg.blocks);
    expect(text).toContain("*Finalized (total)*\\n7");
    expect(text).toContain("Ann Lee — Pending Contra Response");
    expect(text).toContain("(Pending Contra Response)");
    expect(text).not.toContain("PendingContraResponse");
  });

  it("omits the 'opened in last 24h' block when there are none", () => {
    const msg = formatDigestMessage(emptySnapshot(), NOW);
    const text = JSON.stringify(msg.blocks);
    expect(text).not.toContain("Opened in the last 24h");
  });

  it("includes the slowest-open section listing days + status", () => {
    // `daysAgoIso(12)` returns midnight UTC 12 calendar days back,
    // and NOW is mid-day UTC, so getDaysOpen rounds the diff up to
    // 13. Pick a numerically clean offset so the assertion stays
    // robust to clock-of-day shifts in the test fixture.
    const stalest = [
      ({
        id: "S1",
        clientName: "Jane & Co.",
        status: "Submitted",
        crmDealId: "x",
        custodianId: "c",
        custodianName: "Schwab",
        acatDate: new Date(NOW - 12 * DAY_MS).toISOString(),
        slackAlerted: false,
        mappingSource: "",
        apexSource: "",
        assets: [],
        lastUpdated: new Date(NOW).toISOString(),
        transferringContra: "Schwab",
        apexAccountId: "x",
      } as unknown) as AcatRecord,
    ];
    const msg = formatDigestMessage(
      { ...emptySnapshot(), stalest },
      NOW
    );
    const text = JSON.stringify(msg.blocks);
    expect(text).toContain("Slowest open transfers");
    // mrkdwn-escape of the ampersand keeps Slack from rendering "&Co" garbled.
    expect(text).toContain("Jane &amp; Co.");
    expect(text).toContain("*12d*");
    expect(text).toContain("Schwab");
  });
});
