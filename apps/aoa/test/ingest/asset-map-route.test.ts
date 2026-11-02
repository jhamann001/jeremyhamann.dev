import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pure (no-DB) cron asset-map route cases. The ingest scope + audit writer are
// MOCKED (the account-aum-route.test.ts idiom) and the keyless OIDC layer is
// MOCKED (the acat-status.test.ts idiom) so the happy path exercises pagination
// + flatten/coercion + FK-ordered upserts + response shaping without a database
// or a real token. The route runs against the REAL lib/data/asset-map module
// (only its google-auth-library + server-only seams are stubbed).

// server-only throws outside an RSC bundle — stub it so lib/data/asset-map loads
// under the vitest node env (the twr-warehouse / acat-status idiom).
vi.mock("server-only", () => ({}));

// Keyless OIDC seam: GoogleAuth().getIdTokenClient(audience) → client.request(opts).
const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

// execRawSpy captures every upsert's bound values; scopeSpy proves the tx runs
// (or not, on dryRun / a pull failure) and hands the route a fake tx.
const { execRawSpy, queryRawSpy, scopeSpy } = vi.hoisted(() => {
  const execRawSpy = vi.fn(async (..._args: unknown[]) => 1);
  const queryRawSpy = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  const scopeSpy = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $executeRaw: execRawSpy, $queryRaw: queryRawSpy }),
  );
  return { execRawSpy, queryRawSpy, scopeSpy };
});
// Run identity seams (ticket): the identity writer and the CRM resolver are
// mocked so the route matrix can prove WHICH phase runs in which mode; their
// own behavior is covered in test/data/asset-map-run-identity-*.test.ts.
const { persistMock, resolveMock } = vi.hoisted(() => ({
  persistMock: vi.fn(),
  resolveMock: vi.fn(async (_tx: unknown, ids: readonly string[]) =>
    new Map(ids.map((id) => [id, { cedarRidgeUserId: id, outcome: "missing", canonicalContactIdentityId: null, canonicalContactSourceKey: null }])),
  ),
}));
vi.mock("@/lib/data/asset-map-run-identity/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/asset-map-run-identity/persistence")>()),
  persistRunIdentities: persistMock,
}));
vi.mock("@/lib/data/asset-map-run-identity/resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/asset-map-run-identity/resolver")>()),
  resolveRunPeople: resolveMock,
}));
vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: scopeSpy }));
const { writeAuditMock } = vi.hoisted(() => ({ writeAuditMock: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditMock };
});

import * as route from "../../app/api/cron/asset-map/route";

// Every live import tx opens with the import lock (ticket); upserts() is the
// tx's writes after it.
const isLock = (c: unknown[]) => (c[0] as readonly string[]).join("?").includes("pg_advisory_xact_lock");
const upserts = () => (execRawSpy.mock.calls as unknown[][]).filter((c) => !isLock(c));

const TOKEN = "test-asset-map-token";
const BASE = "https://pipeline.example.test";

function post(opts: { auth?: string; url?: string } = {}) {
  const headers = new Headers();
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/cron/asset-map", { method: "POST", headers });
}

function pageResponse(page: number, per_page: number, total: number, households: unknown[]) {
  return { status: 200, data: { page, per_page, total, households } };
}

// A 2-page dataset: page1 has HH1 (2 accounts / 2 positions) + HH2 (superseded,
// 1 account / 1 position); page2 has HH3 (0 accounts). per_page=2, total=3 so the
// route fetches exactly two pages. Counts: 3 households, 3 accounts, 3 positions.
const HH1 = {
  id: "h1",
  client_name: "Willie & John Doe",
  run_number: 4,
  superseded_by: null,
  total_value: "1000.50",
  acat_count: 2,
  review_count: 1,
  accounts: [
    {
      id: "a1",
      household_id: "h1",
      account_number: "WJOKRD-UCZJDMLK-591",
      custodian: "Fidelity",
      is_stale: "false",
      custodian_intel: { dtcc_number: "0226" },
      assets: [
        { id: "p1", account_id: "a1", symbol: "AAPL", effective_status: "ACAT", lots: [{ q: 1 }] },
        { id: "p2", account_id: "a1", symbol: "VTI", effective_status: "LIQUIDATE" },
      ],
    },
    { id: "a2", household_id: "h1", custodian: "Schwab", assets: [] },
  ],
};
const HH2 = {
  id: "h2",
  client_name: "Old Version",
  superseded_by: "h9",
  accounts: [
    { id: "a3", household_id: "h2", assets: [{ id: "p3", account_id: "a3", symbol: "SPY" }] },
  ],
};
const HH3 = { id: "h3", client_name: "Solo", accounts: [] };

function mockTwoPages() {
  requestMock.mockReset();
  requestMock
    .mockResolvedValueOnce(pageResponse(1, 2, 3, [HH1, HH2]))
    .mockResolvedValueOnce(pageResponse(2, 2, 3, [HH3]));
}

describe("POST /api/cron/asset-map — pure (mocked OIDC/scope/audit)", () => {
  const originalToken = process.env.INGEST_TOKEN;
  const originalUrl = process.env.STATEMENT_PIPELINE_URL;

  beforeEach(() => {
    process.env.INGEST_TOKEN = TOKEN;
    process.env.STATEMENT_PIPELINE_URL = BASE;
    execRawSpy.mockClear();
    scopeSpy.mockClear();
    writeAuditMock.mockClear();
    getIdTokenClientMock.mockClear();
    requestMock.mockReset();
  });
  const originalRead = process.env.EPIC_AOA_ASSET_MAPPING_READ;
  const originalEdits = process.env.EPIC_AOA_ASSET_MAPPING_EDITS;
  afterEach(() => {
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    restore("INGEST_TOKEN", originalToken);
    restore("STATEMENT_PIPELINE_URL", originalUrl);
    restore("EPIC_AOA_ASSET_MAPPING_READ", originalRead);
    restore("EPIC_AOA_ASSET_MAPPING_EDITS", originalEdits);
    vi.restoreAllMocks();
  });

  it("auth: wrong bearer → 401, no fetch", async () => {
    mockTwoPages();
    const res = await route.POST(post({ auth: "Bearer wrong" }));
    expect(res.status).toBe(401);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("auth: missing bearer → 401", async () => {
    const res = await route.POST(post({ auth: undefined }));
    expect(res.status).toBe(401);
  });

  it("non-POST verbs → 405 on every verb", async () => {
    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const res = verb();
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("unset STATEMENT_PIPELINE_URL → 503 config_error, no fetch, no write", async () => {
    delete process.env.STATEMENT_PIPELINE_URL;
    const res = await route.POST(post());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "config_error" });
    expect(requestMock).not.toHaveBeenCalled();
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("happy path: paginates 2 pages, upserts household→account→position in FK order", async () => {
    mockTwoPages();
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toEqual({ households: 3, accounts: 3, positions: 3 });
    expect(body.total).toBe(9);
    expect(body.pages).toBe(2);
    expect(body.superseded).toBe(1);
    expect(body.rejected).toEqual([]);
    expect(body.source).toBe("statement-pipeline");

    // Audience == the base URL (== the pipeline's OIDC audience), never the path.
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);

    // One tx, 9 upserts, in FK-parent order: households, then accounts, then positions.
    expect(scopeSpy).toHaveBeenCalledTimes(1);
    expect(upserts()).toHaveLength(9);
    const idOf = (i: number) => (upserts()[i] as unknown[])[1];
    expect([idOf(0), idOf(1), idOf(2)]).toEqual(["h1", "h2", "h3"]); // households first
    expect([idOf(3), idOf(4), idOf(5)]).toEqual(["a1", "a2", "a3"]); // then accounts
    expect([idOf(6), idOf(7), idOf(8)]).toEqual(["p1", "p2", "p3"]); // then positions
    // account bound [2] = household_id (FK carried).
    expect((upserts()[3] as unknown[])[2]).toBe("h1");
    expect((upserts()[5] as unknown[])[2]).toBe("h2");
    // position bound [2] = account_id (FK carried).
    expect((upserts()[6] as unknown[])[2]).toBe("a1");
    expect((upserts()[8] as unknown[])[2]).toBe("a3");

    // Audit written once inside the tx, counts only.
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const auditEntry = (writeAuditMock.mock.calls[0] as unknown[])[2] as {
      detail: Record<string, unknown>;
    };
    expect(auditEntry.detail).toMatchObject({
      source: "statement-pipeline",
      households: 3,
      accounts: 3,
      positions: 3,
      upserted: 9,
      superseded: 1,
      dry_run: false,
    });
  });

  it("superseded_by is carried verbatim (bound value on the household upsert)", async () => {
    mockTwoPages();
    await route.POST(post());
    // household bound values: [1]=id … [6]=superseded_by.
    const h2 = upserts()[1] as unknown[]; // second household = h2
    expect(h2[1]).toBe("h2");
    expect(h2[6]).toBe("h9"); // carried straight through
    const h1 = upserts()[0] as unknown[];
    expect(h1[6]).toBeNull(); // live household → NULL
  });

  it("all-versions pull demotes the old version; live set = current version per source_folder_id", async () => {
    // New-UUID-per-version semantics: a doc drop INSERTs a NEW household row
    // (fresh UUID) and flips the PRIOR row's superseded_by → the new UUID, keyed
    // on the stable source_folder_id. With include_superseded=true BOTH versions
    // of source folder "sf-1" come back in one page: the OLD row (v1) now carries
    // superseded_by=v2, the CURRENT row (v2) carries superseded_by=null.
    requestMock.mockReset();
    const vOld = {
      id: "v1",
      client_name: "Chain Client",
      source_folder_id: "sf-1",
      superseded_by: "v2", // demoted at source
      accounts: [],
    };
    const vNew = {
      id: "v2",
      client_name: "Chain Client",
      source_folder_id: "sf-1",
      superseded_by: null, // current live version
      accounts: [],
    };
    requestMock.mockResolvedValueOnce(pageResponse(1, 200, 2, [vOld, vNew]));

    const res = await route.POST(post());
    expect(res.status).toBe(200);
    const body = await res.json();
    // BOTH versions upserted; superseded count sees the demoted old row.
    expect(body.upserted).toEqual({ households: 2, accounts: 0, positions: 0 });
    expect(body.superseded).toBe(1);

    // household bound values: [1]=id, [6]=superseded_by, [7]=source_folder_id.
    expect(upserts()).toHaveLength(2);
    const rows = upserts().map((c) => ({
      id: c[1] as string,
      superseded_by: c[6] as string | null,
      source_folder_id: c[7] as string | null,
    }));
    const old = rows.find((r) => r.id === "v1")!;
    const cur = rows.find((r) => r.id === "v2")!;
    // Demotion: the old mirror row is re-upserted WITH its now-set superseded_by,
    // so the upsert-by-id clears its stale ghost-live status.
    expect(old.superseded_by).toBe("v2");
    expect(cur.superseded_by).toBeNull();

    // Guard the LOAD-BEARING clause itself: demotion works only because the
    // household upsert's ON CONFLICT DO UPDATE actually re-writes superseded_by.
    // Asserting the bound value alone would still pass if that clause were
    // dropped — so assert the SQL skeleton retains it.
    const householdSql = (
      (upserts()[0] as unknown[])[0] as readonly string[]
    )
      .join(" ")
      .replace(/\s+/g, " ");
    expect(householdSql).toContain("superseded_by = EXCLUDED.superseded_by");

    // Live set (superseded_by IS NULL) has EXACTLY the current version per
    // source_folder_id — the self-healed liveness the fix guarantees.
    const liveBySource = new Map<string, string[]>();
    for (const r of rows.filter((r) => r.superseded_by == null)) {
      const key = r.source_folder_id ?? "";
      liveBySource.set(key, [...(liveBySource.get(key) ?? []), r.id]);
    }
    expect(liveBySource.get("sf-1")).toEqual(["v2"]);
  });

  it("dryRun=1: reports would_upsert, writes nothing (no rows, no audit)", async () => {
    mockTwoPages();
    const res = await route.POST(post({ url: "https://x/api/cron/asset-map?dryRun=1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.would_upsert).toEqual({ households: 3, accounts: 3, positions: 3 });
    expect(body.upserted).toBeUndefined();
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(execRawSpy).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("malformed/empty page does not crash; a household missing id is rejected", async () => {
    requestMock.mockReset();
    // total=0 with an empty households list, plus one bad-shape extra ignored.
    requestMock.mockResolvedValueOnce(
      pageResponse(1, 200, 2, [{ client_name: "no id here" }, { id: "hOK", accounts: [] }]),
    );
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toEqual({ households: 1, accounts: 0, positions: 0 });
    expect(body.rejected).toEqual([{ level: "household", index: "h0", reason: "id_missing" }]);
    // Only the one valid household upserted; audit still written once.
    expect(upserts()).toHaveLength(1);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
  });

  it("empty first page (total 0) → zero rows, one audit, no crash", async () => {
    requestMock.mockReset();
    requestMock.mockResolvedValueOnce(pageResponse(1, 200, 0, []));
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toEqual({ households: 0, accounts: 0, positions: 0 });
    expect(body.pages).toBe(1);
    expect(upserts()).toHaveLength(0);
    expect(writeAuditMock).toHaveBeenCalledTimes(1); // live run still audits
  });

  it("outbound pipeline failure → 502, tx never opened (no partial write)", async () => {
    requestMock.mockReset();
    requestMock
      .mockResolvedValueOnce(pageResponse(1, 2, 4, [HH1, HH2])) // page 1 ok
      .mockResolvedValueOnce({ status: 500, data: { error: "boom" } }); // page 2 fails
    const res = await route.POST(post());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "pipeline_error" });
    // Fetched all pages BEFORE opening the tx → a mid-pull failure writes nothing.
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(execRawSpy).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("401 from the pipeline → 502, no write", async () => {
    requestMock.mockReset();
    requestMock.mockResolvedValueOnce({ status: 401, data: {} });
    const res = await route.POST(post());
    expect(res.status).toBe(502);
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("position upsert marks every received position not deleted", async () => {
    mockTwoPages();
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    const call = upserts()[6] as unknown[];
    expect((call[0] as readonly string[]).join("?").replace(/\s+/g, " ")).toContain("is_deleted = false");
    expect(call[1]).toBe("p1");
  });

  it("the pull maps the pipeline's YES/NO transferring text only while the edits flag is on", async () => {
    const yesPage = () => {
      requestMock.mockReset();
      requestMock.mockResolvedValueOnce(pageResponse(1, 200, 1, [
        { id: "h1", accounts: [{ id: "a1", assets: [{ id: "p1", account_id: "a1", transferring: "YES" }] }] },
      ]));
    };
    process.env.EPIC_AOA_ASSET_MAPPING_READ = "1";
    process.env.EPIC_AOA_ASSET_MAPPING_EDITS = "1";
    yesPage();
    expect((await route.POST(post())).status).toBe(200);
    expect((upserts()[2] as unknown[])[21]).toBe(true);

    execRawSpy.mockClear();
    delete process.env.EPIC_AOA_ASSET_MAPPING_EDITS;
    yesPage();
    expect((await route.POST(post())).status).toBe(200);
    expect((upserts()[2] as unknown[])[21]).toBeNull();
  });

  it("the account upsert writes the pipeline's account-type override person and time (ticket)", async () => {
    requestMock.mockReset();
    requestMock.mockResolvedValueOnce(pageResponse(1, 200, 1, [
      {
        id: "h1",
        accounts: [{
          id: "a1",
          account_type_overridden_by: "ops.person@example.invalid",
          account_type_overridden_at: "2026-10-06T14:05:00Z",
          assets: [],
        }],
      },
    ]));
    expect((await route.POST(post())).status).toBe(200);
    const call = upserts()[1] as unknown[];
    const sql = (call[0] as readonly string[]).join("?").replace(/\s+/g, " ");
    expect(sql).toContain("THEN cur.account_type_overridden_by ELSE EXCLUDED.account_type_overridden_by END");
    expect(sql).toContain("THEN cur.account_type_overridden_at ELSE EXCLUDED.account_type_overridden_at END");
    expect(call[24]).toBe("ops.person@example.invalid");
    expect(call[25]).toBeInstanceOf(Date);
    expect((call[25] as Date).toISOString()).toBe("2026-10-06T14:05:00.000Z");
  });

  it("every live import takes the import lock as the tx's first statement, and dryRun opens no tx (ticket)", async () => {
    mockTwoPages();
    expect((await route.POST(post())).status).toBe(200);
    expect(isLock(execRawSpy.mock.calls[0] as unknown[])).toBe(true);
    expect(execRawSpy.mock.calls.filter((c) => isLock(c as unknown[]))).toHaveLength(1);
    expect(((execRawSpy.mock.calls[0] as unknown[])[0] as readonly string[]).join("?")).toContain("hashtextextended('aoa:asset-map-import', 0)");

    execRawSpy.mockClear();
    scopeSpy.mockClear();
    mockTwoPages();
    expect((await route.POST(post({ url: "https://x/api/cron/asset-map?dryRun=1" }))).status).toBe(200);
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(execRawSpy).not.toHaveBeenCalled();
  });

  it("an older pull keeps a newer stored account type: every account-type column is guarded by the pull start (ticket)", async () => {
    let fetchedAt = "";
    requestMock.mockReset();
    requestMock.mockImplementationOnce(async () => {
      fetchedAt = new Date().toISOString();
      return pageResponse(1, 200, 1, [{ id: "h1", accounts: [{ id: "a1", account_type: "IRA", assets: [] }] }]);
    });
    expect((await route.POST(post())).status).toBe(200);
    const call = upserts()[1] as unknown[];
    const sql = (call[0] as readonly string[]).join("?").replace(/\s+/g, " ");
    expect(sql).toContain("INSERT INTO mirror.acat_asset_map_account AS cur");
    for (const col of ["account_type", "account_type_other", "is_rollover", "is_inherited", "apex_restriction", "account_type_overridden_by", "account_type_overridden_at"]) {
      expect(sql).toContain(`${col} = CASE WHEN cur.account_type_overridden_at >= ?::timestamptz THEN cur.${col} ELSE EXCLUDED.${col} END`);
    }
    for (const col of ["account_type_raw", "account_type_override", "account_holder", "total_value"]) {
      expect(sql).toContain(`${col} = EXCLUDED.${col}`);
    }
    const guards = call.slice(26);
    expect(guards).toHaveLength(7);
    expect(new Set(guards).size).toBe(1);
    expect(typeof guards[0]).toBe("string");
    expect(guards[0] as string <= fetchedAt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ticket run identity mode matrix. Invented run UUIDs / Cedar Ridge ids only.
// ---------------------------------------------------------------------------

const IDENTITY_RUN_1 = "02710000-0000-4000-8000-00000000e001";
const IDENTITY_RUN_2 = "02710000-0000-4000-8000-00000000e002";
const LINKED = {
  schema_version: 1, availability: "available", identity_version: 3,
  decision_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", decision_state: "linked",
  people_ids: ["cr-route-a", "cr-route-b"], coverage: "complete", primary_user_id: null,
  cedar_ridge_user_id: null, review_state: "complete", conflict_flags: [],
};
const IDENTITY_HH1 = {
  id: IDENTITY_RUN_1, client_name: "Invented Household", source_folder_id: "folder-inv", superseded_by: IDENTITY_RUN_2,
  client_link: LINKED,
  accounts: [{ id: "acct-inv-1", account_number: "HNPZSC-AHFDVWBV-052", assets: [{ id: "pos-inv-1", symbol: "VTI" }] }],
};
const IDENTITY_HH2 = {
  id: IDENTITY_RUN_2, client_name: "Invented Household", source_folder_id: "folder-inv", superseded_by: null,
  client_link: { schema_version: 1, availability: "unavailable", reason: "client_linking_disabled" },
  accounts: [],
};

function persistCounts(observed: number) {
  return {
    observed, inserted: observed, sourceApplied: 0, unchanged: 0, staleRejected: 0, quarantinedEqualVersion: 0,
    quarantinedUnreviewed: 0, unavailablePreserved: 0, missingParent: 0, resolutionRefreshed: 0, historyRows: observed,
    membersActivated: 2, membersRetired: 0, resolved: 0, missing: 2, ambiguous: 0, conflict: 0,
  };
}

describe("POST /api/cron/asset-map — run identity mode matrix (ticket)", () => {
  const FLAGS = ["ASSET_MAP_RUN_IDENTITY_ENABLED", "ASSET_MAP_RUN_IDENTITY_WRITES_ENABLED"] as const;
  const saved = {
    token: process.env.INGEST_TOKEN,
    url: process.env.STATEMENT_PIPELINE_URL,
    flags: FLAGS.map((k) => process.env[k]),
  };
  const events: string[] = [];
  const logs: string[] = [];

  function setMode(mode: "off" | "writes_only" | "preview" | "write") {
    FLAGS.forEach((k) => delete process.env[k]);
    if (mode === "preview" || mode === "write") process.env.ASSET_MAP_RUN_IDENTITY_ENABLED = "1";
    if (mode === "write" || mode === "writes_only") process.env.ASSET_MAP_RUN_IDENTITY_WRITES_ENABLED = "1";
  }
  const sqlOf = (call: unknown[]) => ((call[0] as readonly string[]).join("?")).replace(/\s+/g, " ").trim();
  const mockIdentityPages = () => {
    requestMock.mockReset();
    requestMock.mockResolvedValueOnce(pageResponse(1, 200, 2, [IDENTITY_HH1, IDENTITY_HH2]));
  };
  const call = (dryRun = false) =>
    route.POST(post({ url: `https://x/api/cron/asset-map${dryRun ? "?dryRun=1" : ""}` }));

  beforeEach(() => {
    process.env.INGEST_TOKEN = TOKEN;
    process.env.STATEMENT_PIPELINE_URL = BASE;
    events.length = 0;
    logs.length = 0;
    execRawSpy.mockReset();
    execRawSpy.mockImplementation(async (...args: unknown[]) => {
      events.push(`exec:${sqlOf(args).slice(0, 40)}`);
      return 1;
    });
    queryRawSpy.mockClear();
    scopeSpy.mockClear();
    scopeSpy.mockImplementation(async (fn) => {
      events.push("scope:begin");
      const result = await fn({ $executeRaw: execRawSpy, $queryRaw: queryRawSpy });
      events.push("scope:commit");
      return result;
    });
    writeAuditMock.mockReset();
    writeAuditMock.mockImplementation(async (...args: unknown[]) => {
      events.push(`audit:${(args[2] as { action: string }).action}`);
    });
    persistMock.mockReset();
    persistMock.mockImplementation(async (_tx: unknown, observations: unknown[]) => {
      events.push("persist");
      return { runs: [], counts: persistCounts(observations.length) };
    });
    resolveMock.mockClear();
    vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  });
  afterEach(() => {
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore("INGEST_TOKEN", saved.token);
    restore("STATEMENT_PIPELINE_URL", saved.url);
    FLAGS.forEach((k, i) => restore(k, saved.flags[i]));
    vi.restoreAllMocks();
  });

  const baseWrites = () => events.filter((e) => e.startsWith("exec:INSERT INTO mirror.acat_asset_map_")).length;
  const audits = () => events.filter((e) => e.startsWith("audit:"));

  it.each(["off", "writes_only"] as const)("%s: legacy import unchanged, no identity reads/writes, no identity body", async (mode) => {
    setMode(mode);
    mockIdentityPages();
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identity).toBeUndefined();
    expect(body.base_status).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(["pages", "rejected", "source", "superseded", "total", "upserted"]);
    expect(scopeSpy).toHaveBeenCalledTimes(1);
    expect(baseWrites()).toBe(4);
    expect(audits()).toEqual(["audit:ingest.asset_map"]);
    expect(queryRawSpy).not.toHaveBeenCalled();
    expect(persistMock).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("preview: base import + its audit run; identity is read-only with no identity/history/audit writes", async () => {
    setMode("preview");
    mockIdentityPages();
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toEqual({ households: 2, accounts: 1, positions: 1 });
    expect(body.base_status).toBe("committed");
    expect(body.identity).toMatchObject({
      mode: "preview",
      status: "previewed",
      diagnostics: {
        mode: "preview", dryRun: false, schemaStatus: "supported",
        census: { complete: true, reasons: [], pages: 1, total: 2 },
        runs: { observed: 2, available: 1, unavailable: 1, quarantined: 0, linked: 1 },
        people: { status: "available", accepted: 2, missing: 2 },
        plan: { status: "available", wouldAdd: 2, transitions: { inserted: 1, unavailable_preserved: 1 } },
      },
    });
    expect(persistMock).not.toHaveBeenCalled();
    expect(audits()).toEqual(["audit:ingest.asset_map"]);
    // Second transaction is the READ ONLY diagnostic: its only statement is the mode switch.
    const secondScope = events.slice(events.lastIndexOf("scope:begin"));
    expect(secondScope.filter((e) => e.startsWith("exec:"))).toEqual(["exec:SET TRANSACTION READ ONLY"]);
    expect(events.indexOf("audit:ingest.asset_map")).toBeLessThan(events.lastIndexOf("scope:begin"));
  });

  it("write (positive control): identity tx runs after the base tx commits, with its own audit", async () => {
    setMode("write");
    mockIdentityPages();
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toEqual({ households: 2, accounts: 1, positions: 1 });
    expect(body.base_status).toBe("committed");
    expect(body.identity).toMatchObject({
      mode: "write", status: "applied", audited: true,
      counts: { observed: 2, inserted: 2, historyRows: 2 },
      census: { complete: true, schema_status: "supported", runs: { observed: 2, available: 1, unavailable: 1 } },
    });
    expect(scopeSpy).toHaveBeenCalledTimes(2);
    expect(persistMock).toHaveBeenCalledTimes(1);
    const observations = persistMock.mock.calls[0][1] as Array<{ runId: string; availability: string }>;
    expect(observations.map((o) => [o.runId, o.availability])).toEqual([[IDENTITY_RUN_1, "available"], [IDENTITY_RUN_2, "unavailable"]]);
    expect(audits()).toEqual(["audit:ingest.asset_map", "audit:ingest.asset_map_run_identity"]);
    const firstCommit = events.indexOf("scope:commit");
    expect(events.indexOf("persist")).toBeGreaterThan(firstCommit);
    expect(events.lastIndexOf("scope:begin")).toBeGreaterThan(firstCommit);
  });

  it.each(["off", "writes_only", "preview", "write"] as const)("dryRun=1 in %s: no base, identity or audit writes", async (mode) => {
    setMode(mode);
    mockIdentityPages();
    const res = await call(true);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.would_upsert).toEqual({ households: 2, accounts: 1, positions: 1 });
    expect(body.upserted).toBeUndefined();
    expect(baseWrites()).toBe(0);
    expect(audits()).toEqual([]);
    expect(persistMock).not.toHaveBeenCalled();
    expect(events.filter((e) => e.startsWith("exec:") && e !== "exec:SET TRANSACTION READ ONLY")).toEqual([]);
    if (mode === "preview" || mode === "write") {
      expect(body.base_status).toBe("dry_run");
      expect(body.identity).toMatchObject({ mode, status: "previewed", diagnostics: { dryRun: true, people: { status: "available" } } });
      expect(scopeSpy).toHaveBeenCalledTimes(1);
      expect(resolveMock).toHaveBeenCalledTimes(1);
    } else {
      expect(body.identity).toBeUndefined();
      expect(scopeSpy).not.toHaveBeenCalled();
    }
  });

  it("base import failure: 500, no identity transaction even when parents already exist", async () => {
    setMode("write");
    mockIdentityPages();
    execRawSpy.mockRejectedValueOnce(new Error("invented base failure"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal", identity: { mode: "write", status: "not_attempted", reason: "base_failed" } });
    expect(scopeSpy).toHaveBeenCalledTimes(1);
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("identity failure after a committed base import is reported separately and never as success", async () => {
    setMode("write");
    mockIdentityPages();
    persistMock.mockRejectedValueOnce(new Error("invented identity failure"));
    const res = await call();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.upserted).toEqual({ households: 2, accounts: 1, positions: 1 });
    expect(body.base_status).toBe("committed");
    expect(body.identity).toMatchObject({ mode: "write", status: "failed", reason: "transaction_failed" });
    expect(body.identity.counts).toBeUndefined();
    expect(audits()).toEqual(["audit:ingest.asset_map"]);
  });

  it("an incomplete census (early short page) still imports base data but blocks every identity write", async () => {
    setMode("write");
    requestMock.mockReset();
    requestMock
      .mockResolvedValueOnce(pageResponse(1, 200, 3, [IDENTITY_HH1]))
      .mockResolvedValueOnce(pageResponse(2, 200, 3, []));
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted.households).toBe(1);
    expect(body.identity).toMatchObject({ status: "blocked", reasons: ["short_page"], census: { complete: false } });
    expect(persistMock).not.toHaveBeenCalled();
    expect(scopeSpy).toHaveBeenCalledTimes(1);
  });

  it("page safety-cap truncation blocks identity writes", async () => {
    setMode("write");
    requestMock.mockReset();
    let n = 0;
    requestMock.mockImplementation(async (opts: { url: string }) => {
      const pageNo = Number(new URL(opts.url).searchParams.get("page"));
      const households = Array.from({ length: 200 }, () => ({ id: `02710000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`, client_link: LINKED, accounts: [] }));
      return pageResponse(pageNo, 200, 20000, households);
    });
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pages).toBe(50);
    expect(body.identity).toMatchObject({ status: "blocked", reasons: ["safety_cap"] });
    expect(persistMock).not.toHaveBeenCalled();
  });

  it("source fetch failure with identity on → 502 and identity not attempted", async () => {
    setMode("write");
    requestMock.mockReset();
    requestMock.mockResolvedValueOnce({ status: 503, data: {} });
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "pipeline_error", identity: { mode: "write", status: "not_attempted", reason: "fetch_failed" } });
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("responses and logs carry counts and reason codes only", async () => {
    for (const mode of ["preview", "write"] as const) {
      setMode(mode);
      mockIdentityPages();
      const body = JSON.stringify(await (await call()).json());
      expect(body).not.toMatch(/cr-route|SECRET-UNMASKED|Invented Household|folder-inv|02710000/);
    }
    const logText = logs.join("\n");
    expect(logText).toMatch(/identity mode=preview/);
    expect(logText).toMatch(/identity mode=write status=applied/);
    expect(logText).not.toMatch(/cr-route|SECRET-UNMASKED|Invented Household|folder-inv|02710000/);
  });
});
