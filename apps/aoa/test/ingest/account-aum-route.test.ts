import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { execRawSpy, queryRawSpy, scopeSpy, freshnessSpy, writeAuditSpy, overrideSpy, latestSpy } = vi.hoisted(() => {
  const execRawSpy = vi.fn(async (..._args: unknown[]) => 1);
  const latestSpy = vi.fn(async () => null as string | null);
  const queryRawSpy = vi.fn(async (strings: TemplateStringsArray) =>
    strings.join("?").includes("max(source_snapshot_as_of)")
      ? [{ max_as_of: await latestSpy() }]
      : [{ locked: null }]);
  return {
    execRawSpy,
    queryRawSpy,
    scopeSpy: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $executeRaw: execRawSpy, $queryRaw: queryRawSpy })),
    freshnessSpy: vi.fn(),
    writeAuditSpy: vi.fn(async () => {}),
    overrideSpy: vi.fn(),
    latestSpy,
  };
});

vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: scopeSpy }));
vi.mock("@/lib/data/feed-health", () => ({ checkAumFreshness: freshnessSpy }));
vi.mock("@/lib/data/account-close-date-overrides", () => ({
  activeAccountCloseDateOverridesInTransaction: overrideSpy,
}));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditSpy };
});

import * as route from "../../app/api/cron/account-aum/route";
import { FIRM_ACCOUNT_IDS, FIRM_HOUSEHOLD_ID } from "@/lib/data/firm-household";

const TOKEN = "test-d2-secret-token";
const SNAPSHOT_DATE = "2026-08-21";
const CLOSED_ID = "01SYNTH91CNZDPTY5FVCZAQCB1";

function currentRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    custodian_account_id: id,
    apex_account_number: `APX-${id.slice(-4)}`,
    client_sf_id: "003AAA",
    household_sf_id: "001AAA",
    account_type: "Individual",
    is_managed: true,
    account_status: "OPEN",
    account_cash: 100.25,
    account_securities: 899.75,
    account_aum: 1000,
    balance_as_of: SNAPSHOT_DATE,
    source_snapshot_as_of: SNAPSHOT_DATE,
    balance_current: true,
    close_date: null,
    source_record_class: "CLIENT",
    expected_snapshot_rows: 6,
    expected_open_accounts: 1,
    expected_closed_accounts: 1,
    expected_corporate_accounts: 4,
    expected_current_balance_rows: 5,
    ...extra,
  };
}

function completePayload(): Array<Record<string, unknown>> {
  return [
    currentRow("01CLIENT000000000000000001"),
    {
      ...currentRow(CLOSED_ID), apex_account_number: "1G7AX6R", account_status: "CLOSED",
      account_cash: null, account_securities: null, account_aum: null,
      balance_as_of: null, balance_current: null,
    },
    ...[...FIRM_ACCOUNT_IDS].map((id) => currentRow(id, {
      apex_account_number: null, client_sf_id: null, household_sf_id: null,
      account_type: null, is_managed: false, source_record_class: "UNMAPPED_BALANCE",
    })),
  ];
}

function post(opts: { auth?: string; url?: string } = {}) {
  const headers = new Headers();
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/cron/account-aum", { method: "POST", headers });
}

function mockFetch(body: unknown, ok = true, status = 200) {
  global.fetch = vi.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
}

describe("POST /api/cron/account-aum", () => {
  const originalToken = process.env.INGEST_TOKEN;
  const originalUrl = process.env.WAREHOUSE_URL;
  const originalKey = process.env.WAREHOUSE_API_KEY;

  beforeEach(() => {
    process.env.INGEST_TOKEN = TOKEN;
    process.env.WAREHOUSE_URL = "https://warehouse.example.test";
    process.env.WAREHOUSE_API_KEY = "mb-key";
    execRawSpy.mockClear(); queryRawSpy.mockClear(); scopeSpy.mockClear();
    freshnessSpy.mockReset(); writeAuditSpy.mockClear(); latestSpy.mockReset().mockResolvedValue(null);
    overrideSpy.mockReset().mockResolvedValue([{
      custodianAccountId: CLOSED_ID, provisionalCloseDate: "2026-04-14",
      reason: "90 days after close request", sourceReference: "approved operations exception",
    }]);
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined) =>
      value === undefined ? delete process.env[key] : (process.env[key] = value);
    restore("INGEST_TOKEN", originalToken); restore("WAREHOUSE_URL", originalUrl);
    restore("WAREHOUSE_API_KEY", originalKey); vi.restoreAllMocks();
  });

  it("rejects missing or incorrect authentication before fetching", async () => {
    mockFetch(completePayload());
    expect((await route.POST(post({ auth: undefined }))).status).toBe(401);
    expect((await route.POST(post({ auth: "Bearer wrong" }))).status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns the explicit 405 contract for other verbs", async () => {
    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const response = verb();
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("atomically upserts a complete snapshot, retires omissions, and audits provenance", async () => {
    mockFetch(completePayload());
    const response = await route.POST(post());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      upserted: 6, open_accounts: 1, closed_accounts: 1, corporate_accounts: 4,
      provisional_close_dates: 1, as_of_max: "2026-08-21T00:00:00.000Z",
    });
    expect(scopeSpy).toHaveBeenCalledTimes(1);
    expect(queryRawSpy.mock.calls[0][0].join("?")).toContain("pg_advisory_xact_lock");
    expect(queryRawSpy.mock.calls[0][0].join("?")).toContain("::text");
    expect(queryRawSpy.mock.invocationCallOrder[0]).toBeLessThan(overrideSpy.mock.invocationCallOrder[0]);
    expect(execRawSpy).toHaveBeenCalledTimes(7);
    const closedCall = execRawSpy.mock.calls[1] as unknown[];
    expect(closedCall).toContain("PROVISIONAL_OVERRIDE");
    expect((execRawSpy.mock.calls[2] as unknown[])).toContain(FIRM_HOUSEHOLD_ID);
    const [, , audit] = writeAuditSpy.mock.calls[0] as unknown[] as [unknown, unknown, { detail: Record<string, unknown> }];
    expect(audit.detail).toMatchObject({ received: 6, upserted: 6, retired: 1, provisional_close_dates: 1 });
  });

  it("commits when a newly closed account retains its final current zero-dollar balance", async () => {
    const payload = completePayload();
    payload[1] = {
      ...payload[1],
      account_cash: 0,
      account_securities: 0,
      account_aum: 0,
      balance_as_of: SNAPSHOT_DATE,
      balance_current: true,
      close_date: "2026-08-22",
    };
    for (const row of payload) row.expected_current_balance_rows = 6;
    mockFetch(payload);

    const response = await route.POST(post());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      upserted: 6,
      open_accounts: 1,
      closed_accounts: 1,
      corporate_accounts: 4,
    });
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
  });

  it("fails the whole snapshot before any write when one balance does not reconcile", async () => {
    const payload = completePayload(); payload[0] = { ...payload[0], account_aum: 1000.02 };
    mockFetch(payload);
    const response = await route.POST(post());
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("snapshot_validation_failed");
    expect(body.rejected).toEqual(expect.arrayContaining([
      { index: 0, reason: "balance_does_not_reconcile" },
    ]));
    expect(scopeSpy).toHaveBeenCalledTimes(1);
    expect(execRawSpy).not.toHaveBeenCalled();
  });

  it("rejects a transport-truncated snapshot using source-published cardinality", async () => {
    mockFetch(completePayload().slice(0, -1));
    const response = await route.POST(post());
    expect(response.status).toBe(422);
    expect((await response.json()).rejected).toEqual(expect.arrayContaining([
      { index: -1, reason: "snapshot_row_count_mismatch" },
    ]));
    expect(execRawSpy).not.toHaveBeenCalled();
  });

  it("dry run validates and reports but performs no mirror write", async () => {
    mockFetch(completePayload());
    const response = await route.POST(post({ url: "https://x/api/cron/account-aum?dryRun=1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ would_upsert: 6, provisional_close_dates: 1 });
    expect(scopeSpy).toHaveBeenCalledTimes(1);
    expect(execRawSpy).not.toHaveBeenCalled();
  });

  it("rejects an older source date after acquiring the transaction lock", async () => {
    latestSpy.mockResolvedValue("2026-08-22");
    mockFetch(completePayload());
    const response = await route.POST(post());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "snapshot_out_of_order", committed_as_of: "2026-08-22",
    });
    expect(execRawSpy).not.toHaveBeenCalled();
  });

  it("permanently retires the fallback when an authoritative Apex date commits", async () => {
    const payload = completePayload();
    payload[1] = { ...payload[1], close_date: "2026-05-02" };
    mockFetch(payload);
    const response = await route.POST(post());
    expect(response.status).toBe(200);
    const retirement = execRawSpy.mock.calls.find((call) =>
      (call[0] as TemplateStringsArray).join("?").includes("account_close_date_override"));
    expect(retirement).toBeDefined();
    expect(retirement as unknown[]).toContain(CLOSED_ID);
    const [, , audit] = writeAuditSpy.mock.calls[0] as unknown[] as [unknown, unknown, { detail: Record<string, unknown> }];
    expect(audit.detail.retired_close_date_overrides).toBe(1);
  });

  it("onlyIfStale skips when the current snapshot is healthy", async () => {
    freshnessSpy.mockResolvedValue({
      ok: true, reason: "ok", expectedMinAsOf: SNAPSHOT_DATE, maxAsOf: SNAPSHOT_DATE,
      maxSyncedAt: new Date(), staleByTradingDays: 0, rowCount: 455, syncAgeHours: 1,
    });
    mockFetch(completePayload());
    const response = await route.POST(post({ url: "https://x/api/cron/account-aum?onlyIfStale=1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ skipped: true, reason: "already_fresh" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("maps Warehouse failures and malformed bodies without writing", async () => {
    mockFetch({}, false, 503); expect((await route.POST(post())).status).toBe(502);
    mockFetch({ bad: true }); expect((await route.POST(post())).status).toBe(502);
    expect(scopeSpy).not.toHaveBeenCalled();
  });
});
