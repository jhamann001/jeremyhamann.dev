import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FeeRequestValidationError,
  parseFeeRequestWorkflowForm,
  parseOperationsFeeRequestForm,
} from "@/lib/operations/fee-request";

const CLIENT_ID = "003V100000ABCDEF";

function form(entries: Array<[string, string]>): FormData {
  const value = new FormData();
  for (const [key, item] of entries) value.append(key, item);
  return value;
}

describe("Operations fee-request validation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts an exact fee-credit amount, multiple fee types, and multiple accounts", () => {
    const parsed = parseOperationsFeeRequestForm(form([
      ["requestKind", "FEE_CREDIT"],
      ["clientSfId", CLIENT_ID],
      ["accountIds", "opaque-account-a"],
      ["accountIds", "opaque-account-b"],
      ["feeTypes", "IRA Maintenance"],
      ["feeTypes", "Wire"],
      ["feeAmount", "$33,333.45"],
      ["reason", "Client was charged two eligible fees."],
      ["relevantTicketRefs", "ZD-123, PT-456\nZD-123"],
    ]));

    expect(parsed).toEqual({
      kind: "FEE_CREDIT",
      clientSfId: CLIENT_ID,
      accountIds: ["opaque-account-a", "opaque-account-b"],
      feeTypes: ["IRA Maintenance", "Wire"],
      feeAmount: "33333.45",
      waiverStart: null,
      waiverDurationMonths: null,
      indefiniteDuration: false,
      reason: "Client was charged two eligible fees.",
      relevantTicketRefs: ["ZD-123", "PT-456"],
    });
  });

  it("accepts the guarded synthetic development client namespace", () => {
    vi.stubEnv("APP_ENV", "dev");
    const parsed = parseOperationsFeeRequestForm(form([
      ["requestKind", "FEE_CREDIT"],
      ["clientSfId", "DEV-DUP-CONTACT-A-20260824"],
      ["accountIds", "DEV-OPS-FEE-ACCOUNT-20260904"],
      ["feeTypes", "Transaction"],
      ["feeAmount", "25.00"],
    ]));

    expect(parsed.clientSfId).toBe("DEV-DUP-CONTACT-A-20260824");
  });

  it.each(["prod", "production", "staging", "", undefined])(
    "rejects synthetic client IDs outside explicit development (%s)", (appEnv) => {
      vi.stubEnv("APP_ENV", appEnv);
      vi.stubEnv("OPERATIONS_PRODUCTION_ENABLED", "1");
      expect(() => parseOperationsFeeRequestForm(form([
        ["requestKind", "FEE_CREDIT"],
        ["clientSfId", "DEV-DUP-CONTACT-A-20260824"],
        ["accountIds", "DEV-OPS-FEE-ACCOUNT-20260904"],
        ["feeTypes", "Transaction"],
        ["feeAmount", "25.00"],
      ]))).toThrow(FeeRequestValidationError);
    },
  );

  it.each([
    "DEV-lowercase-is-not-allowed",
    "DEV-INVALID/PATH",
    `DEV-${"A".repeat(61)}`,
  ])("rejects malformed synthetic client ID %s", (clientSfId) => {
    expect(() => parseOperationsFeeRequestForm(form([
      ["requestKind", "FEE_CREDIT"],
      ["clientSfId", clientSfId],
      ["accountIds", "opaque-account"],
      ["feeTypes", "Transaction"],
      ["feeAmount", "25.00"],
    ]))).toThrow(FeeRequestValidationError);
  });

  it.each([
    ["missing account", [["requestKind", "FEE_CREDIT"], ["clientSfId", CLIENT_ID], ["feeTypes", "Wire"], ["feeAmount", "25.00"]]],
    ["unknown fee type", [["requestKind", "FEE_CREDIT"], ["clientSfId", CLIENT_ID], ["accountIds", "opaque-account"], ["feeTypes", "Invented Fee"], ["feeAmount", "25.00"]]],
    ["zero amount", [["requestKind", "FEE_CREDIT"], ["clientSfId", CLIENT_ID], ["accountIds", "opaque-account"], ["feeTypes", "Wire"], ["feeAmount", "0"]]],
    ["excess precision", [["requestKind", "FEE_CREDIT"], ["clientSfId", CLIENT_ID], ["accountIds", "opaque-account"], ["feeTypes", "Wire"], ["feeAmount", "25.001"]]],
  ] satisfies Array<[string, Array<[string, string]>]>) (
    "rejects a fee credit with %s",
    (_label, entries) => expect(() => parseOperationsFeeRequestForm(form(entries))).toThrow(FeeRequestValidationError),
  );

  it("accepts a fixed service guarantee and normalizes its first month", () => {
    const parsed = parseOperationsFeeRequestForm(form([
      ["requestKind", "SERVICE_GUARANTEE"],
      ["clientSfId", CLIENT_ID],
      ["accountIds", "opaque-account"],
      ["waiverStart", "2026-10"],
      ["waiverDurationMonths", "6"],
      ["reason", "Approved service-recovery request."],
    ]));

    expect(parsed.feeAmount).toBeNull();
    expect(parsed.feeTypes).toEqual([]);
    expect(parsed.waiverStart).toBe("2026-10-01");
    expect(parsed.waiverDurationMonths).toBe(6);
    expect(parsed.indefiniteDuration).toBe(false);
  });

  it("accepts an indefinite billing exception without a duration", () => {
    const parsed = parseOperationsFeeRequestForm(form([
      ["requestKind", "BILLING_EXCEPTION"],
      ["clientSfId", CLIENT_ID],
      ["accountIds", "opaque-account"],
      ["waiverStart", "2026-10"],
      ["waiverDurationMonths", "999"],
      ["indefiniteDuration", "on"],
      ["reason", "Indefinite approved exception requested."],
    ]));

    expect(parsed.waiverDurationMonths).toBeNull();
    expect(parsed.indefiniteDuration).toBe(true);
  });

  it.each(["BILLING_EXCEPTION", "SERVICE_GUARANTEE"] as const)(
    "ignores forged approval metadata on a new %s request",
    (requestKind) => {
      const parsed = parseOperationsFeeRequestForm(form([
        ["requestKind", requestKind],
        ["clientSfId", CLIENT_ID],
        ["accountIds", "opaque-account"],
        ["waiverStart", "2026-10"],
        ["waiverDurationMonths", "6"],
        ["reason", "This request still requires an authorized review."],
        ["status", "APPROVED"],
        ["approval_status", "Approved"],
        ["reviewed_by_email", "forged-reviewer@example.com"],
        ["workflowAction", "APPROVE"],
      ]));

      expect(parsed.kind).toBe(requestKind);
      expect(parsed).not.toHaveProperty("status");
      expect(parsed).not.toHaveProperty("approval_status");
      expect(parsed).not.toHaveProperty("reviewed_by_email");
      expect(parsed).not.toHaveProperty("workflowAction");
    },
  );

  it.each([
    ["missing reason", "", "6"],
    ["zero duration", "Required context", "0"],
    ["excess duration", "Required context", "121"],
  ])("rejects an exception with %s", (_label, reason, duration) => {
    expect(() => parseOperationsFeeRequestForm(form([
      ["requestKind", "LARGE_HOUSEHOLD_EXCEPTION"],
      ["clientSfId", CLIENT_ID],
      ["accountIds", "opaque-account"],
      ["waiverStart", "2026-10"],
      ["waiverDurationMonths", duration],
      ["reason", reason],
    ]))).toThrow(FeeRequestValidationError);
  });

  it("accepts review and credit-completion workflow fields", () => {
    expect(parseFeeRequestWorkflowForm(form([
      ["requestId", "cmfee_request_123456"],
      ["workflowAction", "APPROVE"],
      ["workflowNote", "Reviewed against the supporting ticket."],
    ]))).toEqual({
      requestId: "cmfee_request_123456",
      action: "APPROVE",
      note: "Reviewed against the supporting ticket.",
      creditedDate: null,
      apexRequestId: null,
    });

    expect(parseFeeRequestWorkflowForm(form([
      ["requestId", "cmfee_request_123456"],
      ["workflowAction", "CREDIT"],
      ["creditedDate", "2026-09-03"],
      ["apexRequestId", "APEX-REQ-123"],
    ]))).toMatchObject({
      action: "CREDIT",
      creditedDate: "2026-09-03",
      apexRequestId: "APEX-REQ-123",
    });
  });

  it("requires reasons for rejection/cancellation and exact completion evidence", () => {
    for (const entries of [
      [["requestId", "cmfee_request_123456"], ["workflowAction", "REJECT"]],
      [["requestId", "cmfee_request_123456"], ["workflowAction", "CANCEL"]],
      [["requestId", "cmfee_request_123456"], ["workflowAction", "CREDIT"], ["creditedDate", "2026-02-31"], ["apexRequestId", "APEX-1"]],
      [["requestId", "cmfee_request_123456"], ["workflowAction", "CREDIT"], ["creditedDate", "2026-09-03"]],
    ] satisfies Array<Array<[string, string]>>) {
      expect(() => parseFeeRequestWorkflowForm(form(entries))).toThrow(FeeRequestValidationError);
    }
  });
});
