import type { CustodianAuthorityProfileRecord } from "@/lib/data/custodian-authority";

// Synthetic only. Never copy live custodian routing or client details here.
export const authorityRecord: CustodianAuthorityProfileRecord = {
  id: "synthetic-one", name: "Example Custodian", reviewStatus: "VERIFIED",
  acatFeeAmount: 50, avgProcessingDays: 9, transferType: "MIXED",
  documentationStatus: "PARTIAL", dtcNumber: "DEMO-1234", receivingAccountNumber: "DEMO-ROUTING",
  signature: null, letterOfAcceptance: null, medallionRequired: null,
  liquidationMethod: null, returnMethod: null, watchouts: null,
  paperworkOnFile: false, transfersToDate: 0, contactEmail: "ops@example.test",
  contactMethod: "EMAIL", contactDetails: "ops@example.test",
  mergedIntoId: null, revision: "1",
  createdAt: "2026-09-01T12:00:00.000Z", updatedAt: "2026-09-20T12:00:00.000Z",
  fees: [{
    id: "fee-1", feeType: "Transfer fee", accountType: "IRA", transferType: "FULL",
    direction: "OUT", amount: 0, amountText: null, notes: null, documentation: null,
    createdAt: "2026-09-01T12:00:00.000Z", updatedAt: "2026-09-20T12:00:00.000Z", revision: "1",
  }],
};
