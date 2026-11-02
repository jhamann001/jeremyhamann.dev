import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// listAssignableAssetMapAccounts (rework S3/S4 read seam), WITHOUT a DB.
// server-only is stubbed; @/lib/rls (withUserScope) runs the real callback against
// a fake tx whose $queryRaw is a spy. Asserts the S4 reuse behavior (annotate
// already-linked instead of excluding, exclude only the current transfer's link),
// the recommended-by-deal-last-4 split, masking, and the empty-last-4 case.
vi.mock("server-only", () => ({}));

const { withUserScopeSpy, queryRawSpy } = vi.hoisted(() => {
  const queryRawSpy = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  const withUserScopeSpy = vi.fn(async (_id: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRaw: queryRawSpy }),
  );
  return { withUserScopeSpy, queryRawSpy };
});
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));

import {
  getAssignedAssetMapDetail,
  getAssetMapApprovalSnapshot,
  listAssignableAssetMapAccounts,
  resolveAssignableAssetMapAccount,
} from "@/lib/data/transfer-asset-map";

const ID = { role: "OPERATIONS", email: "ops@example.com" };
const ACCOUNT_ID = "d064886e-7275-40af-a78d-465795702104";
const OTHER_ACCOUNT_ID = "d064886e-7275-40af-a78d-465795702105";
const TX = { $queryRaw: queryRawSpy } as unknown as Prisma.TransactionClient;

function querySql(index: number): string {
  const [strings, ...values] = queryRawSpy.mock.calls[index];
  return Prisma.sql(strings as TemplateStringsArray, ...values).sql;
}

function row(over: Record<string, unknown> = {}) {
  return {
    account_id: ACCOUNT_ID,
    source_folder_id: "f1",
    household_name: "Stone Household",
    custodian: "Fidelity",
    account_number: "562501053333",
    account_type: "Individual",
    account_holder: "Sam Stone",
    total_value: "150000",
    linked_count: 0,
    linked_clients: [] as string[],
    ...over,
  };
}

beforeEach(() => {
  withUserScopeSpy.mockClear();
  queryRawSpy.mockReset();
  queryRawSpy.mockResolvedValue([]);
});

describe("listAssignableAssetMapAccounts", () => {
  it("includes already-linked accounts (annotated), excluding only the current transfer's link", async () => {
    await listAssignableAssetMapAccounts(ID, {
      hrqjSbevsbySbin8: null,
      currentTransferId: "t_current",
    });
    const sql = querySql(0);
    expect(sql).toContain("LEFT JOIN app.transfer");
    expect(sql).toContain("COUNT(t.id)"); // annotate the reuse count …
    expect(sql).not.toContain("t.id IS NULL"); // … instead of hiding linked accounts (S4)
    expect(sql).toContain("NOT EXISTS"); // exclude only the CURRENT transfer's own link
    expect(sql).toContain("mirror.acat_asset_map_account");
    // S5: numberless accounts included (no `account_number IS NOT NULL` filter),
    // key matched NULL-safe on number + type.
    expect(sql).not.toContain("a.account_number IS NOT NULL");
    expect(sql).toContain("asset_map_account_number IS NOT DISTINCT FROM");
    expect(sql).toContain("asset_map_account_type   IS NOT DISTINCT FROM");
  });

  it("dedupes the live set per CLIENT (newest run), not per source_folder_id — the repeated-account fix", async () => {
    await listAssignableAssetMapAccounts(ID, { hrqjSbevsbySbin8: null });
    const sql = querySql(0);
    // Keyed on the client identity (name, folder-id fallback for nameless), so a
    // stale mirror carrying one client under several live folders no longer
    // surfaces the SAME account once per folder ("Alfreda + Reynold Hayes" ×5).
    expect(sql).toContain("DISTINCT ON (COALESCE(NULLIF(btrim(h.client_name), ''), h.source_folder_id))");
    // Newest run wins.
    expect(sql).toContain("h.processed_at DESC NULLS LAST");
    // NOT the old per-folder key (that was the bug).
    expect(sql).not.toContain("DISTINCT ON (h.source_folder_id)");
  });

  it("S5: includes a numberless account — masked number null, account_type carried", async () => {
    queryRawSpy.mockResolvedValue([
      row({ account_number: null, account_type: "Roth IRA", custodian: "T. Rowe Price" }),
    ]);
    const res = await listAssignableAssetMapAccounts(ID, { hrqjSbevsbySbin8: "1188" });
    const all = [...res.recommended, ...res.others];
    expect(all).toHaveLength(1);
    // No number → not recommendable by last-4; lands in `others`.
    expect(res.recommended).toEqual([]);
    expect(all[0].accountId).toBe(ACCOUNT_ID);
    expect(all[0]).not.toHaveProperty("accountNumber");
    expect(all[0].accountNumberMasked).toBeNull();
    expect(all[0].accountType).toBe("Roth IRA");
  });

  it("annotates an already-linked account with reuse count + client names", async () => {
    queryRawSpy.mockResolvedValue([
      row({ linked_count: 2, linked_clients: ["Reynold Hayes"] }),
    ]);
    const res = await listAssignableAssetMapAccounts(ID, {
      hrqjSbevsbySbin8: null,
      currentTransferId: "t1",
    });
    const all = [...res.recommended, ...res.others];
    expect(all).toHaveLength(1);
    expect(all[0].linkedTransferCount).toBe(2);
    expect(all[0].linkedTransferClients).toEqual(["Reynold Hayes"]);
  });

  it("an unlinked account reports zero reuse", async () => {
    queryRawSpy.mockResolvedValue([row()]);
    const res = await listAssignableAssetMapAccounts(ID, { hrqjSbevsbySbin8: null });
    const all = [...res.recommended, ...res.others];
    expect(all[0].linkedTransferCount).toBe(0);
    expect(all[0].linkedTransferClients).toEqual([]);
  });

  it("recommends by the deal's last-4 and masks numbers; others carries the rest", async () => {
    queryRawSpy.mockResolvedValue([
      row({ account_number: "562501053333", custodian: "Fidelity" }), // ends 3333 → recommended
      row({ account_id: OTHER_ACCOUNT_ID, account_number: "971622147016", custodian: "Schwab", household_name: "Nguyen" }), // other
    ]);
    const res = await listAssignableAssetMapAccounts(ID, { hrqjSbevsbySbin8: "3333" });

    expect(res.recommended).toHaveLength(1);
    expect(res.recommended[0].custodian).toBe("Fidelity");
    expect(res.recommended[0].accountNumberMasked).toBe("••••3333");
    expect(res.recommended[0].accountNumberMasked).not.toContain("562501053333");
    expect(res.recommended[0].totalValue).toBe(150000);

    expect(res.others).toHaveLength(1);
    expect(res.others[0].custodian).toBe("Schwab");
    expect(res.others[0].accountNumberMasked).toBe("••••7016");
    expect(res.recommended[0].accountId).toBe(ACCOUNT_ID);
    expect(res.others[0].accountId).toBe(OTHER_ACCOUNT_ID);
    for (const option of [...res.recommended, ...res.others]) {
      expect(option).not.toHaveProperty("accountNumber");
      expect(option).not.toHaveProperty("account_number");
    }
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("562501053333");
    expect(serialized).not.toContain("971622147016");
  });

  it("keeps different accounts with colliding last-4 distinct by opaque ID", async () => {
    queryRawSpy.mockResolvedValue([
      row({ account_number: "562501053333" }),
      row({ account_id: OTHER_ACCOUNT_ID, account_number: "313196883333" }),
    ]);

    const res = await listAssignableAssetMapAccounts(ID, { hrqjSbevsbySbin8: "3333" });

    expect(res.recommended.map((account) => account.accountId)).toEqual([
      ACCOUNT_ID, OTHER_ACCOUNT_ID,
    ]);
    expect(res.recommended.map((account) => account.accountNumberMasked)).toEqual([
      "••••3333", "••••3333",
    ]);
    expect(res.others).toEqual([]);
    expect(JSON.stringify(res)).not.toMatch(/562501053333|313196883333/);
  });

  it("keeps numberless same-custodian siblings independently selectable", async () => {
    queryRawSpy.mockResolvedValue([
      row({ account_number: null, account_type: "Traditional IRA" }),
      row({ account_id: OTHER_ACCOUNT_ID, account_number: null, account_type: "Roth IRA" }),
    ]);

    const res = await listAssignableAssetMapAccounts(ID, { hrqjSbevsbySbin8: "3333" });

    expect(res.recommended).toEqual([]);
    expect(res.others.map(({ accountId, accountType, accountNumberMasked }) => ({
      accountId, accountType, accountNumberMasked,
    }))).toEqual([
      { accountId: ACCOUNT_ID, accountType: "Traditional IRA", accountNumberMasked: null },
      { accountId: OTHER_ACCOUNT_ID, accountType: "Roth IRA", accountNumberMasked: null },
    ]);
  });

  it("no deal last-4 → nothing recommended; the full list is in others", async () => {
    queryRawSpy.mockResolvedValue([row(), row({ account_number: "971622147016", custodian: "Schwab" })]);
    const res = await listAssignableAssetMapAccounts(ID, { hrqjSbevsbySbin8: null });
    expect(res.recommended).toEqual([]);
    expect(res.others).toHaveLength(2);
  });

  it("last-4 with punctuation/short deal value is normalized (…-3333 → 3333)", async () => {
    queryRawSpy.mockResolvedValue([row({ account_number: "562501053333" })]);
    const res = await listAssignableAssetMapAccounts(ID, { hrqjSbevsbySbin8: "xxxx-3333" });
    expect(res.recommended).toHaveLength(1);
  });
});

describe("resolveAssignableAssetMapAccount", () => {
  it("resolves the server-side durable key in the caller's existing transaction", async () => {
    queryRawSpy.mockResolvedValue([row()]);

    const result = await resolveAssignableAssetMapAccount(TX, ACCOUNT_ID);

    expect(result).toEqual({
      sourceFolderId: "f1",
      custodian: "Fidelity",
      accountNumber: "562501053333",
      accountType: "Individual",
    });
    expect(withUserScopeSpy).not.toHaveBeenCalled();
    expect(queryRawSpy).toHaveBeenCalledTimes(1);
    const params = queryRawSpy.mock.calls[0].slice(2).filter((value) => typeof value !== "object"); // shared SQL fragment, then ID, then the empty scope
    expect(params).toEqual([ACCOUNT_ID]);
    expect(params).not.toContain("3333");
    expect(params).not.toContain("562501053333");
  });

  it("shares current household eligibility and resolves only the selected representative ID", async () => {
    await listAssignableAssetMapAccounts(ID);
    await resolveAssignableAssetMapAccount(TX, ACCOUNT_ID);

    // Both queries interpolate the same fragment, preventing latest-run drift.
    expect(queryRawSpy.mock.calls[1][1]).toBe(queryRawSpy.mock.calls[0][1]);
    const listSql = querySql(0);
    const sql = querySql(1);
    expect(sql).toContain("h.superseded_by IS NULL");
    expect(sql).toContain("DISTINCT ON (COALESCE(NULLIF(btrim(h.client_name), ''), h.source_folder_id))");
    expect(sql).toContain("h.processed_at DESC NULLS LAST, h.synced_at DESC, h.id");
    expect(sql).toContain("a.custodian IS NOT NULL");
    expect(listSql).toContain("MIN(accts.account_id) AS account_id");
    expect(sql).toContain("WHERE a.id = ?");
    expect(sql).toContain("SELECT MIN(sibling.id)");
    expect(sql).toContain("sibling.account_number IS NOT DISTINCT FROM a.account_number");
    expect(sql).toContain("sibling.account_type IS NOT DISTINCT FROM a.account_type");
    expect(sql).toContain("sibling.account_holder IS NOT DISTINCT FROM a.account_holder");
    expect(sql).toContain("sibling.total_value IS NOT DISTINCT FROM a.total_value");
    expect(sql).not.toContain("app.transfer");
    // Adding the physical ID to GROUP BY would undo the picker's logical dedupe.
    const groupBy = listSql.split("GROUP BY")[1].split("ORDER BY")[0];
    expect(groupBy).not.toContain("accts.account_id");
  });

  it("limits the list and the resolver to folders linked to the intake client or household", async () => {
    await listAssignableAssetMapAccounts(ID, { client: { clientSfId: "SF-SYN-1", householdSfId: "HH-SYN-1" } });
    await resolveAssignableAssetMapAccount(TX, ACCOUNT_ID, { clientSfId: "SF-SYN-1", householdSfId: null });
    for (const index of [0, 1]) {
      const sql = querySql(index);
      expect(sql).toContain("FROM mirror.acat_asset_map_link l");
      expect(sql).toContain("l.source_folder_id = live.source_folder_id");
      expect(sql).toContain("l.match_status IN ('AUTO_LINKED', 'CONFIRMED')");
      expect(sql).toContain("l.client_sf_id");
    }
    expect(querySql(0)).toContain("l.household_sf_id");
    expect(querySql(1)).not.toContain("l.household_sf_id");
    await listAssignableAssetMapAccounts(ID);
    expect(querySql(2)).not.toContain("acat_asset_map_link");
  });

  it("returns null when RLS or current eligibility excludes the requested ID", async () => {
    // An unknown, superseded, older-run, or RLS-invisible ID yields no row from
    // the shared SQL. The resolver must never fall back to a number/last-4 match.
    queryRawSpy.mockResolvedValue([]);

    expect(await resolveAssignableAssetMapAccount(TX, OTHER_ACCOUNT_ID)).toBeNull();
    expect(queryRawSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty ID without reading the inventory", async () => {
    expect(await resolveAssignableAssetMapAccount(TX, "")).toBeNull();
    expect(queryRawSpy).not.toHaveBeenCalled();
  });

  it("resolves a reused numberless account without inventing a number", async () => {
    queryRawSpy.mockResolvedValue([
      row({ account_number: null, account_type: "Roth IRA", linked_count: 2 }),
    ]);

    expect(await resolveAssignableAssetMapAccount(TX, ACCOUNT_ID)).toEqual({
      sourceFolderId: "f1",
      custodian: "Fidelity",
      accountNumber: null,
      accountType: "Roth IRA",
    });
  });
});

// --- getAssignedAssetMapDetail (funding-picture hub expansion) ---------------

const KEY = {
  folderId: "f1",
  custodian: "Fidelity",
  accountNumber: "562501053333" as string | null,
  accountType: "Individual" as string | null,
};

function accountRow(over: Record<string, unknown> = {}) {
  return {
    id: "acct-1",
    household_name: "Stone Household",
    account_holder: "Sam Stone",
    account_type: "Individual",
    statement_date: new Date("2026-06-30T00:00:00Z"),
    cash_balance: "12.5",
    total_value: "150000",
    ...over,
  };
}

function positionRow(over: Record<string, unknown> = {}) {
  return {
    symbol: "VTI",
    description: "Vanguard Total Stock Market ETF",
    quantity: "12.5",
    market_value: "150000",
    transfer_eligible: "eligible",
    effective_status: null,
    ...over,
  };
}

describe("getAssignedAssetMapDetail", () => {
  it("happy path: two reads in ONE scope, live-CTE + key predicates, masked number only", async () => {
    queryRawSpy
      .mockResolvedValueOnce([accountRow()])
      .mockResolvedValueOnce([positionRow()]);

    const detail = await getAssignedAssetMapDetail(ID, KEY);

    expect(withUserScopeSpy).toHaveBeenCalledTimes(1);
    expect(queryRawSpy).toHaveBeenCalledTimes(2);

    const accountSql = (queryRawSpy.mock.calls[0][0] as TemplateStringsArray).join(" ");
    expect(accountSql).toContain("superseded_by IS NULL");
    // Stays keyed PER FOLDER (it resolves a specific stored folder key) — this is
    // the intentional divergence from the picker's per-client dedupe.
    expect(accountSql).toContain("DISTINCT ON (h.source_folder_id)");
    expect(accountSql).not.toContain("btrim(h.client_name)");
    expect(accountSql).toContain("live.source_folder_id =");
    expect(accountSql).toContain("a.custodian =");
    // S5: NULL-safe number + type match (numberless accounts).
    expect(accountSql).toContain("a.account_number IS NOT DISTINCT FROM");
    expect(accountSql).toContain("a.account_type   IS NOT DISTINCT FROM");
    expect(accountSql).toContain("mirror.acat_asset_map_account");

    const positionsSql = (queryRawSpy.mock.calls[1][0] as TemplateStringsArray).join(" ");
    expect(positionsSql).toContain("account_id =");
    expect(positionsSql).toContain("ORDER BY market_value DESC NULLS LAST");

    expect(detail).not.toBeNull();
    expect(detail!.accountNumberMasked).toBe("••••3333");
    // The raw number never leaves the seam — masked property only.
    expect(detail).not.toHaveProperty("accountNumber");
    expect(JSON.stringify(detail)).not.toContain("562501053333");
  });

  it("coerces Decimals to numbers, keeps SQL NULLs null, and resolves eligibility", async () => {
    queryRawSpy
      .mockResolvedValueOnce([accountRow({ cash_balance: null })])
      .mockResolvedValueOnce([
        positionRow({ quantity: "12.5", market_value: "150000" }),
        positionRow({
          symbol: "XYZ",
          quantity: null,
          market_value: null,
          transfer_eligible: "eligible",
          effective_status: "review",
        }),
      ]);

    const detail = await getAssignedAssetMapDetail(ID, KEY);
    expect(detail!.totalValue).toBe(150000);
    expect(detail!.cashBalance).toBeNull();
    expect(detail!.statementDate).toBe("2026-06-30");
    expect(detail!.positions[0]).toMatchObject({
      quantity: 12.5,
      marketValue: 150000,
      eligibility: "eligible", // effective_status null → transfer_eligible
    });
    expect(detail!.positions[1]).toMatchObject({
      quantity: null,
      marketValue: null,
      eligibility: "review", // effective_status wins over transfer_eligible
    });
  });

  it("no live account row → null, and the positions query is never issued", async () => {
    queryRawSpy.mockResolvedValueOnce([]);
    const detail = await getAssignedAssetMapDetail(ID, KEY);
    expect(detail).toBeNull();
    expect(queryRawSpy).toHaveBeenCalledTimes(1);
  });

  it("account found with zero positions → positions: [] (not null)", async () => {
    queryRawSpy.mockResolvedValueOnce([accountRow()]).mockResolvedValueOnce([]);
    const detail = await getAssignedAssetMapDetail(ID, KEY);
    expect(detail!.positions).toEqual([]);
  });

  it("S5: a numberless key resolves by type; masked number is null", async () => {
    queryRawSpy
      .mockResolvedValueOnce([accountRow({ account_type: "Roth IRA" })])
      .mockResolvedValueOnce([]);
    const detail = await getAssignedAssetMapDetail(ID, {
      folderId: "f1",
      custodian: "T. Rowe Price",
      accountNumber: null,
      accountType: "Roth IRA",
    });
    expect(detail).not.toBeNull();
    expect(detail!.accountNumberMasked).toBeNull();
    expect(detail!.accountType).toBe("Roth IRA");
  });
});


describe("approval snapshot saved selection resolution", () => {
  it("resolves saved overrides, pipeline flags and eligibility inside the caller transaction", async () => {
    queryRawSpy.mockResolvedValueOnce([accountRow()]).mockResolvedValueOnce([
      positionRow({ symbol: "OVERRIDE", override_is_transferring: false, pipeline_transferring: true, effective_status: "ACAT" }),
      positionRow({ symbol: "PIPELINE", override_is_transferring: null, pipeline_transferring: false, effective_status: "ACAT" }),
      positionRow({ symbol: "ELIGIBLE", override_is_transferring: null, pipeline_transferring: null, effective_status: "ACAT" }),
      positionRow({ symbol: "REVIEW", override_is_transferring: null, pipeline_transferring: null, effective_status: "REVIEW" }),
    ]);
    const snapshot = await getAssetMapApprovalSnapshot(TX, { ...KEY, transferId: "synthetic-transfer" });
    expect(snapshot?.positions.map((position) => [position.symbol, position.isTransferring])).toEqual([
      ["OVERRIDE", false], ["PIPELINE", false], ["ELIGIBLE", true], ["REVIEW", false],
    ]);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
    expect(querySql(1)).toContain("LEFT JOIN app.transfer_position_flag");
    expect(queryRawSpy.mock.calls[1].slice(1)).toContain("synthetic-transfer");
  });
});
