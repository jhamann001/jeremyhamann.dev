import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { directoryStatusFromState, lockDirectory } from "@/lib/client-directory/repository";
import { CLIENT_IDENTITY_MAX_CLIENTS } from "@/lib/client-identity-contract";
import { TRANSFER_LINKAGE_CONTRACT_VERSION, TRANSFER_LINKAGE_MAX_MEMBERS, TRANSFER_LINKAGE_MAX_MEMBERS_PER_ACCOUNT,
  TRANSFER_LINKAGE_MAX_RECORDS, LinkageError, type LinkageDirectory, type LinkagePoint, type LinkageSource } from "./contract";
import { projectRecord, projectSnapshot } from "./projection";

const recordSelect = {
  id: true, identityVersion: true, clientLinks: { take: CLIENT_IDENTITY_MAX_CLIENTS + 1,
    select: { cedarRidgeUserId: true }, orderBy: { cedarRidgeUserId: "asc" as const } },
  acatTransferId: true, controlNumber: true, crmDealId: true, direction: true, type: true,
  transferWorkflow: true, status: true, deletedAt: true, createdAt: true, originalClientRequestDate: true, apexAccountId: true,
} satisfies Prisma.AcatRecordSelect;

/** One bounded MVCC snapshot. Directory share lock precedes all reads and
 * matches publisher/identity-writer lock order. No source HTTP inside locks. */
async function readEvidence(recordId: string | undefined, db: PrismaClient) {
  const environment = process.env.TRANSFER_LINKAGE_ENVIRONMENT;
  if (environment !== "production" && environment !== "synthetic") throw new LinkageError("NOT_CONFIGURED");
  return db.$transaction(async (tx) => {
    await lockDirectory(tx);
    const state = await tx.cedarRidgeDirectorySync.findUnique({ where: { id: "global" } });
    if (!state) throw new LinkageError("DIRECTORY_UNAVAILABLE");
    const boundary = await tx.$queryRaw<Array<{ observedAt: Date }>>`SELECT transaction_timestamp() AS "observedAt"`;
    const observedAt = boundary[0].observedAt;
    const status = directoryStatusFromState(state, observedAt);
    const source: LinkageSource = { system: "transfer-tracker", installationId: state.installationId, environment };
    const directory: LinkageDirectory = { snapshotId: state.activeSnapshotId, publishedGeneration: state.publishedGeneration,
      health: status.health, freshnessBasis: status.freshnessBasis!, lastSuccessAt: status.lastSuccessAt, sourceAsOf: status.sourceAsOf };
    const records = await tx.acatRecord.findMany({
      ...(recordId !== undefined ? { where: { id: recordId } } : {}),
      orderBy: { id: "asc" }, take: recordId !== undefined ? 1 : TRANSFER_LINKAGE_MAX_RECORDS + 1, select: recordSelect,
    });
    if (records.length > TRANSFER_LINKAGE_MAX_RECORDS) throw new LinkageError("SNAPSHOT_OVERFLOW");
    if (records.some((record) => record.clientLinks.length > CLIENT_IDENTITY_MAX_CLIENTS)) throw new LinkageError("ACCOUNT_EVIDENCE_OVERFLOW");
    const numbers = [...new Set(records.map((record) => record.apexAccountId.trim().toUpperCase()).filter(Boolean))];
    // Check the total before fetching nested members. A per-account limit alone
    // could materialize hundreds of thousands of rows before rejecting them.
    const membershipCount = numbers.length ? await tx.cedarRidgeAccountMember.count({
      where: { account: { custodian: "APEX", normalizedAccountNumber: { in: numbers } } },
    }) : 0;
    if (membershipCount > TRANSFER_LINKAGE_MAX_MEMBERS) throw new LinkageError("ACCOUNT_EVIDENCE_OVERFLOW");
    const accounts = numbers.length ? await tx.cedarRidgeAccount.findMany({
      where: { custodian: "APEX", normalizedAccountNumber: { in: numbers } },
      orderBy: { investmentAccountId: "asc" },
      select: { investmentAccountId: true, normalizedAccountNumber: true, status: true, isCurrent: true, lastSeenSnapshotId: true,
        members: { take: TRANSFER_LINKAGE_MAX_MEMBERS_PER_ACCOUNT + 1, orderBy: { cedarRidgeUserId: "asc" },
          select: { cedarRidgeUserId: true, relationshipType: true, isCurrent: true, lastSeenSnapshotId: true,
            client: { select: { eligibility: true, lastSeenSnapshotId: true } } } } },
    }) : [];
    if (accounts.some((account) => account.members.length > TRANSFER_LINKAGE_MAX_MEMBERS_PER_ACCOUNT) ||
      accounts.reduce((count, account) => count + account.members.length, 0) > TRANSFER_LINKAGE_MAX_MEMBERS) throw new LinkageError("ACCOUNT_EVIDENCE_OVERFLOW");
    const byNumber = new Map(accounts.map((account) => [account.normalizedAccountNumber, account]));
    return { source, directory, observedAt,
      records: records.map((record) => projectRecord(record, byNumber.get(record.apexAccountId.trim().toUpperCase()) ?? null, directory)) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 3_000, timeout: 10_000 });
}

export async function readLinkageSnapshot(db: PrismaClient = prisma) {
  const result = await readEvidence(undefined, db);
  return projectSnapshot(result.source, result.directory, result.observedAt, result.records);
}

export async function readLinkagePoint(recordId: string, db: PrismaClient = prisma): Promise<LinkagePoint> {
  const result = await readEvidence(recordId, db);
  const record = result.records[0] ?? null;
  return { contractVersion: TRANSFER_LINKAGE_CONTRACT_VERSION, source: result.source, scope: "RECORD", complete: false,
    observedAt: result.observedAt.toISOString(), directory: result.directory,
    outcome: !record ? "MISSING" : record.deletedAt ? "DELETED" : "FOUND", record };
}
