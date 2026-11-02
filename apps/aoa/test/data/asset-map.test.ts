import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// lib/data/asset-map imports "server-only" (throws outside an RSC bundle) — stub
// it so the module loads under the vitest node env (the acat-status idiom).
vi.mock("server-only", () => ({}));

// Mock the keyless OIDC layer (the acat-status.test.ts idiom) for the fetch cases.
const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import {
  AOA_RUNTIME_SERVICE_ACCOUNTS,
  AssetMapError,
  accountTypeOverride,
  assetMapBaseUrl,
  fetchHouseholdsPage,
  flattenHouseholds,
  readAssetMapHousehold,
} from "@/lib/data/asset-map";

const BASE = "https://pipeline.example.test";

describe("assetMapBaseUrl", () => {
  const original = process.env.STATEMENT_PIPELINE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.STATEMENT_PIPELINE_URL;
    else process.env.STATEMENT_PIPELINE_URL = original;
  });

  it("returns null when unset or empty", () => {
    delete process.env.STATEMENT_PIPELINE_URL;
    expect(assetMapBaseUrl()).toBeNull();
    process.env.STATEMENT_PIPELINE_URL = "   ";
    expect(assetMapBaseUrl()).toBeNull();
  });

  it("strips a trailing slash (audience must match byte-for-byte)", () => {
    process.env.STATEMENT_PIPELINE_URL = "https://p.example.test/";
    expect(assetMapBaseUrl()).toBe("https://p.example.test");
    process.env.STATEMENT_PIPELINE_URL = "https://p.example.test///";
    expect(assetMapBaseUrl()).toBe("https://p.example.test");
  });
});

describe("flattenHouseholds — mapping + coercion", () => {
  it("flattens household → accounts → positions and coerces scalar types", () => {
    const flat = flattenHouseholds([
      {
        id: "h1",
        client_name: "Willie & John",
        run_number: "7", // string → int
        total_value: "1234.56", // string → number
        total_accounts: 1,
        acat_count: 2,
        review_count: 1,
        superseded_by: null,
        accounts: [
          {
            id: "a1",
            household_id: "h1",
            account_number: "XCRUGSLC-100",
            is_stale: "true", // string → bool
            statement_age_days: "3",
            custodian_intel: { dtcc_number: "0226", contact: "x" },
            validation_issues: ["late"],
            assets: [
              {
                id: "p1",
                account_id: "a1",
                symbol: "AAPL",
                quantity: "10.5",
                market_value: "2100",
                effective_status: "ACAT",
                lots: [{ qty: 5 }],
                notion_check: { ok: true },
              },
            ],
          },
        ],
      },
    ]);

    expect(flat.households).toHaveLength(1);
    expect(flat.accounts).toHaveLength(1);
    expect(flat.positions).toHaveLength(1);
    expect(flat.rejected).toEqual([]);

    const h = flat.households[0];
    expect(h.id).toBe("h1");
    expect(h.run_number).toBe(7);
    expect(h.total_value).toBe(1234.56);
    // status_tallies collapses the count fields into one JSON bag.
    expect(JSON.parse(h.status_tallies!)).toEqual({ acat_count: 2, review_count: 1 });

    const a = flat.accounts[0];
    expect(a.household_id).toBe("h1");
    expect(a.account_number).toBe("XCRUGSLC-100");
    expect(a.is_stale).toBe(true);
    expect(a.statement_age_days).toBe(3);
    // nested bags are serialized to JSON strings for the ::jsonb bind.
    expect(JSON.parse(a.custodian_intel!)).toEqual({ dtcc_number: "0226", contact: "x" });
    expect(JSON.parse(a.validation_issues!)).toEqual(["late"]);

    const p = flat.positions[0];
    expect(p.account_id).toBe("a1");
    expect(p.quantity).toBe(10.5);
    expect(p.market_value).toBe(2100);
    expect(p.effective_status).toBe("ACAT");
    expect(JSON.parse(p.lots!)).toEqual([{ qty: 5 }]);
    expect(JSON.parse(p.notion_check!)).toEqual({ ok: true });
  });

  it("carries superseded_by verbatim and null status_tallies when no counts", () => {
    const flat = flattenHouseholds([{ id: "h2", superseded_by: "h9", accounts: [] }]);
    expect(flat.households[0].superseded_by).toBe("h9");
    expect(flat.households[0].status_tallies).toBeNull();
  });

  it("unknown/absent numeric → null (never 0); missing jsonb bag → null", () => {
    const flat = flattenHouseholds([
      {
        id: "h3",
        total_value: "not-a-number",
        accounts: [
          { id: "a3", cash_balance: null, assets: [{ id: "p3", quantity: "", lots: undefined }] },
        ],
      },
    ]);
    expect(flat.households[0].total_value).toBeNull();
    expect(flat.accounts[0].cash_balance).toBeNull();
    expect(flat.accounts[0].custodian_intel).toBeNull();
    expect(flat.positions[0].quantity).toBeNull();
    expect(flat.positions[0].lots).toBeNull();
  });

  it("rejects rows missing their own id without aborting the batch", () => {
    const flat = flattenHouseholds([
      { client_name: "no id" },
      {
        id: "hOK",
        accounts: [
          { assets: [] }, // account missing id
          { id: "aOK", assets: [{ symbol: "X" }, { id: "pOK", account_id: "aOK" }] },
        ],
      },
    ]);
    expect(flat.households.map((h) => h.id)).toEqual(["hOK"]);
    expect(flat.accounts.map((a) => a.id)).toEqual(["aOK"]);
    expect(flat.positions.map((p) => p.id)).toEqual(["pOK"]);
    expect(flat.rejected).toEqual([
      { level: "household", index: "h0", reason: "id_missing" },
      { level: "account", index: "hOK:a0", reason: "id_missing" },
      { level: "position", index: "aOK:p0", reason: "id_missing" },
    ]);
  });

  it("defaults account_id to the parent account when a position omits it", () => {
    const flat = flattenHouseholds([
      { id: "h", accounts: [{ id: "aP", assets: [{ id: "pNoAcct" }] }] },
    ]);
    expect(flat.positions[0].account_id).toBe("aP");
  });

  it("maps the pipeline's inherited_note into the inherited note (ticket)", () => {
    const flat = flattenHouseholds([
      {
        id: "h1",
        accounts: [
          { id: "a1", is_inherited: true, inherited_note: "Synthetic beneficiary note" },
          { id: "a2", is_inherited: true, inherited_notes: "x" },
        ],
      },
    ]);
    expect(flat.accounts[0].inherited_notes).toBe("Synthetic beneficiary note");
    expect(flat.accounts[1].inherited_notes).toBeNull();
  });
});

describe("fetchHouseholdsPage — OIDC read + status handling", () => {
  beforeEach(() => {
    requestMock.mockReset();
    getIdTokenClientMock.mockClear();
  });

  it("200 → typed page; audience == base URL; query carries include_superseded=true", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      data: { page: 1, per_page: 200, total: 1, households: [{ id: "h1" }] },
    });
    const pg = await fetchHouseholdsPage(BASE, 1, 200);
    expect(pg.total).toBe(1);
    expect(pg.households).toHaveLength(1);
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);
    const opts = requestMock.mock.calls[0][0] as { url: string; method: string };
    expect(opts.method).toBe("GET");
    // All-versions pull (self-healing liveness): superseded rows are re-emitted so
    // the upsert-by-id demotes the mirror's stale ghosts.
    expect(opts.url).toBe(`${BASE}/api/v1/households?page=1&per_page=200&include_superseded=true`);
  });

  it("200 with an off-shape body → households coerced to [] (never crashes)", async () => {
    requestMock.mockResolvedValue({ status: 200, data: { households: "nope" } });
    const pg = await fetchHouseholdsPage(BASE, 3, 50);
    expect(pg.households).toEqual([]);
    expect(pg.page).toBe(3); // falls back to the requested page
    expect(pg.per_page).toBe(50);
    expect(pg.total).toBe(0);
  });

  it("exposes the envelope strictly (ticket) while the base fields keep their fallbacks", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      data: { page: 2, per_page: 200, total: 401, households: [{ id: "h1" }] },
    });
    expect((await fetchHouseholdsPage(BASE, 2, 200)).envelope).toEqual({
      page: 2, per_page: 200, total: 401, households_is_array: true,
    });

    requestMock.mockResolvedValue({ status: 200, data: { page: "2", per_page: 1.5, total: -1, households: {} } });
    const odd = await fetchHouseholdsPage(BASE, 2, 200);
    expect(odd.envelope).toEqual({ page: null, per_page: null, total: null, households_is_array: false });
    expect(odd.page).toBe(2); // base import still coerces/falls back exactly as before
    expect(odd.per_page).toBe(1);
    expect(odd.total).toBe(-1);

    requestMock.mockResolvedValue({ status: 200, data: [] });
    expect((await fetchHouseholdsPage(BASE, 1, 200)).envelope).toEqual({
      page: null, per_page: null, total: null, households_is_array: false,
    });
  });

  it("preserves each household's client_link object verbatim for the identity census", async () => {
    const link = { schema_version: 1, availability: "unavailable", reason: "client_linking_disabled" };
    requestMock.mockResolvedValue({
      status: 200,
      data: { page: 1, per_page: 200, total: 1, households: [{ id: "h1", client_link: link }] },
    });
    const pg = await fetchHouseholdsPage(BASE, 1, 200);
    expect(pg.households[0].client_link).toEqual(link);
  });

  it("401/403 → AssetMapError(unauthorized)", async () => {
    requestMock.mockResolvedValue({ status: 401, data: {} });
    await expect(fetchHouseholdsPage(BASE, 1, 200)).rejects.toMatchObject({
      reason: "unauthorized",
    });
  });

  it("5xx → AssetMapError(pipeline_error)", async () => {
    requestMock.mockResolvedValue({ status: 503, data: {} });
    await expect(fetchHouseholdsPage(BASE, 1, 200)).rejects.toBeInstanceOf(AssetMapError);
  });

  it("transport throw → AssetMapError(transport_error)", async () => {
    requestMock.mockRejectedValue(new Error("network"));
    await expect(fetchHouseholdsPage(BASE, 1, 200)).rejects.toMatchObject({
      reason: "transport_error",
    });
  });
});

describe("manual account-type badge (ticket)", () => {
  const AT = new Date("2026-10-06T14:05:00.000Z");
  let originalAppEnv: string | undefined;
  beforeEach(() => {
    originalAppEnv = process.env.APP_ENV;
  });
  afterEach(() => {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  });

  it("the import maps the pipeline's account-type override person and time (ticket)", () => {
    const { accounts } = flattenHouseholds([
      {
        id: "h1",
        accounts: [
          { id: "a1", account_type_overridden_by: "ops.person@example.invalid", account_type_overridden_at: "2026-10-06T14:05:00+00:00" },
          { id: "a2" },
        ],
      },
    ]);
    const a1 = accounts.find((a) => a.id === "a1")!;
    const a2 = accounts.find((a) => a.id === "a2")!;
    expect(a1.account_type_overridden_by).toBe("ops.person@example.invalid");
    expect(a1.account_type_overridden_at?.toISOString()).toBe("2026-10-06T14:05:00.000Z");
    expect(a2.account_type_overridden_by).toBeNull();
    expect(a2.account_type_overridden_at).toBeNull();
  });

  it("a pipeline person is named directly, and no override time means no badge (ticket)", () => {
    expect(accountTypeOverride("ops.person@example.invalid", new Date("2026-10-06T14:05:00Z"), null)).toEqual({
      by: "ops.person@example.invalid",
      at: "2026-10-06T14:05:00.000Z",
    });
    expect(accountTypeOverride("ops.person@example.invalid", null, null)).toBeNull();
    expect(accountTypeOverride(null, null, "x@example.invalid")).toBeNull();
  });

  it("only this environment's AoA service account is credited to the audit row's person (ticket)", () => {
    const who = (sa: string) => accountTypeOverride(sa, AT, "saver@example.invalid")?.by;
    process.env.APP_ENV = "prod";
    expect(who(AOA_RUNTIME_SERVICE_ACCOUNTS.prod)).toBe("saver@example.invalid");
    expect(who("  AOA-RUN@ops-portal.IAM.GSERVICEACCOUNT.COM ")).toBe("saver@example.invalid");
    expect(who(AOA_RUNTIME_SERVICE_ACCOUNTS.dev)).toBe(AOA_RUNTIME_SERVICE_ACCOUNTS.dev);
    process.env.APP_ENV = "dev";
    expect(who(AOA_RUNTIME_SERVICE_ACCOUNTS.dev)).toBe("saver@example.invalid");
    expect(who(AOA_RUNTIME_SERVICE_ACCOUNTS.prod)).toBe(AOA_RUNTIME_SERVICE_ACCOUNTS.prod);
    delete process.env.APP_ENV;
    expect(who(AOA_RUNTIME_SERVICE_ACCOUNTS.prod)).toBe(AOA_RUNTIME_SERVICE_ACCOUNTS.prod);
  });

  it("AoA's service account with no audit row names no AoA person (ticket)", () => {
    process.env.APP_ENV = "prod";
    expect(accountTypeOverride(AOA_RUNTIME_SERVICE_ACCOUNTS.prod, AT, null)).toEqual({
      by: null,
      at: "2026-10-06T14:05:00.000Z",
    });
  });

  it("a later pipeline edit is credited to the pipeline person, not an earlier AoA editor (ticket)", () => {
    expect(accountTypeOverride("pipeline.person@example.invalid", AT, "earlier.aoa@example.invalid")?.by).toBe(
      "pipeline.person@example.invalid",
    );
  });

  it("the household read joins the latest account-type audit row for that account and maps the badge (ticket)", async () => {
    process.env.APP_ENV = "dev";
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: "hh-1", client_name: null, processed_at: null, status_tallies: null }])
      .mockResolvedValueOnce([
        {
          id: "a1", validation_issues: null, custodian_intel: null,
          account_type_overridden_by: AOA_RUNTIME_SERVICE_ACCOUNTS.dev, account_type_overridden_at: AT,
          account_type_audit_actor: "saver@example.invalid",
        },
        {
          id: "a2", validation_issues: null, custodian_intel: null,
          account_type_overridden_by: null, account_type_overridden_at: null, account_type_audit_actor: null,
        },
      ])
      .mockResolvedValueOnce([]);
    const view = await readAssetMapHousehold({ $queryRaw: queryRaw } as never, "hh-1");

    const [strings, ...binds] = queryRaw.mock.calls[1] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?").replace(/\s+/g, " ");
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(sql).toContain('audit."AuditLog"');
    expect(sql).toContain('"entityId" = acc.id');
    expect(sql).toContain("ORDER BY at DESC, id DESC LIMIT 1");
    expect(sql).toContain("account_type_overridden_by, account_type_overridden_at");
    expect(binds).toContain("asset_map_edit.account_type");
    expect(binds).toContain("asset_map_account");
    expect(view?.accounts.map((a) => a.accountTypeOverride)).toEqual([
      { by: "saver@example.invalid", at: "2026-10-06T14:05:00.000Z" },
      null,
    ]);
  });
});
