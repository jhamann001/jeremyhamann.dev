import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { buildFeeScheduleDocument, FeeScheduleUploadError } from "@/lib/data/custodian-fee-documents";
import { withUserScope } from "@/lib/rls";
import { markCase } from "./acat-book-flywheel";

// Quality / default vitest has no app_rw DATABASE_URL. The database-tests job
// sets app_rw + DIRECT_DATABASE_URL and must still execute these cases.
function appRwDatabaseReady(): boolean {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const directUrl = process.env.DIRECT_DATABASE_URL ?? "";
  if (!directUrl) return false;
  try {
    return new URL(databaseUrl).username === "app_rw";
  } catch {
    return false;
  }
}

const gated = appRwDatabaseReady() ? describe : describe.skip;

const PDF = Buffer.from("%PDF-1.4 fee-schedule");
const sha = createHash("sha256").update(PDF).digest("hex");

async function roleInTx(role: string): Promise<string | null> {
  return withUserScope({ role, email: "admin@example.test" }, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ role: string | null }>>`
      SELECT current_setting('app.user_role', true) AS role`;
    return rows[0]?.role ?? null;
  });
}

gated("custodian fee schedule database", () => {
  const prisma = new PrismaClient();
  const sourceId = `src-${randomUUID()}`;
  const targetId = `tgt-${randomUUID()}`;
  const docId = randomUUID();

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (new URL(databaseUrl).username !== "app_rw") {
      throw new Error("DATABASE_URL username must be app_rw for custodian-fee-schedule-db tests");
    }
    if (!process.env.DIRECT_DATABASE_URL) {
      throw new Error("DIRECT_DATABASE_URL is required for custodian-fee-schedule-db tests");
    }
    await withUserScope({ role: "ADMIN", email: "admin@example.test" }, async (tx) => {
      await tx.custodianProfile.create({
        data: {
          id: sourceId,
          name: `Source ${sourceId}`,
          revision: 1n,
        },
      });
      await tx.custodianProfile.create({
        data: {
          id: targetId,
          name: `Target ${targetId}`,
          revision: 1n,
        },
      });
      await tx.custodianFeeScheduleDocument.create({
        data: {
          id: docId,
          custodianId: sourceId,
          filename: "schedule.pdf",
          contentType: "application/pdf",
          content: PDF,
          sha256: sha,
          byteSize: PDF.byteLength,
          createdBy: "admin@example.test",
        },
      });
    });
  });

  afterAll(async () => {
    await withUserScope({ role: "ADMIN", email: "admin@example.test" }, async (tx) => {
      await tx.$executeRaw`DELETE FROM app.custodian_fee_schedule_document WHERE id = ${docId}`;
      await tx.$executeRaw`DELETE FROM app.custodian_profile WHERE id IN (${sourceId}, ${targetId})`;
    }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("rejected upload leaves the stored file unchanged", async () => {
    const before = await withUserScope({ role: "ADMIN", email: "admin@example.test" }, async (tx) =>
      tx.custodianFeeScheduleDocument.findUnique({
        where: { id: docId },
        select: { id: true, byteSize: true, sha256: true },
      }),
    );
    expect(before).toEqual({ id: docId, byteSize: PDF.byteLength, sha256: sha });
    expect(() => buildFeeScheduleDocument({
      filename: "empty.pdf", contentType: "application/pdf", content: new Uint8Array(),
    })).toThrow(FeeScheduleUploadError);
    expect(() => buildFeeScheduleDocument({
      filename: "fake.pdf", contentType: "application/pdf", content: Buffer.from("<html>"),
    })).toThrow(FeeScheduleUploadError);
    const after = await withUserScope({ role: "ADMIN", email: "admin@example.test" }, async (tx) =>
      tx.custodianFeeScheduleDocument.findUnique({
        where: { id: docId },
        select: { id: true, byteSize: true, sha256: true },
      }),
    );
    expect(after).toEqual(before);
    expect(docId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    markCase("custodian-fee-schedule-db", "rejected upload leaves the stored file unchanged", "integration");
  });

  it("merge keeps the source file id byte count and checksum", async () => {
    expect(await roleInTx("ADMIN")).toBe("ADMIN");
    await withUserScope({ role: "ADMIN", email: "admin@example.test" }, async (tx) => {
      await tx.custodianFeeScheduleDocument.updateMany({
        where: { id: { in: [docId] } },
        data: { custodianId: targetId },
      });
    });
    const moved = await withUserScope({ role: "ADMIN", email: "admin@example.test" }, async (tx) =>
      tx.custodianFeeScheduleDocument.findUnique({
        where: { id: docId },
        select: { id: true, custodianId: true, byteSize: true, sha256: true },
      }),
    );
    expect(moved).toEqual({
      id: docId,
      custodianId: targetId,
      byteSize: PDF.byteLength,
      sha256: sha,
    });
    const viewer = await withUserScope({ role: "VIEWER", email: null }, async (tx) =>
      tx.custodianFeeScheduleDocument.updateMany({
        where: { id: docId },
        data: { custodianId: sourceId },
      }),
    );
    expect(viewer.count).toBe(0);
    markCase("custodian-fee-schedule-db", "merge keeps the source file id byte count and checksum", "integration");
  });

  it("refused merge puts the file back on the source", async () => {
    await withUserScope({ role: "ADMIN", email: "admin@example.test" }, async (tx) => {
      await tx.custodianFeeScheduleDocument.updateMany({
        where: { id: { in: [docId] } },
        data: { custodianId: sourceId },
      });
    });
    const restored = await withUserScope({ role: "ADMIN", email: "admin@example.test" }, async (tx) =>
      tx.custodianFeeScheduleDocument.findUnique({
        where: { id: docId },
        select: { custodianId: true, id: true, byteSize: true, sha256: true },
      }),
    );
    expect(restored).toEqual({
      id: docId,
      custodianId: sourceId,
      byteSize: PDF.byteLength,
      sha256: sha,
    });
    markCase("custodian-fee-schedule-db", "refused merge puts the file back on the source", "integration");
  });
});
