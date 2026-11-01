// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

import { prisma } from "@/lib/prisma";
import {
  DemoLimitError,
  demoLimitMessage,
  demoLimitResponse,
  demoQuotaMax,
  documentHolds,
  holdDemoQuota,
  unknownContraError,
  withDemoQuota,
} from "./limits";

// A transaction that records the advisory locks it takes and reports fixed counts.
function fakeTx(counts: { transfers?: number; positions?: number; documents?: number; documentBytes?: number; reviews?: number } = {}) {
  const locks: number[] = [];
  const tx = {
    $executeRaw: vi.fn(async (_sql: TemplateStringsArray, _namespace: number, lock: number) => {
      locks.push(lock);
      return 1;
    }),
    $queryRaw: vi.fn(async () => [{ n: BigInt(counts.documentBytes ?? 0) }]),
    acatRecord: { count: vi.fn(async () => counts.transfers ?? 0) },
    asset: { count: vi.fn(async () => counts.positions ?? 0) },
    acatDocument: { count: vi.fn(async () => counts.documents ?? 0) },
    dataQualityReview: { count: vi.fn(async () => counts.reviews ?? 0), findUnique: vi.fn() },
  };
  return { tx: tx as never, locks, raw: tx };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PERSONA_SIGN_IN", "on");
});
afterEach(() => vi.unstubAllEnvs());

describe("holdDemoQuota", () => {
  it("does nothing outside the demo", async () => {
    vi.stubEnv("PERSONA_SIGN_IN", "off");
    const { tx, raw } = fakeTx({ transfers: 10_000 });
    await holdDemoQuota(tx, { transfers: 1 });
    expect(raw.$executeRaw).not.toHaveBeenCalled();
  });

  it("locks the kind, counts inside the transaction and lets a write under the cap through", async () => {
    const { tx, locks, raw } = fakeTx({ transfers: 399 });
    await holdDemoQuota(tx, { transfers: 1 });
    expect(locks).toEqual([1]);
    expect(raw.acatRecord.count).toHaveBeenCalledOnce();
  });

  it("skips kinds the write doesn't add to", async () => {
    const { tx, raw } = fakeTx();
    await holdDemoQuota(tx, { positions: 0 });
    expect(raw.$executeRaw).not.toHaveBeenCalled();
  });

  it("refuses at the cap, with the cap and the reset in the message", async () => {
    const { tx } = fakeTx({ transfers: 400 });
    const refused = await holdDemoQuota(tx, { transfers: 1 }).catch((e) => e);
    expect(refused).toBeInstanceOf(DemoLimitError);
    expect(refused.status).toBe(429);
    expect(refused.message).toBe(demoLimitMessage("transfers"));
    expect(refused.message).toBe("The demo holds up to 400 transfers until its nightly reset at 07:00 UTC. Please try again tomorrow.");
  });

  it("refuses a batch that would overshoot, saying how much room is left", async () => {
    const { tx } = fakeTx({ positions: demoQuotaMax("positions") - 10 });
    await expect(holdDemoQuota(tx, { positions: 25 })).rejects.toThrow(
      `The demo holds up to ${demoQuotaMax("positions")} positions until its nightly reset at 07:00 UTC, and this change would add 25 with room for 10. Please make a smaller change.`,
    );
  });

  it("states the document byte cap in MB", async () => {
    const { tx } = fakeTx({ documentBytes: 50 * 1024 * 1024 - 10 });
    await expect(holdDemoQuota(tx, { documentBytes: 11 })).rejects.toThrow(
      "The demo holds up to 50 MB of documents until its nightly reset at 07:00 UTC. Please try again tomorrow.",
    );
  });

  it("takes several caps in one fixed order, whatever order they are passed in", async () => {
    const { tx, locks } = fakeTx();
    await holdDemoQuota(tx, { documentBytes: 100, positions: 3, documents: 1 });
    expect(locks).toEqual([6, 7, 8]);
  });
});

describe("withDemoQuota", () => {
  it("is just the write outside the demo", async () => {
    vi.stubEnv("PERSONA_SIGN_IN", "off");
    const result = await withDemoQuota({ reviews: 1 }, async (db) => (db === (prisma as never) ? "direct" : "tx"));
    expect(result).toBe("direct");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("works a kind's amount out after taking its lock, then writes", async () => {
    const { tx, raw } = fakeTx({ reviews: 300 });
    vi.mocked(prisma.$transaction).mockImplementationOnce(((fn: (t: unknown) => unknown) => fn(tx)) as never);
    const order: string[] = [];
    raw.$executeRaw.mockImplementation(async () => (order.push("lock"), 1));
    // An existing review is only updated, so it adds nothing and passes even at the cap.
    await withDemoQuota(
      { reviews: async () => (order.push("count"), 0) },
      async () => (order.push("write"), "saved"),
    );
    expect(order).toEqual(["lock", "count", "write"]);
    expect(raw.dataQualityReview.count).not.toHaveBeenCalled();
  });

  it("does not write when a cap refuses", async () => {
    const { tx } = fakeTx({ reviews: 300 });
    vi.mocked(prisma.$transaction).mockImplementationOnce(((fn: (t: unknown) => unknown) => fn(tx)) as never);
    const write = vi.fn();
    await expect(withDemoQuota({ reviews: 1 }, write)).rejects.toBeInstanceOf(DemoLimitError);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("count a document's file and its CSV snapshot in bytes", () => {
    expect(documentHolds({ byteSize: 1000, inputCsv: "é,1\n" })).toEqual({ documents: 1, documentBytes: 1005 });
  });

  it("answer a limit with its status and message, and nothing else", async () => {
    const capped = demoLimitResponse(new DemoLimitError("full"));
    expect(capped?.status).toBe(429);
    expect(await capped?.json()).toEqual({ error: "full" });
    expect(demoLimitResponse(unknownContraError())?.status).toBe(400);
    expect(demoLimitResponse(new Error("other"))).toBeNull();
  });
});
