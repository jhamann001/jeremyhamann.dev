import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  accountSpy,
  authSpy,
  cedarRidgeUserSpy,
  revalidateSpy,
  requestsSpy,
  withUserScopeSpy,
} = vi.hoisted(() => ({
  accountSpy: vi.fn(),
  authSpy: vi.fn(),
  cedarRidgeUserSpy: vi.fn(),
  revalidateSpy: vi.fn(),
  requestsSpy: vi.fn(),
  withUserScopeSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/data/account-aum", () => ({ apexAccountsForClient: accountSpy }));
vi.mock("@/lib/data/clients", () => ({
  getCedarRidgeUserIdForLinkedReads: cedarRidgeUserSpy,
}));
vi.mock("@/lib/data/trade-requests", () => ({ getTradeRequestsForUser: requestsSpy }));

import { confirmTradeProfileSource } from "@/app/(authenticated)/client-portrait/[id]/actions";
import {
  TRADE_PROFILE_SOURCE_CHANGE,
  TRADE_PROFILE_SOURCE_CONFIRM,
} from "@/lib/audit";

type FakeTx = {
  $queryRaw: ReturnType<typeof vi.fn>;
  tradeProfileSelection: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

const REQUEST = {
  id: "REQ-LUCIA-03",
  clientId: "cedar-ridge-henry",
  clientIds: ["cedar-ridge-henry"],
  status: "Approved",
  tradeType: "Initial Funding",
  priority: "Standard",
  createdAt: "2026-03-03T15:00:00.000Z",
  updatedAt: "2026-03-03T15:00:00.000Z",
  totalValue: 180000,
  advisor: "Advisor",
  householdId: null,
  householdName: null,
  selectedAccounts: ["****4J9A"],
  accounts: [
    {
      accountId: "01SYNTH1QCJEYSZ6CE6AFS1DRV",
      accountNumber: "****4J9A",
      accountType: "Taxable",
      balance: 180000,
    },
  ],
  liquidateOption: null,
  liquidationApproval: "Yes",
  profile: {
    decidedAt: "2026-03-03T15:00:00.000Z",
    riskScore: 25,
    instructions: [
      { key: "equity_strategy", label: "Equity strategy", value: "IWV 65% · EFA 35%" },
    ],
  },
};

let tx: FakeTx;

beforeEach(() => {
  authSpy.mockResolvedValue({
    user: { email: "advisor@example.com", role: "ADVISOR" },
  });
  cedarRidgeUserSpy.mockResolvedValue("cedar-ridge-henry");
  requestsSpy.mockResolvedValue([REQUEST]);
  accountSpy.mockResolvedValue([
    {
      custodianAccountId: "01SYNTH1QCJEYSZ6CE6AFS1DRV",
      accountStatus: "OPEN",
    },
  ]);
  tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ sf_id: "003HENRY" }]),
    tradeProfileSelection: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "selection-1" }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  withUserScopeSpy.mockImplementation(
    async (_identity: unknown, fn: (value: FakeTx) => unknown) => fn(tx),
  );
});

afterEach(() => vi.clearAllMocks());

describe("confirmTradeProfileSource", () => {
  it("fails closed for a read-only role before reading linked client data", async () => {
    authSpy.mockResolvedValue({ user: { email: "viewer@example.com", role: "VIEWER" } });

    expect(
      await confirmTradeProfileSource(
        "003HENRY",
        "01SYNTH1QCJEYSZ6CE6AFS1DRV",
        "REQ-LUCIA-03",
        "",
      ),
    ).toMatchObject({ ok: false });
    expect(cedarRidgeUserSpy).not.toHaveBeenCalled();
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it("rejects a request that is not scoped to the selected stable account id", async () => {
    requestsSpy.mockResolvedValue([
      {
        ...REQUEST,
        accounts: [{ ...REQUEST.accounts[0], accountId: "different-account" }],
      },
    ]);

    expect(
      await confirmTradeProfileSource(
        "003HENRY",
        "01SYNTH1QCJEYSZ6CE6AFS1DRV",
        "REQ-LUCIA-03",
        "",
      ),
    ).toMatchObject({ ok: false });
    expect(tx.tradeProfileSelection.upsert).not.toHaveBeenCalled();
  });

  it("stores only provenance and writes the confirmation audit in the RLS transaction", async () => {
    const result = await confirmTradeProfileSource(
      "003HENRY",
      "01SYNTH1QCJEYSZ6CE6AFS1DRV",
      "REQ-LUCIA-03",
      " Latest complete instructions ",
    );

    expect(result).toEqual({ ok: true });
    const write = tx.tradeProfileSelection.upsert.mock.calls[0][0];
    expect(write.create).toMatchObject({
      client_sf_id: "003HENRY",
      custodian_account_id: "01SYNTH1QCJEYSZ6CE6AFS1DRV",
      selected_request_id: "REQ-LUCIA-03",
      reviewed_request_ids: ["REQ-LUCIA-03"],
      selection_note: "Latest complete instructions",
      selected_by: "advisor@example.com",
    });
    expect(write.create).not.toHaveProperty("riskScore");
    expect(write.create).not.toHaveProperty("instructions");

    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe(TRADE_PROFILE_SOURCE_CONFIRM);
    expect(JSON.parse(audit.detail)).toMatchObject({
      clientSfId: "003HENRY",
      accountId: "01SYNTH1QCJEYSZ6CE6AFS1DRV",
      requestId: "REQ-LUCIA-03",
      priorRequestId: null,
      notePresent: true,
    });
    expect(revalidateSpy).toHaveBeenCalledWith("/client-portrait/003HENRY");
  });

  it("uses the change audit when replacing a prior confirmation", async () => {
    tx.tradeProfileSelection.findUnique.mockResolvedValue({
      id: "selection-1",
      selected_request_id: "REQ-LUCIA-01",
    });

    await confirmTradeProfileSource(
      "003HENRY",
      "01SYNTH1QCJEYSZ6CE6AFS1DRV",
      "REQ-LUCIA-03",
      "",
    );

    expect(tx.auditLog.create.mock.calls[0][0].data.action).toBe(
      TRADE_PROFILE_SOURCE_CHANGE,
    );
  });
});
