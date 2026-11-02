import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { PrismaClient } from "@prisma/client";
import { getPartialAcatPositions } from "@/lib/data/transfer-asset-map";
import type { Identity } from "@/lib/data/types";

// DB-gated: getPartialAcatPositions joins mirror.acat_asset_map_position (no
// Prisma model → raw INSERT seed) to app.transfer_position_flag and resolves the
// is-transferring flag. Gate on INGEST_DATABASE_URL (same as the board suite).
// The linked account is resolved from the transfer's asset_map_* key exactly as
// getAssignedAssetMapDetail resolves it.

const RUN = process.env.INGEST_DATABASE_URL ? describe : describe.skip;

function makeSudoClient(): PrismaClient {
  const url =
    process.env.INGEST_TEST_CLEANUP_URL ??
    `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`;
  return new PrismaClient({ datasources: { db: { url } } });
}

const OPS: Identity = { role: "OPERATIONS", email: "ops@example.com" };

const IDS = {
  household: "ZZTEST-P-HH",
  account: "ZZTEST-P-ACCT",
  pos1: "ZZTEST-P-POS1",
  pos2: "ZZTEST-P-POS2",
  pos3: "ZZTEST-P-POS3",
  pos4: "ZZTEST-P-POS4",
  transfer: "ZZTEST-P-XFER",
} as const;
const FOLDER = "ZZTEST-P-FOLDER";

const sudo = makeSudoClient();

async function teardown() {
  await sudo.$executeRaw`DELETE FROM app.transfer_position_flag WHERE transfer_id LIKE 'ZZTEST-P-%'`;
  await sudo.$executeRaw`DELETE FROM app.transfer WHERE id LIKE 'ZZTEST-P-%'`;
  await sudo.$executeRaw`DELETE FROM mirror.acat_asset_map_position WHERE id LIKE 'ZZTEST-P-%'`;
  await sudo.$executeRaw`DELETE FROM mirror.acat_asset_map_account WHERE id LIKE 'ZZTEST-P-%'`;
  await sudo.$executeRaw`DELETE FROM mirror.acat_asset_map_household WHERE id LIKE 'ZZTEST-P-%'`;
  await sudo.$executeRaw`
    DELETE FROM audit.row_change WHERE table_name = 'transfer' AND row_pk LIKE 'ZZTEST-P-%'`;
}

RUN("getPartialAcatPositions", () => {
  beforeAll(async () => {
    await teardown();
    // mirror chain (raw — no Prisma model for mirror.*)
    await sudo.$executeRaw`
      INSERT INTO mirror.acat_asset_map_household (id, source_folder_id, client_name, superseded_by, processed_at)
      VALUES (${IDS.household}, ${FOLDER}, 'ZZTEST Partial Client', NULL, now())`;
    await sudo.$executeRaw`
      INSERT INTO mirror.acat_asset_map_account (id, household_id, custodian, account_number, account_type, account_holder)
      VALUES (${IDS.account}, ${IDS.household}, 'APEX', 'KI-238', 'Roth IRA', 'ZZTEST Partial Client')`;
    // Real pipeline vocab: effective_status ACAT = transfer-eligible, LIQUIDATE =
    // not. The `transferring` boolean is NULL (as it is in the live feed), so the
    // default falls to the eligibility classification.
    //   AAPL: ACAT, transferring NULL, no override → default TRUE (from ACAT).
    //   VTI:  ACAT, transferring NULL, override FALSE → override wins → FALSE.
    //   GLD:  LIQUIDATE → ineligible; default FALSE.
    await sudo.$executeRaw`
      INSERT INTO mirror.acat_asset_map_position
        (id, account_id, symbol, description, market_value, cost_basis, transferring, transfer_eligible, effective_status)
      VALUES
        (${IDS.pos1}, ${IDS.account}, 'AAPL', 'Apple Inc',   181000, 22000,  NULL, 'ACAT',      'ACAT'),
        (${IDS.pos2}, ${IDS.account}, 'VTI',  'Vanguard Tot', 140000, 128000, NULL, 'ACAT',      'ACAT'),
        (${IDS.pos3}, ${IDS.account}, 'GLD',  'SPDR Gold',     45000, 61000,  NULL, 'REVIEW',    'LIQUIDATE'),
        (${IDS.pos4}, ${IDS.account}, 'PFE',  'Pfizer',        30000, NULL,   NULL, 'ACAT',      NULL)`;

    // the transfer, linked to the account, ACAT_PARTIAL
    await sudo.transfer.create({
      data: {
        id: IDS.transfer,
        source: "APP",
        client_first_name: "ZZTEST",
        client_last_name: "Partial",
        value: "321000.00",
        owner_kind: "OPERATIONS",
        stage: "DECISION",
        funding_type: "ACAT_PARTIAL",
        asset_map_folder_id: FOLDER,
        asset_map_custodian: "APEX",
        asset_map_account_number: "KI-238",
        asset_map_account_type: "Roth IRA",
      },
    });

    // AOA override: force VTI to NOT transferring (over the ACAT eligibility default).
    await sudo.transferPositionFlag.create({
      data: {
        transfer_id: IDS.transfer,
        symbol: "VTI",
        is_transferring: false,
        decided_by: "ops@example.com",
        decided_at: new Date(),
      },
    });
  });
  afterAll(async () => {
    await teardown();
    await sudo.$disconnect();
  });

  const key = {
    transferId: IDS.transfer,
    folderId: FOLDER,
    custodian: "APEX",
    accountNumber: "KI-238",
    accountType: "Roth IRA",
  };

  it("returns the linked account's positions with cost basis, ordered by value desc", async () => {
    const rows = await getPartialAcatPositions(OPS, key);
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => r.symbol)).toEqual(["AAPL", "VTI", "GLD", "PFE"]);
    const aapl = rows!.find((r) => r.symbol === "AAPL")!;
    expect(aapl.marketValue).toBe(181000);
    expect(aapl.costBasis).toBe(22000);
  });

  it("defaults is-transferring from ACAT eligibility when the pipeline boolean is null; override wins", async () => {
    const rows = await getPartialAcatPositions(OPS, key);
    const aapl = rows!.find((r) => r.symbol === "AAPL")!;
    const vti = rows!.find((r) => r.symbol === "VTI")!;
    const gld = rows!.find((r) => r.symbol === "GLD")!;
    expect(aapl.isTransferring).toBe(true); // ACAT, no override → default true
    expect(vti.isTransferring).toBe(false); // ACAT default true, but override forces false
    expect(gld.isTransferring).toBe(false); // LIQUIDATE → default false
    // PFE: effective_status NULL, transfer_eligible 'ACAT' → the fallback still
    // reads ACAT → eligible + default transferring.
    expect(rows!.find((r) => r.symbol === "PFE")!.isTransferring).toBe(true);
  });

  it("flags ONLY non-ACAT positions as ineligible (ACAT is transfer-eligible)", async () => {
    const rows = await getPartialAcatPositions(OPS, key);
    expect(rows!.find((r) => r.symbol === "AAPL")!.ineligible).toBe(false);
    expect(rows!.find((r) => r.symbol === "VTI")!.ineligible).toBe(false);
    expect(rows!.find((r) => r.symbol === "GLD")!.ineligible).toBe(true);
    // effective_status NULL but transfer_eligible ACAT → eligible via fallback.
    expect(rows!.find((r) => r.symbol === "PFE")!.ineligible).toBe(false);
  });

  it("returns null when the asset-map key does not resolve to an account", async () => {
    const rows = await getPartialAcatPositions(OPS, { ...key, folderId: "NOPE" });
    expect(rows).toBeNull();
  });
});
