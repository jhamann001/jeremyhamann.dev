import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEE_FIELDS, type TransferFee } from "@/lib/data/acat-fee-view";
import type { TransferFeeReview } from "@/lib/data/transfer-fee-review-contract";
import { libraryFixture } from "./fixtures/custodian-library";

vi.mock("server-only", () => ({}));
vi.mock("@/app/(authenticated)/acat-tracking/fee-actions", () => ({
  loadTransferFee: vi.fn(), saveTransferFeeField: vi.fn(), applyTransferFeeRules: vi.fn(), loadFeeRules: vi.fn(),
}));
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/data/transfer-fee-review", () => ({ readTransferFeeReview: mocks.read }));
vi.mock("@/lib/operations/fee-request-link", () => ({
  acatFeeRequestsHref: () => "/operations/fee-requests",
  acatReimbursementCreateEnabled: () => true,
  acatFeeRequestsReadEnabled: () => true,
}));

import { TransferFeeReviewView, type TransferFeeReviewViewProps } from "@/components/asset-transfer/follow-up/TransferFeeReviewView";
import { TransferFeeReview as Review } from "@/components/asset-transfer/follow-up/TransferFeeReview";

const fee: TransferFee = {
  feeCharged: "Yes", feeAmount: "$45.00", feeMemo: "Synthetic transfer charge",
  feeRequestSubmitted: "2026-10-20", feeRequestCompleted: null,
  feeApexTicket: "https://support.example.test/requests/TEST-45", feeCreditRequestId: "synthetic-request",
};
const ready: TransferFeeReview = {
  library: { state: "ready", custodian: { ...libraryFixture.custodians[0], feeSchedules: [{
    id: "test-schedule", filename: "Synthetic-fee-schedule.pdf", contentType: "application/pdf", byteSize: 2048,
    sha256: "a".repeat(64), createdAt: "2026-10-01T12:00:00.000Z",
  }] }, retrievedAt: libraryFixture.retrievedAt, matchedBy: "id" },
  actual: { state: "ready", fee },
  requests: { state: "ready", accountLabel: "Test brokerage · ****4321", scope: "account", truncated: false,
    requests: [{ id: "synthetic-request", kind: "FEE_CREDIT", status: "PENDING", feeAmount: "45.00", feeTypes: ["Transfer fee"], submittedAt: "2026-10-20T12:00:00Z", creditedAt: null }] },
  recordId: "synthetic-tracker-record",
  record: { clientName: null, direction: "In", type: "Full", status: "Completed", transferringContra: "Example Custodian",
    custodianName: "Example Custodian", custodianId: null, controlNumber: "TEST-CONTROL", apexAccountId: "****4321", transferWorkflow: null, cedarRidgeUserId: null },
};

function props(review: TransferFeeReview = ready): TransferFeeReviewViewProps {
  return { review, clientName: "Test Client", archived: false, feeRequestsHref: "/operations/fee-requests", reimbursement: true, requestsOnFile: false, legacyEntries: [] };
}
const html = (review = ready) => renderToStaticMarkup(createElement(TransferFeeReviewView, props(review)));

describe("asset-transfer fee review", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders all seven tracker fields and the full library qualifications, source and documents", () => {
    const markup = html();
    for (const field of FEE_FIELDS) expect(markup).toContain(field.label);
    for (const text of ["$45.00", "Synthetic transfer charge", "Waived with qualification", "Confirm eligibility", "Internal reference", "Synthetic-fee-schedule.pdf", "Transfer into Apex", "Transfer out of Apex", "$0.00", "Varies"]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain("Edit Fee Amount");
    expect(markup).toContain("Pending");
    expect(markup).not.toContain("Loading custodian fee schedule");
    expect(markup).not.toContain("Reimbursement recorded");
  });

  it("keeps the library and actual values visible when the fee endpoint is unavailable", () => {
    const markup = html({ ...ready, actual: { state: "partial", fee, code: "unauthorized" } });
    expect(markup).toContain("The fee service could not be refreshed");
    expect(markup).toContain("$45.00");
    expect(markup).toContain("Internal reference");
    expect(markup).not.toContain("Edit Fee Amount");
    expect(markup).not.toContain("No Fee Charged");
  });

  it("does not turn failed or missing sources into zero fees or an empty reimbursement history", () => {
    const markup = html({ ...ready, record: null, actual: { state: "unavailable" }, library: { state: "unavailable" }, requests: { state: "unmatched", reason: "account" } });
    expect(markup).toContain("Fee status is unknown");
    expect(markup).toContain("could not be matched to one Apex account");
    expect(markup).not.toContain("No requests found");
    expect(markup).not.toContain("$0.00");
  });

  it("shows explicit off and restricted states with no editor", () => {
    for (const state of ["off", "restricted"] as const) {
      const markup = html({ ...ready, actual: { state }, requests: { state }, library: { state: "restricted" }, record: null });
      expect(markup).toContain(state === "off" ? "not enabled" : "available to Operations and Admin");
      expect(markup).not.toContain("Edit Fee");
    }
  });

  it("keeps requests account scoped and labels only the exact saved request ID as linked", () => {
    const requests = ready.requests;
    if (requests.state !== "ready") throw new Error("fixture");
    const markup = html({ ...ready, actual: { state: "partial", fee, code: "transport" }, requests: { ...requests,
      requests: [...requests.requests, { ...requests.requests[0], id: "other-request", status: "CREDITED", creditedAt: "2026-10-22T12:00:00Z" }], truncated: true } });
    expect(markup.match(/Linked to this transfer/g)).toHaveLength(1);
    expect(markup).toContain("Requests below belong to this account");
    expect(markup).toContain("Showing the 50 most recent requests");
    expect(markup).toContain("Pending");
    expect(markup).toContain("Credited");
  });

  it("renders archived fees read-only and keeps prior manual entries as history", () => {
    const markup = renderToStaticMarkup(createElement(TransferFeeReviewView, {
      ...props(), archived: true, legacyEntries: [{ recordedAt: "2026-10-15T12:00:00Z" }],
    }));
    expect(markup).toContain("Fee details are read-only");
    expect(markup).toContain("Earlier workspace reimbursement entries (1)");
    expect(markup).not.toContain("Edit Fee Amount");
    expect(markup).not.toContain("Record fee reimbursement");
  });

  it("renders unsafe ticket text without turning it into an executable link", () => {
    const markup = html({ ...ready, actual: { state: "partial", fee: { ...fee, feeApexTicket: "javascript:alert(1)" }, code: "transport" } });
    expect(markup).toContain("javascript:alert(1)");
    expect(markup).not.toContain('href="javascript:');
  });

  it("passes the authorized stored transfer and identity to the reader and preserves archive status", async () => {
    mocks.read.mockResolvedValue(ready);
    const identity = { role: "OPERATIONS", email: "test@example.invalid" };
    const transfer = { id: "test-local", acat_record_id: "synthetic-tracker-record", transferring_firm: "Example Custodian",
      archived_at: new Date(), client_first_name: "Test", client_last_name: "Client" };
    const view = await Review({ identity, transfer, legacyEntries: [] });
    expect(mocks.read).toHaveBeenCalledWith(identity, transfer);
    expect(view.props.archived).toBe(true);
    expect(view.props.clientName).toBe("Test Client");
  });
});
