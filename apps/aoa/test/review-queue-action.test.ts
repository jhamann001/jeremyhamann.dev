import { beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, flagSpy, scopeSpy, auditSpy, revalidateSpy, redirectSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(), flagSpy: vi.fn(() => true), scopeSpy: vi.fn(),
  auditSpy: vi.fn(async () => {}), revalidateSpy: vi.fn(), redirectSpy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/flags", () => ({ reviewQueueEnabled: flagSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()), writeAudit: auditSpy,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

import { updateReviewQueueItem } from "@/app/(authenticated)/review-queue/actions";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function valid(overrides: Record<string, string> = {}) {
  return form({
    itemId: "queue_item_1", status: "IN_REVIEW", assignedTo: "new.ops@example.com",
    expectedUpdatedAt: "2026-08-17T12:00:00.000Z",
    returnTo: "/review-queue?source=TRADE_REQUEST&owner=unassigned&page=2",
    resolutionNote: "Current resolution context", snoozedUntil: "", ...overrides,
  });
}

describe("review queue workflow action", () => {
  let tx: {
    user: { findFirst: ReturnType<typeof vi.fn> };
    reviewQueueItem: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    reviewQueueEvent: { create: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    authSpy.mockReset();
    flagSpy.mockReset();
    scopeSpy.mockReset();
    auditSpy.mockReset();
    revalidateSpy.mockReset();
    redirectSpy.mockReset();
    authSpy.mockResolvedValue({ user: { role: "OPERATIONS", email: "actor@example.com" } });
    flagSpy.mockReturnValue(true);
    tx = {
      user: { findFirst: vi.fn().mockResolvedValue({ email: "New.Ops@Example.com" }) },
      reviewQueueItem: {
        findUnique: vi.fn().mockResolvedValue({
          id: "queue_item_1", source_active: true, status: "NEW", assigned_to: "old.ops@example.com",
          updated_at: new Date("2026-08-17T12:00:00.000Z"),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      reviewQueueEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    scopeSpy.mockImplementation(async (_identity: unknown, fn: (value: typeof tx) => unknown) => fn(tx));
  });

  it("blocks non-Operations roles and a dark feature before opening a scope", async () => {
    authSpy.mockResolvedValue({ user: { role: "ADVISOR", email: "advisor@example.com" } });
    await updateReviewQueueItem(valid());
    expect(scopeSpy).not.toHaveBeenCalled();

    authSpy.mockResolvedValue({ user: { role: "ADMIN", email: "admin@example.com" } });
    flagSpy.mockReturnValue(false);
    await updateReviewQueueItem(valid());
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed ids, states, owners and snooze dates without a write", async () => {
    for (const input of [
      valid({ itemId: "bad id" }), valid({ status: "DONE" }),
      valid({ assignedTo: "not-an-email" }), valid({ status: "SNOOZED", snoozedUntil: "2020-01-01" }),
    ]) await updateReviewQueueItem(input);
    expect(scopeSpy).not.toHaveBeenCalled();

    tx.user.findFirst.mockResolvedValueOnce(null);
    await updateReviewQueueItem(valid());
    expect(tx.reviewQueueItem.updateMany).not.toHaveBeenCalled();
  });

  it("normalizes a real internal assignee and preserves the assignment transition without copying note text", async () => {
    await updateReviewQueueItem(valid());
    expect(tx.reviewQueueItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: "queue_item_1", source_active: true,
        updated_at: new Date("2026-08-17T12:00:00.000Z"),
      },
      data: expect.objectContaining({
        status: "IN_REVIEW", assigned_to: "new.ops@example.com",
        resolution_note: "Current resolution context", updated_by: "actor@example.com",
      }),
    });
    const event = tx.reviewQueueEvent.create.mock.calls[0][0].data;
    expect(event.detail).toEqual({
      assignmentChanged: true,
      fromAssignee: "old.ops@example.com",
      toAssignee: "new.ops@example.com",
      snoozed: false,
    });
    expect(JSON.stringify(event.detail)).not.toContain("Current resolution context");
    expect(auditSpy).toHaveBeenCalledOnce();
    expect(revalidateSpy).toHaveBeenCalledWith("/review-queue");
  });

  it("refuses workflow writes after the source condition has cleared", async () => {
    tx.reviewQueueItem.findUnique.mockResolvedValueOnce({
      id: "queue_item_1", source_active: false, status: "RESOLVED", assigned_to: null,
      updated_at: new Date("2026-08-17T12:00:00.000Z"),
    });
    await updateReviewQueueItem(valid({ assignedTo: "" }));
    expect(tx.reviewQueueItem.updateMany).not.toHaveBeenCalled();
    expect(tx.reviewQueueEvent.create).not.toHaveBeenCalled();
  });

  it("surfaces a conflict and preserves validated queue filters when another writer wins", async () => {
    tx.reviewQueueItem.updateMany.mockResolvedValueOnce({ count: 0 });
    await updateReviewQueueItem(valid());
    expect(tx.reviewQueueEvent.create).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(redirectSpy).toHaveBeenCalledWith(
      "/review-queue?source=TRADE_REQUEST&owner=unassigned&page=2&queueMessage=conflict",
    );
  });

  it("rejects an external conflict return path", async () => {
    tx.reviewQueueItem.updateMany.mockResolvedValueOnce({ count: 0 });
    await updateReviewQueueItem(valid({ returnTo: "//evil.example/review-queue" }));
    expect(redirectSpy).toHaveBeenCalledWith("/review-queue?queueMessage=conflict");
  });

  it("accepts an evening New York snooze through the selected business date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T03:00:00.000Z")); // Aug 17, 11pm ET
    try {
      await updateReviewQueueItem(valid({
        status: "SNOOZED", snoozedUntil: "2026-08-17",
      }));
      expect(tx.reviewQueueItem.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          snoozed_until: new Date("2026-08-18T04:00:00.000Z"),
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
