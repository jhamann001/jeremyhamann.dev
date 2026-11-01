// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { DemoLimitError, demoHistoryFull, demoQuotaMax, holdDemoQuota, withDemoQuota } from "./limits";

// The caps against real PostgreSQL: the advisory lock goes through Prisma, writers racing for the last
// places never overshoot, and the SQL sums count what they claim. Run in CI on the job's own Postgres
// (ACAT_LIMITS_DATABASE_TEST=1).
const enabled = process.env.ACAT_LIMITS_DATABASE_TEST === "1";
const MARK = "Synthetic Limits Race";
const RECORD_ID = "synthetic-limits-record";

const feeRow = (n: number) => ({
  clientName: MARK, feeType: "ACAT Transfer Fee", feeAmount: 75, accountNumbers: `RACE-${n}`,
  submissionDate: "2026-09-21T00:00:00Z", status: "Pending",
});

describe.skipIf(!enabled)("demo caps against PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/transfer_tracker_test") {
      throw new Error("Limit tests require an explicit localhost transfer_tracker_test database");
    }
    vi.stubEnv("PERSONA_SIGN_IN", "on");
    await prisma.acatRecord.create({ data: {
      id: RECORD_ID, clientName: MARK, apexAccountId: "SYNTHETIC", acatDate: "2026-09-21", lastUpdated: "2026-09-21T00:00:00Z",
    } });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    // Only rows made by this suite; never truncate shared tables. The record's documents and history go with it.
    await prisma.demoFeeCreditRow.deleteMany({ where: { clientName: MARK } });
    await prisma.acatRecord.deleteMany({ where: { id: RECORD_ID } });
  });

  it("lets exactly the remaining room through when writers race for it", async () => {
    const cap = demoQuotaMax("feeCredits");
    const before = await prisma.demoFeeCreditRow.count();
    expect(before).toBeLessThan(cap - 5);
    await prisma.demoFeeCreditRow.createMany({ data: Array.from({ length: cap - 5 - before }, (_, i) => feeRow(i)) });

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        withDemoQuota({ feeCredits: 1 }, (db) => db.demoFeeCreditRow.create({ data: feeRow(1000 + i) })),
      ),
    );
    const refused = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(refused).toHaveLength(7);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(DemoLimitError);
    expect(await prisma.demoFeeCreditRow.count()).toBe(cap);
  });

  it("sums a document's file and its CSV snapshot for the byte cap", async () => {
    await prisma.acatDocument.create({ data: {
      acatRecordId: RECORD_ID, kind: "MAPPING_CSV", filename: "limits.csv", createdBy: MARK,
      content: Buffer.alloc(1234), sha256: "0".repeat(64), byteSize: 1234, inputCsv: "é,1\n",
      positionCount: 1, includedCount: 1, excludedCount: 0, undecidedCount: 0,
    } });
    const docs = await prisma.acatDocument.findMany({ select: { byteSize: true, inputCsv: true } });
    const stored = docs.reduce((sum, d) => sum + d.byteSize + Buffer.byteLength(d.inputCsv, "utf8"), 0);
    const room = demoQuotaMax("documentBytes") - stored;
    await expect(prisma.$transaction((tx) => holdDemoQuota(tx, { documentBytes: room }))).resolves.toBeUndefined();
    await expect(prisma.$transaction((tx) => holdDemoQuota(tx, { documentBytes: room + 1 }))).rejects.toBeInstanceOf(DemoLimitError);
  });

  it("counts record history by entries and by the bytes of its values", async () => {
    expect(await demoHistoryFull()).toBe(false);
    const existing = await prisma.auditLog.count();
    // 20 MB of values, in few rows: the byte limit alone fills it.
    await prisma.auditLog.createMany({ data: Array.from({ length: 11 }, () => ({
      acatRecordId: RECORD_ID, action: "update", field: "notes", oldValue: "x".repeat(1024 * 1024), newValue: "y".repeat(1024 * 1024), performedBy: MARK,
    })) });
    expect(await demoHistoryFull()).toBe(true);
    await prisma.auditLog.deleteMany({ where: { acatRecordId: RECORD_ID } });
    // Then by count.
    await prisma.auditLog.createMany({ data: Array.from({ length: Math.max(0, 20_000 - existing) }, () => ({
      acatRecordId: RECORD_ID, action: "update", field: "notes", performedBy: MARK,
    })) });
    expect(await demoHistoryFull()).toBe(true);
  });
});
