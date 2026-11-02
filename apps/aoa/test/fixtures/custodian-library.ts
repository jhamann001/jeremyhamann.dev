import type { CustodianLibrary } from "@/lib/data/custodian-library-contract";

// Synthetic only. Never copy live custodian routing or client details here.
export const libraryFixture: CustodianLibrary = {
  schemaVersion: 1, retrievedAt: "2026-09-21T16:00:00.000Z",
  custodians: [{
    id: "synthetic-one", name: "Example Custodian", reviewStatus: "VERIFIED",
    acatFeeAmount: 50, transferType: "MIXED", documentationStatus: "PARTIAL",
    dtcNumber: "DEMO-1234", receivingAccountNumber: "DEMO-ROUTING",
    signature: "Wet signature", letterOfAcceptance: "Required for IRA",
    medallionRequired: "Call to confirm", liquidationMethod: "Contact firm",
    returnMethod: "Secure portal", watchouts: "Confirm instructions\nUse current form",
    paperworkOnFile: false, transfersToDate: 0, contactEmail: "ops@example.test",
    contactMethod: "EMAIL", contactDetails: "ops@example.test",
    configuredExpectedProcessingDays: 7, observedAvgProcessingBusinessDays: 3,
    observedCompletedTransfers: 8,
    fees: [{ id: "fee-zero", feeType: "Transfer fee", accountType: "IRA",
      transferType: "FULL", direction: "OUT", amount: 0,
      amountText: "Waived with qualification", notes: "Confirm eligibility",
      documentation: "Internal reference", createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-20T12:00:00.000Z" },
    { id: "fee-variable", feeType: "Delivery fee", accountType: "ANY",
      transferType: "ANY", direction: "IN", amount: null,
      amountText: "Varies", notes: null, documentation: null,
      createdAt: "2026-09-01T12:00:00.000Z", updatedAt: "2026-09-20T12:00:00.000Z" }],
  }],
};
