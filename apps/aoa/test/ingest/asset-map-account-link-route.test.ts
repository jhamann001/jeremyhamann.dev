import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pure (no-DB) cron asset-map-match ACCOUNT-PASS cases (P2.5). The ingest scope, the
// folder-link seam, the P2.5 account-link seam, and the audit writer are MOCKED; the
// route runs against the REAL matcher libs (asset-map-match + asset-map-account-match)
// so the tiers asserted here are the real verdicts. Follows the
// asset-map-match-route.test.ts wireReads idiom.

const {
  queryRawSpy,
  scopeSpy,
  setLinkSpy,
  listLinksSpy,
  listAccountLinksByFolderSpy,
  replaceCandidatesSpy,
  resolveDeterministicSpy,
  writeAuditSpy,
} = vi.hoisted(() => {
  const queryRawSpy = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  const scopeSpy = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRaw: queryRawSpy }),
  );
  const setLinkSpy = vi.fn(async () => {});
  const listLinksSpy = vi.fn(async (_tx: unknown, _status: string) => [] as unknown[]);
  const listAccountLinksByFolderSpy = vi.fn(async (_tx: unknown, _folder: string) => [] as unknown[]);
  const replaceCandidatesSpy = vi.fn(async () => {});
  const resolveDeterministicSpy = vi.fn(async () => [] as { cedarRidgeUserId: string }[]);
  const writeAuditSpy = vi.fn(async () => {});
  return {
    queryRawSpy,
    scopeSpy,
    setLinkSpy,
    listLinksSpy,
    listAccountLinksByFolderSpy,
    replaceCandidatesSpy,
    resolveDeterministicSpy,
    writeAuditSpy,
  };
});

vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: scopeSpy }));
vi.mock("@/lib/data/asset-map-link", () => ({
  setLink: setLinkSpy,
  listLinksByStatus: listLinksSpy,
}));
vi.mock("@/lib/data/asset-map-account-link", () => ({
  listAccountLinksByFolder: listAccountLinksByFolderSpy,
  replaceAccountOwnerCandidates: replaceCandidatesSpy,
  resolveDeterministicOwners: resolveDeterministicSpy,
}));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditSpy };
});

import * as route from "../../app/api/cron/asset-map-match/route";

const TOKEN = "test-asset-map-account-token";

function post(opts: { auth?: string; url?: string } = {}) {
  const headers = new Headers();
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/cron/asset-map-match", {
    method: "POST",
    headers,
  });
}

// Folder link rows by status (the account pass feeds off AUTO_LINKED + CONFIRMED).
function wireFolderLinks(links: {
  autoLinked?: { sourceFolderId: string; householdSfId: string | null }[];
  confirmed?: { sourceFolderId: string; householdSfId: string | null }[];
  rejected?: { sourceFolderId: string }[];
}) {
  listLinksSpy.mockImplementation(async (_tx: unknown, status: string) => {
    if (status === "AUTO_LINKED") return links.autoLinked ?? [];
    if (status === "CONFIRMED") return links.confirmed ?? [];
    if (status === "REJECTED") return links.rejected ?? [];
    return [];
  });
}

// Route reads via tx.$queryRaw: dispatch by SQL. The account-pass live-accounts read
// JOINs acat_asset_map_account (checked first); the folder-pass live-households read
// hits acat_asset_map_household only; members are mirror.client WHERE household_id =.
function wireReads(opts: {
  households?: unknown[];
  members?: unknown[];
  liveAccounts?: unknown[];
}) {
  queryRawSpy.mockImplementation(async (...args: unknown[]) => {
    const sql = (args[0] as TemplateStringsArray).join(" ");
    if (sql.includes("acat_asset_map_account")) return opts.liveAccounts ?? [];
    if (sql.includes("acat_asset_map_household")) return opts.households ?? [];
    if (sql.includes("mirror.client") && sql.includes("household_id ="))
      return opts.members ?? [];
    if (sql.includes("mirror.client")) return []; // folder-pass candidates
    return [];
  });
}

function memberRow(over: Record<string, unknown> = {}) {
  return {
    sf_id: "cJ",
    household_id: "h1",
    first_name: "John",
    last_name: "Smith",
    cedar_ridge_user_id: "eJ",
    ...over,
  };
}
function accountRow(over: Record<string, unknown> = {}) {
  return {
    custodian: "Fidelity",
    account_number: "1234",
    account_holder: "John Smith",
    account_type: "IRA",
    total_value: 100,
    ...over,
  };
}

const accountAuditCall = () =>
  writeAuditSpy.mock.calls.find(
    (c) => ((c as unknown[])[2] as { action: string }).action === "ingest.asset_map_account_link",
  ) as unknown[] | undefined;

describe("POST /api/cron/asset-map-match — account pass (P2.5)", () => {
  const originalToken = process.env.INGEST_TOKEN;

  beforeEach(() => {
    process.env.INGEST_TOKEN = TOKEN;
    queryRawSpy.mockReset();
    queryRawSpy.mockResolvedValue([]);
    scopeSpy.mockClear();
    setLinkSpy.mockClear();
    listLinksSpy.mockReset();
    listLinksSpy.mockResolvedValue([]);
    listAccountLinksByFolderSpy.mockReset();
    listAccountLinksByFolderSpy.mockResolvedValue([]);
    replaceCandidatesSpy.mockClear();
    resolveDeterministicSpy.mockReset();
    resolveDeterministicSpy.mockResolvedValue([]);
    writeAuditSpy.mockClear();
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

  it("non-POST verbs → 405", async () => {
    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      expect(verb().status).toBe(405);
    }
  });

  it("account pass runs ONLY for AUTO_LINKED/CONFIRMED folders with a household", async () => {
    // A folder link that is NOT AUTO_LINKED/CONFIRMED (or lacks a household) never
    // feeds the account pass. Here: no linked folders at all.
    wireFolderLinks({ autoLinked: [], confirmed: [] });
    wireReads({ households: [], members: [memberRow()], liveAccounts: [accountRow()] });

    const res = await route.POST(post());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ accounts_scored: 0, account_auto_linked: 0 });
    expect(replaceCandidatesSpy).not.toHaveBeenCalled();
  });

  it("a linked folder's account is scored by the REAL matcher + persisted", async () => {
    wireFolderLinks({ autoLinked: [{ sourceFolderId: "f_linked", householdSfId: "h1" }] });
    wireReads({
      households: [],
      members: [memberRow()], // John Smith in h1
      liveAccounts: [accountRow({ account_holder: "John Smith" })], // exact → AUTO_LINKED
    });

    const res = await route.POST(post());
    const body = await res.json();
    expect(body).toMatchObject({ accounts_scored: 1, account_auto_linked: 1 });
    expect(replaceCandidatesSpy).toHaveBeenCalledTimes(1);
    const arg = (replaceCandidatesSpy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(arg).toMatchObject({
      sourceFolderId: "f_linked",
      custodian: "Fidelity",
      accountNumber: "1234",
      isEntity: false,
      matchStatus: "AUTO_LINKED",
    });
    expect(arg.owners).toEqual([
      { cedarRidgeUserId: "eJ", clientSfId: "cJ", ownershipRole: "PRIMARY" },
    ]);
  });

  it("preserved account (a CONFIRMED/REJECTED owner row) is skipped, not re-scored", async () => {
    wireFolderLinks({ autoLinked: [{ sourceFolderId: "f_linked", householdSfId: "h1" }] });
    wireReads({ members: [memberRow()], liveAccounts: [accountRow()] });
    listAccountLinksByFolderSpy.mockResolvedValue([
      { custodian: "Fidelity", accountNumber: "1234", matchStatus: "CONFIRMED" },
    ]);

    const res = await route.POST(post());
    const body = await res.json();
    expect(body).toMatchObject({ accounts_preserved: 1, accounts_scored: 0 });
    expect(replaceCandidatesSpy).not.toHaveBeenCalled();
  });

  it("unkeyable account (NULL custodian/number) is counted, not written", async () => {
    wireFolderLinks({ autoLinked: [{ sourceFolderId: "f_linked", householdSfId: "h1" }] });
    wireReads({
      members: [memberRow()],
      liveAccounts: [accountRow({ custodian: null }), accountRow({ account_number: null })],
    });

    const res = await route.POST(post());
    const body = await res.json();
    expect(body).toMatchObject({ accounts_unkeyable: 2, accounts_scored: 0 });
    // PII-safe diagnostic: grouped by account_type + which id was null (no holder,
    // no account number). One custodian-null + one number-null, both type "IRA".
    expect(body.unkeyable_breakdown).toEqual({
      IRA: { both_null: 0, custodian_null: 1, number_null: 1 },
    });
    expect(replaceCandidatesSpy).not.toHaveBeenCalled();
  });

  it("dryRun=1: scores but writes NO owner rows; still writes the counts audit", async () => {
    wireFolderLinks({ autoLinked: [{ sourceFolderId: "f_linked", householdSfId: "h1" }] });
    wireReads({ members: [memberRow()], liveAccounts: [accountRow()] });

    const res = await route.POST(post({ url: "https://x/api/cron/asset-map-match?dryRun=1" }));
    const body = await res.json();
    expect(body).toMatchObject({ accounts_scored: 1, account_auto_linked: 1, dry_run: true });
    expect(replaceCandidatesSpy).not.toHaveBeenCalled();
    expect(accountAuditCall()).toBeTruthy();
  });

  it("counts audit is counts-only — no holder name, no account number", async () => {
    wireFolderLinks({ autoLinked: [{ sourceFolderId: "f_linked", householdSfId: "h1" }] });
    wireReads({
      members: [memberRow()],
      liveAccounts: [accountRow({ account_holder: "John Smith", account_number: "SECRET-1234" })],
    });

    await route.POST(post());
    const call = accountAuditCall()!;
    const entry = (call as unknown[])[2] as { detail: Record<string, unknown> };
    expect(entry.detail).toMatchObject({
      source: "acat-asset-map",
      accounts_scored: 1,
      account_auto_linked: 1,
      accounts_preserved: 0,
      accounts_unkeyable: 0,
    });
    const serialized = JSON.stringify(entry.detail);
    expect(serialized).not.toContain("John");
    expect(serialized).not.toContain("SECRET-1234");
  });

  it("resolveDeterministicOwners is consulted (structured no-op → falls through to fuzzy)", async () => {
    wireFolderLinks({ autoLinked: [{ sourceFolderId: "f_linked", householdSfId: "h1" }] });
    wireReads({ members: [memberRow()], liveAccounts: [accountRow()] });

    await route.POST(post());
    expect(resolveDeterministicSpy).toHaveBeenCalledWith(expect.anything(), {
      custodian: "Fidelity",
      accountNumber: "1234",
    });
  });
});
