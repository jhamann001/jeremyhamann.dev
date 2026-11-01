import { describe, it, expect } from "vitest";
import {
  ADVISOR_VISIBLE_KEYS,
  AdvisorAcatRecord,
  RedactionInput,
  redactForAdvisor,
} from "./advisor-redaction";

// Build a "kitchen sink" record that mixes the structurally-required
// fields with every sensitive sibling we want to confirm gets stripped.
// Using `Record<string, unknown> & RedactionInput` lets the test
// supply extra keys the redactor isn't typed for — exactly the case
// we're guarding against in production (Prisma rows always carry more
// than the redactor's input type names).
function makeRecord(
  overrides: Partial<RedactionInput> & Record<string, unknown> = {}
): RedactionInput & Record<string, unknown> {
  return {
    id: "REC-001",
    clientName: "Jane Doe",
    status: "Submitted",
    direction: "In",
    type: "Full",
    accountType: "Traditional IRA",
    transferringContra: "Schwab",
    wealthAdvisor: "Rachel",
    originalClientRequestDate: "2026-04-01",
    opsSubmissionDateToApex: "2026-04-03",
    apexCompletionDate: null,
    acatDate: "2026-04-01",
    statementAmount: 25000000, // $250K in cents — whitelisted aggregate
    custodian: {
      id: "CUST-1",
      name: "Fidelity",
      avgProcessingDays: 5,
      acatFeeAmount: 75,
      requiresManualReview: false,
      contactEmail: "ops@fidelity.example",
      fees: [{ id: "FEE-1", notes: "internal-only fee memo" }],
    },
    cedarRidgeUserId: "user-private",
    identityVersion: 7,
    // --- Sensitive fields that must be stripped --------------------
    apexAccountId: "APX-9876543",
    statementAccountNumber: "STMT-secret-12345",
    dtccNumber: "1234",
    controlNumber: "CTRL-secret-001",
    associatedControlNumber: "ASSOC-secret-001",
    notes: "Client called ops, do not share these notes",
    feeAmount: "$75.00",
    feeMemo: "Internal: waive if VIP",
    feeCharged: "Yes",
    feeRequestSubmitted: "2026-04-04",
    crwEe: "Yes",
    methodRequested: "Full Docusign",
    crmDealId: "CRM-internal-1",
    crmTicket: "CRM-T-99",
    apexTicket: "AX-T-77",
    additionalResources: "https://crm.example/tasks/abc-123",
    tradeRequestId: "TR-internal-1",
    tradeRequestUrl: "https://internal.example/trades/1",
    rejectionReason: null,
    mappingSource: "GCP Project API",
    apexSource: "Uploaded",
    reconCompletedAt: "2026-04-05T00:00:00Z",
    slackAlerted: true,
    lastUpdated: "2026-04-04T00:00:00Z",
    deletedAt: null,
    assets: [{ id: "A-1", symbol: "AAPL" }],
    ...overrides,
  };
}

describe("redactForAdvisor", () => {
  it("returns only whitelisted keys", () => {
    const out = redactForAdvisor(makeRecord());
    const keys = new Set(Object.keys(out));
    expect(keys).toEqual(ADVISOR_VISIBLE_KEYS);
  });

  it("preserves non-sensitive status and contra fields", () => {
    const out = redactForAdvisor(makeRecord());
    expect(out.clientName).toBe("Jane Doe");
    expect(out.status).toBe("Submitted");
    expect(out.direction).toBe("In");
    expect(out.transferringContra).toBe("Schwab");
    expect(out.wealthAdvisor).toBe("Rachel");
    expect(out.statementAmount).toBe(25000000);
  });

  it("strips internal account numbers, control numbers, and tickets", () => {
    const out = redactForAdvisor(makeRecord()) as unknown as Record<string, unknown>;
    // None of these should appear as keys at all — even a null value
    // surfacing the key implies "this field exists" to a curious caller.
    expect(out).not.toHaveProperty("cedarRidgeUserId");
    expect(out).not.toHaveProperty("identityVersion");
    expect(out).not.toHaveProperty("apexAccountId");
    expect(out).not.toHaveProperty("statementAccountNumber");
    expect(out).not.toHaveProperty("dtccNumber");
    expect(out).not.toHaveProperty("controlNumber");
    expect(out).not.toHaveProperty("associatedControlNumber");
    expect(out).not.toHaveProperty("crmTicket");
    expect(out).not.toHaveProperty("crmDealId");
    expect(out).not.toHaveProperty("apexTicket");
    expect(out).not.toHaveProperty("tradeRequestId");
    expect(out).not.toHaveProperty("tradeRequestUrl");
  });

  it("strips fee and ops-internal notes", () => {
    const out = redactForAdvisor(makeRecord()) as unknown as Record<string, unknown>;
    expect(out).not.toHaveProperty("feeAmount");
    expect(out).not.toHaveProperty("feeMemo");
    expect(out).not.toHaveProperty("feeCharged");
    expect(out).not.toHaveProperty("feeRequestSubmitted");
    expect(out).not.toHaveProperty("feeRequestCompleted");
    expect(out).not.toHaveProperty("notes");
    expect(out).not.toHaveProperty("crwEe");
    expect(out).not.toHaveProperty("methodRequested");
    expect(out).not.toHaveProperty("rejectionReason");
  });

  it("strips audit and recon-internal signals", () => {
    const out = redactForAdvisor(makeRecord()) as unknown as Record<string, unknown>;
    expect(out).not.toHaveProperty("mappingSource");
    expect(out).not.toHaveProperty("apexSource");
    expect(out).not.toHaveProperty("reconCompletedAt");
    expect(out).not.toHaveProperty("slackAlerted");
    expect(out).not.toHaveProperty("lastUpdated");
    expect(out).not.toHaveProperty("deletedAt");
  });

  it("never exposes asset-level positions", () => {
    const out = redactForAdvisor(makeRecord()) as unknown as Record<string, unknown>;
    expect(out).not.toHaveProperty("assets");
  });

  it("keeps a redacted custodian (SLA only, no fees or contact)", () => {
    const out = redactForAdvisor(makeRecord());
    expect(out.custodian).toEqual({
      id: "CUST-1",
      name: "Fidelity",
      avgProcessingDays: 5,
    });
    const c = out.custodian as unknown as Record<string, unknown>;
    expect(c.fees).toBeUndefined();
    expect(c.contactEmail).toBeUndefined();
    expect(c.acatFeeAmount).toBeUndefined();
    expect(c.requiresManualReview).toBeUndefined();
  });

  it("returns custodian=null when the record has none linked", () => {
    const out = redactForAdvisor(makeRecord({ custodian: null }));
    expect(out.custodian).toBeNull();
  });

  it("returns custodian=null when avgProcessingDays is missing (no SLA → not useful)", () => {
    const out = redactForAdvisor(
      makeRecord({
        custodian: {
          id: "CUST-2",
          name: "Some New Custodian",
          avgProcessingDays: null,
        },
      })
    );
    expect(out.custodian).toBeNull();
  });

  it("normalizes empty strings to null on optional text fields", () => {
    const out = redactForAdvisor(
      makeRecord({
        direction: "",
        type: "",
        accountType: "",
        wealthAdvisor: "",
        transferringContra: "",
        apexCompletionDate: "",
        originalClientRequestDate: "",
        opsSubmissionDateToApex: "",
      })
    );
    expect(out.direction).toBeNull();
    expect(out.type).toBeNull();
    expect(out.accountType).toBeNull();
    expect(out.wealthAdvisor).toBeNull();
    expect(out.transferringContra).toBeNull();
    expect(out.apexCompletionDate).toBeNull();
    expect(out.originalClientRequestDate).toBeNull();
    expect(out.opsSubmissionDateToApex).toBeNull();
  });

  it("preserves opsSubmissionDateToApex when present (advisor uses it for timing context)", () => {
    const out = redactForAdvisor(makeRecord());
    expect(out.opsSubmissionDateToApex).toBe("2026-04-03");
  });

  it("preserves a CRM-style additionalResources URL verbatim", () => {
    const out = redactForAdvisor(
      makeRecord({
        additionalResources: "https://crm.example/tasks/abc-123",
      })
    );
    expect(out.additionalResources).toBe(
      "https://crm.example/tasks/abc-123"
    );
  });

  it("maps null/undefined/empty additionalResources to null", () => {
    expect(
      redactForAdvisor(makeRecord({ additionalResources: null }))
        .additionalResources
    ).toBeNull();
    expect(
      redactForAdvisor(makeRecord({ additionalResources: undefined }))
        .additionalResources
    ).toBeNull();
    expect(
      redactForAdvisor(makeRecord({ additionalResources: "" }))
        .additionalResources
    ).toBeNull();
  });

  it("returns a fresh object (does not alias into the source)", () => {
    const src = makeRecord();
    const out = redactForAdvisor(src) as AdvisorAcatRecord;
    if (out.custodian) {
      (out.custodian as { name: string }).name = "TAMPERED";
    }
    const srcCustodian = src.custodian as { name?: string } | null | undefined;
    expect(srcCustodian?.name).toBe("Fidelity");
  });

  it("coerces non-number statementAmount to null", () => {
    const out = redactForAdvisor(
      makeRecord({ statementAmount: undefined as unknown as number })
    );
    expect(out.statementAmount).toBeNull();
  });
});
