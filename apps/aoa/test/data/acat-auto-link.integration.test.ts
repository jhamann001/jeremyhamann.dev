import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sourceFixture from "../fixtures/transfer-linkage-v1.json";
import { applyAcatDecisionWithinScope, undoAcatDecisionWithinScope, setAcatAutomationHoldWithinScope, readAcatRejectedPairsWithinScope } from "@/lib/data/acat-auto-link";
import { readAcatCandidatesWithinScope } from "@/lib/data/acat-match-source";
import { acatEvidenceHash, makeAcatMatchDecision, matchAcatPopulation } from "@/lib/data/acat-match";
import { prepareManifestFromMatches } from "@/lib/data/acat-reconciliation/prepare";
import { prepareReconciliationRun, reviewReconciliationDecision } from "@/lib/data/acat-reconciliation/persistence";
import { prepareHistoricalAcatManifest, readHistoricalAcatIntentWithinScope } from "@/lib/data/acat-historical-review";
import type { LinkageSnapshot } from "@/lib/data/acat-link-contract";
import { attachAcatToTransfer, unlinkAcatFromTransfer, setManualAcatLinkWithinScope } from "@/lib/data/acat-link";

vi.mock("server-only", () => ({}));

// Explicit opt-in to a dedicated synthetic database. Never infer permission
// from an ambient DATABASE_URL or allow fixture writes through a cloud URL.
const RUN = process.env.ACAT_LINK_TEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "ZZTEST-ACAT-LINK-WRITER";
const OPS = { role: "OPERATIONS", email: "acat-link-ops@example.invalid" };
const ids = ["target-race", "record-race-a", "record-race-b", "audit-failure", "viewer", "unlink", "automatic", "drift", "edited", "held", "reviewed", "case-a", "case-b", "rejected", "freshness", "automatic-race", "review-race", "legacy-denial", "historical-uuid"]
  .map((suffix) => `${PREFIX}-${suffix}`);

function syntheticUrl(raw: string | undefined, user: string): URL {
  if (!raw) throw new Error("explicit_acat_link_synthetic_database_required");
  const url = new URL(raw);
  if (!["postgresql:", "postgres:"].includes(url.protocol)
    || url.hostname !== "127.0.0.1" || url.port !== "15541"
    || url.pathname !== "/aoa_acat_matcher_synthetic" || url.username !== user
    || url.hash || [...url.searchParams.keys()].some((key) => key !== "schema")
    || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE) {
    throw new Error("isolated_acat_link_synthetic_database_required");
  }
  return url;
}

RUN("ACAT link writer concurrency and RLS on synthetic PostgreSQL", () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let ingest: PrismaClient;
  const clientId = "003BHJU53435728";
  const householdId = "001BHJU53435728";
  let verified = false;

  async function scoped<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, role = OPS.role, serializable = false): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_role', ${role}, true),
        set_config('app.user_email', ${OPS.email}, true)`;
      return fn(tx);
    }, { timeout: 10_000, maxWait: 5_000, ...(serializable ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : {}) });
  }

  async function clean() {
    if (!verified) return;
    const owned = await owner.acatLinkDecision.findMany({ where: { transfer_id: { in: ids } }, select: { id: true, run_id: true } });
    const runIds = [...new Set(owned.map((row) => row.run_id))];
    const decisions = await owner.acatLinkDecision.findMany({ where: { run_id: { in: runIds } }, select: { id: true } });
    await owner.acatLinkReviewEvent.deleteMany({ where: { decision_id: { in: decisions.map((row) => row.id) } } });
    await owner.acatLinkDecision.deleteMany({ where: { run_id: { in: runIds } } });
    await owner.acatLinkRun.deleteMany({ where: { id: { in: runIds } } });
    await owner.auditLog.deleteMany({ where: { entityId: { in: [...ids, ...runIds, ...decisions.map((row) => row.id)] } } });
    await owner.transfer.deleteMany({ where: { id: { in: ids } } });
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id=${householdId}`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk IN (${Prisma.join(ids)})`;
  }

  beforeAll(async () => {
    const runtime = syntheticUrl(process.env.ACAT_LINK_TEST_DATABASE_URL, "app_rw");
    const cleanup = syntheticUrl(process.env.ACAT_LINK_TEST_CLEANUP_URL, "aoa");
    owner = new PrismaClient({ datasourceUrl: cleanup.href });
    app = new PrismaClient({ datasourceUrl: runtime.href });
    const ingestUrl = new URL(runtime.href); ingestUrl.username = "ingest_rw";
    ingest = new PrismaClient({ datasourceUrl: ingestUrl.href });
    const [actual] = await owner.$queryRaw<Array<{ database: string; username: string }>>`
      SELECT current_database() AS database, current_user AS username`;
    expect(actual).toEqual({ database: "aoa_acat_matcher_synthetic", username: "aoa" });
    const [role] = await scoped((tx) => tx.$queryRaw<Array<{ username: string; superuser: boolean; bypassrls: boolean }>>`
      SELECT current_user AS username, rolsuper AS superuser, rolbypassrls AS bypassrls
      FROM pg_roles WHERE rolname = current_user`);
    expect(role).toEqual({ username: "app_rw", superuser: false, bypassrls: false });
    verified = true;
    await clean();
    await owner.$executeRaw`INSERT INTO mirror.household(sf_id,name,lead_advisor_email)
      VALUES(${householdId},'Synthetic ACAT household',${OPS.email})`;
    await owner.$executeRaw`INSERT INTO mirror.client(sf_id,household_id,lead_advisor_email,cedar_ridge_user_id)
      VALUES(${clientId},${householdId},${OPS.email},'user-11111111-1111-4111-8111-111111111111')`;
    await owner.transfer.createMany({ data: ids.map((id) => ({
      id, source: "APP", client_sf_id: clientId, client_first_name: "Synthetic", client_last_name: "Fixture",
      value: 100, stage: "IN_TRANSFER", funding_type: "ACAT_FULL",
    })) });
    // Only this exact synthetic row fails audit. This exercises the real
    // transaction rollback; mocking writeAudit would bypass the DB guarantee.
    await owner.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION audit.acat_link_synthetic_reject()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."entityId" = 'ZZTEST-ACAT-LINK-WRITER-audit-failure' THEN
        RAISE EXCEPTION 'synthetic audit rejection';
      END IF; RETURN NEW; END $$`);
    await owner.$executeRawUnsafe(`CREATE TRIGGER acat_link_synthetic_reject
      BEFORE INSERT ON audit."AuditLog" FOR EACH ROW
      EXECUTE FUNCTION audit.acat_link_synthetic_reject()`);
  });

  afterAll(async () => {
    if (verified) {
      await owner.$executeRawUnsafe('DROP TRIGGER IF EXISTS acat_link_synthetic_reject ON audit."AuditLog"');
      await owner.$executeRawUnsafe("DROP FUNCTION IF EXISTS audit.acat_link_synthetic_reject()");
      await clean();
    }
    await app?.$disconnect();
    await ingest?.$disconnect();
    await owner?.$disconnect();
  });

  it("one target cannot be overwritten by simultaneous different ACAT attachments", async () => {
    const transferId = ids[0];
    const results = await Promise.all([
      scoped((tx) => attachAcatToTransfer(tx, OPS, transferId, { recordId: "synthetic-acat-a", acatTransferId: null })),
      scoped((tx) => attachAcatToTransfer(tx, OPS, transferId, { recordId: "synthetic-acat-b", acatTransferId: null })),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const row = await owner.transfer.findUniqueOrThrow({ where: { id: transferId } });
    expect(["synthetic-acat-a", "synthetic-acat-b"]).toContain(row.acat_record_id);
    expect(row.stage).toBe("IN_TRANSFER");
    expect(row.value.toString()).toBe("100");
    expect(await owner.auditLog.count({ where: { entityId: transferId, action: "transfer.update" } })).toBe(1);
  });

  it("one ACAT cannot be attached to simultaneous different targets", async () => {
    const key = { recordId: "synthetic-same-record", acatTransferId: null };
    const results = await Promise.allSettled([
      scoped((tx) => attachAcatToTransfer(tx, OPS, ids[1], key)),
      scoped((tx) => attachAcatToTransfer(tx, OPS, ids[2], key)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled" && result.value.ok)).toHaveLength(1);
    // Any raced unique-constraint exception is a normal lost write, not success.
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "P2002" });
    }
    expect(await owner.transfer.count({ where: { acat_record_id: key.recordId } })).toBe(1);
    expect(await owner.auditLog.count({ where: { entityId: { in: [ids[1], ids[2]] }, action: "transfer.update" } })).toBe(1);
  });

  it("audit failure rolls back the link itself", async () => {
    await expect(scoped((tx) => attachAcatToTransfer(tx, OPS, ids[3], {
      recordId: "synthetic-audit-record", acatTransferId: null,
    }))).rejects.toThrow();
    const row = await owner.transfer.findUniqueOrThrow({ where: { id: ids[3] } });
    expect(row.acat_record_id).toBeNull();
    expect(row.acat_transfer_id).toBeNull();
    expect(await owner.auditLog.count({ where: { entityId: ids[3] } })).toBe(0);
  });

  it("VIEWER RLS cannot attach or generate a successful audit", async () => {
    const result = await scoped((tx) => attachAcatToTransfer(tx, { role: "VIEWER", email: OPS.email }, ids[4], {
      recordId: "synthetic-viewer-record", acatTransferId: null,
    }), "VIEWER");
    expect(result.ok).toBe(false);
    expect((await owner.transfer.findUniqueOrThrow({ where: { id: ids[4] } })).acat_record_id).toBeNull();
    expect(await owner.auditLog.count({ where: { entityId: ids[4] } })).toBe(0);
  });

  it("stale manual unlink cannot clear a different record and repeated unlink no-ops", async () => {
    const key = { recordId: "synthetic-unlink-record", acatTransferId: null };
    expect((await scoped((tx) => attachAcatToTransfer(tx, OPS, ids[5], key))).ok).toBe(true);
    expect((await scoped((tx) => unlinkAcatFromTransfer(tx, OPS, ids[5], {
      recordId: "synthetic-other-record", acatTransferId: null,
    }))).ok).toBe(false);
    expect((await scoped((tx) => unlinkAcatFromTransfer(tx, OPS, ids[5], key))).ok).toBe(true);
    expect((await scoped((tx) => unlinkAcatFromTransfer(tx, OPS, ids[5], key))).ok).toBe(true);
    expect(await owner.auditLog.count({ where: { entityId: ids[5], action: "transfer.update" } })).toBe(2);
  });
  async function prepared(index: number, reviewed = false, historical = false) {
    const transferId = ids[index];
    const uuid = `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
    await owner.transfer.update({ where: { id: transferId }, data: { acat_transfer_id: reviewed && !historical ? null : uuid } });
    const now = new Date();
    const snapshot = structuredClone(sourceFixture) as LinkageSnapshot;
    const single = snapshot.records.find((row) => row.recordId === "synthetic-acat-single")!;
    snapshot.records = [{ ...single, recordId: `${transferId}-record`, acatTransferId: uuid }];
    snapshot.records[0].recordEvidenceDigest = acatEvidenceHash({ ...snapshot.records[0], recordEvidenceDigest: undefined });
    snapshot.recordCount = 1;
    snapshot.observedAt = now.toISOString();
    snapshot.snapshotDigest = acatEvidenceHash({ contractVersion: 1, source: snapshot.source, scope: snapshot.scope,
      records: snapshot.records.map((row) => [row.recordId, row.recordEvidenceDigest, row.accountEvidenceDigest]) });
    const targets = await scoped(readAcatCandidatesWithinScope);
    const target = targets.find((row) => row.transferId === transferId)!;
    const decision = reviewed ? makeAcatMatchDecision(snapshot, target, snapshot.records[0], "missing_transaction_evidence", "review")
      : matchAcatPopulation(snapshot, targets, { now, allowLegacyEnrichment: true }).find((row) => row.transferId === transferId)!;
    if (reviewed) {
      return scoped(async (tx) => {
        const rejectedPairs = await readAcatRejectedPairsWithinScope(tx);
        const ordinary = matchAcatPopulation(snapshot, targets, { now, rejectedPairs }).filter((row) =>
          row.transferId !== transferId && !(row.transferId === null && row.recordId === snapshot.records[0].recordId));
        const manifest = historical
          ? prepareHistoricalAcatManifest({ snapshot, targets, now, rejectedPairs,
            intent: await readHistoricalAcatIntentWithinScope(tx, transferId), selection: {
              transferId, recordId: snapshot.records[0].recordId, historicalConfirmed: "yes", evidenceKind: "TRANSFER_DOCUMENT",
              evidenceReference: "SYNTHETIC-UUID-TRANSFER-DOCUMENT", correspondence: "Synthetic exact transfer document proves this selected full transfer; identity and dates alone are not authority.",
              expectedTargetVersion: target.linkVersion, expectedTargetDigest: target.evidenceDigest, expectedSourceDigest: snapshot.snapshotDigest } })
          : prepareManifestFromMatches({ mode: "PREPARE", snapshot, targets, targetBoundary: now, decisions: [...ordinary, decision] });
        const run = await prepareReconciliationRun(tx, OPS, { manifest: manifest.manifest,
          sourceBoundary: { source: { ...snapshot.source }, observedAt: snapshot.observedAt }, targetBoundary: now,
          summary: JSON.parse(JSON.stringify(manifest.summary)) });
        const row = await tx.acatLinkDecision.findFirstOrThrow({ where: { run_id: run.runId, transfer_id: transferId } });
        expect(await reviewReconciliationDecision(tx, OPS, { decisionId: row.id, action: "ACCEPT", expectedReviewVersion: 0,
          expectedEvidenceDigest: row.evidence_digest, reason: "Synthetic exact pair reviewed", historicalConfirmed: historical }))
          .toEqual({ result: "saved", reviewVersion: 1 });
        return { target, decision, row: await tx.acatLinkDecision.findUniqueOrThrow({ where: { id: row.id } }), snapshot, now };
      });
    }
    // Deliberately retain a saved pre-correction UUID-only AUTOMATIC receipt for
    // stale-source/hold/clock and new fail-closed regression tests, never success.
    const run = await owner.acatLinkRun.create({ data: { id: `${transferId}-run`, mode: reviewed ? "PREPARE" : "AUTOMATIC",
      contract_version: 1, rule_version: decision.ruleVersion, installation_id: snapshot.source.installationId,
      source_scope: snapshot.scope, source_boundary: { source: { ...snapshot.source }, observedAt: snapshot.observedAt }, source_digest: snapshot.snapshotDigest,
      source_count: 1, source_complete: true, target_boundary: now, target_digest: "synthetic", target_count: targets.length,
      manifest_digest: "synthetic", idempotency_key: `${transferId}-idempotency`, created_role: "OPERATIONS", created_by: OPS.email, summary: {} } });
    const row = await owner.acatLinkDecision.create({ data: { id: `${transferId}-decision`, run_id: run.id, decision_key: transferId,
      record_id: decision.recordId, transfer_id: decision.transferId, reason: decision.reason, action: decision.action,
      rule_version: decision.ruleVersion, evidence_digest: decision.evidenceDigest, expected_target_version: decision.targetVersion,
      target_evidence_digest: decision.targetDigest, source_candidate_set_digest: decision.sourceCandidateSetDigest,
      payload: { decision: { ...decision }, context: { targetBefore: { recordId: target.existingRecordId, transferUuid: target.existingTransferUuid, hold: target.hold } } },
      disposition: reviewed ? "ACCEPT" : "PENDING", reviewed_by: reviewed ? OPS.email : null, reviewed_at: reviewed ? now : null,
      review_version: reviewed ? 1 : 0 } });
    return { target, decision, row, snapshot, now };
  }

  const automatic = (item: Awaited<ReturnType<typeof prepared>>, snapshot = item.snapshot) => ingest.$transaction((tx) =>
    applyAcatDecisionWithinScope(tx, { role: "INGEST", email: null }, { decisionId: item.row.id, mode: "automatic",
      expectedReviewVersion: 0, snapshot, now: new Date() }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  const reviewedApply = (item: Awaited<ReturnType<typeof prepared>>) => scoped((tx) =>
    applyAcatDecisionWithinScope(tx, OPS, { decisionId: item.row.id, mode: "reviewed",
      expectedReviewVersion: 1, snapshot: item.snapshot, now: new Date() }), OPS.role, true);

  it("applies an ordinary approved pair, reruns without another audit, and undo restores the held unlinked state", async () => {
    const item = await prepared(6, true);
    expect((await reviewedApply(item)).outcome).toBe("APPLIED");
    const after = await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } });
    expect(after.acat_record_id).toBe(item.decision.recordId);
    expect(after.acat_link_version).toBe(item.target.linkVersion + 1);
    expect((await reviewedApply(item)).outcome).toBe("NOOP");
    expect(await owner.auditLog.count({ where: { entityId: item.target.transferId, action: "acat_link.apply" } })).toBe(1);
    const undone = await scoped((tx) => undoAcatDecisionWithinScope(tx, OPS, { decisionId: item.row.id, identity: OPS, expectedReviewVersion: 1 }));
    expect(undone.outcome).toBe("UNDONE");
    const restored = await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } });
    expect(restored.acat_record_id).toBeNull();
    expect(restored.acat_transfer_id).toBe(item.target.existingTransferUuid);
    expect(restored.acat_auto_link_hold).toBe(true);
    expect(restored.acat_link_version).toBe(after.acat_link_version + 1);
    expect((await reviewedApply(item)).outcome).toBe("CONFLICT");
    expect((await scoped((tx) => undoAcatDecisionWithinScope(tx, OPS, { decisionId: item.row.id, identity: OPS, expectedReviewVersion: 1 }))).outcome).toBe("NOOP");
    expect((await scoped((tx) => setManualAcatLinkWithinScope(tx, OPS, { transferId: item.target.transferId,
      expectedVersion: restored.acat_link_version, expectedRecordId: null, expectedTransferUuid: item.target.existingTransferUuid,
      recordId: "synthetic-manual-after-undo", acatTransferId: null }))).ok).toBe(true);
    expect((await scoped((tx) => undoAcatDecisionWithinScope(tx, OPS, { decisionId: item.row.id, identity: OPS, expectedReviewVersion: 1 }))).outcome).toBe("CONFLICT");
  });

  it("refuses a new competing source after preparation although the selected record did not change", async () => {
    const item = await prepared(7);
    const changed = structuredClone(item.snapshot);
    changed.records.push({ ...changed.records[0], recordId: "synthetic-new-competitor", acatTransferId: changed.records[0].acatTransferId!.toUpperCase() });
    changed.recordCount++;
    changed.snapshotDigest = acatEvidenceHash({ contractVersion: 1, source: changed.source, scope: changed.scope,
      records: [...changed.records].sort((a,b)=>a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0).map((row)=>[row.recordId,row.recordEvidenceDigest,row.accountEvidenceDigest]) });
    expect(await automatic(item, changed)).toMatchObject({ outcome: "CONFLICT", reason: "source_changed" });
    expect((await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } })).acat_record_id).toBeNull();
  });

  it("a later manual edit invalidates undo and manual unlink leaves an enduring hold", async () => {
    const item = await prepared(8, true);
    expect((await reviewedApply(item)).outcome).toBe("APPLIED");
    await scoped((tx) => unlinkAcatFromTransfer(tx, OPS, item.target.transferId, { recordId: item.decision.recordId!, acatTransferId: null }));
    const undone = await scoped((tx) => undoAcatDecisionWithinScope(tx, OPS, { decisionId: item.row.id, identity: OPS, expectedReviewVersion: 1 }));
    expect(undone).toMatchObject({ outcome: "CONFLICT", reason: "target_changed" });
    expect((await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } })).acat_auto_link_hold).toBe(true);
  });

  it("hold invalidates a prepared apply, while resume requires its current revision", async () => {
    const item = await prepared(9);
    expect(await scoped((tx) => setAcatAutomationHoldWithinScope(tx, OPS, { action: "HOLD", transferId: item.target.transferId,
      expectedTargetVersion: item.target.linkVersion, decisionId: item.row.id }))).toBe(true);
    expect(await automatic(item)).toMatchObject({ outcome: "CONFLICT", reason: "target_changed" });
    expect(await scoped((tx) => setAcatAutomationHoldWithinScope(tx, OPS, { action: "RESUME", transferId: item.target.transferId,
      expectedTargetVersion: item.target.linkVersion, decisionId: item.row.id }))).toBe(false);
  });

  it("an explicitly reviewed pair can resolve missing transaction authority without changing workflow", async () => {
    const item = await prepared(10, true);
    const applied = await scoped((tx) => applyAcatDecisionWithinScope(tx, OPS, { decisionId: item.row.id, mode: "reviewed",
      expectedReviewVersion: 1, snapshot: item.snapshot, now: new Date() }));
    expect(applied.outcome).toBe("APPLIED");
    const row = await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } });
    expect(row.stage).toBe("IN_TRANSFER");
    expect(row.acat_auto_link_hold).toBe(true);
    expect(row.acat_link_provenance).toBe("REVIEWED");
  });

  it("canonical UUID uniqueness covers differently cased archived reservations at the database boundary", async () => {
    const uuid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await owner.transfer.update({ where: { id: ids[11] }, data: { acat_transfer_id: uuid, archived_at: new Date() } });
    await expect(owner.transfer.update({ where: { id: ids[12] }, data: { acat_transfer_id: uuid.toUpperCase() } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("retains rejected pairs while stale legacy automatic application is denied before mutation", async () => {
    const item = await prepared(13);
    await owner.acatLinkDecision.update({ where: { id: item.row.id }, data: {
      disposition: "REJECT", review_version: 1, reviewed_by: OPS.email, reviewed_at: new Date(),
    } });
    const { id: _id, run_id: _run, created_at: _created, updated_at: _updated, ...copy } = item.row;
    const secondRunId = `${item.target.transferId}-run-next`;
    const oldRun = await owner.acatLinkRun.findUniqueOrThrow({ where: { id: item.row.run_id } });
    const { id: _runId, created_at: _createdRun, updated_at: _updatedRun, ...runCopy } = oldRun;
    await owner.acatLinkRun.create({ data: { ...runCopy, id: secondRunId, idempotency_key: secondRunId,
      source_boundary: oldRun.source_boundary ?? Prisma.JsonNull, summary: oldRun.summary ?? Prisma.JsonNull } });
    const second = await owner.acatLinkDecision.create({ data: { ...copy, id: `${item.row.id}-next`, run_id: secondRunId,
      payload: item.row.payload ?? Prisma.JsonNull } });
    try {
      expect(await automatic({ ...item, row: second })).toMatchObject({ outcome: "CONFLICT", reason: "ineligible_lifecycle" });
      expect(await scoped(readAcatRejectedPairsWithinScope)).toContainEqual({ transferId: item.target.transferId,
        recordId: item.decision.recordId, evidenceDigest: item.decision.evidenceDigest });
      await expect(scoped(async (tx) => prepareHistoricalAcatManifest({ snapshot: item.snapshot,
        targets: await readAcatCandidatesWithinScope(tx), now: new Date(),
        rejectedPairs: await readAcatRejectedPairsWithinScope(tx), intent: await readHistoricalAcatIntentWithinScope(tx, item.target.transferId),
        selection: { transferId: item.target.transferId, recordId: item.decision.recordId!, historicalConfirmed: "yes", evidenceKind: "TRANSFER_DOCUMENT",
          evidenceReference: "SYNTHETIC-REJECTED-PAIR", correspondence: "Synthetic evidence cannot bypass existing rejected intent for this exact pair.",
          expectedTargetVersion: item.target.linkVersion, expectedTargetDigest: item.target.evidenceDigest, expectedSourceDigest: item.snapshot.snapshotDigest } })))
        .rejects.toThrow("prior_rejection");
      expect((await owner.acatLinkDecision.findUniqueOrThrow({ where: { id: second.id } })).outcome).toBe("CONFLICT");
      expect((await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } })).acat_record_id).toBeNull();
    } finally {
      await owner.acatLinkDecision.delete({ where: { id: second.id } });
      await owner.acatLinkRun.delete({ where: { id: secondRunId } });
    }
  });

  it("reviewed audit failure rolls back both the link and its outcome receipt", async () => {
    const item = await prepared(3, true);
    await expect(reviewedApply(item)).rejects.toThrow();
    expect((await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } })).acat_record_id).toBeNull();
    expect((await owner.acatLinkDecision.findUniqueOrThrow({ where: { id: item.row.id } })).outcome).toBe("PENDING");
  });

  it("expires source proof by actual wall clock after a real database advisory-lock wait", async () => {
    const item = await prepared(14);
    let unlock!: () => void;
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => { locked = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const blocker = owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(268261, 1)`;
      locked(); await release;
    });
    await hasLock;
    const applying = automatic(item);
    let waiting = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const [row] = await owner.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory') AS waiting`;
      if (row.waiting) { waiting = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const clock = vi.spyOn(Date, "now").mockReturnValue(item.now.getTime() + 6 * 60_000);
    unlock();
    try {
      expect(waiting).toBe(true);
      await blocker;
      expect(await applying).toMatchObject({ outcome: "CONFLICT", reason: "source_unavailable" });
      expect((await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } })).acat_record_id).toBeNull();
    } finally { clock.mockRestore(); unlock(); await blocker; }
  });

  it("overlapping reviewed attempts commit one link and one audit", async () => {
    const item = await prepared(15, true);
    const results = await Promise.allSettled([reviewedApply(item), reviewedApply(item)]);
    expect(results.filter((row) => row.status === "fulfilled" && row.value.outcome === "APPLIED")).toHaveLength(1);
    for (const row of results) if (row.status === "rejected") {
      expect(row.reason).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      if (row.reason.code !== "P2034") expect(row.reason).toMatchObject({ code: "P2010", meta: { code: "40001" } });
    }
    expect(await owner.auditLog.count({ where: { entityId: item.target.transferId, action: "acat_link.apply" } })).toBe(1);
  });

  it("an older apply request cannot poison the outcome of a newer accepted review", async () => {
    const item = await prepared(16, true);
    await owner.acatLinkDecision.update({ where: { id: item.row.id }, data: { review_version: 2 } });
    const apply = (expectedReviewVersion: number) => scoped((tx) => applyAcatDecisionWithinScope(tx, OPS, {
      decisionId: item.row.id, mode: "reviewed", expectedReviewVersion, snapshot: item.snapshot, now: new Date(),
    }));
    expect(await apply(1)).toMatchObject({ outcome: "CONFLICT", reason: "review_changed" });
    expect(await owner.acatLinkDecision.findUniqueOrThrow({ where: { id: item.row.id } })).toMatchObject({ review_version: 2, outcome: "PENDING" });
    expect((await apply(2)).outcome).toBe("APPLIED");
  });

  it("denies an unapplied legacy UUID-only automatic receipt and generic approval with no link or apply audit", async () => {
    const item = await prepared(17);
    const before = await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } });
    expect(before.acat_auto_link_hold).toBe(false);
    expect(await automatic(item)).toMatchObject({ outcome: "CONFLICT", reason: "ineligible_lifecycle" });
    expect(await scoped((tx) => reviewReconciliationDecision(tx, OPS, { decisionId: item.row.id, action: "ACCEPT",
      expectedReviewVersion: 0, expectedEvidenceDigest: item.row.evidence_digest, reason: "Synthetic stale generic review" })))
      .toEqual({ result: "saved", reviewVersion: 1 });
    expect(await reviewedApply(item)).toMatchObject({ outcome: "CONFLICT", reason: "historical_review_required" });
    expect(await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } })).toEqual(before);
    expect(await owner.auditLog.count({ where: { entityId: item.target.transferId, action: "acat_link.apply" } })).toBe(0);
  });

  it("explicit historical prepare and confirmation apply then undo UUID-only evidence without erasing its original UUID", async () => {
    const item = await prepared(18, true, true);
    const before = await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } });
    expect(item.row.payload).toMatchObject({ context: { historicalReview: { kind: "HISTORICAL_ACAT_REVIEW" } } });
    expect(await reviewedApply(item)).toMatchObject({ outcome: "APPLIED" });
    const linked = await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } });
    expect(linked).toMatchObject({ acat_record_id: item.decision.recordId, acat_transfer_id: before.acat_transfer_id,
      acat_auto_link_hold: true, acat_link_provenance: "REVIEWED", acat_link_version: before.acat_link_version + 1 });
    expect(linked.stage).toBe(before.stage); expect(linked.funding_type).toBe(before.funding_type); expect(linked.value).toEqual(before.value);
    expect(await reviewedApply(item)).toMatchObject({ outcome: "NOOP" });
    expect(await owner.auditLog.count({ where: { entityId: item.target.transferId, action: "acat_link.apply" } })).toBe(1);
    expect(await scoped((tx) => undoAcatDecisionWithinScope(tx, OPS, { decisionId: item.row.id, identity: OPS, expectedReviewVersion: 1 })))
      .toMatchObject({ outcome: "UNDONE" });
    const restored = await owner.transfer.findUniqueOrThrow({ where: { id: item.target.transferId } });
    expect(restored).toMatchObject({ acat_record_id: null, acat_transfer_id: before.acat_transfer_id,
      acat_auto_link_hold: true, acat_link_provenance: "UNDO", acat_link_version: linked.acat_link_version + 1 });
    expect(restored.stage).toBe(before.stage); expect(restored.funding_type).toBe(before.funding_type); expect(restored.value).toEqual(before.value);
    expect(await owner.auditLog.count({ where: { entityId: item.target.transferId, action: "acat_link.undo" } })).toBe(1);
  });

});
