import type { Evidence, TrackerRow, TrackerSnapshot } from "../contracts";
export const USER_A = "user-11111111-1111-4111-8111-111111111111";
export const USER_B = "user-22222222-2222-4222-8222-222222222222";
export const NOW = "2026-09-25T12:00:00.000Z";
export const evidence: Evidence = {
  version: 1, extractedAt: NOW, snapshotId: "synthetic-snapshot", sourceQueryHashes: { synthetic: "a".repeat(64) },
  upstreamFreshness: "verified", freshnessEvidence: "synthetic test only",
  clients: [{ userId: USER_A, name: "Morgan Sample" }, { userId: USER_B, name: "Taylor Example" }],
  accounts: [{ accountId: "account-synthetic-1", accountNumber: "SYNTHETIC1", userId: USER_A, relationshipType: "PRIMARY" }],
  transfers: [{ transferId: "transfer-synthetic-1", userId: USER_A, isInitiator: true }],
};
export const record: TrackerRow = {
  id: "synthetic-record-1", cedarRidgeUserId: null, cedarRidgeUserIds: [], identityVersion: 0, clientName: "Morgan Sample",
  apexAccountId: " SYNTHETIC1 ", acatTransferId: "transfer-synthetic-1", deletedAt: null,
};
export const tracker: TrackerSnapshot = { version: 2, extractedAt: NOW, target: "local-test", databaseName: "transfer_tracker_test", installationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", preMigrationPlaceholders: [], records: [record] };

export const jointEvidence: Evidence = { ...evidence, accounts: [
  { ...evidence.accounts[0], relationshipType: "JOINT" },
  { ...evidence.accounts[0], userId: USER_B, relationshipType: "JOINT" },
] };
