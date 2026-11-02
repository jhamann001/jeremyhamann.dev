import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import * as route from "../app/api/ingest/crm-parent-orphans/route";

const gated = process.env.INGEST_DATABASE_URL ? describe : describe.skip;
const TOKEN = "crm-parent-orphan-integration-token";
const SOURCE_15 = "001900000000011";
const SOURCE_18 = `${SOURCE_15}AAA`;
const REPLACEMENT_18 = "001904782845683AAA";

function request(items: unknown[], runId: string, dryRun = false): Request {
  return new Request(
    `https://x/api/ingest/crm-parent-orphans${dryRun ? "?dryRun=1" : ""}`,
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

gated("CRM parent orphan evidence ingest", () => {
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
      DELETE FROM mirror.crm_parent_orphan_evidence
       WHERE normalized_key = ${SOURCE_15}`;
    await owner.$executeRaw`
      DELETE FROM audit."AuditLog"
       WHERE "entityType" = 'ingest_run'
         AND "entityId" LIKE 'RUN-CRM-ORPHAN-INT-%'`;
  });

  afterAll(async () => {
    await owner.$executeRaw`
      DELETE FROM mirror.crm_parent_orphan_evidence
       WHERE normalized_key = ${SOURCE_15}`;
    await owner.$executeRaw`
      DELETE FROM audit."AuditLog"
       WHERE "entityType" = 'ingest_run'
         AND "entityId" LIKE 'RUN-CRM-ORPHAN-INT-%'`;
    await app.$disconnect();
    await ingest.$disconnect();
    await owner.$disconnect();
    if (originalToken === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = originalToken;
  });

  it("canonicalizes and updates diagnostic evidence idempotently", async () => {
    const first = await route.POST(request([{
      parent_type: "HOUSEHOLD",
      source_key: SOURCE_18,
      parent_state: "DELETED",
    }], "RUN-CRM-ORPHAN-INT-1"));
    expect(first.status).toBe(200);

    const replay = await route.POST(request([{
      parent_type: "HOUSEHOLD",
      source_key: SOURCE_15,
      parent_state: "MERGED",
      replacement_key: REPLACEMENT_18,
    }], "RUN-CRM-ORPHAN-INT-2"));
    expect(replay.status).toBe(200);

    const rows = await owner.$queryRaw<Array<{
      source_key: string;
      normalized_key: string;
      evidence_type: string;
      replacement_normalized_key: string | null;
    }>>`
      SELECT source_key, normalized_key, evidence_type,
             replacement_normalized_key
        FROM mirror.crm_parent_orphan_evidence
       WHERE normalized_key = ${SOURCE_15}`;
    expect(rows).toEqual([{
      source_key: SOURCE_15,
      normalized_key: SOURCE_15,
      evidence_type: "MERGED",
      replacement_normalized_key: REPLACEMENT_18.slice(0, 15),
    }]);
  });

  it("keeps dry-run mirror-write-free", async () => {
    const response = await route.POST(request([{
      parent_type: "HOUSEHOLD",
      source_key: SOURCE_18,
      parent_state: "DELETED",
    }], "RUN-CRM-ORPHAN-INT-DRY", true));
    expect(response.status).toBe(200);

    const [row] = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n
        FROM mirror.crm_parent_orphan_evidence
       WHERE normalized_key = ${SOURCE_15}`;
    expect(Number(row.n)).toBe(0);
  });

  it("keeps app users dark and withholds delete/type mutation from ingest", async () => {
    await expect(
      app.$queryRawUnsafe(
        "SELECT source_key FROM mirror.crm_parent_orphan_evidence LIMIT 1",
      ),
    ).rejects.toThrow();
    await expect(
      ingest.$executeRawUnsafe(
        "UPDATE mirror.crm_parent_orphan_evidence SET parent_type = parent_type WHERE false",
      ),
    ).rejects.toThrow();
    await expect(
      ingest.$executeRawUnsafe(
        "DELETE FROM mirror.crm_parent_orphan_evidence WHERE false",
      ),
    ).rejects.toThrow();
  });
});
