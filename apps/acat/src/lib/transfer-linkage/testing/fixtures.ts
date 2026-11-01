import type { LinkageDirectory, LinkageSource } from "../contract";
import { projectRecord, projectSnapshot, type AccountEvidence, type RecordEvidence } from "../projection";

export const SYNTHETIC_INSTALLATION = "9fffffff-ffff-4fff-8fff-ffffffffffff";
export const SYNTHETIC_EPOCHS = ["baseline", "late-arrival", "new-competitor", "membership-changed", "stale-directory"] as const;
export type SyntheticEpoch = typeof SYNTHETIC_EPOCHS[number];
export const SYNTHETIC_PEOPLE = [
  "user-11111111-1111-4111-8111-111111111111",
  "user-22222222-2222-4222-8222-222222222222",
  "user-33333333-3333-4333-8333-333333333333",
] as const;
export const SYNTHETIC_TRANSFERS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
] as const;

export function syntheticInputs(epoch: SyntheticEpoch = "baseline", now = new Date("2026-09-26T12:00:00.000Z")) {
  const source: LinkageSource = { system: "transfer-tracker", installationId: SYNTHETIC_INSTALLATION, environment: "synthetic" };
  const directory: LinkageDirectory = { snapshotId: "synthetic-publication-1", publishedGeneration: 1,
    health: epoch === "stale-directory" ? "STALE" : "FRESH", freshnessBasis: "FETCH_SUCCESS",
    lastSuccessAt: new Date(now.getTime() - (epoch === "stale-directory" ? 86_400_000 : 1000)).toISOString(), sourceAsOf: null };
  const member = (index: number, relationshipType: string) => ({ cedarRidgeUserId: SYNTHETIC_PEOPLE[index],
    relationshipType, isCurrent: true, lastSeenSnapshotId: directory.snapshotId!,
    client: { eligibility: "ACTIVE", lastSeenSnapshotId: directory.snapshotId! } });
  const accounts: AccountEvidence[] = [
    { investmentAccountId: "synthetic-investment-single", normalizedAccountNumber: "SYNTHETIC001", status: "OPEN",
      isCurrent: true, lastSeenSnapshotId: directory.snapshotId!, members: [member(0, "PRIMARY")] },
    { investmentAccountId: "synthetic-investment-joint", normalizedAccountNumber: "SYNTHETIC002", status: "OPEN",
      isCurrent: true, lastSeenSnapshotId: directory.snapshotId!, members: [member(1, "JOINT"), member(2, "JOINT")] },
  ];
  const makeRecord = (id: string, index: number, ids: readonly string[]): RecordEvidence => ({
    id, identityVersion: 3, clientLinks: ids.map((cedarRidgeUserId) => ({ cedarRidgeUserId })),
    acatTransferId: SYNTHETIC_TRANSFERS[index], controlNumber: `SYNTHETIC-CONTROL-${index + 1}`,
    crmDealId: "", direction: "IN", type: "FULL", transferWorkflow: "ACAT", status: "Submitted",
    deletedAt: null, createdAt: new Date("2026-09-01T12:00:00.000Z"),
    originalClientRequestDate: "2026-09-01", apexAccountId: index === 1 ? "SYNTHETIC002" : "SYNTHETIC001",
  });
  const records = [makeRecord("synthetic-acat-single", 0, [SYNTHETIC_PEOPLE[0]]),
    makeRecord("synthetic-acat-joint", 1, [SYNTHETIC_PEOPLE[1], SYNTHETIC_PEOPLE[2]])];
  if (epoch === "late-arrival") records.push(makeRecord("synthetic-acat-late", 2, [SYNTHETIC_PEOPLE[0]]));
  if (epoch === "new-competitor") records.push({ ...makeRecord("synthetic-acat-competitor", 0, [SYNTHETIC_PEOPLE[0]]),
    acatTransferId: SYNTHETIC_TRANSFERS[0].toUpperCase() });
  if (epoch === "membership-changed") accounts[0].members.push(member(1, "JOINT"));
  return { source, directory, accounts, records };
}

export function syntheticSnapshot(epoch: SyntheticEpoch = "baseline", now = new Date()) {
  const { source, directory, accounts, records } = syntheticInputs(epoch, now);
  return projectSnapshot(source, directory, now, records.map((record) => projectRecord(record,
    accounts.find((account) => account.normalizedAccountNumber === record.apexAccountId) ?? null, directory)));
}
