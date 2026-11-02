import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLegacyImportDirectory } from "@/lib/operations/legacy-import-engine";
import { parseLegacyFeeCreditsCsv, resolveLegacyRequest } from "@/lib/operations/legacy-import";

// Explicitly opted-in loopback disposable PostgreSQL only. Every synthetic
// mirror insert is inside a transaction that deliberately rolls back; no
// shared-dev/prod fallback, imported rows, role changes or trigger changes.
const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
gated.sequential("legacy directory loader: real PostgreSQL identity regression", () => {
  let database: PrismaClient;
  beforeAll(() => {
    const datasourceUrl = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!datasourceUrl || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(datasourceUrl).hostname)) {
      throw new Error("directory_test_requires_opted_in_loopback_disposable_database");
    }
    database = new PrismaClient({ datasourceUrl, log: [] });
  });
  afterAll(async () => { await database?.$disconnect(); });

  async function withDirectory(check: (tx: Prisma.TransactionClient, fixture: {
    first: string; second: string; real: string; accountA: string; sharedToken: string;
    request: ReturnType<typeof parseLegacyFeeCreditsCsv>["rows"][number];
  }) => Promise<void>) {
    const nonce = randomUUID().replaceAll("-", "");
    const first = `DEV-DIRECTORY-${nonce}-A`, second = `DEV-DIRECTORY-${nonce}-B`;
    const real = `003${nonce.slice(0, 12)}`, accountA = `synthetic-account-${nonce}`;
    const sharedToken = `SYNTHETIC-${nonce}`, bridge = `synthetic-bridge-${nonce}`;
    const parsed = parseLegacyFeeCreditsCsv([
      "id,submission_date,user_role,client_user_id,fee_type,fee_amount,account_numbers,waiver_reason,created_at,status,credited_date,client_name,apex_request,submitted_by",
      `9909160001001,2026-09-14,OPERATIONS,${bridge},Wire,20.00,${sharedToken},Synthetic reason,2026-09-14,Rejected,,Synthetic ${nonce},,Synthetic Importer`,
    ].join("\n"));
    expect(parsed.issues).toEqual([]);
    const rollback = new Error("synthetic_directory_fixture_rollback");
    await expect(database.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO mirror.client (sf_id, first_name, last_name, cedar_ridge_user_id)
        VALUES (${first}, 'Synthetic', ${nonce}, ${bridge}),
               (${second}, 'Synthetic', ${nonce}, ${bridge}),
               (${real}, 'Synthetic', ${nonce}, ${bridge})`;
      await tx.$executeRaw`
        INSERT INTO mirror.client_account_aum
          (custodian_account_id, apex_account_number, client_sf_id, account_type, account_status, source_present)
        VALUES (${accountA}, ${sharedToken}, ${first}, 'Individual', 'ACTIVE', true),
               (${`real-account-${nonce}`}, ${`REAL-${nonce}`}, ${(real + "AAA").toUpperCase()}, 'Individual', 'ACTIVE', true)`;
      await check(tx, { first, second, real, accountA, sharedToken, request: parsed.rows[0] });
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);
  }

  it("does not attach A's account to B before invoking the real resolver", async () => {
    await withDirectory(async (tx, fixture) => {
      const directory = await loadLegacyImportDirectory([fixture.request], [], tx);
      expect(directory.clients.map((row) => row.sfId)).toContain(fixture.second);
      expect(directory.accounts.filter((row) => row.id === fixture.accountA)).toEqual([
        { id: fixture.accountA, clientSfId: fixture.first, apexAccountNumber: fixture.sharedToken },
      ]);
      expect(resolveLegacyRequest(fixture.request, directory)).toMatchObject({ issue: null,
        resolved: { clientSfId: fixture.first, accountIds: [fixture.accountA] } });
    });
  });
  it("still joins genuine 15/18-character Salesforce IDs case-insensitively", async () => {
    await withDirectory(async (tx, fixture) => {
      const directory = await loadLegacyImportDirectory([fixture.request], [], tx);
      expect(directory.accounts.filter((row) => row.clientSfId === fixture.real)).toHaveLength(1);
    });
  });
  it("blocks two genuinely distinct owners with the same source account token", async () => {
    await withDirectory(async (tx, fixture) => {
      await tx.$executeRaw`
        INSERT INTO mirror.client_account_aum
          (custodian_account_id, apex_account_number, client_sf_id, account_type, account_status, source_present)
        VALUES (${fixture.accountA + "-b"}, ${fixture.sharedToken}, ${fixture.second}, 'Individual', 'ACTIVE', true)`;
      const directory = await loadLegacyImportDirectory([fixture.request], [], tx);
      expect(resolveLegacyRequest(fixture.request, directory)).toMatchObject({ resolved: null,
        issue: { code: "ambiguous_match" } });
    });
  });
});
