// Synthetic Transfer Tracker records for the demo stand-in's tests. Names and numbers are invented; three records
// carry the local seed's links (DEMO-T-0007 by record id, DEMO-T-0008 and DEMO-T-0009 by transfer id).
import { newTrackerRecord, type TrackerClient, type TrackerRecord } from "@/lib/demo/stand-ins/tracker-model";
import type { PipelineHousehold } from "@/lib/demo/stand-ins/pipeline";

export const USER = {
  neil: "user-0b6f3c1e-2d4a-4b8c-9e1f-3a5b7c9d1e2f",
  sam: "user-1c7a4d2f-3e5b-4c9d-8f2a-4b6c8d0e2f3a",
  asha: "user-2d8b5e3a-4f6c-4dae-9a3b-5c7d9e1f3a4b",
  gavin: "user-3e9c6f4b-5a7d-4ebf-8b4c-6d8e0f2a4b5c",
  abby: "user-4fad7a5c-6b8e-4fca-9c5d-7e9f1a3b5c6d",
  former: "user-5abe8b6d-7c9f-4adb-8d6e-8f0a2b4c6d7e",
} as const;

export const CUSTODIAN = { fidelity: "cust-fidelity", schwab: "cust-schwab", etrade: "cust-etrade", merrill: "cust-merrill" } as const;

const asset = (id: string, symbol: string, description: string, qty: number, amount: number, mapStatus: "Mapped" | "Unmapped" | "Pending" | "Expected" = "Mapped") => ({
  id, symbol, description, cusip: `${symbol.padEnd(6, "0")}101`, expectedQty: qty, actualQty: mapStatus === "Mapped" ? qty : 0,
  mapStatus, issue: mapStatus === "Unmapped" ? "Not in the Apex file" : null, notes: null, amount, assetClass: "Equity",
});

export function trackerRecords(): TrackerRecord[] {
  return [
    newTrackerRecord({
      id: "rec-lee-8", clientName: "Neil Walker", acatDate: "2026-10-20", createdAt: "2026-10-20T14:00:00.000Z",
      lastUpdated: "2026-10-28T15:00:00.000Z", cedarRidgeUserIds: [USER.neil], identityVersion: 2,
      acatTransferId: "ACT-NEIL-8", controlNumber: "C2026102001", direction: "In", type: "Full", accountType: "Individual brokerage",
      status: "Accepted", wealthAdvisor: "Rachel Moss", apexAccountId: "7QA41ZHLK", statementAccountNumber: "Z39129384",
      transferringContra: "Fidelity", dtccNumber: "226", statementAmount: 1871000, transferWorkflow: "ACAT",
      methodRequested: "ACAT (API)", originalClientRequestDate: "2026-10-20", opsSubmissionDateToApex: "2026-10-22",
      custodianId: CUSTODIAN.fidelity, custodianName: "Fidelity", custodianAvgProcessingDays: 6,
      notes: "Client asked to keep the index funds.", tradeInstructions: "Hold in kind.",
      assets: [asset("asset-neil-1", "VTI", "Vanguard Total Stock Market ETF", 120, 3480000), asset("asset-neil-2", "AAPL", "Apple Inc", 40, 912000, "Pending")],
      history: [{ id: "h-neil-1", action: "update", field: "status", oldValue: "Submitted", newValue: "Accepted", performedBy: "jordan.reyes@example.com", timestamp: "2026-10-28T15:00:00.000Z" },
        { id: "h-neil-0", action: "read", field: null, oldValue: null, newValue: null, performedBy: "aoa", timestamp: "2026-10-27T15:00:00.000Z" }],
      feeLog: null,
    }),
    newTrackerRecord({
      id: "rec-sam-9", clientName: "Sam Stone", acatDate: "2026-10-18", createdAt: "2026-10-18T14:00:00.000Z",
      lastUpdated: "2026-10-26T12:00:00.000Z", cedarRidgeUserIds: [USER.sam], acatTransferId: "ACT-SAM-9", direction: "In",
      type: "Full", accountType: "Traditional IRA", status: "Rejected", rejectionReason: "Account title mismatch: the delivering account includes a middle initial.",
      apexAccountId: "4TL22TL8F", statementAccountNumber: "8840-7788", transferringContra: "Schwab", dtccNumber: "0164",
      statementAmount: 2182000, transferWorkflow: "ACAT", custodianId: CUSTODIAN.schwab, custodianName: "Schwab", custodianAvgProcessingDays: 5,
    }),
    newTrackerRecord({
      id: "ACATREC-DEMO-0007", clientName: "Asha Patel", acatDate: "2026-10-24", createdAt: "2026-10-24T14:00:00.000Z",
      lastUpdated: "2026-10-27T12:00:00.000Z", cedarRidgeUserIds: [USER.asha], direction: "In", type: "Full",
      accountType: "Traditional IRA", status: "AcatReceived", apexAccountId: "6PL90AP07", statementAccountNumber: "X55120044",
      transferringContra: "Fidelity", dtccNumber: "0226", statementAmount: 5490000, transferWorkflow: "ACAT",
      custodianId: CUSTODIAN.fidelity, custodianName: "Fidelity", custodianAvgProcessingDays: 6,
      assets: [asset("asset-asha-1", "FXAIX", "Fidelity 500 Index Fund", 210, 4200000, "Pending"), asset("asset-asha-2", "CASH", "Cash", 0, 129000, "Pending")],
    }),
    newTrackerRecord({
      id: "rec-res-2", clientName: "Dev Anand", acatDate: "2026-10-21", createdAt: "2026-10-21T14:00:00.000Z",
      lastUpdated: "2026-10-29T09:00:00.000Z", acatTransferId: "ACT-RES-2", direction: "In", type: "Partial", status: "Submitted",
      apexAccountId: "2NP33NP06", statementAccountNumber: "5512-3571", transferringContra: "Merrill", statementAmount: 512300,
      transferWorkflow: "ACAT", custodianId: CUSTODIAN.merrill, custodianName: "Merrill",
    }),
    newTrackerRecord({
      id: "rec-done-3", clientName: "Gavin Carver", acatDate: "2026-08-03", createdAt: "2026-08-03T14:00:00.000Z",
      lastUpdated: "2026-08-12T16:00:00.000Z", cedarRidgeUserIds: [USER.gavin], controlNumber: "C2026080301", direction: "In",
      type: "Full", accountType: "Roth IRA", status: "Completed", apexAccountId: "9DZ60GC03", statementAccountNumber: "77012716",
      transferringContra: "E*Trade", dtccNumber: "0385", statementAmount: 297000, transferWorkflow: "ACAT",
      originalClientRequestDate: "2026-08-03", opsSubmissionDateToApex: "2026-08-05", apexCompletionDate: "2026-08-12",
      feeCharged: "Yes", feeAmount: "$75.00", feeMemo: "ACAT transfer fee: $75.00", crmTicket: "CRM-4410",
      custodianId: CUSTODIAN.etrade, custodianName: "E*Trade", custodianAvgProcessingDays: 7, reconCompletedAt: "2026-08-13T10:00:00.000Z",
      apexSource: "Uploaded", assets: [asset("asset-gavin-1", "MSFT", "Microsoft Corp", 30, 1290000)],
    }),
    newTrackerRecord({
      id: "rec-out-4", clientName: "Abby Baumbach", acatDate: "2026-07-28", createdAt: "2026-07-28T14:00:00.000Z",
      lastUpdated: "2026-08-04T16:00:00.000Z", cedarRidgeUserIds: [USER.abby], controlNumber: "C2026080401", direction: "Out",
      type: "Full", status: "Completed", apexAccountId: "1GZ47AB04", statementAccountNumber: "61236865", transferringContra: "Fidelity",
      statementAmount: -1044000, transferWorkflow: "ACAT", originalClientRequestDate: "2026-07-28", opsSubmissionDateToApex: "2026-07-29",
      apexCompletionDate: "2026-08-04", residualMonitoringRequired: true, residualFollowUpDate: "2026-09-01", feeCharged: "Yes",
      crmTicket: "CRM-4398", custodianId: CUSTODIAN.fidelity, custodianName: "Fidelity", custodianAvgProcessingDays: 6,
    }),
    newTrackerRecord({
      id: "rec-removed-5", clientName: "Abraham Bergnaum", acatDate: "2026-09-02", createdAt: "2026-09-02T14:00:00.000Z",
      lastUpdated: "2026-09-10T16:00:00.000Z", deletedAt: "2026-09-10T16:00:00.000Z", direction: "In", type: "Full", status: "Canceled",
      apexAccountId: "3NK47AB05", statementAccountNumber: "99019087", transferringContra: "Schwab",
    }),
  ];
}

export function trackerClients(): TrackerClient[] {
  const person = (id: string, name: string, accounts: TrackerClient["accounts"] = [], eligibility: "ACTIVE" | "INACTIVE" = "ACTIVE"): TrackerClient =>
    ({ cedarRidgeUserId: id, displayName: name, eligibility, accounts });
  const apex = (n: string, id: string) => ({ investmentAccountId: id, custodian: "APEX", accountNumber: n, status: "OPEN", isCurrent: true, relationshipType: "INDIVIDUAL" });
  return [
    person(USER.neil, "Neil Walker", [apex("7QA41ZHLK", "inv-neil-1")]),
    person(USER.sam, "Sam Stone", [apex("4TL22TL8F", "inv-sam-1")]),
    person(USER.asha, "Asha Patel", [apex("6PL90AP07", "inv-asha-1")]),
    person(USER.gavin, "Gavin Carver", [apex("9DZ60GC03", "inv-gavin-1")]),
    person(USER.abby, "Abby Baumbach", [apex("1GZ47AB04", "inv-abby-1")]),
    person(USER.former, "Neila Former", [], "INACTIVE"),
  ];
}

/** One statement pipeline run whose account matches Neil Walker's delivering account. */
export function pipelineHouseholds(): PipelineHousehold[] {
  return [{
    id: "9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", client_name: "Walker Household", run_number: 1, processed_at: "2026-10-19T12:00:00.000Z",
    superseded_by: null, source_folder_id: "folder-walker", accounts: [{
      id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", custodian: "Fidelity", account_type: "Individual", account_number: "Z39129384",
      account_holder: "Neil Walker", statement_date: "2026-09-30", total_value: 4392000, assets: [
        { id: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f", symbol: "VTI", description: "Vanguard Total Stock Market ETF", quantity: 120, market_value: 3480000,
          asset_type: "ETF", transfer_eligible: "ACAT", transfer_notes: null, transferring: "YES" },
        { id: "3d4e5f6a-7b8c-4d9e-8f1a-2b3c4d5e6f7a", symbol: "AAPL", description: "Apple Inc", quantity: 40, market_value: 912000,
          asset_type: "Equity", transfer_eligible: "ACAT", transfer_notes: null, transferring: null },
      ],
    }],
  }];
}

/** AoA custodian authority profiles, as readCustodianAuthorityProfiles returns them. */
export function custodianProfiles() {
  const profile = (id: string, name: string, dtcNumber: string | null, avgProcessingDays: number, fees: unknown[] = []) => ({
    id, name, acatFeeAmount: null, avgProcessingDays, contactEmail: null, contactMethod: null, contactDetails: null,
    reviewStatus: "VERIFIED", transferType: "ACAT_API", documentationStatus: "COMPLETE", dtcNumber, receivingAccountNumber: null,
    signature: "Client signature required", letterOfAcceptance: null, medallionRequired: "Not required", liquidationMethod: null,
    returnMethod: "ACAT", watchouts: null, paperworkOnFile: true, transfersToDate: 0, fees,
  });
  return [
    profile(CUSTODIAN.fidelity, "Fidelity", "0226", 6, [
      { id: "fee-fid-1", feeType: "Full transfer", accountType: "ANY", transferType: "FULL", direction: "OUT", amount: 50, amountText: null, notes: null, documentation: null, createdAt: new Date(), updatedAt: new Date() },
      { id: "fee-fid-2", feeType: "IRA closing", accountType: "IRA", transferType: "FULL", direction: "OUT", amount: 25, amountText: null, notes: null, documentation: null, createdAt: new Date(), updatedAt: new Date() },
    ]),
    profile(CUSTODIAN.schwab, "Schwab", "0164", 5),
    profile(CUSTODIAN.etrade, "E*Trade", "0385", 7),
    profile(CUSTODIAN.merrill, "Merrill", "5198", 8),
  ];
}
