import { beforeEach, describe, expect, it, vi } from "vitest";

// receiving-account-match (rework S6) — the derived receiving account for a
// transfer's linked asset-map registration, sourced from the Warehouse accounts+
// AUM feed (mirror.client_account_aum) matched by client_sf_id. Pure normalizer/
// matcher tested directly; getDerivedReceivingAccount tested against a fake tx
// (server-only + @/lib/rls mocked).
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
  normalizeRegistrationType,
  canonicalizeRegistrationType,
  matchReceivingAccount,
  getDerivedReceivingAccount,
  getDerivedReceivingAccounts,
  type AumAccountRow,
} from "@/lib/data/receiving-account-match";

const ID = { role: "OPERATIONS", email: "ops@example.com" };

describe("normalizeRegistrationType", () => {
  it("strips case/space/punctuation so source and feed vocab compare equal", () => {
    expect(normalizeRegistrationType("Roth IRA")).toBe("rothira");
    expect(normalizeRegistrationType("ROTH_IRA")).toBe("rothira");
    expect(normalizeRegistrationType("Roth-IRA")).toBe("rothira");
    expect(normalizeRegistrationType(null)).toBe("");
  });
});

describe("canonicalizeRegistrationType (synonym folding)", () => {
  it("folds the Traditional IRA family (bare 'IRA' → Traditional, owner rule)", () => {
    for (const s of ["IRA", "Traditional IRA", "Trad IRA", "traditional", "TRADITIONAL_IRA"]) {
      expect(canonicalizeRegistrationType(s)).toBe("traditional_ira");
    }
  });

  it("keeps other IRA families distinct (Roth/SEP/SIMPLE do NOT collapse to Traditional)", () => {
    expect(canonicalizeRegistrationType("Roth IRA")).toBe("roth_ira");
    expect(canonicalizeRegistrationType("Roth")).toBe("roth_ira");
    expect(canonicalizeRegistrationType("SEP IRA")).toBe("sep_ira");
    expect(canonicalizeRegistrationType("SIMPLE")).toBe("simple_ira");
    // and none of them equal the Traditional key
    expect(canonicalizeRegistrationType("Roth IRA")).not.toBe(
      canonicalizeRegistrationType("IRA"),
    );
  });

  it("unknown types fall back to their normalized form (exact matching still works)", () => {
    expect(canonicalizeRegistrationType("Individual")).toBe("individual");
    expect(canonicalizeRegistrationType("Joint Tenants")).toBe("jointtenants");
    expect(canonicalizeRegistrationType(null)).toBe("");
  });
});

describe("matchReceivingAccount", () => {
  const feed: AumAccountRow[] = [
    { account_type: "ROTH_IRA", account_status: "OPEN", apex_account_number: "5ZS85063" },
    { account_type: "Individual", account_status: "ACTIVE", apex_account_number: "1FB35231" },
    { account_type: "TRADITIONAL_IRA", account_status: "CLOSED", apex_account_number: "5SA18340" },
  ];

  it("same-type OPEN account → OPEN + the matched row (carries the real number)", () => {
    expect(matchReceivingAccount("Roth IRA", feed)).toEqual({
      status: "OPEN",
      match: feed[0],
    });
  });

  it("counts ACTIVE (funded) as open too", () => {
    expect(matchReceivingAccount("Individual", feed)).toEqual({
      status: "OPEN",
      match: feed[1],
    });
  });

  it("same-type but only CLOSED → TO_OPEN", () => {
    expect(matchReceivingAccount("Traditional IRA", feed)).toEqual({
      status: "TO_OPEN",
      match: null,
    });
  });

  it("no matching type → TO_OPEN", () => {
    expect(matchReceivingAccount("SEP IRA", feed)).toEqual({
      status: "TO_OPEN",
      match: null,
    });
  });

  it("unrecognized status is NOT treated as open (fail-safe toward TO_OPEN)", () => {
    const pending: AumAccountRow[] = [
      { account_type: "ROTH_IRA", account_status: "PENDING", apex_account_number: "5ZS85063" },
    ];
    expect(matchReceivingAccount("Roth IRA", pending)).toEqual({ status: "TO_OPEN", match: null });
  });

  it("SYNONYM: linked 'Traditional IRA' matches a feed account labeled 'IRA' (the Reynold Hayes case)", () => {
    const ira: AumAccountRow[] = [
      { account_type: "IRA", account_status: "ACTIVE", apex_account_number: "3KE60082" },
    ];
    expect(matchReceivingAccount("Traditional IRA", ira)).toEqual({
      status: "OPEN",
      match: ira[0],
    });
  });

  it("SYNONYM: works in reverse too — linked 'IRA'/'Trad IRA' matches a feed 'Traditional IRA'", () => {
    const trad: AumAccountRow[] = [
      { account_type: "Traditional IRA", account_status: "OPEN", apex_account_number: "5PZ30632" },
    ];
    expect(matchReceivingAccount("IRA", trad).status).toBe("OPEN");
    expect(matchReceivingAccount("Trad IRA", trad).status).toBe("OPEN");
  });

  it("SYNONYM does NOT over-match: linked 'Roth IRA' must NOT match a bare 'IRA' account", () => {
    const ira: AumAccountRow[] = [
      { account_type: "IRA", account_status: "ACTIVE", apex_account_number: "3KE60082" },
    ];
    expect(matchReceivingAccount("Roth IRA", ira)).toEqual({ status: "TO_OPEN", match: null });
  });

  it("empty/blank type → TO_OPEN (never a false OPEN)", () => {
    expect(matchReceivingAccount(null, feed)).toEqual({ status: "TO_OPEN", match: null });
    expect(matchReceivingAccount("", feed)).toEqual({ status: "TO_OPEN", match: null });
  });
});

describe("getDerivedReceivingAccount", () => {
  beforeEach(() => {
    withUserScopeSpy.mockClear();
    queryRawSpy.mockReset();
    queryRawSpy.mockResolvedValue([]);
  });

  it("null client_sf_id or null type → null without querying", async () => {
    expect(await getDerivedReceivingAccount(ID, { clientSfId: null, accountType: "Roth IRA" })).toBeNull();
    expect(await getDerivedReceivingAccount(ID, { clientSfId: "C-1", accountType: null })).toBeNull();
    expect(queryRawSpy).not.toHaveBeenCalled();
  });

  it("matches the feed by client_sf_id → OPEN + masked account NUMBER (no full number leaks)", async () => {
    queryRawSpy.mockResolvedValue([
      { account_type: "ROTH_IRA", account_status: "OPEN", apex_account_number: "5ZS85063" },
    ]);
    const res = await getDerivedReceivingAccount(ID, {
      clientSfId: "C-1",
      accountType: "Roth IRA",
    });
    expect(res).toEqual({
      registrationType: "Roth IRA",
      status: "OPEN",
      apexAccountMasked: "••••5063", // last-4 of the real account number
    });
    // Sourced from the accounts+AUM feed, matched by client_sf_id.
    const sql = (queryRawSpy.mock.calls[0][0] as TemplateStringsArray).join(" ");
    expect(sql).toContain("mirror.client_account_aum");
    expect(sql).toContain("client_sf_id =");
    expect(sql).toContain("apex_account_number");
    // no longer keyed off the (unfed) n8n account tables
    expect(sql).not.toContain("account_holder");
    expect(sql).not.toContain("cedar_ridge_user_id");
    // the full number never leaks into the payload
    expect(JSON.stringify(res)).not.toContain("5ZS85063");
  });

  it("funded ACTIVE account → OPEN + masked number", async () => {
    queryRawSpy.mockResolvedValue([
      { account_type: "Individual", account_status: "ACTIVE", apex_account_number: "1FB35231" },
    ]);
    const res = await getDerivedReceivingAccount(ID, {
      clientSfId: "C-1",
      accountType: "Individual",
    });
    expect(res).toEqual({
      registrationType: "Individual",
      status: "OPEN",
      apexAccountMasked: "••••5231",
    });
  });

  it("open account not yet in the AUM feed (null number) → OPEN, masked null (graceful)", async () => {
    queryRawSpy.mockResolvedValue([
      { account_type: "ROTH_IRA", account_status: "OPEN", apex_account_number: null },
    ]);
    const res = await getDerivedReceivingAccount(ID, {
      clientSfId: "C-1",
      accountType: "Roth IRA",
    });
    expect(res).toEqual({
      registrationType: "Roth IRA",
      status: "OPEN",
      apexAccountMasked: null,
    });
  });

  it("no feed account of that type → TO_OPEN, masked null", async () => {
    queryRawSpy.mockResolvedValue([
      { account_type: "Individual", account_status: "ACTIVE", apex_account_number: "8ZY00001" },
    ]);
    const res = await getDerivedReceivingAccount(ID, {
      clientSfId: "C-1",
      accountType: "Roth IRA",
    });
    expect(res).toEqual({ registrationType: "Roth IRA", status: "TO_OPEN", apexAccountMasked: null });
  });
});

describe("getDerivedReceivingAccounts (board batch)", () => {
  beforeEach(() => {
    withUserScopeSpy.mockClear();
    queryRawSpy.mockReset();
    queryRawSpy.mockResolvedValue([]);
  });

  it("returns an empty map without querying when no card can be matched", async () => {
    const result = await getDerivedReceivingAccounts(ID, [
      { transferId: "T-1", clientSfId: null, accountType: "Roth IRA" },
      { transferId: "T-2", clientSfId: "C-2", accountType: null },
    ]);
    expect(result).toEqual({});
    expect(queryRawSpy).not.toHaveBeenCalled();
  });

  it("matches multiple cards from one feed query and never returns full account numbers", async () => {
    queryRawSpy.mockResolvedValue([
      {
        client_sf_id: "C-1",
        account_type: "ROTH_IRA",
        account_status: "OPEN",
        apex_account_number: "5ZS85063",
      },
      {
        client_sf_id: "C-2",
        account_type: "Individual",
        account_status: "CLOSED",
        apex_account_number: "5SA18340",
      },
    ]);

    const result = await getDerivedReceivingAccounts(ID, [
      { transferId: "T-1", clientSfId: "C-1", accountType: "Roth IRA" },
      { transferId: "T-2", clientSfId: "C-2", accountType: "Individual" },
    ]);

    expect(queryRawSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      "T-1": {
        registrationType: "Roth IRA",
        status: "OPEN",
        apexAccountMasked: "••••5063",
      },
      "T-2": {
        registrationType: "Individual",
        status: "TO_OPEN",
        apexAccountMasked: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain("5ZS85063");
    expect(JSON.stringify(result)).not.toContain("5SA18340");
    const sql = (queryRawSpy.mock.calls[0][0] as TemplateStringsArray).join(" ");
    expect(sql).toContain("client_sf_id IN");
  });
});
