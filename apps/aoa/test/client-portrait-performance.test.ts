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
  ...await importOriginal<typeof import("@/lib/data/investment-accounts")>(),
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
  accountsByClient: { default: { apex: [] } },
  prepByClient: { default: null },
}));
vi.mock("@/lib/flags", () => ({
  clientPortraitExperimentsEnabled: vi.fn(() => false),
  showPlaidLinkedAccountSummariesEnabled: vi.fn(() => false),
}));
vi.mock("@/lib/data/linked-external-account-summary", () => ({
  linkedExternalSummariesForClient: vi.fn(),
}));
vi.mock("@/lib/mock/trade-request-profile", () => ({
  devTradeRequestProfileForClient: vi.fn(() => null),
}));
vi.mock("@/lib/observability/structured-log", () => ({
  logDetailTiming: mocks.logDetailTiming,
}));

import { clientPortraitDetail } from "@/lib/data/portrait";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("client portrait detail latency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClientWithHousehold.mockResolvedValue({
      sf_id: "003-client",
      name: "Test Client",
      household: { sf_id: "001-household", aum: 100 },
    });
  });

  it("starts independent RLS reads together after resolving the client", async () => {
    const deals = deferred<never[]>();
    const clientAum = deferred<Array<Record<string, unknown>>>();
    const householdAum = deferred<{ value: number; availability: "AVAILABLE" }>();
    const accounts = deferred<never[]>();
    const taxBudget = deferred<null>();

    mocks.dealsForClient.mockReturnValue(deals.promise);
    mocks.investmentAccountsForClient.mockReturnValue(clientAum.promise);
    mocks.householdInvestmentAumState.mockReturnValue(householdAum.promise);
    mocks.apexAccountsForClient.mockReturnValue(accounts.promise);
    mocks.taxBudgetForClient.mockReturnValue(taxBudget.promise);

    const result = clientPortraitDetail(
      { role: "OPERATIONS", email: "ops@example.test" },
      "003-client",
    );
    await vi.waitFor(() => {
      expect(mocks.dealsForClient).toHaveBeenCalledOnce();
      expect(mocks.investmentAccountsForClient).toHaveBeenCalledOnce();
      expect(mocks.householdInvestmentAumState).toHaveBeenCalledOnce();
      expect(mocks.apexAccountsForClient).toHaveBeenCalledOnce();
      expect(mocks.taxBudgetForClient).toHaveBeenCalledOnce();
    });

    deals.resolve([]);
    clientAum.resolve([{ custodian: "Schwab", status: "OPEN", balanceCurrent: true, value: 50 }]);
    householdAum.resolve({ value: 100, availability: "AVAILABLE" });
    accounts.resolve([]);
    taxBudget.resolve(null);

    await expect(result).resolves.toMatchObject({
      clientAum: 50,
      householdAum: 100,
      accounts: {
        apex: [],
        investment: [{ custodian: "Schwab", status: "OPEN", balanceCurrent: true, value: 50 }],
      },
    });
    expect(mocks.investmentAccountsForClient).toHaveBeenCalledWith(
      { role: "OPERATIONS", email: "ops@example.test" }, "003-client",
    );
    expect(mocks.householdInvestmentAumState).toHaveBeenCalledWith(
      { role: "OPERATIONS", email: "ops@example.test" }, "001-household",
    );
    expect(mocks.dealsForHousehold).not.toHaveBeenCalled();
    expect(mocks.logDetailTiming).toHaveBeenCalledOnce();
  });
});
