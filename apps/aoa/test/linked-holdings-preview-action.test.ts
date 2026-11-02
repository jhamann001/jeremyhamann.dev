import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  allowPreview: vi.fn(),
  summaries: vi.fn(),
  queryWarehouseCard: vi.fn(),
  classify: vi.fn(),
  withUserScope: vi.fn(),
  writeAudit: vi.fn(),
  revalidatePath: vi.fn(),
  apexAccountsForClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/rls", () => ({ withUserScope: mocks.withUserScope }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  writeAudit: mocks.writeAudit,
}));
vi.mock("@/lib/data/account-aum", () => ({ apexAccountsForClient: mocks.apexAccountsForClient }));
vi.mock("@/lib/data/asset-map", () => ({
  fetchHouseholdsPage: vi.fn(),
}));
vi.mock("@/lib/data/holdings-transferability-preview", () => ({
  classifyHoldingsTransferability: mocks.classify,
  degradedTransferability: (count: number) =>
    Array.from({ length: count }, () => ({ label: "unknown", reason: "rules_unavailable" })),
}));
vi.mock("@/lib/data/clients", () => ({ getCedarRidgeUserIdForLinkedReads: vi.fn() }));
vi.mock("@/lib/data/trade-requests", () => ({ getTradeRequestsForUser: vi.fn() }));
vi.mock("@/lib/flags", () => ({
  allowPlaidHoldingsPreviewEnabled: mocks.allowPreview,
}));
vi.mock("@/lib/data/linked-external-account-summary", () => ({
  linkedExternalSummariesForClient: mocks.summaries,
}));
vi.mock("@/lib/warehouse/client", () => ({
  queryWarehouseCard: mocks.queryWarehouseCard,
}));

import { previewLinkedHoldings } from "@/app/(authenticated)/client-portrait/[id]/actions";

const activeSummary = {
  externalAccountId: "ext-live-1",
  clientSfId: "003-client",
  householdSfId: "001-household",
  institutionName: "Live Bank",
  accountSubtype: "brokerage",
  mask: "9999",
  cashAmount: 10,
  securitiesAmount: 32,
  holdingsTotal: 42,
  institutionBalance: 41,
  asOf: new Date("2026-10-01T00:00:00.000Z"),
  linkStatus: "ACTIVE",
  lineageKey: "lineage-live",
  priorExternalAccountId: null,
};

const CARD_ROWS = [
  {
    ticker: "VTI", security_id: "sec-1", security_name: "Vanguard Total", security_type: "etf",
    quantity: 1, market_value: 32,
    as_of: "2026-10-02", access_token: "access-sandbox-secret", isin: "US0000000001",
    cusip: "000000001", cost_basis: 30,
  },
  { ticker: null, security_id: "sec-cash", security_name: "Cash", security_type: "cash", quantity: 10, market_value: 10 },
];

const ARGS = { clientSfId: "003-client", externalAccountId: "ext-live-1" };

function asRole(role: string) {
  mocks.auth.mockResolvedValue({ user: { role, email: `${role.toLowerCase()}@example.invalid` } });
}

function expectNoPersistence() {
  expect(mocks.withUserScope).not.toHaveBeenCalled();
  expect(mocks.writeAudit).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
  expect(mocks.apexAccountsForClient).not.toHaveBeenCalled();
}

describe("previewLinkedHoldings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asRole("ADMIN");
    mocks.allowPreview.mockReturnValue(true);
    mocks.summaries.mockResolvedValue([activeSummary]);
    mocks.queryWarehouseCard.mockResolvedValue(CARD_ROWS);
    mocks.classify.mockImplementation(async (inputs: { symbol: string | null }[]) =>
      inputs.map((input) => input.symbol === "VTI"
        ? { label: "likely_transferable", reason: "standard_security" }
        : { label: "likely_transferable", reason: "cash" }),
    );
  });

  it.each(["ADMIN", "OPERATIONS"])("returns the holdings DTO for %s without persisting it", async (role) => {
    asRole(role);
    const result = await previewLinkedHoldings(ARGS);

    expect(result).toEqual({
      ok: true,
      asOf: "2026-10-02",
      holdingsTotal: 42,
      institutionBalance: 41,
      difference: 1,
      rows: [
        { symbol: "VTI", name: "Vanguard Total", quantity: 1, value: 32, label: "likely_transferable", reason: "standard_security" },
        { symbol: "sec-cash", name: "Cash", quantity: 10, value: 10, label: "likely_transferable", reason: "cash" },
      ],
    });
    const serialized = JSON.stringify(result);
    for (const field of ["access_token", "isin", "cusip", "cost_basis", "access-sandbox-secret", "security_type"]) {
      expect(serialized).not.toContain(field);
    }
    expect(mocks.summaries).toHaveBeenCalledWith(
      { role, email: `${role.toLowerCase()}@example.invalid` },
      "003-client",
    );
    expect(mocks.classify).toHaveBeenCalledWith([
      { symbol: "VTI", name: "Vanguard Total", security_type: "etf" },
      { symbol: "sec-cash", name: "Cash", security_type: "cash" },
    ]);
    expect(mocks.queryWarehouseCard).toHaveBeenCalledTimes(1);
    expect(mocks.queryWarehouseCard).toHaveBeenCalledWith(
      6899,
      [
        {
          id: "fe1f5565-cc0f-4338-865c-bd1a66475f5c",
          type: "string/=",
          target: ["variable", ["template-tag", "external_account_id"]],
          value: "ext-live-1",
        },
      ],
      "plaid-holdings-preview",
      expect.any(Function),
    );
    expectNoPersistence();
  });

  it("keeps the holdings preview and marks every row unknown when the classifier times out", async () => {
    mocks.classify.mockRejectedValue(Object.assign(new Error("timeout"), { code: "ECONNABORTED" }));
    const result = await previewLinkedHoldings(ARGS);
    expect(result).toMatchObject({
      ok: true,
      rows: [
        { symbol: "VTI", label: "unknown", reason: "rules_unavailable" },
        { symbol: "sec-cash", label: "unknown", reason: "rules_unavailable" },
      ],
    });
    expectNoPersistence();
    markCase("holdings-transferability-preview", "keeps the holdings preview and marks every row unknown when the classifier times out");
  });

  it("returns preview_failed from the catch branch when Warehouse throws", async () => {
    mocks.queryWarehouseCard.mockRejectedValue(
      Object.assign(new Error("Warehouse 502"), { reason: "warehouse_error" }),
    );
    const result = await previewLinkedHoldings(ARGS);
    expect(result).toEqual({ ok: false, reason: "preview_failed" });
    expect(mocks.queryWarehouseCard).toHaveBeenCalledWith(
      6899,
      [expect.objectContaining({ value: "ext-live-1" })],
      "plaid-holdings-preview",
      expect.any(Function),
    );
    expectNoPersistence();
  });

  it("returns preview_failed when the card returns an error shape", async () => {
    mocks.queryWarehouseCard.mockResolvedValue({ error: "bad" });
    expect(await previewLinkedHoldings(ARGS)).toEqual({ ok: false, reason: "preview_failed" });
  });

  it("prefers the card institution balance and falls back to the mirrored one", async () => {
    expect(await previewLinkedHoldings(ARGS)).toMatchObject({
      ok: true, institutionBalance: 41, difference: 1,
    });
    mocks.queryWarehouseCard.mockResolvedValue([{ ...CARD_ROWS[0], institution_balance: 40 }, CARD_ROWS[1]]);
    expect(await previewLinkedHoldings(ARGS)).toMatchObject({
      ok: true, institutionBalance: 40, difference: 2,
    });
  });

  it("returns unauthorized and never calls Warehouse when the preview switch is off", async () => {
    mocks.allowPreview.mockReturnValue(false);
    expect(await previewLinkedHoldings(ARGS)).toEqual({ ok: false, reason: "unauthorized" });
    expect(mocks.summaries).not.toHaveBeenCalled();
    expect(mocks.queryWarehouseCard).not.toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled();
  });

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER"])(
    "returns unauthorized for %s even when the preview switch is on",
    async (role) => {
      asRole(role);
      expect(await previewLinkedHoldings(ARGS)).toEqual({ ok: false, reason: "unauthorized" });
      expect(mocks.summaries).not.toHaveBeenCalled();
      expect(mocks.queryWarehouseCard).not.toHaveBeenCalled();
    },
  );

  it("fails closed for an account that is not an active mirrored link visible to the caller", async () => {
    expect(
      await previewLinkedHoldings({ ...ARGS, externalAccountId: "ext-someone-else" }),
    ).toEqual({ ok: false, reason: "unauthorized" });

    mocks.summaries.mockResolvedValue([{ ...activeSummary, linkStatus: "INACTIVE" }]);
    expect(await previewLinkedHoldings(ARGS)).toEqual({ ok: false, reason: "unauthorized" });

    mocks.summaries.mockResolvedValue([]);
    expect(await previewLinkedHoldings(ARGS)).toEqual({ ok: false, reason: "unauthorized" });

    mocks.summaries.mockRejectedValue(new Error("rls"));
    expect(await previewLinkedHoldings(ARGS)).toEqual({ ok: false, reason: "unauthorized" });

    expect(mocks.queryWarehouseCard).not.toHaveBeenCalled();
  });

  it.each([
    { clientSfId: "", externalAccountId: "ext-live-1" },
    { clientSfId: "003-client", externalAccountId: "  " },
    { clientSfId: 42, externalAccountId: "ext-live-1" },
    { clientSfId: "003-client", externalAccountId: { $ne: "" } },
    { clientSfId: "003-client", externalAccountId: "x".repeat(257) },
  ])("rejects malformed input %# before any read", async (args) => {
    expect(await previewLinkedHoldings(args)).toEqual({ ok: false, reason: "unauthorized" });
    expect(mocks.summaries).not.toHaveBeenCalled();
    expect(mocks.queryWarehouseCard).not.toHaveBeenCalled();
  });
});
