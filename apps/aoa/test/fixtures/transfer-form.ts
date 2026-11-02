import type { TransferFormPreparation, ConfirmReceivingTitle, GenerateTransferForm } from "@/lib/transfers/transfer-form-contract";

export const transferFormFixture: TransferFormPreparation = {
  schemaVersion: 1, recordId: "sample-record", sourceRevision: "a".repeat(64), checkedAt: "2026-09-25T14:00:00.000Z",
  direction: "INCOMING", scope: "FULL", transferMethod: "ACAT", custodian: { id: "sample-custodian", name: "Example Brokerage" },
  accounts: { receivingMasked: "****1234", deliveringMasked: "****5678", receivingTitleSuggestion: "Sample Test", deliveringTitleSuggestion: "Sample Test", registrationSuggestion: "Individual" },
  confirmation: null,
  workflows: [{ id: "default-brokerage", name: "Standard brokerage transfer", automated: true, requiresReceivingAccountNumber: false, handling: { mode: "CLIENT_DIRECTED", options: ["IN_KIND", "LIQUIDATE"] }, note: null }],
  positions: [{ id: "sample-holding", symbol: "SAMPLE", description: "Synthetic example", quantity: 10, include: true }],
  inheritedTitleReview: false, requirements: [{ label: "Signature", value: "Synthetic instructions for test only" }],
  notices: [], blockers: [], documents: [], ruleVersion: "test-version",
};
export const confirmTitleFixture: ConfirmReceivingTitle = {
  expectedRevision: "a".repeat(64), operationId: "c4b6a222-628d-4e71-951b-79c06ff00e01", title: "Sample Test", registration: "Individual", confirmed: true,
};
export const generateTransferFixture: GenerateTransferForm = {
  expectedRevision: "a".repeat(64), confirmationId: "sample-confirmation", operationId: "c4b6a222-628d-4e71-951b-79c06ff00e02",
  workflowId: "default-brokerage", assetInstruction: "IN_KIND", deliveringTitle: "Sample Test", deliveringTitleConfirmed: true,
  accountsReviewed: true, instructionsReviewed: true, letterOfAuthorizationRequired: false,
};
