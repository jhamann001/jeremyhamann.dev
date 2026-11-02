import { beforeEach, describe, expect, it, vi } from "vitest";

const { flagSpy, scopeSpy } = vi.hoisted(() => ({
  flagSpy: vi.fn(() => true),
  scopeSpy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/flags", () => ({ reviewQueueEnabled: flagSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));

import { listReviewQueue } from "@/lib/data/review-queue";

function row(snoozedUntil: Date) {
  return {
    id: "queue-1", detector_key: "a".repeat(64), subject_key: "b".repeat(64),
    source: "CRM_IDENTITY", exception_type: "CRM_SOURCE_KEY_COLLISION",
    source_record_ref: "exception-1", resolution_href: "/crm/dea_example#resolution-exceptions",
    summary: "A CRM identity mapping needs review", source_snapshot: {}, source_active: true,
    status: "SNOOZED", assigned_to: null, resolution_note: "", snoozed_until: snoozedUntil,
    detected_at: new Date("2026-08-01T00:00:00Z"), last_seen_at: new Date("2026-08-10T00:00:00Z"),
    source_resolved_at: null, resolved_at: null, resolved_by: null, updated_by: null,
    created_at: new Date("2026-08-01T00:00:00Z"), updated_at: new Date("2026-08-10T00:00:00Z"),
    events: [],
  };
}

describe("review queue snooze read behavior", () => {
  let capturedWhere: unknown[];
  beforeEach(() => {
    capturedWhere = [];
    flagSpy.mockReturnValue(true);
    scopeSpy.mockImplementation(async (_identity: unknown, fn: (tx: unknown) => unknown) => {
      const tx = {
        reviewQueueItem: {
          count: vi.fn(({ where }) => { capturedWhere.push(where); return 1; }),
          findMany: vi.fn((args) => {
            if (args.include) { capturedWhere.push(args.where); return [row(new Date("2026-08-01T00:00:00Z"))]; }
            return [];
          }),
        },
        reviewQueueSweepState: { findUnique: vi.fn().mockResolvedValue(null) },
      };
      return fn(tx);
    });
  });

  it("suppresses future snoozes by default and presents delayed expired snoozes as NEW", async () => {
    const result = await listReviewQueue({ role: "OPERATIONS", email: "ops@example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].status).toBe("NEW");
    expect(result.freshness.state).toBe("NOT_RUN");
    expect(capturedWhere[0]).toMatchObject({
      OR: [{ status: { not: "SNOOZED" } }, { snoozed_until: { lte: expect.any(Date) } }],
    });
  });

  it("keeps explicit SNOOZED filtering available without rewriting the displayed state", async () => {
    const result = await listReviewQueue(
      { role: "ADMIN", email: "admin@example.com" },
      { status: "SNOOZED" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].status).toBe("SNOOZED");
    expect(capturedWhere[0]).toMatchObject({ status: "SNOOZED" });
  });
});
