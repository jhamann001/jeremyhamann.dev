/**
 * The digest's pure parts, its firm-clock guard, and the acceptance criterion that matters most on
 * this branch: with no channel configured it sends nothing and reports it (CONTRACT §0 rule 4).
 *
 * The dispatcher and B10's sender are mocked so this suite needs no database and no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  dispatchPending: vi.fn(async () => ({ inApp: 0, slack: 0, push: 0, skipped: 0 })),
  sendSlackDm: vi.fn(async () => "disabled" as const),
  isSlackDmEnabled: vi.fn(() => false),
  slackUserMap: vi.fn(() => new Map<string, string>()),
}));
const { dispatchPending, sendSlackDm } = hoisted;

vi.mock("@/server/notifications-push", () => ({ sendWebPush: vi.fn(async () => "disabled" as const) }));
vi.mock("@/server/notifications-dispatch", () => ({
  dispatchPending: hoisted.dispatchPending,
  sendSlackDm: hoisted.sendSlackDm,
  isSlackDmEnabled: hoisted.isSlackDmEnabled,
  slackUserMap: hoisted.slackUserMap,
}));

import type { NotificationKind } from "@/types/domain";
import { NOTIFICATION_KINDS } from "@/types/domain";
import { DIGEST_MAX_TICKETS } from "@/server/notifications-templates";
import {
  DIGEST_HOUR_DEFAULT,
  DIGEST_WINDOW_MS,
  countByKind,
  digestHour,
  digestTicketNumbers,
  isDigestHour,
  runDigest,
} from "@/jobs/digest";

beforeEach(() => {
  dispatchPending.mockClear();
});

describe("digestHour", () => {
  it("defaults to 8 firm-local and honours a configured hour, including 0", () => {
    expect(digestHour(undefined)).toBe(DIGEST_HOUR_DEFAULT);
    expect(DIGEST_HOUR_DEFAULT).toBe(8);
    expect(digestHour(0)).toBe(0);
    expect(digestHour(17)).toBe(17);
  });
});

describe("isDigestHour — the FIRM clock, not the container's", () => {
  it("is true at 08:00 ET in summer (EDT, UTC-4) and false an hour either side", () => {
    expect(isDigestHour(new Date("2026-07-15T12:00:00.000Z"), 8)).toBe(true);
    expect(isDigestHour(new Date("2026-07-15T11:59:59.000Z"), 8)).toBe(false);
    expect(isDigestHour(new Date("2026-07-15T13:00:00.000Z"), 8)).toBe(false);
  });

  it("is true at 08:00 ET in winter (EST, UTC-5) — the same wall clock, a different offset", () => {
    expect(isDigestHour(new Date("2026-01-15T13:00:00.000Z"), 8)).toBe(true);
    expect(isDigestHour(new Date("2026-01-15T12:00:00.000Z"), 8)).toBe(false);
  });

  it("is false for an instant that cannot be read", () => {
    expect(isDigestHour(new Date(Number.NaN), 8)).toBe(false);
  });
});

describe("countByKind", () => {
  it("counts in NOTIFICATION_KINDS order and drops kinds with nothing in them", () => {
    const rows: Array<{ kind: NotificationKind }> = [
      { kind: "SLA_BREACH" },
      { kind: "MENTION" },
      { kind: "MENTION" },
      { kind: "ASSIGNED" },
    ];
    expect(countByKind(rows)).toEqual([
      { kind: "MENTION", count: 2 },
      { kind: "ASSIGNED", count: 1 },
      { kind: "SLA_BREACH", count: 1 },
    ]);
  });

  it("is total over the eight kinds and empty for no rows", () => {
    expect(countByKind([])).toEqual([]);
    expect(countByKind(NOTIFICATION_KINDS.map((kind) => ({ kind })))).toHaveLength(NOTIFICATION_KINDS.length);
  });
});

describe("digestTicketNumbers", () => {
  it("is distinct, in first-seen order", () => {
    expect(
      digestTicketNumbers([{ ticketNumber: 3 }, { ticketNumber: 1 }, { ticketNumber: 3 }, { ticketNumber: null }]),
    ).toEqual([3, 1]);
  });

  it("stops at DIGEST_MAX_TICKETS — a lock screen is not a list", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ ticketNumber: i + 1 }));
    expect(digestTicketNumbers(rows)).toHaveLength(DIGEST_MAX_TICKETS);
  });
});

describe("runDigest", () => {
  it("does nothing outside the digest hour, and does not even drain the dispatcher", async () => {
    await expect(runDigest({ now: new Date("2026-07-15T17:00:00.000Z") })).resolves.toEqual({ sent: 0, skipped: 0 });
    expect(dispatchPending).not.toHaveBeenCalled();
  });

  it("with no channel configured it sends nothing — the wave's acceptance criterion", async () => {
    await expect(runDigest({ force: true })).resolves.toEqual({ sent: 0, skipped: 0 });
    expect(sendSlackDm).not.toHaveBeenCalled();
  });

  it("drains the pending fan-out first, so one item is not DM'd and digested in the same minute", async () => {
    await runDigest({ force: true });
    expect(dispatchPending).toHaveBeenCalledTimes(1);
  });

  it("looks back exactly one firm day", () => {
    expect(DIGEST_WINDOW_MS).toBe(24 * 60 * 60_000);
  });
});
