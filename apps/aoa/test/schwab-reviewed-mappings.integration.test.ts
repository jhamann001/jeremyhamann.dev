import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { reviewSchwabMappings, listSchwabMappings } from "@/lib/data/schwab-mappings";
import { parseSchwabMappingCsv } from "@/lib/schwab/review";
import { prisma } from "@/lib/db";
import { ingestPrisma } from "@/lib/ingest/db";
import { POST } from "@/app/api/ingest/schwab-account-balances/route";

// Dedicated synthetic LOCAL database only. Run after prisma migrate deploy.
// Set DATABASE_URL=app_rw, INGEST_DATABASE_URL=ingest_rw and
// SCHWAB_TEST_DB_URL=the non-superuser migration owner for that same database.
const url = process.env.SCHWAB_TEST_DB_URL;
const gated = url ? describe : describe.skip;
const HH = "001811414863873AAA", OTHER_HH = "001391076342625AAA";
const CONTACT = "003811414863873AAA", OTHER_CONTACT = "003391076342625AAA";
const identity = { role: "OPERATIONS", email: "schwab-review@example.test" };
const rows = parseSchwabMappingCsv(`91000001,${HH},${CONTACT},CLIENT\n91000002,${HH},,CLIENT\n91000003,,,FIRM_OPERATING`)!;

gated("Schwab reviewed mappings: real role/database integration", () => {
  let owner: PrismaClient;
  const versions = new Map<string, number>();
  beforeAll(async () => {
    const expected = new URL(url!);
    for (const value of [url, process.env.DATABASE_URL, process.env.INGEST_DATABASE_URL]) {
      const checked = new URL(value ?? "");
      if (!["localhost", "127.0.0.1"].includes(checked.hostname)
          || !checked.pathname.startsWith("/aoa_schwab_review_")
          || checked.host !== expected.host || checked.pathname !== expected.pathname) {
        throw new Error("Requires an isolated localhost aoa_schwab_review_* database for all three roles");
      }
    }
    owner = new PrismaClient({ datasourceUrl: url });
    process.env.INGEST_TOKEN = "synthetic-review-integration-token";
    await ingestPrisma.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
      VALUES (${HH}, 'Example Household', 'Lost Client', 'advisor@example.test'),
             (${OTHER_HH}, 'Example Household', 'Client', 'advisor@example.test')
      ON CONFLICT (sf_id) DO NOTHING`;
    await ingestPrisma.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, stage, lead_advisor_email)
      VALUES (${CONTACT}, ${HH}, 'Alex', 'Example', 'Lost Client', 'advisor@example.test'),
             (${OTHER_CONTACT}, ${OTHER_HH}, 'Alex', 'Example', 'Client', 'advisor@example.test')
      ON CONFLICT (sf_id) DO NOTHING`;
  });
  afterAll(async () => { await Promise.all([owner?.$disconnect(), prisma.$disconnect(), ingestPrisma.$disconnect()]); });

  it("runs the audit trigger owned by a non-superuser under FORCE RLS", async () => {
    const [role] = await owner.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT r.rolsuper, r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid = 'app.audit_schwab_account_mapping()'::regprocedure`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const preview = await reviewSchwabMappings(identity, rows);
    expect(preview.status).toBe("preview");
    if (preview.status !== "preview") throw new Error("missing preview");
    expect(preview.rows[0]?.stage).toBe("Lost Client");
    preview.rows.forEach((row) => versions.set(row.accountId, row.version + 1));
    expect(await reviewSchwabMappings(identity, preview.rows, true)).toEqual({ status: "saved" });
    const saved = await listSchwabMappings(identity);
    expect(saved.filter((row) => rows.some((input) => input.accountId === row.accountId))).toHaveLength(3);
    expect(saved[0]?.reviewedBy).toBe(identity.email);
    const history = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_role', 'OPERATIONS', true)`;
      return tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM app.schwab_account_mapping_event`;
    });
    expect(Number(history[0]?.n)).toBeGreaterThanOrEqual(3);
  });

  it("blocks ingest mapping edits, advisor access, history edits and full-number app reads", async () => {
    await expect(ingestPrisma.$executeRaw`UPDATE app.schwab_account_mapping SET account_scope = 'CLIENT'`).rejects.toThrow();
    await expect(ingestPrisma.$queryRaw`SELECT reviewed_by FROM app.schwab_account_mapping`).rejects.toThrow();
    await expect(prisma.$queryRaw`SELECT account_number FROM mirror.schwab_account_balance`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM app.schwab_account_mapping_event`).rejects.toThrow();
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_role', 'ADVISOR', true)`;
      return tx.$queryRaw<unknown[]>`SELECT account_id FROM app.schwab_account_mapping`;
    });
    expect(result).toEqual([]);
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_role', 'ADVISOR', true)`;
      await tx.$executeRaw`SELECT set_config('app.user_email', 'advisor@example.test', true)`;
      await tx.$executeRaw`INSERT INTO app.schwab_account_mapping
        (account_id, account_number_last4, account_scope, version, reviewed_by)
        VALUES ('schw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '9999', 'FIRM_OPERATING', 1, 'forged@example.test')`;
    })).rejects.toThrow();
  });

  it("dry-runs then imports all reviewed rows, retains zero balances and scopes firm accounts", async () => {
    const payload = { source: "schwab-s3", run_id: "synthetic-reviewed-run", as_of_date: "2026-09-17",
      source_key: "synthetic/CRS20260917.RPS", source_sha256: "d".repeat(64), expected_account_count: 3,
      items: ["91000001", "91000002", "91000003"].map((account_number) => ({
        account_number, account_name: "Synthetic Corporation", account_cash: 0, account_securities: 0,
        account_aum: 0, balance_as_of: "2026-09-17",
      })) };
    const request = (dry: boolean) => new Request(`https://ops-portal.test/api/ingest/schwab-account-balances${dry ? "?dryRun=1" : ""}`, {
      method: "POST", headers: { authorization: `Bearer ${process.env.INGEST_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const before = await ingestPrisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM mirror.schwab_account_balance`;
    const dry = await POST(request(true));
    expect(await dry.json()).toMatchObject({ would_upsert: 3, match_summary: { operations_reviewed: 3, firm_operating: 1 } });
    expect(dry.status).toBe(200);
    const after = await ingestPrisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM mirror.schwab_account_balance`;
    expect(after).toEqual(before);
    const live = await POST(request(false));
    expect(live.status).toBe(200);
    const accounts = await ingestPrisma.$queryRaw<Array<{ account_number_last4: string; client_sf_id: string | null; household_sf_id: string | null; account_scope: string; reviewed_mapping_version: number }>>`
      SELECT account_number_last4, client_sf_id, household_sf_id, account_scope, reviewed_mapping_version
      FROM mirror.schwab_account_balance WHERE source_present ORDER BY account_number_last4`;
    expect(accounts).toEqual([
      { account_number_last4: "0001", client_sf_id: CONTACT, household_sf_id: HH, account_scope: "CLIENT", reviewed_mapping_version: versions.get(rows[0]!.accountId) },
      { account_number_last4: "0002", client_sf_id: null, household_sf_id: HH, account_scope: "CLIENT", reviewed_mapping_version: versions.get(rows[1]!.accountId) },
      { account_number_last4: "0003", client_sf_id: null, household_sf_id: null, account_scope: "FIRM_OPERATING", reviewed_mapping_version: versions.get(rows[2]!.accountId) },
    ]);
    const rerun = await POST(request(false));
    expect(await rerun.json()).toMatchObject({ upserted: 3, retired: 0 });
    expect(rerun.status).toBe(200);
    expect((await listSchwabMappings(identity)).filter((row) => versions.has(row.accountId))
      .every((row) => row.appliedVersion === row.version)).toBe(true);

    // A later source re-parenting must not silently send this account to a
    // different same-name person. Reject the whole snapshot and preserve rows.
    await ingestPrisma.$executeRaw`UPDATE mirror.client SET household_id = ${OTHER_HH} WHERE sf_id = ${CONTACT}`;
    try {
      const invalid = await POST(request(false));
      expect(invalid.status).toBe(422);
      expect(await invalid.json()).toMatchObject({ rejected: [{ index: 0, reason: "reviewed_mapping_invalid" }] });
      const unchanged = await ingestPrisma.$queryRaw<Array<{ household_sf_id: string }>>`
        SELECT household_sf_id FROM mirror.schwab_account_balance WHERE account_id = ${rows[0]!.accountId}`;
      expect(unchanged[0]?.household_sf_id).toBe(HH);
    } finally {
      await ingestPrisma.$executeRaw`UPDATE mirror.client SET household_id = ${HH} WHERE sf_id = ${CONTACT}`;
    }
  });
});
