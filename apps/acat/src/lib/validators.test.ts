import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  createAcatSchema,
  updateAcatSchema,
  createCustodianSchema,
  updateCustodianSchema,
  formatZodError,
  boundedArray,
} from "./validators";

describe("createAcatSchema", () => {
  it("accepts Waiting for Statement on creation and status updates", () => {
    const status = "WaitingForStatement";
    expect(createAcatSchema.parse({
      clientName: "Test Client",
      apexAccountId: "APX-001",
      status,
    }).status).toBe(status);
    expect(updateAcatSchema.parse({ status }).status).toBe(status);
  });

  it("accepts valid input with required fields", () => {
    const result = createAcatSchema.safeParse({
      clientName: "Test Client",
      apexAccountId: "APX-001",
    });
    expect(result.success).toBe(true);
  });

  it("accepts full input with all optional fields", () => {
    const result = createAcatSchema.safeParse({
      clientName: "Test Client",
      apexAccountId: "APX-001",
      direction: "In",
      controlNumber: "CTL-001",
      acatTransferId: "TRN-001",
      accountType: "Individual",
      type: "Full",
      status: "AcatReceived",
      wealthAdvisor: "Jeremy H.",
      feeCharged: "Yes",
      feeAmount: "$50.00",
      notes: "Some notes",
      dtccNumber: "0188",
      tradeRequestId: "TRQ-456",
      tradeRequestUrl: "https://trades.example.com/requests/TRQ-456",
      tradeInstructions: "Liquidate on receipt",
      feeApexTicket: "APEX-FEE-1",
      feeCreditRequestId: "REQ-1",
      transferWorkflow: "ACAT",
      residualMonitoringRequired: true,
      residualFollowUpDate: "2026-02-01",
    });
    expect(result.success).toBe(true);
  });

  it("normalizes DTC, money, and legacy date inputs", () => {
    const result = createAcatSchema.safeParse({
      clientName: "Test Client",
      apexAccountId: "APX-001",
      dtccNumber: "164",
      feeAmount: "50.5",
      originalClientRequestDate: "8-6-2026",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        dtccNumber: "0164",
        feeAmount: "$50.50",
        originalClientRequestDate: "2026-08-06",
      });
    }
  });

  it("normalizes legacy database timestamps with a space separator", () => {
    const result = updateAcatSchema.safeParse({
      originalClientRequestDate: "June 27, 2025",
      opsSubmissionDateToApex: "2025-06-27 12:30:00+00",
      apexCompletionDate: "Jul 3, 2025",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        originalClientRequestDate: "2025-06-27",
        opsSubmissionDateToApex: "2025-06-27",
        apexCompletionDate: "2025-07-03",
      });
    }
  });

  it("rejects invalid trade request URLs on create", () => {
    expect(
      createAcatSchema.safeParse({
        clientName: "Test",
        apexAccountId: "APX-001",
        tradeRequestUrl: "ftp://trades.example.com/request",
      }).success
    ).toBe(false);
    expect(
      createAcatSchema.safeParse({
        clientName: "Test",
        apexAccountId: "APX-001",
        tradeRequestUrl: `https://example.com/${"x".repeat(501)}`,
      }).success
    ).toBe(false);
  });

  it("rejects missing clientName", () => {
    const result = createAcatSchema.safeParse({
      apexAccountId: "APX-001",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty clientName", () => {
    const result = createAcatSchema.safeParse({
      clientName: "",
      apexAccountId: "APX-001",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing apexAccountId", () => {
    const result = createAcatSchema.safeParse({
      clientName: "Test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid status value", () => {
    const result = createAcatSchema.safeParse({
      clientName: "Test",
      apexAccountId: "APX-001",
      status: "InvalidStatus",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateAcatSchema", () => {
  it("accepts partial updates", () => {
    const result = updateAcatSchema.safeParse({ notes: "Updated" });
    expect(result.success).toBe(true);
  });

  it("accepts status enum values", () => {
    const result = updateAcatSchema.safeParse({ status: "Completed" });
    expect(result.success).toBe(true);
  });

  it("accepts only the exclusive transfer workflows", () => {
    expect(updateAcatSchema.safeParse({ transferWorkflow: "PAPERWORK" }).success).toBe(false);
    expect(updateAcatSchema.safeParse({ transferWorkflow: "DRS" }).success).toBe(true);
    expect(updateAcatSchema.safeParse({ transferWorkflow: "API, MANUAL" }).success).toBe(false);
  });

  it("accepts nullable fields", () => {
    const result = updateAcatSchema.safeParse({
      notes: null,
      rejectionReason: null,
      tradeRequestId: null,
      tradeRequestUrl: null,
      tradeInstructions: null,
      feeApexTicket: null,
      feeCreditRequestId: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts and validates trade request fields on update", () => {
    expect(
      updateAcatSchema.safeParse({
        tradeRequestId: "TRQ-456",
        tradeRequestUrl: "https://trades.example.com/requests/TRQ-456",
      }).success
    ).toBe(true);
    expect(updateAcatSchema.safeParse({ tradeRequestUrl: "not-a-url" }).success).toBe(false);
    expect(updateAcatSchema.safeParse({ tradeRequestUrl: "ftp://example.com/request" }).success).toBe(false);
  });

  it("rejects unknown keys (prevents mass-assignment)", () => {
    const forbidden = [
      "deletedAt",
      "createdAt",
      "updatedAt",
      "id",
      "mappingSource",
      "custodianId",
      "custodianName",
      "somethingCompletelyMadeUp",
    ];
    for (const key of forbidden) {
      const result = updateAcatSchema.safeParse({ [key]: "anything" });
      expect(result.success, `${key} should be rejected by strict schema`).toBe(false);
    }
  });

  it("rejects ill-typed values for constrained fields", () => {
    expect(updateAcatSchema.safeParse({ apexSource: "attacker-controlled" }).success).toBe(false);
  });

  it("rejects slackAlerted (ticket: removed in favor of daily digest)", () => {
    // slackAlerted was the toggle behind the now-deleted "Flag to CS Slack"
    // button. It must NOT be settable from the UI anymore — strict mode
    // rejects it as an unknown key. We test true AND a wrong type to make
    // sure both paths are blocked, not just one.
    expect(updateAcatSchema.safeParse({ slackAlerted: true }).success).toBe(false);
    expect(updateAcatSchema.safeParse({ slackAlerted: "yes" }).success).toBe(false);
  });

  it("accepts the narrow allow-list for apexSource", () => {
    expect(updateAcatSchema.safeParse({ apexSource: "Uploaded" }).success).toBe(true);
    expect(updateAcatSchema.safeParse({ apexSource: "Pending Upload" }).success).toBe(true);
  });
});

describe("createCustodianSchema", () => {
  it("accepts a valid name", () => {
    const result = createCustodianSchema.safeParse({ name: "Raymond James" });
    expect(result.success).toBe(true);
  });

  it("trims whitespace around the name", () => {
    const result = createCustodianSchema.safeParse({ name: "  Raymond James  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Raymond James");
    }
  });

  it("rejects an empty name", () => {
    const result = createCustodianSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only name", () => {
    const result = createCustodianSchema.safeParse({ name: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects a name longer than 120 characters", () => {
    const result = createCustodianSchema.safeParse({ name: "x".repeat(121) });
    expect(result.success).toBe(false);
  });

  it("strips the retired requiresManualReview field", () => {
    const created = createCustodianSchema.parse({
      name: "Raymond James",
      requiresManualReview: true,
    });
    const updated = updateCustodianSchema.parse({ requiresManualReview: true });

    expect(created).not.toHaveProperty("requiresManualReview");
    expect(updated).not.toHaveProperty("requiresManualReview");
  });
});

describe("formatZodError", () => {
  it("formats a Zod error into a readable string", () => {
    const result = createAcatSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = formatZodError(result.error);
      expect(message).toContain("clientName");
      expect(message).toContain("apexAccountId");
    }
  });
});

describe("oversized lists", () => {
  it("refuses a list over its limit with one issue, before checking any item", () => {
    const ids = createAcatSchema.safeParse({ clientName: "x", apexAccountId: "APX-1", cedarRidgeUserIds: Array(100_000).fill(0) });
    expect(ids.success).toBe(false);
    if (!ids.success) {
      expect(ids.error.issues).toHaveLength(1);
      expect(formatZodError(ids.error)).toBe("cedarRidgeUserIds: Too many items: at most 10");
    }
  });

  it("still checks the items of a list within its limit", () => {
    const ids = createAcatSchema.safeParse({ clientName: "x", apexAccountId: "APX-1", cedarRidgeUserIds: [0, 0] });
    expect(ids.success).toBe(false);
    if (!ids.success) expect(ids.error.issues).toHaveLength(2);
  });

  it("reports at most five issues", () => {
    const many = boundedArray(z.string(), 50).safeParse(Array(20).fill(0));
    expect(many.success).toBe(false);
    if (!many.success) expect(formatZodError(many.error)).toMatch(/^0: .*; 4: [^;]*; and 15 more$/);
  });
});
