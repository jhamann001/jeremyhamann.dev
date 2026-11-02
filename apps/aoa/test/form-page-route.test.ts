import { beforeEach, describe, expect, it, vi } from "vitest";

const { clientSpy, accountsSpy, authSpy } = vi.hoisted(() => ({
  clientSpy: vi.fn(), accountsSpy: vi.fn(), authSpy: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/data/clients", () => ({ getClientWithHousehold: clientSpy }));
vi.mock("@/lib/data/account-aum", () => ({ apexAccountsForClient: accountsSpy }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("REDIRECT"); },
}));
vi.mock("@/components/forms/IraBeneficiaryForm", () => ({ IraBeneficiaryForm: () => null }));

import Page from "../app/(authenticated)/client-portrait/[id]/forms/ira-beneficiary/page";

describe("IRA form route context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authSpy.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.test" } });
    clientSpy.mockResolvedValue({ sf_id: "FL-SOURCE-1", name: "Jordan Synthetic" });
    accountsSpy.mockResolvedValue([{
      custodianAccountId: "FL-ACCOUNT-1", apexAccountNumber: "DEMO-IRA-1001",
      accountType: "Roth IRA", accountStatus: "OPEN",
    }]);
  });

  it("uses the resolved source contact key for account reads", async () => {
    await Page({ params: Promise.resolve({ id: "canonical-contact-key" }) });
    expect(clientSpy).toHaveBeenCalledWith(expect.anything(), "canonical-contact-key");
    expect(accountsSpy).toHaveBeenCalledWith(expect.anything(), "FL-SOURCE-1");
  });

  it("does not read accounts for an inaccessible client", async () => {
    clientSpy.mockResolvedValue(null);
    await expect(Page({ params: Promise.resolve({ id: "missing" }) })).rejects.toThrow("NOT_FOUND");
    expect(accountsSpy).not.toHaveBeenCalled();
  });

  it("does not open the generator without a real Apex number", async () => {
    accountsSpy.mockResolvedValue([{ custodianAccountId: "FL-ACCOUNT-1", apexAccountNumber: null, accountType: "Roth IRA" }]);
    await expect(Page({ params: Promise.resolve({ id: "FL-SOURCE-1" }) })).rejects.toThrow("NOT_FOUND");
  });
});
