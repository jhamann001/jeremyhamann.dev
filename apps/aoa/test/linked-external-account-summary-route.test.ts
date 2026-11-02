import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { execRawSpy, scopeSpy, writeAuditSpy, queryWarehouseCard } = vi.hoisted(() => {
  const execRawSpy = vi.fn(async () => 1);
  return {
    execRawSpy,
    scopeSpy: vi.fn(async (fn: (tx: { $executeRaw: typeof execRawSpy }) => Promise<unknown>) =>
      fn({ $executeRaw: execRawSpy })),
    writeAuditSpy: vi.fn(async (..._args: unknown[]) => {}),
    queryWarehouseCard: vi.fn(),
  };
});

vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: scopeSpy }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditSpy };
});
vi.mock("@/lib/warehouse/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/warehouse/client")>();
  return { ...actual, queryWarehouseCard };
});

import * as route from "../app/api/cron/linked-external-account-summary/route";
import { RUNTIME_WAREHOUSE_CARD_IDS } from "@/lib/warehouse/client";

const TOKEN = "test-plaid-summary-token";

function post(opts: { auth?: string; url?: string } = {}) {
  const headers = new Headers();
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/cron/linked-external-account-summary", {
    method: "POST",
    headers,
  });
}

const goodRow = {
  external_account_id: "ext-1",
  client_sf_id: "TPLAIDCLA000001",
  household_sf_id: "TPLAIDHHA000001",
  institution_name: "Bank A",
  account_subtype: "brokerage",
  mask: "2222",
  cash_amount: 1,
  securities_amount: 2,
  holdings_total: 3,
  institution_balance: 3,
  as_of: "2026-01-15T00:00:00.000Z",
  link_status: "ACTIVE",
  lineage_key: "lineage-1",
  prior_external_account_id: null,
};

describe("POST /api/cron/linked-external-account-summary", () => {
  const originalToken = process.env.INGEST_TOKEN;

  beforeEach(() => {
    process.env.INGEST_TOKEN = TOKEN;
    execRawSpy.mockClear();
    scopeSpy.mockClear();
    writeAuditSpy.mockClear();
    queryWarehouseCard.mockReset();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = originalToken;
  });

  it("rejects missing authentication before querying Warehouse", async () => {
    queryWarehouseCard.mockResolvedValue([goodRow]);
    expect((await route.POST(post({ auth: undefined }))).status).toBe(401);
    expect(queryWarehouseCard).not.toHaveBeenCalled();
  });

  it("returns 405 for other verbs", async () => {
    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const response = verb();
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("dryRun validates and does not open an ingest transaction", async () => {
    queryWarehouseCard.mockResolvedValue([goodRow]);
    const response = await route.POST(post({
      url: "https://x/api/cron/linked-external-account-summary?dryRun=1",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dry_run: true, received: 1, skipped: 0 });
    expect(RUNTIME_WAREHOUSE_CARD_IDS).toContain(6898);
    expect(queryWarehouseCard).toHaveBeenCalledWith(
      6898,
      [],
      "cron:linked-external-account-summary",
      expect.any(Function),
    );
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("writes the audit row inside withIngestScope with the 3-arg signature", async () => {
    queryWarehouseCard.mockResolvedValue([goodRow]);
    const response = await route.POST(post());
    expect(response.status).toBe(200);
    expect(scopeSpy).toHaveBeenCalledTimes(1);
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    const [tx, identity, entry] = writeAuditSpy.mock.calls[0];
    expect(tx).toEqual({ $executeRaw: execRawSpy });
    expect(identity).toEqual({ role: "INGEST", email: null });
    expect(entry).toMatchObject({
      action: "ingest.linked_external_account_summary",
      entityType: "ingest_run",
      detail: { received: 1, upserted: 1, dry_run: false },
    });
  });

  it("skips depository links without investment data instead of failing the snapshot", async () => {
    queryWarehouseCard.mockResolvedValue([
      goodRow,
      {
        ...goodRow,
        external_account_id: "ext-2",
        account_subtype: "checking",
        cash_amount: null,
        securities_amount: null,
        holdings_total: null,
        institution_balance: null,
        as_of: null,
      },
    ]);
    const response = await route.POST(post());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: 1, upserted: 1, skipped: 1 });
    const [, , entry] = writeAuditSpy.mock.calls[0];
    expect(entry).toMatchObject({ detail: { received: 1, upserted: 1, skipped: 1, dry_run: false } });
  });
});
