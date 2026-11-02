import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  identityReadsEnabled: vi.fn(),
  withUserScope: vi.fn(),
}));

vi.mock("@/lib/flags", () => ({
  crmIdentityReadsEnabled: mocks.identityReadsEnabled,
}));
vi.mock("@/lib/rls", () => ({ withUserScope: mocks.withUserScope }));

import {
  crmCanonicalHouseholdSourceKeys,
  crmCanonicalHouseholdSourceKeysForCanonical,
  crmIdentityIdForSource,
  crmRouteSource,
  resolveCrmRouteKey,
} from "@/lib/crm/resolve";

const IDENTITY = { role: "OPERATIONS", email: "ops@example.test" };

function returnRows(rows: unknown[]) {
  const queryRaw = vi.fn().mockResolvedValue(rows);
  mocks.withUserScope.mockImplementation(
    async (_identity: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $queryRaw: queryRaw }),
  );
  return queryRaw;
}

describe("CRM dual-key route resolution", () => {
  beforeEach(() => {
    mocks.identityReadsEnabled.mockReset();
    mocks.withUserScope.mockReset();
    mocks.identityReadsEnabled.mockReturnValue(false);
  });

  it("leaves every legacy route key untouched without querying CRM", async () => {
    expect(
      await resolveCrmRouteKey(IDENTITY, "HOUSEHOLD", "001-LEGACY"),
    ).toBe("001-LEGACY");
    expect(mocks.withUserScope).not.toHaveBeenCalled();
  });

  it("keeps typed CRM routes dark while the independent flag is off", async () => {
    expect(
      await resolveCrmRouteKey(IDENTITY, "CONTACT", "con_c123456"),
    ).toBe("con_c123456");
    expect(mocks.withUserScope).not.toHaveBeenCalled();
  });

  it("resolves one visible typed CRM ID to the existing route key", async () => {
    mocks.identityReadsEnabled.mockReturnValue(true);
    returnRows([{ source_key: "003-SOURCE" }]);

    await expect(
      resolveCrmRouteKey(IDENTITY, "CONTACT", "con_c123456"),
    ).resolves.toBe("003-SOURCE");
    expect(mocks.withUserScope).toHaveBeenCalledWith(
      IDENTITY,
      expect.any(Function),
    );
  });

  it("routes a confirmed household source key to the selected AOA canonical household", async () => {
    mocks.identityReadsEnabled.mockReturnValue(true);
    returnRows([{ source_key: "001-CANONICAL" }]);

    await expect(
      resolveCrmRouteKey(IDENTITY, "HOUSEHOLD", "001-DUPLICATE"),
    ).resolves.toBe("001-CANONICAL");
  });

  it("returns the visible source group with the survivor first", async () => {
    mocks.identityReadsEnabled.mockReturnValue(true);
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ source_key: "001-CANONICAL" }])
      .mockResolvedValueOnce([
        { source_key: "001-CANONICAL" },
        { source_key: "001-DUPLICATE" },
      ]);
    mocks.withUserScope.mockImplementation(
      async (_identity: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRaw: queryRaw }),
    );

    await expect(
      crmCanonicalHouseholdSourceKeys(IDENTITY, "001-DUPLICATE"),
    ).resolves.toEqual(["001-CANONICAL", "001-DUPLICATE"]);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("skips repeat route resolution when the canonical source is already known", async () => {
    mocks.identityReadsEnabled.mockReturnValue(true);
    const queryRaw = returnRows([
      { source_key: "001-CANONICAL" },
      { source_key: "001-DUPLICATE" },
    ]);

    await expect(
      crmCanonicalHouseholdSourceKeysForCanonical(IDENTITY, "001-CANONICAL"),
    ).resolves.toEqual(["001-CANONICAL", "001-DUPLICATE"]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("keeps a single source when canonical reads are disabled", async () => {
    await expect(
      crmCanonicalHouseholdSourceKeys(IDENTITY, "001-LEGACY"),
    ).resolves.toEqual(["001-LEGACY"]);
    expect(mocks.withUserScope).not.toHaveBeenCalled();
  });

  it("resolves a typed household ID and then applies the canonical overlay", async () => {
    mocks.identityReadsEnabled.mockReturnValue(true);
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ source_key: "001-DUPLICATE" }])
      .mockResolvedValueOnce([{ source_key: "001-CANONICAL" }]);
    mocks.withUserScope.mockImplementation(
      async (_identity: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRaw: queryRaw }),
    );

    await expect(
      resolveCrmRouteKey(IDENTITY, "HOUSEHOLD", "hld_c123456"),
    ).resolves.toBe("001-CANONICAL");
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an identity has ambiguous active route aliases", async () => {
    mocks.identityReadsEnabled.mockReturnValue(true);
    returnRows([{ source_key: "one" }, { source_key: "two" }]);

    await expect(
      resolveCrmRouteKey(IDENTITY, "DEAL", "dea_c123456"),
    ).resolves.toBe("dea_c123456");
  });

  it("does not query when a typed ID belongs to another route type", async () => {
    mocks.identityReadsEnabled.mockReturnValue(true);
    expect(
      await resolveCrmRouteKey(IDENTITY, "HOUSEHOLD", "con_c123456"),
    ).toBe("con_c123456");
    expect(mocks.withUserScope).not.toHaveBeenCalled();
  });

  it("provides the reverse lookup seam needed by the Phase 2B explorer", async () => {
    mocks.identityReadsEnabled.mockReturnValue(true);
    returnRows([{ id: "hld_c123456" }]);

    await expect(
      crmIdentityIdForSource(
        IDENTITY,
        "HOUSEHOLD",
        crmRouteSource("HOUSEHOLD"),
        "001-SOURCE",
      ),
    ).resolves.toBe("hld_c123456");
  });
});
