import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "../../app/api/ingest/schwab-account-balances/route";
import * as scope from "../../lib/ingest/scope";
import { schwabAccountId } from "@/lib/ingest/schwab-account-balance";

const TOKEN = "test-schwab-ingest-token";
const CLIENT = "003288867315530AAA";
const HOUSEHOLD = "001288867315530AAA";

function item(over: Record<string, unknown> = {}) {
  return {
    account_number: "00012345678",
    account_name: "Daniel Chen",
    registration_type: "IN",
    account_type: "INDIVIDUAL",
    account_cash: 250,
    account_securities: 750,
    account_aum: 1000,
    balance_as_of: "2026-09-15",
    authoritative_client_sf_id: null,
    authoritative_household_sf_id: null,
    authoritative_match_source: null,
    ...over,
  };
}

function payload(items: unknown[] = [item()], over: Record<string, unknown> = {}) {
  return {
    source: "schwab-s3",
    run_id: "RUN-SCHWAB-ROUTE-1",
    as_of_date: "2026-09-15",
    source_key: "schwab/master=synthetic/year=2026/month=09/day=15/CRS20260915.RPS",
    source_etag: "synthetic-etag",
    source_sha256: "b".repeat(64),
    expected_account_count: items.length,
    items,
    ...over,
  };
}

function post(body: unknown, options: { auth?: string; url?: string } = {}) {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: options.auth ?? `Bearer ${TOKEN}`,
  });
  return new Request(options.url ?? "https://ops-portal.test/api/ingest/schwab-account-balances", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function stubScope(committedAsOf: string | null = null, mappings: unknown[] = [], active = true) {
  const query = vi.fn()
    .mockResolvedValueOnce([{ locked: "" }])
    .mockResolvedValueOnce([{ max_as_of: committedAsOf }])
    .mockResolvedValueOnce(mappings)
    .mockResolvedValueOnce([{
      sf_id: CLIENT,
      household_sf_id: HOUSEHOLD,
      name: "Daniel Chen",
      name_eligible: active,
    }])
    .mockResolvedValueOnce([{ sf_id: HOUSEHOLD, name: "Chen Household", name_eligible: active }]);
  const execute = vi.fn(async () => 1);
  const create = vi.fn(async (_args: unknown) => undefined);
  vi.spyOn(scope, "withIngestScope").mockImplementation(async (fn) => fn({
    $queryRaw: query,
    $executeRaw: execute,
    auditLog: { create },
  } as never));
  return { query, execute, create };
}

describe("POST /api/ingest/schwab-account-balances", () => {
  const original = process.env.INGEST_TOKEN;

  beforeEach(() => {
    process.env.INGEST_TOKEN = TOKEN;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = original;
  });

  it("fails closed and returns the shared non-POST posture", async () => {
    expect((await route.POST(post(payload(), { auth: "Bearer wrong" }))).status).toBe(401);
    for (const method of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const response = method();
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("dry-runs exact name matching without writing balance rows", async () => {
    const { execute, create } = stubScope();
    const response = await route.POST(post(payload(), {
      url: "https://ops-portal.test/api/ingest/schwab-account-balances?dryRun=1",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      would_upsert: 1,
      rejected: [],
      run_id: "RUN-SCHWAB-ROUTE-1",
      as_of_date: "2026-09-15",
      match_summary: {
        authoritative: 0,
        operations_reviewed: 0,
        firm_operating: 0,
        exact_client_name: 1,
        exact_household_name: 0,
        ambiguous: 0,
        unmatched: 0,
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    const audit = JSON.stringify(create.mock.calls[0]?.[0] ?? {});
    expect(audit).not.toContain("Daniel Chen");
    expect(audit).not.toContain("12345678");
    expect(audit).not.toContain(CLIENT);
  });

  it("commits an authoritative account-number match and retires only another Schwab fingerprint", async () => {
    const { execute, create } = stubScope("2026-09-15");
    const response = await route.POST(post(payload([item({
      authoritative_client_sf_id: CLIENT,
      authoritative_household_sf_id: HOUSEHOLD,
      authoritative_match_source: "CRM_ACCOUNT_NUMBER",
    })])));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      upserted: 1,
      retired: 1,
      match_summary: { authoritative: 1 },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects an incomplete financial snapshot before opening a transaction", async () => {
    const scopeSpy = vi.spyOn(scope, "withIngestScope");
    const response = await route.POST(post(payload([item()], { expected_account_count: 2 })));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "snapshot_incomplete", rejected: [] });
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("dry-runs a server-reviewed lost-stage mapping without snapshot writes", async () => {
    const { execute, create } = stubScope(null, [{
      accountId: schwabAccountId("12345678"), accountNumberLast4: "5678",
      clientSfId: CLIENT, householdSfId: HOUSEHOLD, accountScope: "CLIENT", version: 2,
    }], false);
    const response = await route.POST(post(payload(), { url: "https://ops-portal.test/api/ingest/schwab-account-balances?dryRun=1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ would_upsert: 1, match_summary: { authoritative: 0, operations_reviewed: 1 } });
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(create.mock.calls)).not.toContain(CLIENT);
  });

  it("stores firm operating classification without a client link", async () => {
    const { execute } = stubScope(null, [{
      accountId: schwabAccountId("12345678"), accountNumberLast4: "5678",
      clientSfId: null, householdSfId: null, accountScope: "FIRM_OPERATING", version: 1,
    }]);
    const response = await route.POST(post(payload()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ match_summary: { operations_reviewed: 1, firm_operating: 1 } });
    const insert = execute.mock.calls[0] as unknown[];
    expect(insert).toContain("FIRM_OPERATING");
    expect(insert).toContain("OPERATIONS_REVIEWED");
    expect(insert).not.toContain(CLIENT);
    expect(insert).not.toContain(HOUSEHOLD);
  });

  it("does not let a conflicting payload overwrite a reviewed mapping", async () => {
    const { execute } = stubScope(null, [{
      accountId: schwabAccountId("12345678"), accountNumberLast4: "5678",
      clientSfId: null, householdSfId: null, accountScope: "FIRM_OPERATING", version: 1,
    }]);
    const response = await route.POST(post(payload([item({ authoritative_client_sf_id: CLIENT,
      authoritative_household_sf_id: HOUSEHOLD, authoritative_match_source: "CRM_ACCOUNT_NUMBER" })])));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ rejected: [{ index: 0, reason: "reviewed_mapping_conflict" }] });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an older snapshot without writes", async () => {
    const { execute } = stubScope("2026-09-16");
    const response = await route.POST(post(payload()));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "snapshot_out_of_order",
      run_id: "RUN-SCHWAB-ROUTE-1",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns reason codes without echoing source names or account numbers", async () => {
    const secretName = "Sensitive Client Name";
    const response = await route.POST(post(payload([item({
      account_name: secretName,
      account_aum: 999,
    })])));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.rejected).toEqual([{ index: 0, reason: "balance_not_reconciled" }]);
    expect(JSON.stringify(body)).not.toContain(secretName);
    expect(JSON.stringify(body)).not.toContain("12345678");
  });

  it("logs a fixed transaction failure event without request-derived values", async () => {
    const secretRunId = "SECRET-RUN-ID\nFORGED-LOG-LINE";
    vi.spyOn(scope, "withIngestScope").mockRejectedValue(new Error("database unavailable"));
    const response = await route.POST(post(payload(undefined, { run_id: secretRunId })));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(console.error).toHaveBeenCalledWith("[ingest] schwab-account-balances tx_failed");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secretRunId);
  });
});
