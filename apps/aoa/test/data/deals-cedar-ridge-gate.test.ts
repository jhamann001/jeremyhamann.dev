import { describe, it, expect, beforeEach, vi } from "vitest";

// The Deals seam must withhold cedar_ridge_user_id from non-ADMIN/OPERATIONS
// callers: the real value never enters the row a component receives (not the
// RSC payload, not the CSV). This mirrors the Client Portrait precedent
// (clients-cedar-ridge-gate.test.ts): `@/lib/rls` is mocked so withUserScope runs
// the real seam callback against a fake tx whose $queryRaw returns one deal row
// carrying a synthetic `user-<uuid>` cedar_ridge_user_id.

const { withUserScopeSpy } = vi.hoisted(() => ({ withUserScopeSpy: vi.fn() }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));

import { listDeals, getDeal } from "@/lib/data/deals";
import type { Identity } from "@/lib/data/types";

const CRW = "user-00000000-0000-0000-0000-000000000001";

// A DealRow-shaped raw row (as $queryRaw hands it back before `coerce`); only
// the cedarRidge field is load-bearing here. amount is a number so coerce's
// Number() is a no-op.
function rawDeal(over: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    source: "APP",
    sf_deal_id: null,
    name: "Test Deal",
    client_first_name: "Test",
    client_last_name: "Client",
    household_name: null,
    household_sf_id: null,
    client_sf_id: null,
    amount: 1000,
    stage: "POTENTIAL",
    stage_raw: null,
    created_date: new Date("2026-01-01T00:00:00.000Z"),
    close_date: null,
    last_activity_date: null,
    owner_name: null,
    owner_sf_user_id: null,
    secondary_owner: null,
    person_aum: null,
    potential_aum: null,
    cedar_ridge_user_id: CRW,
    statements: true,
    plaid_linked: false,
    account_last4: null,
    account_type: null,
    transferring_firm: null,
    employer: null,
    rolling_into: null,
    lost_from: null,
    archived_reason: null,
    stage_history: [],
    created_by: null,
    updated_by: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    archived_at: null,
    archived_by: null,
    ...over,
  };
}

// The fake tx returns the supplied rows for the single $queryRaw the seam runs.
function wireTx(rows: unknown[]) {
  const queryRaw = vi.fn().mockResolvedValue(rows);
  withUserScopeSpy.mockImplementation(
    (_id: Identity, cb: (tx: unknown) => unknown) => cb({ $queryRaw: queryRaw }),
  );
  return { queryRaw };
}

beforeEach(() => vi.clearAllMocks());

describe("Deals seam — cedar_ridge_user_id visibility gate", () => {
  describe("listDeals", () => {
    it.each(["ADMIN", "OPERATIONS"])(
      "returns the real value + masked=false for %s",
      async (role) => {
        wireTx([rawDeal()]);
        const [deal] = await listDeals({ role, email: "x@e.com" });
        expect(deal.cedar_ridge_user_id).toBe(CRW);
        expect(deal.cedar_ridge_user_id_masked).toBe(false);
      },
    );

    it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER"])(
      "masks AND removes the value for %s (never in the payload)",
      async (role) => {
        wireTx([rawDeal()]);
        const rows = await listDeals({ role, email: "x@e.com" });
        expect(rows[0].cedar_ridge_user_id).toBeNull();
        expect(rows[0].cedar_ridge_user_id_masked).toBe(true);
        // The core security assertion — the raw id is absent from the payload.
        expect(JSON.stringify(rows)).not.toContain(CRW);
      },
    );

    it("null DB value → masked=false for a non-authorized role (nothing to hide)", async () => {
      wireTx([rawDeal({ cedar_ridge_user_id: null })]);
      const [deal] = await listDeals({ role: "VIEWER", email: null });
      expect(deal.cedar_ridge_user_id).toBeNull();
      expect(deal.cedar_ridge_user_id_masked).toBe(false);
    });
  });

  describe("getDeal", () => {
    it.each(["ADMIN", "OPERATIONS"])(
      "returns the real value + masked=false for %s",
      async (role) => {
        wireTx([rawDeal()]);
        const deal = await getDeal({ role, email: "x@e.com" }, "deal-1");
        expect(deal).not.toBeNull();
        expect(deal!.cedar_ridge_user_id).toBe(CRW);
        expect(deal!.cedar_ridge_user_id_masked).toBe(false);
      },
    );

    it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER"])(
      "masks AND removes the value for %s (never in the payload)",
      async (role) => {
        wireTx([rawDeal()]);
        const deal = await getDeal({ role, email: "x@e.com" }, "deal-1");
        expect(deal).not.toBeNull();
        expect(deal!.cedar_ridge_user_id).toBeNull();
        expect(deal!.cedar_ridge_user_id_masked).toBe(true);
        expect(JSON.stringify(deal)).not.toContain(CRW);
      },
    );

    it("null DB value → masked=false for a non-authorized role", async () => {
      wireTx([rawDeal({ cedar_ridge_user_id: null })]);
      const deal = await getDeal({ role: "ADVISOR", email: null }, "deal-1");
      expect(deal!.cedar_ridge_user_id).toBeNull();
      expect(deal!.cedar_ridge_user_id_masked).toBe(false);
    });
  });
});
