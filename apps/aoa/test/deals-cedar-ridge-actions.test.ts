import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PRESERVE-ON-SAVE (the crux of the Deals cedarRidge mask): a non-ADMIN/
// OPERATIONS caller can neither change nor wipe the stored cedar_ridge_user_id,
// and never produces a false audit diff; ADMIN/OPERATIONS still edit it. No DB:
// @/auth, @/lib/rls, @/lib/audit and next cache/navigation are MOCKED so the
// REAL createDeal/updateDeal logic (incl. toDealInput/validate/diff) runs against
// a fake tx. Follows the asset-map-review-actions.test.ts idiom. Synthetic
// `user-<uuid>` ids only (PII rule).

type AuditEvent = {
  action: string;
  detail: { changes: Record<string, { from: unknown; to: unknown }> };
};

const { authSpy, withUserScopeSpy, writeAuditSpy, revalidateSpy, redirectSpy } =
  vi.hoisted(() => ({
    authSpy: vi.fn(),
    withUserScopeSpy: vi.fn(),
    writeAuditSpy: vi.fn(
      async (_tx: unknown, _identity: unknown, _event: AuditEvent) => {},
    ),
    revalidateSpy: vi.fn(),
    redirectSpy: vi.fn(() => {
      throw new Error("REDIRECT");
    }),
  }));

vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditSpy };
});
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

import { createDeal, updateDeal } from "@/app/(authenticated)/deals/actions";
import { DEAL_UPDATE } from "@/lib/audit";
import type { DealFormValues } from "@/components/deals/deal-form";

const STORED_CRW = "user-00000000-0000-0000-0000-0000000000aa";

const sessionFor = (role: string) => ({
  user: { email: "actor@example.com", name: "Actor", role },
});

// The Prisma-shaped row tx.deal.findUnique returns (the action reads the REAL
// cedar_ridge_user_id here — findUnique bypasses the seam masker).
function storedDeal(over: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    source: "APP",
    sf_deal_id: null,
    name: "Jordan Sample - Fidelity - Roth IRA - 1234",
    client_first_name: "Jordan",
    client_last_name: "Sample",
    household_name: "Sample Household",
    household_sf_id: null,
    client_sf_id: null,
    amount: 250000,
    stage: "COMMITTED",
    stage_raw: null,
    created_date: new Date("2026-07-01T00:00:00.000Z"),
    close_date: new Date("2026-08-15T00:00:00.000Z"),
    last_activity_date: null,
    owner_name: "Avery Stone",
    owner_sf_user_id: null,
    secondary_owner: null,
    person_aum: null,
    potential_aum: null,
    cedar_ridge_user_id: STORED_CRW,
    statements: true,
    plaid_linked: false,
    account_last4: "1234",
    account_type: "Roth IRA",
    transferring_firm: "Fidelity",
    employer: null,
    rolling_into: null,
    lost_from: null,
    archived_reason: null,
    stage_history: [],
    created_by: "seed",
    updated_by: null,
    created_at: new Date("2026-07-01T12:00:00.000Z"),
    updated_at: new Date("2026-07-01T12:00:00.000Z"),
    archived_at: null,
    archived_by: null,
    ...over,
  };
}

// Form values a browser submits. A non-authorized (masked) form sends
// cedar_ridge_user_id: "" (the field is display-only, not bound to state).
const formValues = (over: Partial<DealFormValues> = {}): DealFormValues => ({
  client_first_name: "Jordan",
  client_last_name: "Sample",
  household_name: "Sample Household",
  household_sf_id: "",
  amount: "250000",
  stage: "COMMITTED",
  close_date: "2026-08-15",
  cedar_ridge_user_id: "",
  statements: true,
  account_type: "Roth IRA",
  funding_other: "",
  employer: "",
  rolling_into: "",
  account_last4: "1234",
  transferring_firm: "Fidelity",
  ...over,
});

// Wire withUserScope to run the callback against a fake tx with the given deal
// spies; returns the captured update/create data.
type WriteArg = { data: Record<string, unknown> };

function wireUpdate(over: Record<string, unknown> = {}) {
  const updateSpy = vi.fn(async (_arg: WriteArg) => storedDeal(over));
  const findUniqueSpy = vi.fn(async () => storedDeal(over));
  const tx = { deal: { findUnique: findUniqueSpy, update: updateSpy } };
  withUserScopeSpy.mockImplementation(
    async (_id: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  );
  return { updateSpy, findUniqueSpy };
}

function wireCreate() {
  const createSpy = vi.fn(async (_arg: WriteArg) => ({ id: "new-1" }));
  const tx = { deal: { create: createSpy } };
  withUserScopeSpy.mockImplementation(
    async (_id: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  );
  return { createSpy };
}

// createDeal/updateDeal redirect() on success (mocked to throw). Swallow it so
// we can inspect what the write spies received.
async function runSwallowingRedirect(fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (e) {
    if ((e as Error).message !== "REDIRECT") throw e;
    return undefined;
  }
}

beforeEach(() => {
  authSpy.mockReset();
  withUserScopeSpy.mockReset();
  writeAuditSpy.mockClear();
  revalidateSpy.mockClear();
  redirectSpy.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("updateDeal — cedar_ridge_user_id preserve-on-save", () => {
  it("non-authorized save PRESERVES the stored id and writes no false audit diff", async () => {
    authSpy.mockResolvedValue(sessionFor("ADVISOR"));
    const { updateSpy } = wireUpdate();

    // Submit a masked form ("" cedarRidge) with ONE genuine change (amount) so a
    // write happens — the cedarRidge value must NOT be wiped.
    await runSwallowingRedirect(() =>
      updateDeal("deal-1", formValues({ amount: "300000" })),
    );

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const data = updateSpy.mock.calls[0][0].data;
    // Preserved, not wiped to null.
    expect(data.cedar_ridge_user_id).toBe(STORED_CRW);

    // The deal.update audit records the amount change but NOT cedar_ridge_user_id.
    const updateAudit = writeAuditSpy.mock.calls.find(
      (c) => c[2]?.action === DEAL_UPDATE,
    );
    expect(updateAudit).toBeDefined();
    const changes = updateAudit![2].detail.changes;
    expect(changes.amount).toBeDefined();
    expect("cedar_ridge_user_id" in changes).toBe(false);
  });

  it("non-authorized no-op edit (masked form, nothing else changed) writes nothing", async () => {
    authSpy.mockResolvedValue(sessionFor("VIEWER"));
    const { updateSpy } = wireUpdate();

    await runSwallowingRedirect(() => updateDeal("deal-1", formValues()));

    // Preserve made cedarRidge a no-op and no other field changed → no write, no
    // audit noise (the masked "" never registers as clearing the id).
    expect(updateSpy).not.toHaveBeenCalled();
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("ADMIN can still edit the cedar_ridge_user_id (write + audit diff)", async () => {
    authSpy.mockResolvedValue(sessionFor("ADMIN"));
    const { updateSpy } = wireUpdate();

    const NEW_CRW = "user-00000000-0000-0000-0000-0000000000bb";
    await runSwallowingRedirect(() =>
      updateDeal("deal-1", formValues({ cedar_ridge_user_id: NEW_CRW })),
    );

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0].data.cedar_ridge_user_id).toBe(NEW_CRW);

    const updateAudit = writeAuditSpy.mock.calls.find(
      (c) => c[2]?.action === DEAL_UPDATE,
    );
    expect(updateAudit![2].detail.changes.cedar_ridge_user_id).toEqual({
      from: STORED_CRW,
      to: NEW_CRW,
    });
  });
});

describe("createDeal — cedar_ridge_user_id gate", () => {
  it("non-authorized create stores NULL even if a value is injected", async () => {
    authSpy.mockResolvedValue(sessionFor("ADVISOR"));
    const { createSpy } = wireCreate();

    await runSwallowingRedirect(() =>
      createDeal(formValues({ cedar_ridge_user_id: "user-injected-value" })),
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0].data.cedar_ridge_user_id).toBeNull();
  });

  it("ADMIN create persists the submitted cedar_ridge_user_id", async () => {
    authSpy.mockResolvedValue(sessionFor("OPERATIONS"));
    const { createSpy } = wireCreate();

    const NEW_CRW = "user-00000000-0000-0000-0000-0000000000cc";
    await runSwallowingRedirect(() =>
      createDeal(formValues({ cedar_ridge_user_id: NEW_CRW })),
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0].data.cedar_ridge_user_id).toBe(NEW_CRW);
  });
});
