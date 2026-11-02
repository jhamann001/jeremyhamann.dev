import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";
import {
  accountNumberMatchesSuffix,
  defaultReimbursementFeeTypes,
  defaultReimbursementReason,
  isClientSfId,
  isSalesforceId,
  isSubmissionKey,
  maskedAccountSuffix,
  newSubmissionKey,
  normalizeReimbursementAmount,
  parseReimbursementTickets,
  reimbursementDraftErrors,
  reimbursementRequestHref,
  reimbursementStatusChip,
  REIMBURSEMENT_FEE_TYPES,
  type ReimbursementDraft,
} from "@/lib/data/acat-reimbursement-view";
import { FEE_CREDIT_TYPES, parseOperationsFeeRequestForm } from "@/lib/operations/fee-request";
import { parseFeeSubmissionKey } from "@/lib/operations/fee-submission";

const SUITE = "acat-reimbursement-view";
const CLIENT = "003BLO191836131AAA";
const DRAFT: ReimbursementDraft = {
  clientSfId: CLIENT, accountId: "acct-1", feeAmount: "50.00", feeTypes: ["ACAT out"], reason: "Because", tickets: "APX-1, APX-2",
};

describe("reimbursement contract (ticket)", () => {
  it("reads the last four characters of a masked Apex account", () => {
    expect(maskedAccountSuffix("********ZHLK")).toBe("ZHLK");
    expect(maskedAccountSuffix("****1111")).toBe("1111");
    expect(maskedAccountSuffix("  ••••abcd ")).toBe("ABCD");
    expect(maskedAccountSuffix("1111")).toBe("1111");
    for (const none of [null, undefined, "", "***", "********", "abc", "**-12"]) expect(maskedAccountSuffix(none), String(none)).toBeNull();
    markCase(SUITE, "reads the last four characters of a masked Apex account");
  });

  it("matches a full account number only by its last four characters", () => {
    expect(accountNumberMatchesSuffix("5YA01ZHLK", "ZHLK")).toBe(true);
    expect(accountNumberMatchesSuffix(" 5ab12zhlk ", "ZHLK")).toBe(true);
    expect(accountNumberMatchesSuffix("5AB12ZHLJ", "ZHLK")).toBe(false);
    expect(accountNumberMatchesSuffix(null, "ZHLK")).toBe(false);
    expect(accountNumberMatchesSuffix("5YA01ZHLK", null)).toBe(false);
    markCase(SUITE, "matches a full account number only by its last four characters");
  });

  it("defaults the fee type from the direction and leaves an unknown direction empty", () => {
    expect(defaultReimbursementFeeTypes("Out")).toEqual(["ACAT out"]);
    expect(defaultReimbursementFeeTypes(" in ")).toEqual(["ACAT in"]);
    expect(defaultReimbursementFeeTypes(null)).toEqual([]);
    expect(defaultReimbursementFeeTypes("sideways")).toEqual([]);
    for (const type of ["ACAT out", "ACAT in"]) expect(FEE_CREDIT_TYPES as readonly string[]).toContain(type);
    markCase(SUITE, "defaults the fee type from the direction and leaves an unknown direction empty");
  });

  it("writes a default reason that names the control number and the ACAT record", () => {
    expect(defaultReimbursementReason({ recordId: "77", controlNumber: "CTRL-9", contraName: "Fidelity" }))
      .toBe("ACAT transfer fee reimbursement for the Fidelity transfer. Control # CTRL-9. ACAT record 77.");
    expect(defaultReimbursementReason({ recordId: "77", controlNumber: null, contraName: null }))
      .toBe("ACAT transfer fee reimbursement. ACAT record 77.");
    markCase(SUITE, "writes a default reason that names the control number and the ACAT record");
  });

  it("normalizes the amount exactly as the Operations Tools intake does", () => {
    const intake = (value: string): string | null => {
      const form = new FormData();
      form.set("requestKind", "FEE_CREDIT");
      form.set("clientSfId", CLIENT);
      form.append("accountIds", "acct-1");
      form.append("feeTypes", "ACAT out");
      form.set("feeAmount", value);
      try { return parseOperationsFeeRequestForm(form).feeAmount; } catch { return null; }
    };
    for (const value of ["$50.00", "50", "50.5", "1,234.50", " 12.05 ", "0.01", "$0.5", "0", "0.00", "-5", "abc", "", "1.234", "9999999999999.99", "1000000000000"]) {
      expect(normalizeReimbursementAmount(value), JSON.stringify(value)).toBe(intake(value));
    }
    expect(normalizeReimbursementAmount("$50")).toBe("50.00");
    expect(normalizeReimbursementAmount(null)).toBeNull();
    markCase(SUITE, "normalizes the amount exactly as the Operations Tools intake does");
  });

  it("splits ticket references on commas and new lines without repeats", () => {
    expect(parseReimbursementTickets("APX-1, APX-2\nAPX-1\n\n  ,APX-3 ")).toEqual(["APX-1", "APX-2", "APX-3"]);
    expect(parseReimbursementTickets(null)).toEqual([]);
    markCase(SUITE, "splits ticket references on commas and new lines without repeats");
  });

  it("blocks Confirm until a real client, one of its accounts, an amount and a fee type are chosen", () => {
    expect(reimbursementDraftErrors(DRAFT, ["acct-1", "acct-2"])).toEqual({});
    expect(reimbursementDraftErrors({ ...DRAFT, clientSfId: "" }, ["acct-1"]).client).toBeTruthy();
    expect(reimbursementDraftErrors({ ...DRAFT, clientSfId: "Pat Example" }, ["acct-1"]).client).toBeTruthy();
    expect(reimbursementDraftErrors({ ...DRAFT, accountId: "" }, ["acct-1"]).account).toBeTruthy();
    expect(reimbursementDraftErrors({ ...DRAFT, accountId: "acct-9" }, ["acct-1"]).account).toBeTruthy();
    expect(reimbursementDraftErrors(DRAFT, []).account).toBeTruthy();
    expect(reimbursementDraftErrors({ ...DRAFT, feeAmount: "0" }, ["acct-1"]).amount).toBeTruthy();
    expect(reimbursementDraftErrors({ ...DRAFT, feeAmount: "12.345" }, ["acct-1"]).amount).toBeTruthy();
    expect(reimbursementDraftErrors({ ...DRAFT, feeTypes: [] }, ["acct-1"]).feeTypes).toBeTruthy();
    expect(reimbursementDraftErrors({ ...DRAFT, feeTypes: ["Made up"] }, ["acct-1"]).feeTypes).toBeTruthy();
    expect(reimbursementDraftErrors({ ...DRAFT, reason: "x".repeat(2001) }, ["acct-1"]).reason).toBeTruthy();
    expect(reimbursementDraftErrors({ ...DRAFT, tickets: "x".repeat(81) }, ["acct-1"]).tickets).toBeTruthy();
    expect(reimbursementDraftErrors({ ...DRAFT, tickets: Array.from({ length: 51 }, (_, i) => `T-${i}`).join(",") }, ["acct-1"]).tickets).toBeTruthy();
    expect(reimbursementDraftErrors({ ...DRAFT, reason: "" }, ["acct-1"])).toEqual({});
    markCase(SUITE, "blocks Confirm until a real client, one of its accounts, an amount and a fee type are chosen");
  });

  it("accepts a client id only in the shapes the intake accepts, never a name", () => {
    expect(isSalesforceId(CLIENT)).toBe(true);
    expect(isSalesforceId("003BLO191836131")).toBe(true);
    expect(isSalesforceId("Pat Example")).toBe(false);
    expect(isClientSfId("DEV-CLIENT-1")).toBe(true);
    expect(isClientSfId("dev-client-1")).toBe(false);
    expect(isClientSfId("DEV-")).toBe(false);
    for (const bad of ["DEV--A", "DEV-A--B", "DEV-A-", "DEV--", "DEV-a", "DEV-A_B", `DEV-${"A".repeat(61)}`, "XDEV-A"]) expect(isClientSfId(bad), bad).toBe(false);
    for (const good of ["DEV-A", "DEV-A-B-1", `DEV-${"A".repeat(60)}`]) expect(isClientSfId(good), good).toBe(true);
    expect(isClientSfId("")).toBe(false);
    expect(isClientSfId(null)).toBe(false);
    markCase(SUITE, "accepts a client id only in the shapes the intake accepts, never a name");
  });

  it("makes version 4 submission keys the intake accepts", () => {
    const keys = new Set(Array.from({ length: 20 }, () => newSubmissionKey()));
    expect(keys.size).toBe(20);
    for (const key of keys) {
      expect(isSubmissionKey(key)).toBe(true);
      expect(parseFeeSubmissionKey(key)).toBe(key);
    }
    expect(isSubmissionKey("not-a-key")).toBe(false);
    expect(isSubmissionKey(null)).toBe(false);
    markCase(SUITE, "makes version 4 submission keys the intake accepts");
  });

  it("uses the tracker status hues and links one request on the Operations Tools page", () => {
    expect(reimbursementStatusChip("PENDING")).toEqual({ label: "Pending", tone: "warning" });
    expect(reimbursementStatusChip("APPROVED").tone).toBe("info");
    expect(reimbursementStatusChip("CREDITED").tone).toBe("success");
    expect(reimbursementStatusChip("REJECTED").tone).toBe("danger");
    expect(reimbursementStatusChip("CANCELLED").tone).toBe("neutral");
    expect(reimbursementRequestHref("/operations/fee-requests", "req_1")).toBe("/operations/fee-requests?request=req_1#request-req_1");
    expect(REIMBURSEMENT_FEE_TYPES).toEqual([...FEE_CREDIT_TYPES]);
    markCase(SUITE, "uses the tracker status hues and links one request on the Operations Tools page");
  });
});
