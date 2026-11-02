import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { LEGACY_DEV_ADVISORY_LOCK_SQL } from "@/lib/migrations/legacy-dev-data";

// The live checkpoint-3 rehearsal exposed a PostgreSQL/Prisma boundary that a
// string-only unit test cannot cover: pg_advisory_xact_lock returns `void`, and
// Prisma rejects that type unless the SQL casts it to a supported scalar. Run
// the exact importer statement against PostgreSQL in CI so this cannot regress.
const DB_URL = process.env.DIRECT_DATABASE_URL;
const gated = DB_URL ? describe : describe.skip;

gated("legacy dev importer advisory lock", () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("acquires the transaction lock without returning Prisma's unsupported void type", async () => {
    await expect(
      db.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ lock_status: string }[]>(
          LEGACY_DEV_ADVISORY_LOCK_SQL,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.lock_status).toBe("");
      }),
    ).resolves.toBeUndefined();
  });
});
