import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { classifyReviewQueueFreshness } from "@/lib/data/review-queue";

const now = new Date("2026-08-19T16:00:00.000Z");
const state = (overrides: Record<string, Date | string | boolean | null> = {}) => ({
  last_started_at: new Date("2026-08-19T15:55:00.000Z"),
  last_completed_at: new Date("2026-08-19T15:50:00.000Z"),
  last_failure_at: null,
  last_failure_source: null,
  lease_expires_at: null,
  trade_cursor: null,
  crm_cursor: null,
  trade_complete: false,
  crm_complete: false,
  ...overrides,
});

describe("review queue sweep freshness", () => {
  it("distinguishes never-run, current, stale, running, and failed states", () => {
    expect(classifyReviewQueueFreshness(null, now).state).toBe("NOT_RUN");
    expect(classifyReviewQueueFreshness(state(), now).state).toBe("FRESH");
    expect(classifyReviewQueueFreshness(state({
      last_completed_at: new Date("2026-08-19T12:00:00.000Z"),
    }), now).state).toBe("STALE");
    expect(classifyReviewQueueFreshness(state({
      lease_expires_at: new Date("2026-08-19T16:05:00.000Z"),
    }), now).state).toBe("RUNNING");
    expect(classifyReviewQueueFreshness(state({
      last_failure_at: new Date("2026-08-19T15:59:00.000Z"),
      last_failure_source: "TRADE_REQUEST",
    }), now).state).toBe("FAILED");
  });

  it("treats a recent page checkpoint as healthy progress beyond the full-sweep SLA", () => {
    const progressing = classifyReviewQueueFreshness(state({
      last_started_at: new Date("2026-08-19T15:58:00.000Z"),
      last_completed_at: new Date("2026-08-19T12:00:00.000Z"),
      trade_cursor: "opaque_cursor",
      crm_complete: true,
    }), now);
    expect(progressing.state).toBe("PROGRESSING");
    expect(progressing).not.toHaveProperty("tradeCursor");
  });

  it("marks abandoned page progress stale after missed scheduler heartbeats", () => {
    expect(classifyReviewQueueFreshness(state({
      last_started_at: new Date("2026-08-19T15:30:00.000Z"),
      last_completed_at: new Date("2026-08-19T12:00:00.000Z"),
      trade_cursor: "opaque_cursor",
    }), now).state).toBe("STALE");
  });
});
