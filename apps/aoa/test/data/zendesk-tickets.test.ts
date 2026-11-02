import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryRawSpy, resolveRouteKeySpy, withUserScopeSpy } = vi.hoisted(() => {
  const queryRawSpy = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  const withUserScopeSpy = vi.fn(
    async (_identity: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $queryRaw: queryRawSpy }),
  );
  return {
    queryRawSpy,
    resolveRouteKeySpy: vi.fn(),
    withUserScopeSpy,
  };
});

vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
vi.mock("@/lib/crm/resolve", () => ({
  resolveCrmRouteKey: resolveRouteKeySpy,
}));

import {
  zendeskTicketsForClient,
  zendeskTicketsForHouseholdSources,
} from "@/lib/data/zendesk-tickets";

const IDENTITY = { role: "OPERATIONS", email: "ops@example.com" };

function queryText(callIndex = 0): string {
  const query = queryRawSpy.mock.calls[callIndex]?.[0] as
    | { strings?: readonly string[] }
    | undefined;
  return query?.strings?.join("?") ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  queryRawSpy.mockResolvedValue([]);
  resolveRouteKeySpy.mockResolvedValue("003HWKLAZUQY597");
});

describe("Zendesk ticket household lookup", () => {
  it("finds direct household links and client-matched household members", async () => {
    await zendeskTicketsForHouseholdSources(IDENTITY, [
      "001PNPVZFEBZ178AAA",
      "001PNPVZFEBZ178BBB",
    ]);

    expect(withUserScopeSpy).toHaveBeenCalledOnce();
    expect(queryRawSpy).toHaveBeenCalledOnce();
    const sql = queryText();
    expect(sql).toContain("FROM mirror.zendesk_ticket ticket");
    expect(sql).toContain("left(ticket.household_sf_id, 15) IN");
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("FROM mirror.client household_member");
    expect(sql).toContain("left(household_member.household_id, 15)");
    expect(sql).toContain(
      "app.resolve_crm_canonical_contact_source_key(\n                     household_member.sf_id",
    );
    expect(sql).toContain(
      "app.resolve_crm_canonical_contact_source_key(\n                     ticket.client_sf_id",
    );
    // The fallback remains limited to tickets with a resolved client. It does
    // not surface unmatched or ambiguous requester records.
    expect(sql).toContain("ticket.client_sf_id IS NOT NULL");
  });

  it("normalizes and deduplicates household IDs before composing the lookup", async () => {
    await zendeskTicketsForHouseholdSources(IDENTITY, [
      "001PNPVZFEBZ178AAA",
      "001PNPVZFEBZ178BBB",
      "001PNPVZFEBZ178AAA",
    ]);

    const query = queryRawSpy.mock.calls[0]?.[0] as { values?: unknown[] };
    const householdKeys = (query.values ?? []).filter(
      (value) => value === "001PNPVZFEBZ178",
    );
    // One key appears in each of the two safe paths: direct household linkage
    // and matched-client membership.
    expect(householdKeys).toHaveLength(2);
  });

  it("does not query when no household source identity is available", async () => {
    await expect(
      zendeskTicketsForHouseholdSources(IDENTITY, ["", ""]),
    ).resolves.toEqual([]);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
    expect(queryRawSpy).not.toHaveBeenCalled();
  });

  it("keeps the standalone client lookup on the aliased, canonicalized seam", async () => {
    await zendeskTicketsForClient(IDENTITY, "003HPLVUXZCQ311AAA");

    expect(resolveRouteKeySpy).toHaveBeenCalledWith(
      IDENTITY,
      "CONTACT",
      "003HPLVUXZCQ311AAA",
    );
    const sql = queryText();
    expect(sql).toContain("ticket.client_sf_id IS NOT NULL");
    expect(sql).toContain(
      "app.resolve_crm_canonical_contact_source_key(ticket.client_sf_id)",
    );
  });
});
