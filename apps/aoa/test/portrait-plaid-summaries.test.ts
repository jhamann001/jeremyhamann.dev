import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getClientWithHousehold: vi.fn(),
  dealsForClient: vi.fn(),
  dealsForHousehold: vi.fn(),
  investmentAccountsForClient: vi.fn(),
  householdInvestmentAumState: vi.fn(),
  apexAccountsForClient: vi.fn(),
  taxBudgetForClient: vi.fn(),
  logDetailTiming: vi.fn(),
  summariesEnabled: vi.fn(() => false),
  linkedExternalSummariesForClient: vi.fn(),
}));

vi.mock("@/lib/data/clients", () => ({
  getClientWithHousehold: mocks.getClientWithHousehold,
}));
vi.mock("@/lib/data/deals", () => ({
  dealsForClient: mocks.dealsForClient,
  dealsForHousehold: mocks.dealsForHousehold,
}));
vi.mock("@/lib/data/account-aum", () => ({
  apexAccountsForClient: mocks.apexAccountsForClient,
}));
vi.mock("@/lib/data/investment-accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/investment-accounts")>()),
  investmentAccountsForClient: mocks.investmentAccountsForClient,
  householdInvestmentAumState: mocks.householdInvestmentAumState,
}));
vi.mock("@/lib/data/tax-budget", () => ({
  taxBudgetForClient: mocks.taxBudgetForClient,
}));
vi.mock("@/lib/data/deal-types", () => ({
  clientPersonAum: vi.fn(() => null),
  householdAumFromDeals: vi.fn(() => null),
}));
vi.mock("@/lib/mock/client-portrait", () => ({
  feedByClient: { default: [] },
  riskByClient: { default: null },
  riskFlagByClient: { default: false },
  instructionsByClient: { default: [] },
  portraitByClient: { default: {} },
  accountsByClient: {
    default: {
      apex: [],
      ext: [{ inst: "Mock Bank", type: "Brokerage", num: "MOCK", balance: 1 }],
      bene: [],
      plaidLinked: true,
    },
  },
  prepByClient: { default: null },
}));
vi.mock("@/lib/flags", () => ({
  clientPortraitExperimentsEnabled: vi.fn(() => false),
  showPlaidLinkedAccountSummariesEnabled: mocks.summariesEnabled,
}));
vi.mock("@/lib/data/linked-external-account-summary", () => ({
  linkedExternalSummariesForClient: mocks.linkedExternalSummariesForClient,
}));
vi.mock("@/lib/mock/trade-request-profile", () => ({
  devTradeRequestProfileForClient: vi.fn(() => null),
}));
vi.mock("@/lib/observability/structured-log", () => ({
  logDetailTiming: mocks.logDetailTiming,
}));

import { clientPortraitDetail } from "@/lib/data/portrait";

const advisor = { role: "ADVISOR", email: "advisor-a@example.invalid" };

function summary(extra: Record<string, unknown> = {}) {
  return {
    externalAccountId: "ext-live-1",
    clientSfId: "003-client",
    householdSfId: "001-household",
    institutionName: "Live Bank",
    accountSubtype: "brokerage",
    mask: "9999",
    cashAmount: 10,
    securitiesAmount: 32,
    holdingsTotal: 42,
    institutionBalance: 40,
    asOf: new Date("2026-10-01T00:00:00.000Z"),
    linkStatus: "ACTIVE",
    lineageKey: "lineage-live",
    priorExternalAccountId: null,
    ...extra,
  };
}

describe("ticket portrait Plaid-linked summary wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.summariesEnabled.mockReturnValue(false);
    mocks.getClientWithHousehold.mockResolvedValue({
      sf_id: "003-client",
      name: "Test Client",
      household: { sf_id: "001-household", aum: null },
    });
    mocks.dealsForClient.mockResolvedValue([]);
    mocks.dealsForHousehold.mockResolvedValue([]);
    mocks.investmentAccountsForClient.mockResolvedValue([
      { custodian: "Schwab", status: "OPEN", balanceCurrent: true, value: 500 },
    ]);
    mocks.householdInvestmentAumState.mockResolvedValue({
      value: 900,
      availability: "AVAILABLE",
    });
    mocks.apexAccountsForClient.mockResolvedValue([]);
    mocks.taxBudgetForClient.mockResolvedValue(null);
    mocks.linkedExternalSummariesForClient.mockResolvedValue([summary()]);
  });

  it("flag off keeps the mock ext rows and never reads the mirror", async () => {
    const detail = await clientPortraitDetail(advisor, "003-client");
    expect(mocks.linkedExternalSummariesForClient).not.toHaveBeenCalled();
    expect(detail?.accounts.ext).toEqual([
      { inst: "Mock Bank", type: "Brokerage", num: "MOCK", balance: 1 },
    ]);
    expect(detail?.accounts.plaidLinked).toBe(true);
    expect(detail?.accounts.plaidSummariesLive).toBeUndefined();
  });

  it("flag on replaces mock rows with RLS-scoped mirrored summaries", async () => {
    mocks.summariesEnabled.mockReturnValue(true);
    const detail = await clientPortraitDetail(advisor, "003-client");
    expect(mocks.linkedExternalSummariesForClient).toHaveBeenCalledWith(advisor, "003-client");
    expect(detail?.accounts.ext).toEqual([
      {
        inst: "Live Bank",
        type: "brokerage",
        num: "••••9999",
        balance: 42,
        externalAccountId: "ext-live-1",
        cash: 10,
        securities: 32,
        holdingsTotal: 42,
        asOf: "2026-10-01T00:00:00.000Z",
        institutionBalance: 40,
      },
    ]);
    expect(detail?.accounts.plaidLinked).toBe(true);
    expect(detail?.accounts.plaidSummariesLive).toBe(true);
  });

  it.each([
    ["ADMIN", "admin@example.invalid"],
    ["OPERATIONS", "ops@example.invalid"],
    ["CLIENT_SERVICE", "cs@example.invalid"],
  ])("flag on reads summaries under the %s caller's own RLS scope", async (role, email) => {
    mocks.summariesEnabled.mockReturnValue(true);
    const identity = { role, email };
    await clientPortraitDetail(identity, "003-client");
    expect(mocks.linkedExternalSummariesForClient).toHaveBeenCalledWith(identity, "003-client");
  });

  it("flag on with no RLS-visible rows shows no linked summaries and no mock rows", async () => {
    mocks.summariesEnabled.mockReturnValue(true);
    mocks.linkedExternalSummariesForClient.mockResolvedValue([]);
    const detail = await clientPortraitDetail(advisor, "003-client");
    expect(mocks.linkedExternalSummariesForClient).toHaveBeenCalledWith(advisor, "003-client");
    expect(detail?.accounts.ext).toEqual([]);
    expect(detail?.accounts.plaidLinked).toBe(false);
  });

  it("keeps unknown mirror amounts unknown instead of inventing zero", async () => {
    mocks.summariesEnabled.mockReturnValue(true);
    mocks.linkedExternalSummariesForClient.mockResolvedValue([
      summary({
        institutionName: null, accountSubtype: null, mask: null,
        cashAmount: null, securitiesAmount: null, holdingsTotal: null, asOf: null,
      }),
    ]);
    const detail = await clientPortraitDetail(advisor, "003-client");
    expect(detail?.accounts.ext[0]).toMatchObject({
      inst: "Linked account", type: "Account", num: "—",
      cash: null, securities: null, holdingsTotal: null, asOf: null,
    });
  });

  it("linked summaries never change the AUM headers", async () => {
    const off = await clientPortraitDetail(advisor, "003-client");
    mocks.summariesEnabled.mockReturnValue(true);
    mocks.linkedExternalSummariesForClient.mockResolvedValue([
      summary({
        holdingsTotal: 1_000_000, cashAmount: 1_000_000, securitiesAmount: 0,
        institutionBalance: 2_000_000,
      }),
    ]);
    const on = await clientPortraitDetail(advisor, "003-client");
    expect(off?.clientAum).toBe(500);
    expect(off?.householdAum).toBe(900);
    expect(on?.clientAum).toBe(off?.clientAum);
    expect(on?.householdAum).toBe(off?.householdAum);
  });
});
