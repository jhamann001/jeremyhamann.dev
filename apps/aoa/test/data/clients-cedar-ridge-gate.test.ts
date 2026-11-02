import { describe, it, expect, beforeEach, vi } from "vitest";

// getClientWithHousehold must attach cedar_ridge_user_id ONLY for ADMIN/OPERATIONS
// and OMIT the key entirely for every other role — so a non-permitted viewer's
// RSC payload never carries the value. `@/lib/rls` is mocked so withUserScope
// runs the real callback against a fake tx (the transfer-setstage-gate idiom):
// the fake $queryRaw returns the client row, then the (empty) household row.

const { withUserScopeSpy } = vi.hoisted(() => ({ withUserScopeSpy: vi.fn() }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));

import { getClientWithHousehold } from "@/lib/data/clients";
import type { Identity } from "@/lib/data/types";

const CRW = "user-00000000-0000-0000-0000-000000000001";

// A fake tx whose two $queryRaw calls return (1) the client row, (2) no household.
function wireTx() {
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce([
      {
        sf_id: "003AAA",
        name: "Willie Client",
        email: "jane@example.com",
        household_id: "001HHH",
        cedar_ridge_user_id: CRW,
      },
    ])
    .mockResolvedValueOnce([]); // household lookup → null
  const tx = { $queryRaw: queryRaw };
  withUserScopeSpy.mockImplementation(
    (_id: Identity, cb: (tx: unknown) => unknown) => cb(tx),
  );
  return { queryRaw };
}

beforeEach(() => vi.clearAllMocks());

describe("getClientWithHousehold — cedar_ridge_user_id visibility gate", () => {
  it.each(["ADMIN", "OPERATIONS"])("attaches the id for %s", async (role) => {
    wireTx();
    const detail = await getClientWithHousehold({ role, email: "x@e.com" }, "003AAA");
    expect(detail).not.toBeNull();
    expect(detail!.cedarRidgeUserId).toBe(CRW);
  });

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER"])(
    "OMITS the key entirely for %s (never in the payload)",
    async (role) => {
      wireTx();
      const detail = await getClientWithHousehold({ role, email: "x@e.com" }, "003AAA");
      expect(detail).not.toBeNull();
      // Not just undefined — the key must be absent from the serialized object.
      expect("cedarRidgeUserId" in detail!).toBe(false);
      expect(JSON.stringify(detail)).not.toContain(CRW);
    },
  );

  it("still returns the client's normal fields regardless of role", async () => {
    wireTx();
    const detail = await getClientWithHousehold({ role: "VIEWER", email: null }, "003AAA");
    expect(detail!.sf_id).toBe("003AAA");
    expect(detail!.name).toBe("Willie Client");
    expect(detail!.household).toBeNull();
  });
});
