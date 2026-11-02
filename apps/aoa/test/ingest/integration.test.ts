import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import * as clients from "../../app/api/ingest/clients/route";
import * as accounts from "../../app/api/ingest/accounts/route";
import * as accountAum from "../../app/api/cron/account-aum/route";
import {
  apexAccountByNumber,
  apexAccountsForClient,
  apexAccountsForHousehold,
  clientApexAumTotal,
  clientApexAumState,
  householdApexAumTotal,
  householdApexAumState,
  firmWideAumSplit,
} from "@/lib/data/account-aum";
import { listHouseholds, getHousehold } from "@/lib/data/households";
import { FIRM_ACCOUNT_IDS, FIRM_HOUSEHOLD_ID, splitAum } from "@/lib/data/firm-household";
import {
  cleanupFixtures,
  dbGated,
  FX,
  makeCleanupClient,
  makeIngestClient,
  mirrorCounts,
} from "./db-fixture";

// ALL DB-gated ingest integration cases live in ONE file on purpose: they share
// the single local `aoa` DB and the same synthetic fixture ids, so they MUST
// run sequentially. Vitest runs tests WITHIN a file sequentially but runs
// separate files in parallel workers — two DB-touching files would race on the
// shared rows (one file's cleanup DELETE wiping another's fixtures mid-assert,
// or a cross-table count snapshot seeing a concurrent insert). Consolidating
// here keeps them serial without touching vitest.config.ts or slowing the 30-
// plus pure/parallel suites. The pure (no-DB) route cases stay in
// clients-route.test.ts / accounts-route.test.ts.
//
// All ids are synthetic and namespaced (TEST-D2-*, ACCT-D2-*, user-…-000n,
// RUN-D2-*). cleanupFixtures (superuser/BYPASSRLS) removes them after; the DB
// is never reset/dropped.

const TOKEN = "test-d2-secret-token";
const UID = FX.user1;

function clientReq(body: unknown, url = "https://x/api/ingest/clients") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}
function accountReq(body: unknown, url = "https://x/api/ingest/accounts") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

function client(over: Record<string, unknown> = {}) {
  return {
    cedar_ridge_user_id: UID,
    sf_contact_id: FX.c1,
    name: "Daniel Chen",
    household_name: "Chen Household",
    household_sf_id: FX.hh1,
    stage: "Prospect",
    lead_advisor_email: "avery@example.com",
    ...over,
  };
}
function account(over: Record<string, unknown> = {}) {
  return {
    custodian_account_id: FX.acct1,
    cedar_ridge_user_id: FX.user1,
    custodian: "APEX",
    account_type: "INDIVIDUAL",
    status: "OPEN",
    opened_at: "2026-01-15",
    closed_at: null,
    ...over,
  };
}

dbGated("ingest integration (INGEST_DATABASE_URL) — serial, shared DB", () => {
  let ingest: PrismaClient;
  let cleanup: PrismaClient;
  const original = process.env.INGEST_TOKEN;

  const originalMbUrl = process.env.WAREHOUSE_URL;
  const originalMbKey = process.env.WAREHOUSE_API_KEY;

  beforeAll(() => {
    process.env.INGEST_TOKEN = TOKEN;
    // tkt account-AUM cron config — the fetch is mocked per test, so any host works.
    process.env.WAREHOUSE_URL = "https://warehouse.example.test";
    process.env.WAREHOUSE_API_KEY = "mb-key";
    ingest = makeIngestClient();
    cleanup = makeCleanupClient();
  });
  afterAll(async () => {
    await cleanupFixtures(cleanup);
    if (original === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = original;
    if (originalMbUrl === undefined) delete process.env.WAREHOUSE_URL;
    else process.env.WAREHOUSE_URL = originalMbUrl;
    if (originalMbKey === undefined) delete process.env.WAREHOUSE_API_KEY;
    else process.env.WAREHOUSE_API_KEY = originalMbKey;
    await ingest.$disconnect();
    await cleanup.$disconnect();
  });
  beforeEach(async () => {
    await cleanupFixtures(cleanup);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- clients endpoint -----------------------------------------------------

  it("V1: mixed-validity clients — exact reject indexes; valid row lands", async () => {
    const items = [
      client(), // 0 valid (C1)
      "nope", // 1 item_malformed
      client({ sf_contact_id: "", name: "x" }), // 2 sf_contact_id_missing
      client({ sf_contact_id: FX.c2, name: "" }), // 3 name_missing
      client({ sf_contact_id: "TEST-D2-C3", stage: "" }), // 4 stage_missing
      client({ sf_contact_id: "TEST-D2-C4", cedar_ridge_user_id: "bad" }), // 5 cedar_ridge_user_id_invalid
      client({ sf_contact_id: "TEST-D2-C5", household_sf_id: "TEST-D2-HH9", household_name: null }), // 6
      client({ sf_contact_id: "TEST-D2-C6", lead_advisor_email: "nope" }), // 7
    ];
    const res = await clients.POST(clientReq({ source: "crm", run_id: "RUN-D2-V1", items }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rejected).toEqual([
      { index: 1, reason: "item_malformed" },
      { index: 2, reason: "sf_contact_id_missing" },
      { index: 3, reason: "name_missing" },
      { index: 4, reason: "stage_missing" },
      { index: 5, reason: "cedar_ridge_user_id_invalid" },
      { index: 6, reason: "household_name_missing" },
      { index: 7, reason: "lead_advisor_email_invalid" },
    ]);
    expect(body.upserted).toBe(items.length - body.rejected.length); // = 1
    expect(body.run_id).toBe("RUN-D2-V1");
    const rows = await cleanup.$queryRaw<Array<{ first_name: string | null; last_name: string }>>`
      SELECT first_name, last_name FROM mirror.client WHERE sf_id = ${FX.c1}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].first_name).toBe("Daniel");
    expect(rows[0].last_name).toBe("Chen");
  });

  it("B1: empty items → 200 {upserted:0, rejected:[]}; audit received:0", async () => {
    const res = await clients.POST(clientReq({ source: "s", run_id: "RUN-D2-B1", items: [] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ upserted: 0, rejected: [], run_id: "RUN-D2-B1" });
    const audit = await cleanup.$queryRaw<Array<{ detail: string }>>`
      SELECT detail FROM audit."AuditLog" WHERE "entityId" = 'RUN-D2-B1'`;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].detail).received).toBe(0);
  });

  it("C1b: null-sent optional clients fields upsert as NULL (household/advisor/uid)", async () => {
    // A companion to N1 on the clients side: explicitly-null optionals must land
    // as SQL NULL (the null-sent path the ?? null coalesce matches).
    const item = client({
      sf_contact_id: FX.c1,
      name: "Solo", // no space → first_name null, last_name "Solo"
      household_sf_id: null,
      household_name: null,
      cedar_ridge_user_id: null,
      lead_advisor_email: null,
    });
    const res = await clients.POST(clientReq({ source: "s", run_id: "RUN-D2-C1B", items: [item] }));
    expect(res.status).toBe(200);
    expect((await res.json()).upserted).toBe(1);
    const rows = await cleanup.$queryRaw<
      Array<{
        first_name: string | null;
        last_name: string | null;
        household_id: string | null;
        cedar_ridge_user_id: string | null;
        lead_advisor_email: string | null;
      }>
    >`SELECT first_name, last_name, household_id, cedar_ridge_user_id, lead_advisor_email
      FROM mirror.client WHERE sf_id = ${FX.c1}`;
    expect(rows[0].first_name).toBeNull();
    expect(rows[0].last_name).toBe("Solo");
    expect(rows[0].household_id).toBeNull();
    expect(rows[0].cedar_ridge_user_id).toBeNull();
    expect(rows[0].lead_advisor_email).toBeNull();
  });

  it("H1: household stage is written on insert and re-stamped on a stage transition", async () => {
    // The all-stages feed carries Entity_Client_Stage__c through to
    // mirror.household.stage. First sync a Prospect; a later sync of the SAME
    // household as Client must propagate (Prospect→Client) — that is how the
    // mirror tracks a prospect converting.
    const asProspect = client({ household_sf_id: FX.hh1, household_name: "Chen Household", stage: "Prospect" });
    const r1 = await clients.POST(clientReq({ source: "s", run_id: "RUN-D2-H1a", items: [asProspect] }));
    expect(r1.status).toBe(200);
    const hh1 = await cleanup.$queryRaw<Array<{ stage: string | null }>>`
      SELECT stage FROM mirror.household WHERE sf_id = ${FX.hh1}`;
    expect(hh1[0].stage).toBe("Prospect");

    const asClient = client({ household_sf_id: FX.hh1, household_name: "Chen Household", stage: "Client" });
    const r2 = await clients.POST(clientReq({ source: "s", run_id: "RUN-D2-H1b", items: [asClient] }));
    expect(r2.status).toBe(200);
    const hh2 = await cleanup.$queryRaw<Array<{ stage: string | null }>>`
      SELECT stage FROM mirror.household WHERE sf_id = ${FX.hh1}`;
    expect(hh2[0].stage).toBe("Client");
  });

  it("N2: clients item OMITTING optional keys upserts SQL NULL (undefined-vs-null, QC MEDIUM)", async () => {
    // household_sf_id / household_name / cedar_ridge_user_id / lead_advisor_email
    // keys ABSENT (undefined at runtime). Must bind SQL NULL, not throw.
    const item: Record<string, unknown> = {
      sf_contact_id: FX.c1,
      name: "Daniel Chen",
      stage: "Prospect",
      // household_sf_id, household_name, cedar_ridge_user_id, lead_advisor_email OMITTED
    };
    const res = await clients.POST(clientReq({ source: "s", run_id: "RUN-D2-N2", items: [item] }));
    expect(res.status).toBe(200);
    expect((await res.json()).upserted).toBe(1);
    const rows = await cleanup.$queryRaw<
      Array<{ household_id: string | null; cedar_ridge_user_id: string | null; lead_advisor_email: string | null }>
    >`SELECT household_id, cedar_ridge_user_id, lead_advisor_email FROM mirror.client WHERE sf_id = ${FX.c1}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].household_id).toBeNull();
    expect(rows[0].cedar_ridge_user_id).toBeNull();
    expect(rows[0].lead_advisor_email).toBeNull();
  });

  it("I1: idempotent re-run — identical upserted; only synced_at moves", async () => {
    const batch = { source: "s", run_id: "RUN-D2-I1", items: [client()] };
    const r1 = await clients.POST(clientReq(batch));
    expect((await r1.json()).upserted).toBe(1);
    const after1 = await cleanup.$queryRaw<Array<{ stage: string; synced_at: Date }>>`
      SELECT stage, synced_at FROM mirror.client WHERE sf_id = ${FX.c1}`;
    const r2 = await clients.POST(clientReq(batch));
    expect((await r2.json()).upserted).toBe(1);
    const after2 = await cleanup.$queryRaw<Array<{ stage: string; synced_at: Date }>>`
      SELECT stage, synced_at FROM mirror.client WHERE sf_id = ${FX.c1}`;
    const count = await cleanup.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM mirror.client WHERE sf_id = ${FX.c1}`;
    expect(Number(count[0].n)).toBe(1);
    expect(after2[0].stage).toBe(after1[0].stage);
    expect(after2[0].synced_at.getTime()).toBeGreaterThanOrEqual(after1[0].synced_at.getTime());
  });

  it("D1: dryRun writes nothing; audit-only row with dry_run:true", async () => {
    const before = await mirrorCounts(cleanup);
    const beforeMax = await cleanup.$queryRaw<Array<{ m: Date | null }>>`
      SELECT max(synced_at) AS m FROM mirror.client`;
    const res = await clients.POST(
      clientReq({ source: "s", run_id: "RUN-D2-D1", items: [client()] }, "https://x/api/ingest/clients?dryRun=1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.would_upsert).toBe(1);
    expect(body.rejected).toEqual([]);
    const after = await mirrorCounts(cleanup);
    const afterMax = await cleanup.$queryRaw<Array<{ m: Date | null }>>`
      SELECT max(synced_at) AS m FROM mirror.client`;
    expect(after).toEqual(before);
    expect(afterMax[0].m?.getTime() ?? null).toBe(beforeMax[0].m?.getTime() ?? null);
    const audit = await cleanup.$queryRaw<Array<{ detail: string }>>`
      SELECT detail FROM audit."AuditLog" WHERE "entityId" = 'RUN-D2-D1'`;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].detail).dry_run).toBe(true);
  });

  it("U1: two clients share an cedar_ridge_user_id → both accepted, never rejected", async () => {
    const items = [
      client({ sf_contact_id: FX.c1 }),
      client({ sf_contact_id: FX.c2, name: "Grace Hopper" }),
    ];
    const res = await clients.POST(clientReq({ source: "s", run_id: "RUN-D2-U1", items }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toBe(2);
    expect(body.rejected).toEqual([]);
    const rows = await cleanup.$queryRaw<Array<{ cedar_ridge_user_id: string }>>`
      SELECT cedar_ridge_user_id FROM mirror.client WHERE sf_id IN (${FX.c1}, ${FX.c2}) ORDER BY sf_id`;
    expect(rows).toHaveLength(2);
    expect(rows[0].cedar_ridge_user_id).toBe(UID);
    expect(rows[1].cedar_ridge_user_id).toBe(UID);
  });

  it("P1: a null/omitted cedar_ridge_user_id NEVER wipes an existing id (COALESCE guardrail)", async () => {
    // Regression guard for the 2026-07-20 firm-wide wipe: a client-pull run that
    // sends null must NOT clobber an already-populated bridge key (it broke every
    // downstream join — trade-request panels, the id gate — until repopulated).
    // 1. First run populates the id (fresh INSERT — beforeEach cleaned the DB).
    const r1 = await clients.POST(
      clientReq({ source: "s", run_id: "RUN-D2-P1a", items: [client({ cedar_ridge_user_id: UID })] }),
    );
    expect((await r1.json()).upserted).toBe(1);

    // 2. A later run for the SAME client sends null (the wipe scenario) → the
    //    stored id must be PRESERVED (COALESCE), not overwritten to NULL.
    const r2 = await clients.POST(
      clientReq({ source: "s", run_id: "RUN-D2-P1b", items: [client({ cedar_ridge_user_id: null })] }),
    );
    expect((await r2.json()).upserted).toBe(1);
    const preserved = await cleanup.$queryRaw<Array<{ cedar_ridge_user_id: string | null }>>`
      SELECT cedar_ridge_user_id FROM mirror.client WHERE sf_id = ${FX.c1}`;
    expect(preserved).toHaveLength(1);
    expect(preserved[0].cedar_ridge_user_id).toBe(UID);

    // 3. A NON-null incoming id STILL overwrites — source stays authoritative
    //    when it actually sends a value (the guardrail only ignores nulls).
    const r3 = await clients.POST(
      clientReq({ source: "s", run_id: "RUN-D2-P1c", items: [client({ cedar_ridge_user_id: FX.user2 })] }),
    );
    expect((await r3.json()).upserted).toBe(1);
    const updated = await cleanup.$queryRaw<Array<{ cedar_ridge_user_id: string | null }>>`
      SELECT cedar_ridge_user_id FROM mirror.client WHERE sf_id = ${FX.c1}`;
    expect(updated[0].cedar_ridge_user_id).toBe(FX.user2);
  });

  // --- accounts endpoint ----------------------------------------------------

  it("V2: mixed-validity accounts — mismatch + custodian_invalid rejected pre-tx", async () => {
    const items = [
      account(), // 0 valid, APEX/OPEN
      account({ custodian_account_id: FX.acct2, status: "OPEN", closed_at: "2026-06-01" }), // 1 mismatch
      account({ custodian_account_id: "ACCT-D2-3", custodian: "SCHWAB" }), // 2 custodian_invalid
    ];
    const res = await accounts.POST(accountReq({ source: "s", run_id: "RUN-D2-V2", items }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rejected).toEqual([
      { index: 1, reason: "status_closed_at_mismatch" },
      { index: 2, reason: "custodian_invalid" },
    ]);
    expect(body.upserted).toBe(1);
    const n = await cleanup.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM mirror.account WHERE custodian_account_id IN (${FX.acct2}, 'ACCT-D2-3')`;
    expect(Number(n[0].n)).toBe(0);
    const good = await cleanup.$queryRaw<Array<{ custodian: string; status: string }>>`
      SELECT custodian, status FROM mirror.account WHERE custodian_account_id = ${FX.acct1}`;
    expect(good[0]).toEqual({ custodian: "APEX", status: "OPEN" });
  });

  it("N1: accounts item OMITTING optional keys upserts SQL NULL (undefined-vs-null, QC MEDIUM)", async () => {
    // account_type / opened_at / closed_at keys ABSENT (undefined at runtime).
    // Must bind SQL NULL, not throw in the pg raw template.
    const item: Record<string, unknown> = {
      custodian_account_id: FX.acct1,
      cedar_ridge_user_id: FX.user1,
      custodian: "APEX",
      status: "OPEN",
      // account_type, opened_at, closed_at intentionally OMITTED
    };
    const res = await accounts.POST(accountReq({ source: "s", run_id: "RUN-D2-N1", items: [item] }));
    expect(res.status).toBe(200);
    expect((await res.json()).upserted).toBe(1);
    const rows = await cleanup.$queryRaw<
      Array<{ account_type: string | null; opened_at: Date | null; closed_at: Date | null }>
    >`SELECT account_type, opened_at, closed_at FROM mirror.account WHERE custodian_account_id = ${FX.acct1}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].account_type).toBeNull();
    expect(rows[0].opened_at).toBeNull();
    expect(rows[0].closed_at).toBeNull();
  });

  it("J1: joint account → 1 account row, 2 holder rows, upserted:2", async () => {
    const items = [
      account({ custodian_account_id: FX.acct1, cedar_ridge_user_id: FX.user1 }),
      account({ custodian_account_id: FX.acct1, cedar_ridge_user_id: FX.user2 }),
    ];
    const res = await accounts.POST(accountReq({ source: "s", run_id: "RUN-D2-J1", items }));
    expect(res.status).toBe(200);
    expect((await res.json()).upserted).toBe(2);
    const acct = await cleanup.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM mirror.account WHERE custodian_account_id = ${FX.acct1}`;
    expect(Number(acct[0].n)).toBe(1);
    const holders = await cleanup.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM mirror.account_holder WHERE custodian_account_id = ${FX.acct1}`;
    expect(Number(holders[0].n)).toBe(2);
  });

  // --- account-AUM cron pull + read seam --------------------------------------

  // A managed row ($100k) + an unmanaged $0 row, both for client FX.c1 /
  // household FX.hh1. is_managed arrives as the Warehouse STRING "true"/"false".
  const aumPayload = [
    {
      custodian_account_id: FX.cust1,
      apex_account_number: FX.aum1,
      client_sf_id: FX.c1,
      household_sf_id: FX.hh1,
      account_type: "Roth IRA",
      is_managed: "true",
      account_status: "ACTIVE",
      account_aum: 100000,
      as_of: "2026-07-08T00:00:00.000Z",
    },
    {
      custodian_account_id: FX.cust2,
      apex_account_number: FX.aum2,
      client_sf_id: FX.c1,
      household_sf_id: FX.hh1,
      account_type: "Individual",
      is_managed: "false",
      account_status: "PENDING",
      account_aum: 0,
      as_of: "2026-07-08T00:00:00.000Z",
    },
  ];
  function mockWarehouse(rows: unknown[]) {
    const sourceRows = rows as Array<Record<string, unknown>>;
    const normalized: Array<Record<string, unknown>> = sourceRows.map((row) => {
      const id = String(row.custodian_account_id ?? "");
      const total = Number(row.account_aum ?? 0);
      return {
        ...row,
        account_status: row.account_status === "CLOSED" ? "CLOSED" : "OPEN",
        account_cash: 0,
        account_securities: total,
        balance_as_of: "2026-07-08",
        source_snapshot_as_of: "2026-07-08",
        balance_current: true,
        close_date: null,
        source_record_class: FIRM_ACCOUNT_IDS.has(id) ? "UNMAPPED_BALANCE" : "CLIENT",
      };
    });
    const present = new Set(normalized.map((row) => String(row.custodian_account_id)));
    for (const id of FIRM_ACCOUNT_IDS) {
      if (present.has(id)) continue;
      normalized.push({
        custodian_account_id: id, apex_account_number: null, client_sf_id: null,
        household_sf_id: null, account_type: null, is_managed: false,
        account_status: "OPEN", account_cash: 0, account_securities: 0,
        account_aum: 0, balance_as_of: "2026-07-08",
        source_snapshot_as_of: "2026-07-08", balance_current: true,
        close_date: null, source_record_class: "UNMAPPED_BALANCE",
      });
    }
    const openAccounts = normalized.filter((row) =>
      row.account_status === "OPEN" && !FIRM_ACCOUNT_IDS.has(String(row.custodian_account_id))).length;
    const closedAccounts = normalized.filter((row) => row.account_status === "CLOSED").length;
    for (const row of normalized) {
      Object.assign(row, {
        expected_snapshot_rows: normalized.length,
        expected_open_accounts: openAccounts,
        expected_closed_accounts: closedAccounts,
        expected_corporate_accounts: FIRM_ACCOUNT_IDS.size,
        expected_current_balance_rows: openAccounts + FIRM_ACCOUNT_IDS.size,
      });
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => normalized })),
    );
  }
  function aumReq(url = "https://x/api/cron/account-aum") {
    return new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  }
  const OPS = { role: "OPERATIONS", email: "ops@example.com" };
  // Two advisors for the own_book cross-book-leak case.
  const ADVISOR_A_EMAIL = "avery@example.com";
  const ADVISOR_B_EMAIL = "blair@example.com";
  const ADV_A = { role: "ADVISOR", email: ADVISOR_A_EMAIL };

  it("AUM0: native PostgreSQL advisory lock result is Prisma-deserializable", async () => {
    await ingest.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT pg_advisory_xact_lock(1095710769)::text AS locked`;
      expect(rows).toEqual([{ locked: "" }]);
    });
  });

  it("AUM0b: legacy non-current rows make the firm KPI unavailable, not $0", async () => {
    await cleanup.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email, status)
      VALUES (${FX.hh1}, 'Pending Snapshot Household', ${ADVISOR_A_EMAIL}, 'Active')`;
    await cleanup.$executeRaw`
      INSERT INTO mirror.client_account_aum
        (custodian_account_id, apex_account_number, client_sf_id, household_sf_id,
         account_status, account_aum, balance_current, source_present)
      VALUES
        (${FX.cust1}, ${FX.aum1}, ${FX.c1}, ${FX.hh1}, NULL, 999999, false, true)`;
    expect(await clientApexAumState(OPS, FX.c1)).toEqual({
      value: null, availability: "PENDING",
    });
    expect(await householdApexAumState(OPS, FX.hh1)).toEqual({
      value: null, availability: "PENDING",
    });
    expect(await firmWideAumSplit(OPS)).toEqual({
      total: null, firm: null, available: false,
    });
    expect(await getHousehold(OPS, FX.hh1)).toMatchObject({
      aum: null, aumSource: null, aumPending: true,
    });
  });

  it("AUM1: cron pull upserts client_account_aum; totals + list read back (incl $0)", async () => {
    mockWarehouse(aumPayload);
    const res = await accountAum.POST(aumReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toBe(6);
    expect(body.rejected).toEqual([]);
    expect(body.source).toBe("warehouse-card-6601");

    // DB: 2 rows, is_managed STRING coerced to real booleans.
    const rows = await cleanup.$queryRaw<
      Array<{ apex_account_number: string; is_managed: boolean; account_aum: unknown }>
    >`SELECT apex_account_number, is_managed, account_aum
      FROM mirror.client_account_aum WHERE client_sf_id = ${FX.c1} ORDER BY apex_account_number`;
    expect(rows).toHaveLength(2);
    expect(rows[0].is_managed).toBe(true);
    expect(rows[1].is_managed).toBe(false);

    // Read seam (RLS-scoped, OPERATIONS sees the firm). ALL accounts incl $0,
    // most-valuable first.
    const list = await apexAccountsForClient(OPS, FX.c1);
    expect(list.map((a) => a.apexAccountNumber)).toEqual([FX.aum1, FX.aum2]);
    expect(list[1].accountAum).toBe(0);
    expect(typeof list[0].accountAum).toBe("number"); // Decimal→Number at the seam

    // Totals = SUM over ALL accounts (managed + unmanaged) = 100000 + 0.
    expect(await clientApexAumTotal(OPS, FX.c1)).toBe(100000);
    expect(await householdApexAumTotal(OPS, FX.hh1)).toBe(100000);
  });

  it("AUM2: totals return null (not 0) when the client/household has no rows", async () => {
    expect(await clientApexAumTotal(OPS, "TEST-D2-NOBODY")).toBeNull();
    expect(await householdApexAumTotal(OPS, "TEST-D2-NOHH")).toBeNull();
    expect(await apexAccountsForClient(OPS, "TEST-D2-NOBODY")).toEqual([]);
  });

  it("AUM3: idempotent re-run — same rows, count stays 2, only synced_at moves", async () => {
    mockWarehouse(aumPayload);
    await accountAum.POST(aumReq());
    const after1 = await cleanup.$queryRaw<Array<{ synced_at: Date }>>`
      SELECT synced_at FROM mirror.client_account_aum WHERE apex_account_number = ${FX.aum1}`;
    mockWarehouse(aumPayload);
    await accountAum.POST(aumReq());
    const rows = await cleanup.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM mirror.client_account_aum WHERE client_sf_id = ${FX.c1}`;
    expect(Number(rows[0].n)).toBe(2);
    const after2 = await cleanup.$queryRaw<Array<{ synced_at: Date }>>`
      SELECT synced_at FROM mirror.client_account_aum WHERE apex_account_number = ${FX.aum1}`;
    expect(after2[0].synced_at.getTime()).toBeGreaterThanOrEqual(after1[0].synced_at.getTime());
  });

  it("AUM3b: overlapping imports serialize into one complete committed run", async () => {
    mockWarehouse(aumPayload);
    const [first, second] = await Promise.all([
      accountAum.POST(aumReq()),
      accountAum.POST(aumReq()),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const rows = await cleanup.$queryRaw<Array<{ n: bigint; runs: bigint }>>`
      SELECT count(*) AS n, count(DISTINCT snapshot_run_id) AS runs
      FROM mirror.client_account_aum
      WHERE source_present`;
    expect(Number(rows[0].n)).toBe(6);
    expect(Number(rows[0].runs)).toBe(1);
  });

  it("AUM4: dryRun writes nothing", async () => {
    mockWarehouse(aumPayload);
    const res = await accountAum.POST(aumReq("https://x/api/cron/account-aum?dryRun=1"));
    expect(res.status).toBe(200);
    expect((await res.json()).would_upsert).toBe(6);
    const rows = await cleanup.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM mirror.client_account_aum WHERE client_sf_id = ${FX.c1}`;
    expect(Number(rows[0].n)).toBe(0);
  });

  it("AUM5: own_book RLS — advisor A sees A's account, NOT advisor B's (cross-book leak)", async () => {
    // Highest-risk policy: client_account_aum_own_book (ADVISOR/CLIENT_SERVICE),
    // which rides through mirror.household's lead_advisor_email scoping. Seed TWO
    // households under DIFFERENT advisors, each with an AUM account, then read the
    // seam as advisor A and prove A cannot see B's book.
    //
    // Households are seeded DIRECTLY via the superuser cleanup client (not the
    // clients ingest endpoint): the own_book policy joins ONLY mirror.household,
    // so household rows carrying the right lead_advisor_email are the sole
    // precondition, and seeding them directly keeps the RLS assertion independent
    // of the clients-insert path. Cleaned up by cleanupFixtures (TEST-D2-%).
    await cleanup.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email, status)
      VALUES (${FX.hh1}, 'Book A Household', ${ADVISOR_A_EMAIL}, 'Active'),
             (${FX.hh2}, 'Book B Household', ${ADVISOR_B_EMAIL}, 'Active')`;

    // One AUM account per book: aum1 in book A (client c1 / hh1), aum2 in book B.
    mockWarehouse([
      {
        custodian_account_id: FX.cust1,
        apex_account_number: FX.aum1,
        client_sf_id: FX.c1,
        household_sf_id: FX.hh1,
        account_type: "Roth IRA",
        is_managed: "true",
        account_status: "ACTIVE",
        account_aum: 250000,
        as_of: "2026-07-08T00:00:00.000Z",
      },
      {
        custodian_account_id: FX.cust2,
        apex_account_number: FX.aum2,
        client_sf_id: FX.c2,
        household_sf_id: FX.hh2,
        account_type: "Individual",
        is_managed: "true",
        account_status: "ACTIVE",
        account_aum: 999000,
        as_of: "2026-07-08T00:00:00.000Z",
      },
    ]);
    const pull = await accountAum.POST(aumReq());
    expect(pull.status).toBe(200);
    expect((await pull.json()).upserted).toBe(6);

    // (a) Advisor A sees A's own account...
    const aOwn = await apexAccountsForClient(ADV_A, FX.c1);
    expect(aOwn.map((r) => r.apexAccountNumber)).toEqual([FX.aum1]);
    expect(await clientApexAumTotal(ADV_A, FX.c1)).toBe(250000);
    expect(await householdApexAumTotal(ADV_A, FX.hh1)).toBe(250000);

    // (b) ...but NOT advisor B's account (cross-book leak prevented): the list is
    // empty and the totals fall back to null, never leaking B's $999k.
    expect(await apexAccountsForClient(ADV_A, FX.c2)).toEqual([]);
    expect(await clientApexAumTotal(ADV_A, FX.c2)).toBeNull();
    expect(await householdApexAumTotal(ADV_A, FX.hh2)).toBeNull();

    // (c) The Performance report page's OWN per-account gate: apexAccountByNumber
    // returns A's own account by number, but returns null for B's account number
    // (out-of-book) — so an advisor deep-linking a foreign account gets null → 404.
    const aByNum = await apexAccountByNumber(ADV_A, FX.aum1);
    expect(aByNum).not.toBeNull();
    expect(aByNum?.apexAccountNumber).toBe(FX.aum1);
    expect(await apexAccountByNumber(ADV_A, FX.aum2)).toBeNull();
  });

  it("AUM6: households LIST resolves the Apex-first chain in bulk (+ advisor book scoping)", async () => {
    // tkt-households-aum-rollup: listHouseholds must give every row the SAME
    // Apex-first fallback chain the detail page resolves — with NO per-household
    // queries. Four fixture households, one per chain outcome:
    //   hh1 (advisor A): Apex rows AND a bigger deals person_aum → apex wins.
    //   hh2 (advisor B): no Apex; backfilled deals (repeat person_aum) → deals.
    //   hh3 (advisor B): no Apex; an un-backfilled deal (gate) → mirror.
    //   hh4 (advisor B): nothing anywhere → null aum, null source (em dash row).
    const HH3 = "TEST-D2-HH3";
    const HH4 = "TEST-D2-HH4";
    await cleanup.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email, status, stage, aum)
      VALUES (${FX.hh1}, 'Apex Household',   ${ADVISOR_A_EMAIL}, 'Active', 'Client', 111000),
             (${FX.hh2}, 'Deals Household',  ${ADVISOR_B_EMAIL}, 'Active', 'Client', 222000),
             (${HH3},    'Mirror Household', ${ADVISOR_B_EMAIL}, 'Active', 'Client', 333000),
             (${HH4},    'Unknown Household',${ADVISOR_B_EMAIL}, 'Active', 'Client', NULL)`;

    // Apex SOD rows for hh1 only, via the real cron pull (two accounts sum to 250k).
    mockWarehouse([
      {
        custodian_account_id: FX.cust1,
        apex_account_number: FX.aum1,
        client_sf_id: FX.c1,
        household_sf_id: FX.hh1,
        account_type: "Roth IRA",
        is_managed: "true",
        account_status: "ACTIVE",
        account_aum: 200000,
        as_of: "2026-07-08T00:00:00.000Z",
      },
      {
        custodian_account_id: FX.cust2,
        apex_account_number: FX.aum2,
        client_sf_id: FX.c1,
        household_sf_id: FX.hh1,
        account_type: "Individual",
        is_managed: "false",
        account_status: "ACTIVE",
        account_aum: 50000,
        as_of: "2026-07-08T00:00:00.000Z",
      },
    ]);
    const pull = await accountAum.POST(aumReq());
    expect(pull.status).toBe(200);
    expect((await pull.json()).upserted).toBe(6);

    // Deals, seeded directly (superuser client — the write path is not under
    // test; enum literals inline since a text bind won't coerce to app enums):
    //   DEAL1  hh1: person_aum 999999 — must LOSE to the 250k Apex total.
    //   DEAL2/3 hh2: same client twice, person_aum repeats → dedupes to 500000.
    //   DEAL4  hh3: client_sf_id NULL → completeness gate → mirror fallback.
    //   DEAL5  hh2: ARCHIVED with a huge person_aum → must be EXCLUDED.
    await cleanup.$executeRaw`
      INSERT INTO app.deal (id, source, name, client_first_name, client_last_name,
                            household_sf_id, client_sf_id, amount, stage,
                            created_date, person_aum, archived_at, updated_at)
      VALUES
        ('TEST-D2-DEAL1', 'IMPORT', 'd1', 'Ada',   'Chen', ${FX.hh1}, ${FX.c1},       0, 'POTENTIAL', CURRENT_DATE, 999999,  NULL,  now()),
        ('TEST-D2-DEAL2', 'IMPORT', 'd2', 'Grace', 'Hopper',   ${FX.hh2}, ${FX.c2},       0, 'POTENTIAL', CURRENT_DATE, 500000,  NULL,  now()),
        ('TEST-D2-DEAL3', 'IMPORT', 'd3', 'Grace', 'Hopper',   ${FX.hh2}, ${FX.c2},       0, 'COMMITTED', CURRENT_DATE, 500000,  NULL,  now()),
        ('TEST-D2-DEAL4', 'IMPORT', 'd4', 'No',    'Backfill', ${HH3},    NULL,           0, 'POTENTIAL', CURRENT_DATE, 750000,  NULL,  now()),
        ('TEST-D2-DEAL5', 'IMPORT', 'd5', 'Old',   'Archived', ${FX.hh2}, 'TEST-D2-C9',   0, 'LOST',      CURRENT_DATE, 8888888, now(), now())`;

    // OPS sees the firm: each fixture row carries its chain result + source.
    const opsList = await listHouseholds(OPS);
    const byId = new Map(opsList.map((h) => [h.sf_id, h]));
    expect(byId.get(FX.hh1)).toMatchObject({ aum: 250000, aum_source: "apex" });
    expect(byId.get(FX.hh2)).toMatchObject({ aum: 500000, aum_source: "deals" });
    expect(byId.get(HH3)).toMatchObject({ aum: 333000, aum_source: "mirror" });
    expect(byId.get(HH4)).toMatchObject({ aum: null, aum_source: null });
    // Seam coercion: plain numbers/nulls only (Decimal/BigInt never escape).
    expect(typeof byId.get(FX.hh1)?.aum).toBe("number");
    expect(typeof byId.get(FX.hh1)?.member_count).toBe("number");
    // Sort is on the EFFECTIVE aum (deals 500k > apex 250k > mirror 333k? no —
    // 500k > 333k > 250k), largest first, null last.
    const pos = (id: string) => opsList.findIndex((h) => h.sf_id === id);
    expect(pos(FX.hh2)).toBeLessThan(pos(HH3));
    expect(pos(HH3)).toBeLessThan(pos(FX.hh1));
    expect(pos(FX.hh1)).toBeLessThan(pos(HH4)); // null aum sinks below values

    // Advisor A's list is their book ONLY — hh1 present with the Apex-first
    // value; B's households never appear (RLS, not app filtering).
    const aList = await listHouseholds(ADV_A);
    const aIds = aList.map((h) => h.sf_id);
    expect(aIds).toContain(FX.hh1);
    expect(aIds).not.toContain(FX.hh2);
    expect(aIds).not.toContain(HH3);
    expect(aIds).not.toContain(HH4);
    expect(aList.find((h) => h.sf_id === FX.hh1)).toMatchObject({
      aum: 250000,
      aum_source: "apex",
    });
  });

  it("AUM7: firm attribution, Client-vs-Total KPI split, and firm-household RLS", async () => {
    // ticket: the feed attributes the firm ULID to the Cedar Ridge Wealth firm
    // household (overriding the card's NULL household); the KPI must split Client
    // (excludes firm) from Total (ties to Apex), and the firm household is
    // visible to OPS but never to an advisor.
    await cleanup.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email, status, stage, aum)
      VALUES (${FX.hh1}, 'Book A Household', ${ADVISOR_A_EMAIL}, 'Active', 'Client', NULL)`;

    // One client account ($25,248,316.42 — the household-mapped parity number),
    // the firm Fee Account ($87,604.38, card emits NULL household → overridden),
    // and one unlinked $0 account (no household, contributes $0). Total ties to
    // Apex = $25,335,920.80.
    mockWarehouse([
      {
        custodian_account_id: FX.cust1,
        apex_account_number: FX.aum1,
        client_sf_id: FX.c1,
        household_sf_id: FX.hh1,
        account_type: "Roth IRA",
        is_managed: "true",
        account_status: "ACTIVE",
        account_aum: 25_248_316.42,
        as_of: "2026-07-08T00:00:00.000Z",
      },
      {
        custodian_account_id: FX.firmCust, // a real firm ULID (Fee Account)
        apex_account_number: null, // corporate accounts have no Apex number
        client_sf_id: null,
        household_sf_id: null, // card emits NULL → feed overrides to the firm
        account_type: "Corporate",
        is_managed: "false",
        account_status: "OPEN",
        account_aum: 87_604.38,
        as_of: "2026-07-08T00:00:00.000Z",
      },
      {
        custodian_account_id: FX.cust2,
        apex_account_number: FX.aum2,
        client_sf_id: null,
        household_sf_id: null, // unlinked $0 account — belongs to no household
        account_type: "Individual",
        is_managed: "false",
        account_status: "OPEN",
        account_aum: 0,
        as_of: "2026-07-08T00:00:00.000Z",
      },
    ]);
    const pull = await accountAum.POST(aumReq());
    expect(pull.status).toBe(200);
    expect((await pull.json()).upserted).toBe(6);

    // Firm attribution persisted: the firm ULID landed under FIRM-CEDAR-RIDGE.
    const firmRows = await cleanup.$queryRaw<Array<{ household_sf_id: string | null }>>`
      SELECT household_sf_id FROM mirror.client_account_aum
      WHERE custodian_account_id = ${FX.firmCust}`;
    expect(firmRows[0]?.household_sf_id).toBe(FIRM_HOUSEHOLD_ID);

    // KPI split (OPS = firm-wide): Total ties to Apex; Client = Total − Firm.
    const opsSplit = await firmWideAumSplit(OPS);
    expect(opsSplit.available).toBe(true);
    const { total, firm, client } = splitAum(opsSplit.total!, opsSplit.firm!);
    expect(total).toBe(25_335_920.80); // ties to Apex's report
    expect(firm).toBe(87_604.38); // the 4 corporate (here: 1) accounts
    expect(client).toBe(25_248_316.42); // excludes the firm household

    // Firm household accounts (OPS): the firm ULID, read via the household seam.
    const firmAccts = await apexAccountsForHousehold(OPS, FIRM_HOUSEHOLD_ID);
    expect(firmAccts.map((a) => a.custodianAccountId).sort()).toEqual(
      [...FIRM_ACCOUNT_IDS].sort(),
    );
    expect(firmAccts.every((account) => account.apexAccountNumber == null)).toBe(true);

    // Firm household detail: visible to OPS, null (→404) for an advisor.
    const firmForOps = await getHousehold(OPS, FIRM_HOUSEHOLD_ID);
    expect(firmForOps?.name).toBe("Cedar Ridge Wealth");
    expect(firmForOps?.household_kind).toBe("FIRM");
    expect(firmForOps?.aum).toBe(87_604.38);
    expect(await getHousehold(ADV_A, FIRM_HOUSEHOLD_ID)).toBeNull();

    // Households list: OPS sees the firm household row; advisor A never does, and
    // the advisor's firm-wide split has firm = 0 (Total == Client for their book).
    const opsList = await listHouseholds(OPS);
    expect(opsList.some((h) => h.sf_id === FIRM_HOUSEHOLD_ID)).toBe(true);
    expect(opsList.find((h) => h.sf_id === FIRM_HOUSEHOLD_ID)?.aum).toBe(87_604.38);

    const aList = await listHouseholds(ADV_A);
    expect(aList.some((h) => h.sf_id === FIRM_HOUSEHOLD_ID)).toBe(false);
    const advSplit = await firmWideAumSplit(ADV_A);
    expect(advSplit.firm).toBe(0);
    expect(advSplit.available).toBe(true);
  });
});
