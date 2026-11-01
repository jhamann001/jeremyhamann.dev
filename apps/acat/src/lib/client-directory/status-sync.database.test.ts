// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { CedarRidgeDirectorySync } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { lockDirectory, readBackfillDirectoryEvidence, replaceAcatRecordClients, resolveClientIdentity } from "./repository";
import { parseDirectoryRows, type DirectorySnapshot } from "./source";
import { publishDirectorySnapshot, reserveDirectoryAttempt } from "./sync";
import { alice, bob, directoryRows } from "./test-fixtures";

// Run alone, after migrations, against an empty localhost test directory.
// This suite never filters the publication population by CRM stage.
const enabled = process.env.ACAT_DIRECTORY_STATUS_DATABASE_TEST === "1";
let originalState: CedarRidgeDirectorySync | undefined;
const recordIds = new Set<string>();
const accountId = "synthetic-directory-account";

function rowsWithStage(stage: string | null | undefined) {
  const rows = directoryRows();
  if (stage !== undefined) rows[1].crm_stage = stage;
  rows[2].crm_stage = "Lost Client";
  return rows;
}
async function publish(snapshot: DirectorySnapshot) {
  const result = await publishDirectorySnapshot(await reserveDirectoryAttempt(), snapshot);
  expect(result).toEqual({ status: "published", snapshotId: snapshot.digest });
}
async function evidence() {
  return prisma.$transaction(async (tx) => {
    await lockDirectory(tx);
    const { snapshotId, ...facts } = await readBackfillDirectoryEvidence(tx, {
      accountNumber: "001ABC12", candidateUserIds: [alice, bob],
    });
    const identity = await resolveClientIdentity(tx, { cedarRidgeUserId: alice, apexAccountId: "001ABC12" });
    return { snapshotId, facts, identityDigest: identity.evidenceDigest };
  });
}

describe.skipIf(!enabled)("CRM stage publication against PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/transfer_tracker_test") {
      throw new Error("Stage tests require an explicit localhost transfer_tracker_test database");
    }
    if (await prisma.cedarRidgeClient.count() || await prisma.cedarRidgeAccount.count()) {
      throw new Error("Stage tests require an empty directory; no existing rows will be overwritten");
    }
    originalState = await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } });
  });
  beforeEach(() => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "UPSTREAM_VERIFIED");
    vi.stubEnv("CLIENT_DIRECTORY_MAX_AGE_SECONDS", "3600");
    vi.stubEnv("CLIENT_DIRECTORY_SOURCE_MAX_AGE_SECONDS", "7200");
    vi.stubEnv("CLIENT_DIRECTORY_MAX_REMOVAL_PERCENT", "0");
  });
  afterEach(async () => {
    if (!originalState) return;
    await prisma.acatRecord.deleteMany({ where: { id: { in: [...recordIds] } } });
    await prisma.cedarRidgeAccountMember.deleteMany({ where: { investmentAccountId: accountId } });
    await prisma.cedarRidgeAccount.deleteMany({ where: { investmentAccountId: accountId } });
    await prisma.cedarRidgeClient.deleteMany({ where: { cedarRidgeUserId: { in: [alice, bob] } } });
    await prisma.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: originalState });
    recordIds.clear();
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it("persists normalized stage changes and clears null, blank, and legacy missing stages", async () => {
    for (const stage of [" Client ", "Lost Client", "Prospect", null, "Client", " \t ", "Client", undefined]) {
      await publish(parseDirectoryRows(rowsWithStage(stage)));
      expect(await prisma.cedarRidgeClient.findUniqueOrThrow({ where: { cedarRidgeUserId: alice } }))
        .toMatchObject({ crmStage: stage?.trim() || null, eligibility: "ACTIVE" });
      expect(await prisma.cedarRidgeClient.findUniqueOrThrow({ where: { cedarRidgeUserId: bob } }))
        .toMatchObject({ crmStage: "Lost Client", eligibility: "ACTIVE" });
      expect(await prisma.cedarRidgeClient.count()).toBe(2);
      expect(await prisma.cedarRidgeAccount.count()).toBe(1);
      expect(await prisma.cedarRidgeAccountMember.count()).toBe(2);
    }
  });

  it("clears an old stage when a legacy constructed SourceClient omits the optional field", async () => {
    await publish(parseDirectoryRows(rowsWithStage("Client")));
    const legacy = parseDirectoryRows(rowsWithStage(undefined));
    delete legacy.clients[0].crmStage;
    await publish(legacy);
    expect((await prisma.cedarRidgeClient.findUniqueOrThrow({ where: { cedarRidgeUserId: alice } })).crmStage).toBeNull();
  });

  it("changes the publication snapshot but preserves linked records and identity evidence facts", async () => {
    const before = parseDirectoryRows(rowsWithStage("Client"));
    await publish(before);
    const id = `synthetic-stage-${randomUUID()}`;
    recordIds.add(id);
    await prisma.acatRecord.create({ data: { id, clientName: "Historical display", apexAccountId: "001ABC12",
      acatDate: "2026-09-01", lastUpdated: "synthetic-business-clock" } });
    await prisma.$transaction((tx) => replaceAcatRecordClients(tx, {
      recordId: id, cedarRidgeUserIds: [alice], expectedIdentityVersion: 0,
    }));
    const record = await prisma.acatRecord.findUniqueOrThrow({ where: { id }, include: { clientLinks: true } });
    const priorEvidence = await evidence();
    // Keep all non-stage source data, including source-as-of, identical.
    const stableRows = rowsWithStage("Lost Client");
    stableRows[0].source_as_of = before.sourceAsOf;
    const after = parseDirectoryRows(stableRows);
    await publish(after);
    expect(after.digest).not.toBe(before.digest);
    const nextEvidence = await evidence();
    expect(nextEvidence.snapshotId).not.toBe(priorEvidence.snapshotId);
    expect(nextEvidence.facts).toEqual(priorEvidence.facts);
    expect(nextEvidence.identityDigest).toBe(priorEvidence.identityDigest);
    expect(await prisma.acatRecord.findUniqueOrThrow({ where: { id }, include: { clientLinks: true } })).toEqual(record);
  });
});
