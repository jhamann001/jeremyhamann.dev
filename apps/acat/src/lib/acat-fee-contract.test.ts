import { afterEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";
import { feeActionSchema, feeContractEnabled, selectedRuleFee, toFeeLogRow } from "./acat-fee-contract";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("acat-fee-contract", () => {
  it("fee contract is on only when both switches are exactly 1", () => {
    markCase("acat-fee-contract", "fee contract is on only when both switches are exactly 1");
    vi.stubEnv("EPIC_ACAT_FEE_REIMBURSEMENT", "1");
    vi.stubEnv("ROLLOUT_ACAT_FEE_REIMBURSEMENT", "1");
    expect(feeContractEnabled()).toBe(true);
    vi.stubEnv("ROLLOUT_ACAT_FEE_REIMBURSEMENT", "true");
    expect(feeContractEnabled()).toBe(false);
    vi.stubEnv("EPIC_ACAT_FEE_REIMBURSEMENT", "0");
    vi.stubEnv("ROLLOUT_ACAT_FEE_REIMBURSEMENT", "1");
    expect(feeContractEnabled()).toBe(false);
  });

  it("selected rules sum to the workspace amount and memo", () => {
    markCase("acat-fee-contract", "selected rules sum to the workspace amount and memo");
    expect(selectedRuleFee([
      { feeType: "Transfer Out", amount: 75 },
      { feeType: "Account Closing", amount: 50 },
    ])).toEqual({
      feeAmount: "$125.00",
      feeMemo: "Transfer Out: $75.00 + Account Closing: $50.00",
      feeCharged: "Yes",
    });
  });

  it("a rule with an unknown amount marks the fee charged", () => {
    markCase("acat-fee-contract", "a rule with an unknown amount marks the fee charged");
    expect(selectedRuleFee([{ feeType: "Transfer Out", amount: null, amountText: "varies" }])).toMatchObject({
      feeCharged: "Yes",
      feeMemo: "Transfer Out: varies",
    });
  });

  it("the log row drops client and account columns", () => {
    markCase("acat-fee-contract", "the log row drops client and account columns");
    const row = toFeeLogRow({
      id: "9",
      status: "Approved",
      fee_amount: 10,
      client_name: "Synthetic Fee Client",
      account_numbers: "APX-FEE-SECRET-326",
      apex_request: "FEE-326",
    });
    expect(row).toEqual({ id: "9", status: "Approved", feeAmount: 10, feeType: null, submissionDate: null });
    expect(row).not.toHaveProperty("client_name");
    expect(row).not.toHaveProperty("account_numbers");
  });

  it("the request schema rejects extra keys and non-fee fields", () => {
    markCase("acat-fee-contract", "the request schema rejects extra keys and non-fee fields");
    expect(feeActionSchema.safeParse({ action: "log", extra: true }).success).toBe(false);
    expect(feeActionSchema.safeParse({ action: "save", fields: { status: "Completed" } }).success).toBe(false);
    expect(feeActionSchema.safeParse({ action: "save", fields: { feeAmount: "$10.00" } }).success).toBe(true);
  });
});
