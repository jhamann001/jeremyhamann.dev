import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { directoryFreshnessPolicy } from "@/lib/client-identity-policy";
import { ttlSeconds } from "./repository";
import { DirectorySourceError, fetchDirectoryRows, type DirectorySnapshot } from "./source";

export type PublishResult = { status: "published" | "superseded"; snapshotId: string | null };

function maximumRemovalPercent(): number {
  const raw = process.env.CLIENT_DIRECTORY_MAX_REMOVAL_PERCENT ?? "";
  if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) < 0 || Number(raw) > 100) {
    throw new DirectorySourceError("SOURCE_REMOVAL_LIMIT_NOT_CONFIGURED");
  }
  return Number(raw);
}

/** Reserve before fetching. Every completion is fenced by this generation so a
 * slower, older request cannot undo a newer success or hide a newer failure. */
export async function reserveDirectoryAttempt(): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
    const state = await tx.cedarRidgeDirectorySync.update({ where: { id: "global" },
      data: { attemptGeneration: { increment: 1 }, lastAttemptAt: new Date() } });
    return state.attemptGeneration;
  }, { maxWait: 2000, timeout: 3000 });
}

export function assertPublishableSnapshot(snapshot: DirectorySnapshot, now = new Date()): void {
  maximumRemovalPercent();
  const freshnessBasis = directoryFreshnessPolicy();
  const sourceMaxAge = ttlSeconds("CLIENT_DIRECTORY_SOURCE_MAX_AGE_SECONDS");
  if (!ttlSeconds("CLIENT_DIRECTORY_MAX_AGE_SECONDS") || (freshnessBasis === "UPSTREAM_VERIFIED" && !sourceMaxAge)) {
    throw new DirectorySourceError("SOURCE_FRESHNESS_NOT_CONFIGURED");
  }
  if (snapshot.sourceHealth === "STALE") throw new DirectorySourceError("SOURCE_STALE");
  const age = snapshot.sourceAsOf ? now.getTime() - new Date(snapshot.sourceAsOf).getTime() : null;
  if (age !== null && (!Number.isFinite(age) || age < -300_000)) throw new DirectorySourceError("SOURCE_CLOCK_INVALID");
  if (freshnessBasis === "FETCH_SUCCESS") return;
  if (snapshot.sourceHealth !== "FRESH" || !snapshot.sourceAsOf) throw new DirectorySourceError("SOURCE_UNVERIFIED");
  if (age! > sourceMaxAge! * 1000) throw new DirectorySourceError("SOURCE_STALE");
}

export async function recordDirectoryFailure(generation: number, code: string): Promise<void> {
  // The code is deliberately an internal constant, never provider text or SQL.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
    await tx.cedarRidgeDirectorySync.updateMany({ where: { id: "global", attemptGeneration: generation },
      data: { lastErrorCode: code } });
  }, { maxWait: 1000, timeout: 3000 });
}

export async function publishDirectorySnapshot(generation: number, snapshot: DirectorySnapshot): Promise<PublishResult> {
  assertPublishableSnapshot(snapshot);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
    await tx.$queryRaw`SELECT "id" FROM "CedarRidgeDirectorySync" WHERE "id" = 'global' FOR UPDATE`;
    const state = await tx.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } });
    if (generation !== state.attemptGeneration || generation <= state.publishedGeneration) {
      return { status: "superseded", snapshotId: state.activeSnapshotId };
    }
    assertPublishableSnapshot(snapshot);
    if (state.sourceAsOf && snapshot.sourceAsOf && new Date(snapshot.sourceAsOf).getTime() < state.sourceAsOf.getTime()) {
      throw new DirectorySourceError("SOURCE_AS_OF_REGRESSED");
    }
    if (state.activeSnapshotId) {
      // Count actual removed identities/relationships, not merely net row loss:
      // an unrelated same-size source population must not silently replace it.
      const [removed] = await tx.$queryRaw<Array<{ clients: bigint; accounts: bigint; memberships: bigint }>>`
        SELECT
          (SELECT count(*) FROM "CedarRidgeClient" WHERE "lastSeenSnapshotId" = ${state.activeSnapshotId}
            AND "cedar_ridge_user_id" NOT IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(snapshot.clients.map((c) => c.cedarRidgeUserId))}::jsonb))) AS clients,
          (SELECT count(*) FROM "CedarRidgeAccount" WHERE "isCurrent" = true
            AND "investmentAccountId" NOT IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(snapshot.accounts.map((a) => a.investmentAccountId))}::jsonb))) AS accounts,
          (SELECT count(*) FROM "CedarRidgeAccountMember" WHERE "isCurrent" = true
            AND ("investmentAccountId", "cedar_ridge_user_id") NOT IN
              (SELECT "investmentAccountId", "cedarRidgeUserId" FROM jsonb_to_recordset(${JSON.stringify(snapshot.memberships)}::jsonb)
                AS m("investmentAccountId" text, "cedarRidgeUserId" text))) AS memberships
      `;
      const limit = maximumRemovalPercent();
      if ([[removed.clients, state.clientCount], [removed.accounts, state.accountCount], [removed.memberships, state.membershipCount]]
        .some(([count, previous]) => Number(previous) > 0 && Number(count) * 100 > Number(previous) * limit)) {
        throw new DirectorySourceError("SOURCE_REMOVAL_LIMIT_EXCEEDED");
      }
    }
    const snapshotId = snapshot.digest;
    // One parameterized statement per population keeps a several-thousand-row
    // snapshot within the existing 60s request budget. No 4k sequential upserts.
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "CedarRidgeClient" ("cedar_ridge_user_id", "canonicalName", "normalizedName", "crmStage", "eligibility", "source", "sourceUpdatedAt", "lastSeenSnapshotId")
      SELECT "cedarRidgeUserId", "canonicalName", "normalizedName", "crmStage", "eligibility", "source", "sourceUpdatedAt", ${snapshotId}
      FROM jsonb_to_recordset(${JSON.stringify(snapshot.clients.map((client) => ({ ...client,
        crmStage: client.crmStage?.trim() || null })))}::jsonb) AS c(
        "cedarRidgeUserId" text, "canonicalName" text, "normalizedName" text, "crmStage" text, "eligibility" text, "source" text, "sourceUpdatedAt" timestamp)
      ON CONFLICT ("cedar_ridge_user_id") DO UPDATE SET
        "canonicalName" = EXCLUDED."canonicalName", "normalizedName" = EXCLUDED."normalizedName",
        "crmStage" = EXCLUDED."crmStage",
        "eligibility" = EXCLUDED."eligibility", "source" = EXCLUDED."source", "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
        "lastSeenSnapshotId" = EXCLUDED."lastSeenSnapshotId"
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "CedarRidgeAccount" ("investmentAccountId", "custodian", "custodianAccountId", "accountNumber", "normalizedAccountNumber", "status", "sourceUpdatedAt", "isCurrent", "lastSeenSnapshotId")
      SELECT "investmentAccountId", "custodian", "custodianAccountId", "accountNumber", "normalizedAccountNumber", "status", "sourceUpdatedAt", true, ${snapshotId}
      FROM jsonb_to_recordset(${JSON.stringify(snapshot.accounts)}::jsonb) AS a(
        "investmentAccountId" text, "custodian" text, "custodianAccountId" text, "accountNumber" text, "normalizedAccountNumber" text, "status" text, "sourceUpdatedAt" timestamp)
      ON CONFLICT ("investmentAccountId") DO UPDATE SET
        "custodian" = EXCLUDED."custodian", "custodianAccountId" = EXCLUDED."custodianAccountId", "accountNumber" = EXCLUDED."accountNumber",
        "normalizedAccountNumber" = EXCLUDED."normalizedAccountNumber", "status" = EXCLUDED."status", "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
        "isCurrent" = true, "lastSeenSnapshotId" = EXCLUDED."lastSeenSnapshotId"
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "CedarRidgeAccountMember" ("investmentAccountId", "cedar_ridge_user_id", "relationshipType", "isCurrent", "lastSeenSnapshotId")
      SELECT "investmentAccountId", "cedarRidgeUserId", "relationshipType", true, ${snapshotId}
      FROM jsonb_to_recordset(${JSON.stringify(snapshot.memberships)}::jsonb) AS m(
        "investmentAccountId" text, "cedarRidgeUserId" text, "relationshipType" text)
      ON CONFLICT ("investmentAccountId", "cedar_ridge_user_id") DO UPDATE SET
        "relationshipType" = EXCLUDED."relationshipType", "isCurrent" = true, "lastSeenSnapshotId" = EXCLUDED."lastSeenSnapshotId"
    `);
    // Preserve historical identities and relationships. Deleting disappeared
    // clients would invalidate existing ACAT links and lose review evidence.
    await tx.cedarRidgeAccountMember.updateMany({ where: { lastSeenSnapshotId: { not: snapshotId }, isCurrent: true }, data: { isCurrent: false } });
    await tx.cedarRidgeAccount.updateMany({ where: { lastSeenSnapshotId: { not: snapshotId }, isCurrent: true }, data: { isCurrent: false } });
    await tx.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: {
      publishedGeneration: generation, activeSnapshotId: snapshotId, lastSuccessAt: new Date(),
      sourceAsOf: snapshot.sourceAsOf ? new Date(snapshot.sourceAsOf) : null, sourceHealth: snapshot.sourceHealth, source: snapshot.source,
      sourceFingerprint: snapshot.queryFingerprint, clientCount: snapshot.clients.length,
      accountCount: snapshot.accounts.length, membershipCount: snapshot.memberships.length, lastErrorCode: null,
    } });
    return { status: "published", snapshotId };
  }, { maxWait: 2000, timeout: 15_000 });
}

export async function syncClientDirectory(): Promise<PublishResult> {
  const generation = await reserveDirectoryAttempt();
  try {
    return await publishDirectorySnapshot(generation, await fetchDirectoryRows());
  } catch (error) {
    const code = error instanceof DirectorySourceError ? error.code : "DIRECTORY_PUBLICATION_FAILED";
    await recordDirectoryFailure(generation, code);
    throw new DirectorySourceError(code);
  }
}
