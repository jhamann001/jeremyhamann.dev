import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { AssetMapLink } from "@/lib/data/asset-map-link";

// listReviewQueue (P2.3 read seam) composition + shape, WITHOUT a DB. server-only
// is stubbed; @/lib/rls (withUserScope) and the link-store's listLinksByStatus
// are mocked so we drive the two-group read + the LIVE candidate recompute
// through the REAL matcher (lib/data/asset-map-match) — the tiers/candidates
// asserted here are the real verdicts. The two DB reads (candidate clients +
// household summaries) are wired by SQL on a fake tx. Follows the
// asset-map-match-route.test.ts idiom.
vi.mock("server-only", () => ({}));

const { withUserScopeSpy, listLinksSpy, getLinkSpy, queryRawSpy } = vi.hoisted(() => {
  const queryRawSpy = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  const withUserScopeSpy = vi.fn(async (_id: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRaw: queryRawSpy }),
  );
  const listLinksSpy = vi.fn(async (_tx: unknown, _status: string) => [] as AssetMapLink[]);
  const getLinkSpy = vi.fn();
  return { withUserScopeSpy, listLinksSpy, getLinkSpy, queryRawSpy };
});

vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
vi.mock("@/lib/data/asset-map-link", () => ({
  listLinksByStatus: listLinksSpy,
  getLink: getLinkSpy,
}));

import {
  listReviewQueue,
  listAccountReviewQueue,
  listKnownAccounts,
  resolveClientForLink,
  resolveAccountForReview,
} from "@/lib/data/asset-map-review";

const ID = { role: "OPERATIONS", email: "ops@example.com" };

function link(over: Partial<AssetMapLink> & { sourceFolderId: string }): AssetMapLink {
  return {
    clientSfId: null,
    cedarRidgeUserId: null,
    householdSfId: null,
    matchStatus: "NEEDS_REVIEW",
    confidence: null,
    confirmedBy: null,
    confirmedAt: null,
    syncedAt: new Date("2026-07-20T00:00:00.000Z"),
    ...over,
  };
}

// One candidate client row as readCandidateClients reads it from mirror.client.
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
// One household-summary row (client_name + aggregated accounts) by folder.
function summaryRow(over: Record<string, unknown> = {}) {
  return {
    source_folder_id: "f_needs",
    client_name: "John Smith",
    total_value: "125000.50",
    account_count: 2,
    custodians: ["FIDELITY", "SCHWAB"],
    ...over,
  };
}

// Wire the two reads by SQL content; resolveClientForLink is distinguished by
// its `WHERE sf_id =` clause.
function wire(opts: { candidates?: unknown[]; summaries?: unknown[] }) {
  queryRawSpy.mockImplementation(async (...args: unknown[]) => {
    const sql = (args[0] as TemplateStringsArray).join(" ");
    if (sql.includes("acat_asset_map_household")) return opts.summaries ?? [];
    if (sql.includes("mirror.client")) return opts.candidates ?? [];
    return [];
  });
}

beforeEach(() => {
  withUserScopeSpy.mockClear();
  listLinksSpy.mockReset();
  getLinkSpy.mockReset();
  listLinksSpy.mockResolvedValue([]);
  queryRawSpy.mockReset();
  queryRawSpy.mockResolvedValue([]);
});

describe("listReviewQueue — empty", () => {
  it("no NEEDS_REVIEW/AUTO_LINKED links → [] without touching the DB reads", async () => {
    const rows = await listReviewQueue(ID);
    expect(rows).toEqual([]);
    // Both statuses queried; no household/client read (early return).
    expect(listLinksSpy).toHaveBeenCalledTimes(2);
    expect(queryRawSpy).not.toHaveBeenCalled();
  });
});

describe("listReviewQueue — two groups + live recompute", () => {
  it("returns NEEDS_REVIEW then AUTO_LINKED, each with recomputed candidates + coerced summary", async () => {
    listLinksSpy.mockImplementation(async (_tx: unknown, status: string) => {
      if (status === "NEEDS_REVIEW") return [link({ sourceFolderId: "f_needs" })];
      if (status === "AUTO_LINKED")
        return [
          link({
            sourceFolderId: "f_auto",
            matchStatus: "AUTO_LINKED",
            clientSfId: "c1",
            householdSfId: "h1",
            cedarRidgeUserId: "e1",
            confidence: 0.97,
          }),
        ];
      return [];
    });
    wire({
      candidates: [clientRow()],
      summaries: [
        summaryRow(),
        summaryRow({ source_folder_id: "f_auto", client_name: "John Smith", account_count: 1, custodians: ["APEX"] }),
      ],
    });

    const rows = await listReviewQueue(ID);

    // Order: NEEDS_REVIEW first, then AUTO_LINKED.
    expect(rows.map((r) => r.sourceFolderId)).toEqual(["f_needs", "f_auto"]);
    expect(rows.map((r) => r.currentLink.matchStatus)).toEqual([
      "NEEDS_REVIEW",
      "AUTO_LINKED",
    ]);

    const needs = rows[0];
    expect(needs.householdName).toBe("John Smith");
    // Decimal → number; int/bigint → number.
    expect(needs.accountsSummary.totalValue).toBe(125000.5);
    expect(needs.accountsSummary.accountCount).toBe(2);
    expect(needs.accountsSummary.custodians).toEqual(["FIDELITY", "SCHWAB"]);
    // Live recompute against the REAL matcher: "John Smith" ⇄ John Smith client.
    expect(needs.candidates.length).toBeGreaterThan(0);
    const top = needs.candidates[0];
    expect(top.clientSfId).toBe("c1");
    expect(top.name).toBe("John Smith");
    expect(top.confidence).toBe(1); // exact two-token Jaccard
    expect(top.sharedTokens).toBe(2);

    // AUTO_LINKED row carries the machine link on currentLink + the same live
    // candidates so ops can override.
    const auto = rows[1];
    expect(auto.currentLink.clientSfId).toBe("c1");
    expect(auto.currentLink.confidence).toBe(0.97);
    expect(auto.candidates[0].clientSfId).toBe("c1");
  });

  it("a queued household whose live row vanished still appears (null name, empty summary, no candidates)", async () => {
    listLinksSpy.mockImplementation(async (_tx: unknown, status: string) =>
      status === "NEEDS_REVIEW" ? [link({ sourceFolderId: "f_ghost" })] : [],
    );
    wire({ candidates: [clientRow()], summaries: [] }); // no summary for the folder

    const rows = await listReviewQueue(ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].householdName).toBeNull();
    expect(rows[0].accountsSummary).toEqual({
      accountCount: 0,
      custodians: [],
      totalValue: null,
    });
    // normalizeName(null) → no people → UNMATCHED_EMPTY → no candidates.
    expect(rows[0].candidates).toEqual([]);
  });
});

describe("listAccountReviewQueue — unresolved folder (fold-in)", () => {
  it("surfaces an unresolved folder's LIVE accounts with folderResolved:false, empty candidates, masked number, + ranked household candidates", async () => {
    // No queued account-link rows (the reconcile pass writes none pre-resolution),
    // but the folder link is NEEDS_REVIEW with no household → the fold-in surface.
    listLinksSpy.mockImplementation(async (_tx: unknown, status: string) =>
      status === "NEEDS_REVIEW"
        ? [link({ sourceFolderId: "f_unres", matchStatus: "NEEDS_REVIEW", householdSfId: null })]
        : [],
    );
    queryRawSpy.mockImplementation(async (...args: unknown[]) => {
      const sql = (args[0] as TemplateStringsArray).join(" ");
      if (sql.includes("acat_asset_map_account_link")) return []; // no queued account rows
      if (sql.includes("array_agg")) return [summaryRow({ source_folder_id: "f_unres" })];
      if (sql.includes("a.account_holder"))
        return [
          {
            account_id: "opaque-unresolved-account",
            custodian: "FIDELITY",
            account_number: "987654",
            account_holder: "Willie Ortiz",
            total_value: "5000.00",
          },
        ];
      if (sql.includes("mirror.client")) return [clientRow()];
      return [];
    });

    const folders = await listAccountReviewQueue(ID);
    expect(folders).toHaveLength(1);
    const f = folders[0];
    expect(f.sourceFolderId).toBe("f_unres");
    expect(f.folderResolved).toBe(false);
    expect(f.householdSfId).toBeNull();
    // Ranked household candidates recomputed live (John Smith summary ⇄ John Smith client).
    expect(f.householdCandidates[0]?.clientSfId).toBe("c1");

    expect(f.accounts).toHaveLength(1);
    const a = f.accounts[0];
    expect(a.accountNumberMasked).toBe("••••7654");
    expect(a.accountId).toBe("opaque-unresolved-account");
    expect(a).not.toHaveProperty("accountNumber");
    expect(JSON.stringify(folders)).not.toContain("987654");
    expect(a.status).toBe("NEEDS_REVIEW");
    expect(a.candidates).toEqual([]); // no member pool yet — owner picked after the fold-in
    expect(a.totalValue).toBe(5000);
  });
});

describe("listKnownAccounts — already-known surface (S2)", () => {
  // One raw account-link row as the store's $queryRaw returns it (snake_case).
  function acctLinkRow(over: Record<string, unknown> = {}) {
    return {
      source_folder_id: "f_known",
      custodian: "Fidelity",
      account_number: "111100002222",
      cedar_ridge_user_id: "e1",
      client_sf_id: "C-1",
      ownership_role: "PRIMARY",
      is_entity: false,
      match_status: "AUTO_LINKED",
      confidence: "0.970",
      confirmed_by: null,
      confirmed_at: null,
      synced_at: new Date("2026-07-20T00:00:00.000Z"),
      ...over,
    };
  }

  it("groups AUTO_LINKED + CONFIRMED by folder, resolves owner names, masks the number", async () => {
    queryRawSpy.mockImplementation(async (...args: unknown[]) => {
      const sql = (args[0] as TemplateStringsArray).join(" ");
      // listAccountLinksByStatus (status is a bound param at args[1]).
      if (sql.includes("acat_asset_map_account_link") && sql.includes("match_status =")) {
        const status = args[1];
        if (status === "AUTO_LINKED") return [acctLinkRow()];
        return []; // no CONFIRMED rows in this case
      }
      // listAccountLinksByFolder (all owner rows for the folder).
      if (sql.includes("acat_asset_map_account_link") && sql.includes("source_folder_id =")) {
        return [acctLinkRow()];
      }
      if (sql.includes("array_agg")) return [summaryRow({ source_folder_id: "f_known" })];
      if (sql.includes("a.account_holder"))
        return [
          {
            account_id: "opaque-known-account",
            custodian: "Fidelity",
            account_number: "111100002222",
            account_holder: "Sam Stone",
            total_value: "150000",
          },
        ];
      if (sql.includes("mirror.client")) return [clientRow({ sf_id: "C-1", first_name: "Sam", last_name: "Stone" })];
      return [];
    });

    const folders = await listKnownAccounts(ID);
    expect(folders).toHaveLength(1);
    const f = folders[0];
    expect(f.sourceFolderId).toBe("f_known");
    expect(f.accounts).toHaveLength(1);
    const a = f.accounts[0];
    expect(a.status).toBe("AUTO_LINKED");
    expect(a.accountNumberMasked).toBe("••••2222");
    expect(a.accountId).toBe("opaque-known-account");
    expect(a).not.toHaveProperty("accountNumber");
    expect(JSON.stringify(folders)).not.toContain("111100002222");
    expect(a.isEntity).toBe(false);
    expect(a.owners).toEqual([
      { clientSfId: "C-1", name: "Sam Stone", cedarRidgeUserId: "e1" },
    ]);
    expect(a.totalValue).toBe(150000);
  });

  it("no AUTO_LINKED / CONFIRMED rows → [] without folder reads", async () => {
    queryRawSpy.mockResolvedValue([]);
    const folders = await listKnownAccounts(ID);
    expect(folders).toEqual([]);
  });
});

describe("resolveClientForLink — validation read", () => {
  function fakeTx(rows: unknown[]) {
    const queryRaw = vi.fn(async (..._args: unknown[]) => rows);
    return {
      tx: { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
      queryRaw,
    };
  }

  it("empty id → null without querying", async () => {
    const { tx, queryRaw } = fakeTx([]);
    expect(await resolveClientForLink(tx, "")).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("real client → resolved ids; binds the sf_id param + excludes placeholders", async () => {
    const { tx, queryRaw } = fakeTx([
      { sf_id: "003AAA", household_id: "001HHH", cedar_ridge_user_id: "crw_1" },
    ]);
    const resolved = await resolveClientForLink(tx, "003AAA");
    expect(resolved).toEqual({
      clientSfId: "003AAA",
      householdSfId: "001HHH",
      cedarRidgeUserId: "crw_1",
    });
    const [strings, ...params] = queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).toContain("FROM mirror.client");
    expect(sql).toContain("WHERE sf_id = ");
    expect(sql).toContain("sf_id <> household_id"); // placeholder guard
    expect(params).toEqual(["003AAA"]);
  });

  it("no such (or placeholder / out-of-scope) client → null", async () => {
    const { tx } = fakeTx([]);
    expect(await resolveClientForLink(tx, "003ZZZ")).toBeNull();
  });
});


// Raw owner rows keep the durable key server-side; DTOs must not copy it out.
function ownerRow(over: Record<string, unknown> = {}) {
  return {
    source_folder_id: "f_resolved",
    custodian: "Synthetic Custodian",
    account_number: "SYNTHETIC-11001234",
    cedar_ridge_user_id: "e1",
    client_sf_id: "c1",
    ownership_role: "PRIMARY",
    is_entity: false,
    match_status: "NEEDS_REVIEW",
    confidence: "0.970",
    confirmed_by: null,
    confirmed_at: null,
    synced_at: new Date("2026-07-20T00:00:00.000Z"),
    ...over,
  };
}

function wireReviewAccounts(ownerRows: ReturnType<typeof ownerRow>[], liveRows: unknown[]) {
  getLinkSpy.mockResolvedValue(link({
    sourceFolderId: "f_resolved",
    matchStatus: "CONFIRMED",
    householdSfId: "h1",
  }));
  queryRawSpy.mockImplementation(async (...args: unknown[]) => {
    const sql = (args[0] as TemplateStringsArray).join(" ");
    if (sql.includes("acat_asset_map_account_link")) {
      return sql.includes("match_status =")
        ? ownerRows.filter((row) => row.match_status === args[1])
        : ownerRows;
    }
    if (sql.includes("array_agg")) return [summaryRow({ source_folder_id: "f_resolved" })];
    if (sql.includes("a.account_holder")) return liveRows;
    if (sql.includes("mirror.client")) return [clientRow()];
    return [];
  });
}

function liveAccount(accountId: string, accountNumber: string) {
  return {
    account_id: accountId,
    custodian: "Synthetic Custodian",
    account_number: accountNumber,
    account_holder: "John Smith",
    total_value: "5000.50",
  };
}

const NUMBER_A = "SYNTHETIC-11001234";
const NUMBER_B = "SYNTHETIC-99001234";

function assertNoRawNumbers(folders: { accounts: unknown[] }[]) {
  const serialized = JSON.stringify(folders);
  expect(serialized).not.toContain(NUMBER_A);
  expect(serialized).not.toContain(NUMBER_B);
  for (const folder of folders) {
    for (const account of folder.accounts) expect(account).not.toHaveProperty("accountNumber");
  }
}

describe("review DTOs — private account keys", () => {
  it("resolved queue preserves distinct IDs for same-last-four accounts and serializes only masked values", async () => {
    wireReviewAccounts([
      ownerRow(),
      ownerRow({ account_number: NUMBER_B }),
    ], [liveAccount("opaque-a", NUMBER_A), liveAccount("opaque-b", NUMBER_B)]);

    const folders = await listAccountReviewQueue(ID);
    expect(folders).toHaveLength(1);
    expect(folders[0].folderResolved).toBe(true);
    expect(folders[0].accounts.map((row) => row.accountId)).toEqual(["opaque-a", "opaque-b"]);
    expect(folders[0].accounts.map((row) => row.accountNumberMasked)).toEqual(["••••1234", "••••1234"]);
    expect(folders[0].accounts[0].totalValue).toBe(5000.5);
    expect(folders[0].accounts[0].candidates[0]?.clientSfId).toBe("c1");
    assertNoRawNumbers(folders);
  });

  it("unresolved queue retains distinct same-last-four accounts without leaking raw keys", async () => {
    listLinksSpy.mockImplementation(async (_tx: unknown, status: string) =>
      status === "NEEDS_REVIEW" ? [link({ sourceFolderId: "f_resolved" })] : [],
    );
    wireReviewAccounts([], [liveAccount("opaque-a", NUMBER_A), liveAccount("opaque-b", NUMBER_B)]);

    const folders = await listAccountReviewQueue(ID);
    expect(folders).toHaveLength(1);
    expect(folders[0].folderResolved).toBe(false);
    expect(folders[0].accounts.map((row) => row.accountId)).toEqual(["opaque-a", "opaque-b"]);
    expect(folders[0].accounts.every((row) => row.candidates.length === 0)).toBe(true);
    assertNoRawNumbers(folders);
  });

  it("known AUTO_LINKED and CONFIRMED accounts retain distinct IDs with no raw keys", async () => {
    wireReviewAccounts([
      ownerRow({ match_status: "AUTO_LINKED" }),
      ownerRow({ account_number: NUMBER_B, match_status: "CONFIRMED" }),
    ], [liveAccount("opaque-a", NUMBER_A), liveAccount("opaque-b", NUMBER_B)]);

    const folders = await listKnownAccounts(ID);
    expect(folders).toHaveLength(1);
    expect(folders[0].accounts.map((row) => row.accountId)).toEqual(["opaque-a", "opaque-b"]);
    expect(folders[0].accounts.map((row) => row.status)).toEqual(["AUTO_LINKED", "CONFIRMED"]);
    expect(folders[0].accounts[1].owners[0]?.clientSfId).toBe("c1");
    assertNoRawNumbers(folders);
  });

  it.each(["1", "1234"])("fully masks short source account numbers (%s)", async (number) => {
    wireReviewAccounts([ownerRow({ account_number: number })], [liveAccount("opaque-short", number)]);
    const folders = await listAccountReviewQueue(ID);
    expect(folders[0].accounts[0].accountNumberMasked).toBe("••••");
    expect(folders[0].accounts[0]).not.toHaveProperty("accountNumber");
  });

  it("keeps stale pending and known records visible with null IDs and masked numbers", async () => {
    wireReviewAccounts([ownerRow()], []);
    const queued = await listAccountReviewQueue(ID);
    expect(queued[0].accounts[0]).toMatchObject({
      accountId: null,
      accountNumberMasked: "••••1234",
      totalValue: null,
      status: "NEEDS_REVIEW",
    });
    assertNoRawNumbers(queued);

    wireReviewAccounts([ownerRow({ match_status: "CONFIRMED" })], []);
    const known = await listKnownAccounts(ID);
    expect(known[0].accounts[0]).toMatchObject({
      accountId: null,
      accountNumberMasked: "••••1234",
      totalValue: null,
      status: "CONFIRMED",
    });
    assertNoRawNumbers(known);
  });
});

describe("resolveAccountForReview — scoped opaque reference", () => {
  function fakeTx(rows: unknown[]) {
    const queryRaw = vi.fn(async (..._args: unknown[]) => rows);
    return {
      tx: { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
      queryRaw,
    };
  }

  const rawKey = {
    source_folder_id: "folder-resolved-on-server",
    custodian: "Synthetic Custodian",
    account_number: NUMBER_A,
  };

  it.each(["", "   ", "a".repeat(257)])("rejects invalid reference length before querying", async (accountId) => {
    const { tx, queryRaw } = fakeTx([]);
    expect(await resolveAccountForReview(tx, accountId)).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("resolves the complete durable key using a parameterized live-per-folder query", async () => {
    const { tx, queryRaw } = fakeTx([rawKey]);
    expect(await resolveAccountForReview(tx, "opaque-selected-account")).toEqual({
      sourceFolderId: rawKey.source_folder_id,
      custodian: rawKey.custodian,
      accountNumber: NUMBER_A,
    });
    const [strings, ...params] = queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toContain("mirror.acat_asset_map_household");
    expect(sql).toContain("mirror.acat_asset_map_account");
    expect(sql).toContain("DISTINCT ON (source_folder_id)");
    expect(sql).toContain("superseded_by IS NULL");
    expect(sql).toContain("source_folder_id IS NOT NULL");
    expect(sql).toContain("processed_at DESC NULLS LAST");
    expect(sql).toContain("synced_at DESC");
    expect(sql).toMatch(/a\.id\s*=\s*\?/);
    expect(sql).not.toContain("client_name"); // review does not use the transfer picker's client-name inventory
    expect(params).toEqual(["opaque-selected-account"]);
  });

  it("missing, stale, superseded or out-of-scope references return null when the scoped read returns no rows", async () => {
    const { tx } = fakeTx([]);
    expect(await resolveAccountForReview(tx, "unresolvable-account")).toBeNull();
  });

  it.each([
    { custodian: null },
    { custodian: "" },
    { account_number: null },
    { account_number: "" },
  ])("rejects an incomplete durable key: %j", async (missing) => {
    const { tx } = fakeTx([{ ...rawKey, ...missing }]);
    expect(await resolveAccountForReview(tx, "opaque-selected-account")).toBeNull();
  });
});
