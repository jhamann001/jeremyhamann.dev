import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The pipeline pull is the only stub: each test hands the import one synthetic
// page and may act while that pull is in flight. The import, its lock, the
// ingest transaction and the write-through run against PostgreSQL.
const { pull } = vi.hoisted(() => ({
  pull: { households: [] as unknown[], during: null as null | (() => Promise<void>) },
}));
vi.mock("@/lib/data/asset-map", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/asset-map")>()),
  fetchHouseholdsPage: async () => {
    await pull.during?.();
    return { households: pull.households, total: pull.households.length, envelope: {} };
  },
}));

import { runAssetMapImport } from "@/lib/data/asset-map-import";
import { applyAssetMapWriteThrough } from "@/lib/data/asset-map-write-through";
import { ingestPrisma } from "@/lib/ingest/db";
import { withIngestScope } from "@/lib/ingest/scope";

const gated = process.env.INGEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "ZZTEST-ticket-";
const HH = `${PREFIX}household`;
const ACC = `${PREFIX}account`;

function pipelineHousehold(account: Record<string, unknown>) {
  return { id: HH, client_name: "Synthetic Import Client", accounts: [{ id: ACC, custodian: "Synthetic Custodian", assets: [], ...account }] };
}

gated("shared asset-map import with actual PostgreSQL (ticket)", () => {
  let owner: PrismaClient | undefined;
  let savedUrl: string | undefined;

  async function cleanup() {
    if (!owner) return;
    await owner.$executeRaw`DELETE FROM mirror.acat_asset_map_household WHERE id = ${HH}`;
  }

  async function account() {
    const [row] = await owner!.$queryRaw<Array<{ account_type: string | null; account_type_overridden_by: string | null; account_type_overridden_at: Date | null; account_holder: string | null }>>`
      SELECT account_type, account_type_overridden_by, account_type_overridden_at, account_holder
        FROM mirror.acat_asset_map_account WHERE id = ${ACC}`;
    return row;
  }

  beforeAll(async () => {
    const cleanupUrl = process.env.INGEST_TEST_CLEANUP_URL;
    if (!cleanupUrl) throw new Error("INGEST_TEST_CLEANUP_URL is required");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(cleanupUrl).hostname)) {
      throw new Error("Import integration tests require a loopback synthetic database");
    }
    owner = new PrismaClient({ datasourceUrl: cleanupUrl });
    savedUrl = process.env.STATEMENT_PIPELINE_URL;
    process.env.STATEMENT_PIPELINE_URL = "https://pipeline.example.test";
    await cleanup();
  });

  beforeEach(async () => {
    pull.during = null;
    await cleanup();
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      if (savedUrl === undefined) delete process.env.STATEMENT_PIPELINE_URL;
      else process.env.STATEMENT_PIPELINE_URL = savedUrl;
      await owner?.$disconnect();
      await ingestPrisma.$disconnect();
    }
  });

  it("a save confirmed while the pull is in flight keeps its account type; other columns still import (WO-AC-3)", async () => {
    pull.households = [pipelineHousehold({ account_type: "Individual", account_holder: "First Holder" })];
    expect((await runAssetMapImport({ dryRun: false })).status).toBe(200);
    expect((await account())?.account_type).toBe("Individual");

    pull.households = [pipelineHousehold({ account_type: "Individual", account_holder: "Second Holder" })];
    pull.during = () => withIngestScope((tx) => applyAssetMapWriteThrough(tx, {
      kind: "accountType", accountId: ACC, accountType: "IRA", accountTypeOther: null,
      overriddenBy: "ticket-saver@example.test", overriddenAt: new Date().toISOString(),
    }));
    expect((await runAssetMapImport({ dryRun: false })).status).toBe(200);
    const row = await account();
    expect(row?.account_type).toBe("IRA");
    expect(row?.account_type_overridden_by).toBe("ticket-saver@example.test");
    expect(row?.account_holder).toBe("Second Holder");
  });

  it("a pull that began after the save overwrites with the pipeline's values", async () => {
    pull.households = [pipelineHousehold({ account_type: "Individual" })];
    await runAssetMapImport({ dryRun: false });
    await withIngestScope((tx) => applyAssetMapWriteThrough(tx, {
      kind: "accountType", accountId: ACC, accountType: "IRA", accountTypeOther: null,
      overriddenBy: "ticket-saver@example.test", overriddenAt: new Date(Date.now() - 1000).toISOString(),
    }));
    pull.households = [pipelineHousehold({
      account_type: "Roth IRA",
      account_type_overridden_by: "ticket-pipeline@example.test",
      account_type_overridden_at: new Date().toISOString(),
    })];
    expect((await runAssetMapImport({ dryRun: false })).status).toBe(200);
    const row = await account();
    expect(row?.account_type).toBe("Roth IRA");
    expect(row?.account_type_overridden_by).toBe("ticket-pipeline@example.test");
  });

  it("while another transaction holds the import lock, an import cannot commit until it ends (WO-AC-2)", async () => {
    pull.households = [pipelineHousehold({ account_type: "Individual" })];
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const holder = owner!.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('aoa:asset-map-import', 0))`;
      locked();
      await released;
    }, { timeout: 30_000 });
    await holding;

    let finished = false;
    const importing = runAssetMapImport({ dryRun: false }).then((r) => { finished = true; return r; });
    const deadline = Date.now() + 10_000;
    let waiting = 0;
    while (Date.now() < deadline && waiting === 0) {
      const [row] = await owner!.$queryRaw<Array<{ waiting: bigint }>>`
        SELECT count(*) AS waiting FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      waiting = Number(row.waiting);
      if (waiting === 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(waiting).toBeGreaterThan(0);
    expect(finished).toBe(false);
    expect(await account()).toBeUndefined();

    release();
    await holder;
    expect((await importing).status).toBe(200);
    expect((await account())?.account_type).toBe("Individual");
  });
});
