import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pure (no-DB) cron asset-map-match route cases. The ingest scope, the P2.0
// link-store seam (listLinksByStatus / setLink), and the audit writer are MOCKED
// so we exercise auth, method-gating, the read→match→persist loop, the
// CONFIRMED/REJECTED-preserving guard, and the dryRun-writes-only-the-audit-row
// contract WITHOUT a database. The route runs against the REAL matching lib
// (lib/data/asset-map-match), so the tiers asserted here are the real verdicts.
// Follows the asset-map-route.test.ts / transfer-sync-route.test.ts idiom.

// The fake tx only needs $queryRaw — the route's two reads (households, clients).
// Dispatch by SQL: everything else goes through the mocked seam.
const { queryRawSpy, scopeSpy, setLinkSpy, listLinksSpy, writeAuditSpy } = vi.hoisted(() => {
  const queryRawSpy = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  const scopeSpy = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRaw: queryRawSpy }),
  );
  const setLinkSpy = vi.fn(async () => {});
  const listLinksSpy = vi.fn(async (_tx: unknown, _status: string) => [] as unknown[]);
  const writeAuditSpy = vi.fn(async () => {});
  return { queryRawSpy, scopeSpy, setLinkSpy, listLinksSpy, writeAuditSpy };
});

vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: scopeSpy }));
vi.mock("@/lib/data/asset-map-link", () => ({
  setLink: setLinkSpy,
  listLinksByStatus: listLinksSpy,
}));
// The route now also imports the P2.5 account-link seam (which pulls "server-only").
// These folder-pass tests wire no linked folders, so the account pass is a no-op;
// stub the seam so the real module (and server-only) never loads.
vi.mock("@/lib/data/asset-map-account-link", () => ({
  listAccountLinksByFolder: vi.fn(async () => []),
  replaceAccountOwnerCandidates: vi.fn(async () => {}),
  resolveDeterministicOwners: vi.fn(async () => []),
}));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditSpy };
});

import * as route from "../../app/api/cron/asset-map-match/route";

const TOKEN = "test-asset-map-match-token";

function post(opts: { auth?: string; url?: string } = {}) {
  const headers = new Headers();
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/cron/asset-map-match", {
    method: "POST",
    headers,
  });
}

// One live household row as readLiveHouseholds returns it.
function hh(source_folder_id: string, client_name: string | null) {
  return { source_folder_id, client_name };
}
// One candidate client row as readCandidateClients reads from mirror.client.
function clientRow(over: Record<string, unknown> = {}) {
  return {
    sf_id: "c1",
    household_id: "h1",
    first_name: "John",
    last_name: "Smith",
    cedar_ridge_user_id: "e1",
    ...over,
  };
}

// Wire the two reads by SQL content. listLinksByStatus is mocked separately.
function wireReads(households: unknown[], clients: unknown[]) {
  queryRawSpy.mockImplementation(async (...args: unknown[]) => {
    const sql = (args[0] as TemplateStringsArray).join(" ");
    if (sql.includes("acat_asset_map_household")) return households;
    if (sql.includes("mirror.client")) return clients;
    return [];
  });
}
// Wire the preserved-folder reads: CONFIRMED / REJECTED link rows by status.
function wirePreserved(confirmed: string[] = [], rejected: string[] = []) {
  listLinksSpy.mockImplementation(async (_tx: unknown, status: string) => {
    const ids = status === "CONFIRMED" ? confirmed : status === "REJECTED" ? rejected : [];
    return ids.map((sourceFolderId) => ({ sourceFolderId }));
  });
}

describe("POST /api/cron/asset-map-match — pure (mocked scope/seam/audit)", () => {
  const originalToken = process.env.INGEST_TOKEN;

  beforeEach(() => {
    process.env.INGEST_TOKEN = TOKEN;
    queryRawSpy.mockReset();
    queryRawSpy.mockResolvedValue([]);
    scopeSpy.mockClear();
    setLinkSpy.mockClear();
    listLinksSpy.mockReset();
    listLinksSpy.mockResolvedValue([]);
    writeAuditSpy.mockClear();
    wirePreserved();
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = originalToken;
    vi.restoreAllMocks();
  });

  it("auth: wrong bearer → 401, never opens a tx", async () => {
    const res = await route.POST(post({ auth: "Bearer wrong" }));
    expect(res.status).toBe(401);
    expect(scopeSpy).not.toHaveBeenCalled();
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

  it("the live-households read filters to live, folder-keyed rows (load-bearing SQL)", async () => {
    wireReads([], []);
    await route.POST(post());
    const householdCall = queryRawSpy.mock.calls.find((c) =>
      (c[0] as TemplateStringsArray).join(" ").includes("acat_asset_map_household"),
    )!;
    const sql = (householdCall[0] as TemplateStringsArray).join(" ").replace(/\s+/g, " ");
    expect(sql).toContain("superseded_by IS NULL");
    expect(sql).toContain("source_folder_id IS NOT NULL");
  });

  it("happy path: each household is tiered by the REAL lib and persisted via setLink", async () => {
    wireReads(
      [
        hh("f_auto", "John Smith"), // exact single → AUTO_LINKED
        hh("f_review", "John William Smith"), // 2/3 Jaccard → NEEDS_REVIEW
        hh("f_unmatched", "Adan Nobody"), // no overlap → UNMATCHED
      ],
      [clientRow({ sf_id: "c1", household_id: "h1", cedar_ridge_user_id: "e1" })],
    );

    const res = await route.POST(post());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      households_scored: 3,
      auto_linked: 1,
      needs_review: 1,
      unmatched: 1,
      preserved: 0,
      dry_run: false,
      source: "acat-asset-map",
    });

    expect(setLinkSpy).toHaveBeenCalledTimes(3);
    const byFolder = new Map(
      setLinkSpy.mock.calls.map((c) => {
        const input = (c as unknown[])[1] as Record<string, unknown>;
        return [input.sourceFolderId as string, input];
      }),
    );
    // AUTO_LINKED carries the resolved ids.
    expect(byFolder.get("f_auto")).toMatchObject({
      matchStatus: "AUTO_LINKED",
      clientSfId: "c1",
      householdSfId: "h1",
      cedarRidgeUserId: "e1",
      confidence: 1,
    });
    // NEEDS_REVIEW / UNMATCHED leave ids NULL.
    expect(byFolder.get("f_review")).toMatchObject({
      matchStatus: "NEEDS_REVIEW",
      clientSfId: null,
      householdSfId: null,
    });
    expect(byFolder.get("f_unmatched")).toMatchObject({
      matchStatus: "UNMATCHED",
      clientSfId: null,
    });

    // Audit: TWO rows now — the folder pass (index 0) + the P2.5 account pass
    // (index 1); both counts-only (no client_name anywhere). calls[0] is the folder
    // audit asserted here.
    expect(writeAuditSpy).toHaveBeenCalledTimes(2);
    const [, identity, entry] = writeAuditSpy.mock.calls[0] as unknown[] as [
      unknown,
      { role: string; email: null },
      { action: string; detail: Record<string, unknown> },
    ];
    expect(identity).toEqual({ role: "INGEST", email: null });
    expect(entry.action).toBe("ingest.asset_map_match");
    expect(entry.detail).toMatchObject({
      source: "acat-asset-map",
      households_scored: 3,
      auto_linked: 1,
      needs_review: 1,
      unmatched: 1,
      preserved: 0,
      dry_run: false,
    });
    expect(JSON.stringify(entry.detail)).not.toContain("John");
  });

  it("CONFIRMED link is PRESERVED — never re-scored, never overwritten", async () => {
    wireReads(
      [hh("f_confirmed", "John Smith")], // would AUTO_LINK if scored
      [clientRow()],
    );
    wirePreserved(["f_confirmed"], []);

    const res = await route.POST(post());
    const body = await res.json();
    expect(body).toMatchObject({ households_scored: 0, preserved: 1, auto_linked: 0 });
    // The human decision is untouched — setLink was NOT called for it.
    expect(setLinkSpy).not.toHaveBeenCalled();
  });

  it("REJECTED link is PRESERVED too", async () => {
    wireReads([hh("f_rejected", "John Smith")], [clientRow()]);
    wirePreserved([], ["f_rejected"]);

    const res = await route.POST(post());
    const body = await res.json();
    expect(body).toMatchObject({ preserved: 1, households_scored: 0 });
    expect(setLinkSpy).not.toHaveBeenCalled();
  });

  it("machine-tier rows ARE re-written even when a human row is preserved in the same run", async () => {
    wireReads(
      [hh("f_confirmed", "John Smith"), hh("f_fresh", "John Smith")],
      [clientRow()],
    );
    wirePreserved(["f_confirmed"], []);

    const res = await route.POST(post());
    const body = await res.json();
    expect(body).toMatchObject({ preserved: 1, households_scored: 1, auto_linked: 1 });
    expect(setLinkSpy).toHaveBeenCalledTimes(1);
    expect(
      ((setLinkSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>).sourceFolderId,
    ).toBe("f_fresh");
  });

  it("dryRun=1: computes tiers + writes ONLY the audit row (no setLink)", async () => {
    wireReads([hh("f_auto", "John Smith")], [clientRow()]);
    const res = await route.POST(post({ url: "https://x/api/cron/asset-map-match?dryRun=1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ households_scored: 1, auto_linked: 1, dry_run: true });
    expect(setLinkSpy).not.toHaveBeenCalled();
    expect(scopeSpy).toHaveBeenCalledTimes(1);
    // Folder audit (index 0) + account audit (index 1); both written on dryRun.
    expect(writeAuditSpy).toHaveBeenCalledTimes(2);
    const entry = (writeAuditSpy.mock.calls[0] as unknown[])[2] as {
      detail: Record<string, unknown>;
    };
    expect(entry.detail).toMatchObject({ dry_run: true });
  });

  it("a DB read failure → 500, no audit written", async () => {
    queryRawSpy.mockRejectedValue(new Error("db down"));
    const res = await route.POST(post());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });
});
