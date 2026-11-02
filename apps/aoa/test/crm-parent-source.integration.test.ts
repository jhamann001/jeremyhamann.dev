import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import * as route from "../app/api/ingest/crm-parents/route";

const gated = process.env.INGEST_DATABASE_URL ? describe : describe.skip;
const TOKEN = "crm-parent-integration-token";
const HOUSEHOLD_15 = "001900000000001";
const HOUSEHOLD_18 = `${HOUSEHOLD_15}AAA`;
const CONTACT_18 = "003395762819570AAA";

function request(items: unknown[], runId: string, dryRun = false): Request {
  return new Request(
    `https://x/api/ingest/crm-parents${dryRun ? "?dryRun=1" : ""}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ source: "crm-test", run_id: runId, items }),
    },
  );
}

gated("CRM parent source ingest", () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let ingest: PrismaClient;
  const originalToken = process.env.INGEST_TOKEN;

  beforeAll(() => {
    owner = new PrismaClient({
      datasourceUrl: process.env.INGEST_TEST_CLEANUP_URL
        ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=mirror`,
    });
    app = new PrismaClient({
      datasourceUrl: process.env.DATABASE_URL
        ?? "postgresql://app_rw@localhost:5432/aoa?schema=app",
    });
    ingest = new PrismaClient({ datasourceUrl: process.env.INGEST_DATABASE_URL! });
    process.env.INGEST_TOKEN = TOKEN;
  });

  beforeEach(async () => {
    await owner.$executeRaw`
      DELETE FROM mirror.crm_parent_source
       WHERE normalized_key IN (${HOUSEHOLD_15}, ${CONTACT_18.slice(0, 15)})`;
    await owner.$executeRaw`
      DELETE FROM audit."AuditLog"
       WHERE "entityType" = 'ingest_run'
         AND "entityId" LIKE 'RUN-CRM-PARENT-INT-%'`;
  });

  afterAll(async () => {
    await owner.$executeRaw`
      DELETE FROM mirror.crm_parent_source
       WHERE normalized_key IN (${HOUSEHOLD_15}, ${CONTACT_18.slice(0, 15)})`;
    await owner.$executeRaw`
      DELETE FROM audit."AuditLog"
       WHERE "entityType" = 'ingest_run'
         AND "entityId" LIKE 'RUN-CRM-PARENT-INT-%'`;
    await app.$disconnect();
    await ingest.$disconnect();
    await owner.$disconnect();
    if (originalToken === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = originalToken;
  });

  it("batch-upserts canonical parents idempotently through ingest_rw", async () => {
    const first = await route.POST(request([
      { parent_type: "HOUSEHOLD", source_key: HOUSEHOLD_18 },
      { parent_type: "CONTACT", source_key: CONTACT_18 },
    ], "RUN-CRM-PARENT-INT-1"));
    expect(first.status).toBe(200);

    const replay = await route.POST(request([
      { parent_type: "HOUSEHOLD", source_key: HOUSEHOLD_15 },
    ], "RUN-CRM-PARENT-INT-2"));
    expect(replay.status).toBe(200);

    const rows = await owner.$queryRaw<Array<{
      parent_type: string;
      source_key: string;
      normalized_key: string;
    }>>`
      SELECT parent_type, source_key, normalized_key
        FROM mirror.crm_parent_source
       WHERE normalized_key IN (${HOUSEHOLD_15}, ${CONTACT_18.slice(0, 15)})
       ORDER BY parent_type`;
    expect(rows).toEqual([
      {
        parent_type: "CONTACT",
        source_key: CONTACT_18,
        normalized_key: CONTACT_18.slice(0, 15),
      },
      {
        parent_type: "HOUSEHOLD",
        source_key: HOUSEHOLD_15,
        normalized_key: HOUSEHOLD_15,
      },
    ]);
  });

  it("dry-run writes no parent row", async () => {
    const response = await route.POST(request([
      { parent_type: "HOUSEHOLD", source_key: HOUSEHOLD_18 },
    ], "RUN-CRM-PARENT-INT-DRY", true));
    expect(response.status).toBe(200);

    const [row] = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n
        FROM mirror.crm_parent_source
       WHERE normalized_key = ${HOUSEHOLD_15}`;
    expect(Number(row.n)).toBe(0);
  });

  it("keeps app users dark and limits ingest to the feed contract", async () => {
    await expect(
      app.$queryRawUnsafe("SELECT source_key FROM mirror.crm_parent_source LIMIT 1"),
    ).rejects.toThrow();
    await expect(
      ingest.$executeRawUnsafe(
        "UPDATE mirror.crm_parent_source SET parent_type = parent_type WHERE false",
      ),
    ).rejects.toThrow();
    await expect(
      ingest.$executeRawUnsafe("DELETE FROM mirror.crm_parent_source WHERE false"),
    ).rejects.toThrow();
  });
});
