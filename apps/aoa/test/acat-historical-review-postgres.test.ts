import { Prisma, PrismaClient, type Transfer } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sourceFixture from "./fixtures/transfer-linkage-v1.json";
import type { LinkageSnapshot } from "@/lib/data/acat-link-contract";
import { acatEvidenceHash, makeAcatMatchDecision, matchAcatPopulation } from "@/lib/data/acat-match";
import { readAcatCandidatesWithinScope } from "@/lib/data/acat-match-source";
import { prepareHistoricalAcatManifest, readHistoricalAcatIntentWithinScope } from "@/lib/data/acat-historical-review";
import { prepareManifestFromMatches } from "@/lib/data/acat-reconciliation/prepare";
import { prepareReconciliationRun, reviewReconciliationDecision } from "@/lib/data/acat-reconciliation/persistence";
import { applyAcatDecisionWithinScope, readAcatRejectedPairsWithinScope, setAcatAutomationHoldWithinScope, undoAcatDecisionWithinScope } from "@/lib/data/acat-auto-link";
import { attachAcatToTransfer, unlinkAcatFromTransfer } from "@/lib/data/acat-link";
import { writeAudit } from "@/lib/audit";

vi.mock("server-only", () => ({}));

// Deliberately use the existing isolated matcher CI database. No ambient URL,
// cloud host, production fixture or owner role can exercise the app write path.
const RUN = process.env.ACAT_LINK_TEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "ZZTEST-ACAT-HISTORICAL";
const OPS = { role: "OPERATIONS", email: "acat-historical-ops@example.invalid" };
const HOUSEHOLD = "001HISTTEST00001";
const CLIENT = "003HISTTEST00001";
const USER = "user-11111111-1111-4111-8111-111111111111";
const TARGET = `${PREFIX}-target`;
const RECORD = `${PREFIX}-record`;
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const evidence = { evidenceKind: "TRANSFER_DOCUMENT" as const, evidenceReference: "SYNTHETIC-TRANSFER-DOCUMENT-1",
  correspondence: "Synthetic reviewed transfer document identifies this exact full transfer; this is not a name or date inference." };

function localUrl(raw: string | undefined, role: "app_rw" | "aoa"): string {
  if (!raw) throw new Error("explicit_historical_synthetic_database_required");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || url.port !== "15541"
    || url.pathname !== "/aoa_acat_matcher_synthetic" || url.username !== role || url.hash
    || [...url.searchParams.keys()].some((key) => key !== "schema")
    || process.env.K_SERVICE || process.env.CLOUD_RUN_JOB || process.env.CLOUD_RUN_SERVICE
    || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
    throw new Error("isolated_historical_synthetic_database_required");
  }
  return url.href;
}

function snapshot(partial = false): LinkageSnapshot {
  const result = structuredClone(sourceFixture) as LinkageSnapshot;
  const record = result.records.find((row) => row.recordId === "synthetic-acat-single")!;
  record.recordId = RECORD;
  record.status = "Completed";
  record.transferType = partial ? "PARTIAL" : "FULL";
  record.recordEvidenceDigest = acatEvidenceHash({ ...record, recordEvidenceDigest: undefined });
  result.records = [record];
  result.observedAt = new Date().toISOString();
  result.directory.lastSuccessAt = result.observedAt;
  return reseal(result);
}
function reseal(result: LinkageSnapshot): LinkageSnapshot {
  result.recordCount = result.records.length;
  result.snapshotDigest = acatEvidenceHash({ contractVersion: result.contractVersion, source: result.source, scope: result.scope,
    records: [...result.records].sort((a, b) => a.recordId < b.recordId ? -1 : 1)
      .map((row) => [row.recordId, row.recordEvidenceDigest, row.accountEvidenceDigest]) });
  return result;
}
function businessFields(row: Transfer) {
  const { acat_record_id: _record, acat_transfer_id: _uuid, acat_link_version: _version,
    acat_link_provenance: _provenance, acat_link_decision_id: _decision, updated_at: _updated, updated_by: _actor, ...business } = row;
  // Includes hold, funded stage, funding approvals, asset mapping, value, owner,
  // workflow gates and every other scalar business field from the real row.
  return business;
}

RUN("human historical ACAT review on isolated PostgreSQL", () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let ingest: PrismaClient;
  let verified = false;
  let priorIdentityFlag: string | undefined;
  const runs = new Set<string>();
  const transfers = new Set<string>();

  async function scope<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, role = OPS.role): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_role', ${role}, true), set_config('app.user_email', ${OPS.email}, true)`;
      return fn(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000, maxWait: 5_000 });
  }
  async function cleanup() {
    if (!verified) return;
    const decisions = await owner.acatLinkDecision.findMany({ where: { run_id: { in: [...runs] } }, select: { id: true } });
    await owner.acatLinkReviewEvent.deleteMany({ where: { decision_id: { in: decisions.map((row) => row.id) } } });
    await owner.acatLinkDecision.deleteMany({ where: { run_id: { in: [...runs] } } });
    await owner.acatLinkRun.deleteMany({ where: { id: { in: [...runs] } } });
    await owner.transfer.deleteMany({ where: { id: { in: [...transfers] } } });
    await owner.auditLog.deleteMany({ where: { entityId: { in: [...runs, ...transfers, ...decisions.map((row) => row.id)] } } });
    await owner.rowChange.deleteMany({ where: { schema_name: "app", table_name: "transfer", row_pk: { in: [...transfers] } } });
    runs.clear(); transfers.clear();
  }
  async function createTarget(data: Partial<Prisma.TransferCreateInput> = {}) {
    const id = data.id ?? TARGET;
    expect(await owner.transfer.findUnique({ where: { id } })).toBeNull();
    const row = await owner.transfer.create({ data: { id, source: "APP", client_sf_id: CLIENT,
      client_first_name: "Synthetic", client_last_name: "Historical", value: 1234.56, stage: "FUNDED",
      funding_type: "ACAT_FULL", acat_auto_link_hold: true, funding_plan_complete: true,
      accounts_opened_at_apex: true, funding_initiated: true, cash_in_flight: false,
      owner_kind: "OPERATIONS", next_step: "Synthetic workflow must remain unchanged", ...data } });
    transfers.add(id);
    return row;
  }
  async function prepare(source = snapshot(), transferId = TARGET, reference = evidence.evidenceReference) {
    return scope(async (tx) => {
      const now = new Date();
      const targets = await readAcatCandidatesWithinScope(tx);
      const target = targets.find((row) => row.transferId === transferId)!;
      const intent = await readHistoricalAcatIntentWithinScope(tx, transferId);
      const prepared = prepareHistoricalAcatManifest({ snapshot: source, targets, intent, now,
        rejectedPairs: await readAcatRejectedPairsWithinScope(tx), selection: { ...evidence, evidenceReference: reference,
          transferId, recordId: source.records[0].recordId, historicalConfirmed: "yes",
          expectedTargetVersion: target.linkVersion, expectedTargetDigest: target.evidenceDigest, expectedSourceDigest: source.snapshotDigest } });
      const run = await prepareReconciliationRun(tx, OPS, { manifest: prepared.manifest,
        sourceBoundary: { source: { ...source.source }, observedAt: source.observedAt }, targetBoundary: now, summary: prepared.summary });
      runs.add(run.runId);
      const decision = await tx.acatLinkDecision.findFirstOrThrow({ where: { run_id: run.runId, transfer_id: transferId } });
      return { run, decision, source, target };
    });
  }
  type Prepared = Awaited<ReturnType<typeof prepare>>;
  async function confirm(item: Prepared, action: "ACCEPT" | "REJECT" = "ACCEPT", version = 0, confirmed = true) {
    return scope((tx) => reviewReconciliationDecision(tx, OPS, { decisionId: item.decision.id, action,
      expectedReviewVersion: version, expectedEvidenceDigest: item.decision.evidence_digest,
      reason: "Synthetic exact historical transfer evidence reviewed", historicalConfirmed: confirmed }));
  }
  const apply = (item: Prepared, source = item.source, reviewVersion = 1) => scope((tx) => applyAcatDecisionWithinScope(tx, OPS, {
    decisionId: item.decision.id, mode: "reviewed", expectedReviewVersion: reviewVersion, snapshot: source, now: new Date() }));
  const row = () => owner.transfer.findUniqueOrThrow({ where: { id: TARGET } });
  const applyAudits = () => owner.auditLog.count({ where: { entityId: TARGET, action: "acat_link.apply" } });

  beforeAll(async () => {
    const appUrl = localUrl(process.env.ACAT_LINK_TEST_DATABASE_URL, "app_rw");
    const ownerUrl = localUrl(process.env.ACAT_LINK_TEST_CLEANUP_URL, "aoa");
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    const ingestUrl = new URL(appUrl); ingestUrl.username = "ingest_rw";
    ingest = new PrismaClient({ datasourceUrl: ingestUrl.href });
    const [actual] = await owner.$queryRaw<Array<{ database: string; username: string }>>`SELECT current_database() AS database,current_user AS username`;
    expect(actual).toEqual({ database: "aoa_acat_matcher_synthetic", username: "aoa" });
    const [runtime] = await scope((tx) => tx.$queryRaw<Array<{ username: string; superuser: boolean; bypass: boolean; forced: boolean }>>`
      SELECT current_user AS username,r.rolsuper AS superuser,r.rolbypassrls AS bypass,c.relforcerowsecurity AS forced
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='app.transfer'::regclass`);
    expect(runtime).toEqual({ username: "app_rw", superuser: false, bypass: false, forced: true });
    expect(await owner.transfer.count({ where: { id: { startsWith: PREFIX } } })).toBe(0);
    expect(await owner.$queryRaw`SELECT sf_id FROM mirror.client WHERE sf_id=${CLIENT}`).toEqual([]);
    expect(await owner.$queryRaw`SELECT sf_id FROM mirror.household WHERE sf_id=${HOUSEHOLD}`).toEqual([]);
    await owner.$executeRaw`INSERT INTO mirror.household(sf_id,name,lead_advisor_email) VALUES(${HOUSEHOLD},'Synthetic historical household',${OPS.email})`;
    await owner.$executeRaw`INSERT INTO mirror.client(sf_id,household_id,lead_advisor_email,cedar_ridge_user_id) VALUES(${CLIENT},${HOUSEHOLD},${OPS.email},${USER})`;
    verified = true;
    priorIdentityFlag = process.env.CRM_IDENTITY_READS; process.env.CRM_IDENTITY_READS = "1";
  });
  beforeEach(async () => { await cleanup(); await createTarget(); });
  afterAll(async () => {
    try {
      await cleanup();
      if (verified) {
        await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id=${CLIENT}`;
        await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id=${HOUSEHOLD}`;
        if (priorIdentityFlag === undefined) delete process.env.CRM_IDENTITY_READS; else process.env.CRM_IDENTITY_READS = priorIdentityFlag;
      }
    } finally { await app?.$disconnect(); await ingest?.$disconnect(); await owner?.$disconnect(); }
  });

  it.each([false, true])("requires distinct confirmation then applies/retries/undoes a completed %s partial transfer while keeping the hold", async (partial) => {
    if (partial) await owner.transfer.update({ where: { id: TARGET }, data: { funding_type: "ACAT_PARTIAL" } });
    const before = await row(); const item = await prepare(snapshot(partial));
    expect((await prepare(item.source)).run).toMatchObject({ runId: item.run.runId, created: false });
    expect(await row()).toEqual(before);
    expect(await apply(item, item.source, 0)).toMatchObject({ outcome: "CONFLICT", reason: "not_approved" });
    expect(await confirm(item, "ACCEPT", 0, false)).toEqual({ result: "ineligible", reason: "historical_confirmation_required" });
    expect(await owner.acatLinkReviewEvent.count({ where: { decision_id: item.decision.id } })).toBe(0);
    expect(await confirm(item)).toEqual({ result: "saved", reviewVersion: 1 });
    expect(await apply(item)).toMatchObject({ outcome: "APPLIED", recordId: RECORD });
    const after = await row();
    expect(after).toMatchObject({ acat_record_id: RECORD, acat_transfer_id: UUID, acat_auto_link_hold: true, acat_link_provenance: "REVIEWED" });
    expect(businessFields(after)).toEqual(businessFields(before));
    expect(await apply(item)).toMatchObject({ outcome: "NOOP" });
    expect(await applyAudits()).toBe(1);
    expect(await row()).toEqual(after);
    const undo = () => scope((tx) => undoAcatDecisionWithinScope(tx, OPS, { decisionId: item.decision.id, identity: OPS, expectedReviewVersion: 1 }));
    expect(await undo()).toMatchObject({ outcome: "UNDONE" });
    const restored = await row();
    expect(restored).toMatchObject({ acat_record_id: null, acat_transfer_id: null, acat_auto_link_hold: true, acat_link_provenance: "UNDO" });
    expect(businessFields(restored)).toEqual(businessFields(before));
    expect(restored.acat_link_version).toBe(after.acat_link_version + 1);
    expect(await undo()).toMatchObject({ outcome: "NOOP" });
    expect(await apply(item)).toMatchObject({ outcome: "CONFLICT", reason: "decision_undone" });
    await expect(prepare(item.source)).rejects.toThrow("prior_unlink");
  });

  it("historical evidence never makes a funded target eligible for the automatic writer", async () => {
    const item = await prepare();
    const targets = await scope(readAcatCandidatesWithinScope);
    expect(matchAcatPopulation(item.source, targets, { now: new Date() }).find((d) => d.transferId === TARGET))
      .toMatchObject({ action: "exclude", reason: "manual_hold" });
    const result = await ingest.$transaction((tx) => applyAcatDecisionWithinScope(tx, { role: "INGEST", email: null }, {
      decisionId: item.decision.id, mode: "automatic", expectedReviewVersion: 0, snapshot: item.source, now: new Date() }));
    expect(result).toMatchObject({ outcome: "CONFLICT", reason: "historical_review_required" });
    expect((await row()).acat_record_id).toBeNull(); expect(await applyAudits()).toBe(0);
  });

  it.each([null, "WIRE"] as const)("does not create a historical run for unspecified/non-ACAT funding %s", async (funding_type) => {
    await owner.transfer.update({ where: { id: TARGET }, data: { funding_type } });
    const before = await row();
    await expect(prepare()).rejects.toThrow(funding_type === null ? "funding_unspecified" : "not_acat_funding");
    expect(await row()).toEqual(before); expect(runs.size).toBe(0);
  });

  it("keeps prior rejected intent even after that old decision is changed to ACCEPT", async () => {
    const item = await prepare();
    expect(await confirm(item, "REJECT")).toMatchObject({ result: "saved", reviewVersion: 1 });
    expect(await confirm(item, "ACCEPT", 1)).toMatchObject({ result: "saved", reviewVersion: 2 });
    await expect(prepare(item.source, TARGET, "SYNTHETIC-TRANSFER-DOCUMENT-2")).rejects.toThrow("prior_rejection");
    expect(await apply(item, item.source, 2)).toMatchObject({ outcome: "CONFLICT", reason: "prior_rejection" });
    expect((await row()).acat_record_id).toBeNull();
  });

  it("blocks a previously unlinked exact record using the real row-change audit", async () => {
    const key = { recordId: RECORD, acatTransferId: UUID };
    expect((await scope((tx) => attachAcatToTransfer(tx, OPS, TARGET, key))).ok).toBe(true);
    expect((await scope((tx) => unlinkAcatFromTransfer(tx, OPS, TARGET, key))).ok).toBe(true);
    const intent = await scope((tx) => readHistoricalAcatIntentWithinScope(tx, TARGET));
    expect(intent.linkClears.some((clear) => clear.recordId === RECORD && clear.transferUuid === UUID)).toBe(true);
    await expect(prepare()).rejects.toThrow("prior_unlink");
    expect((await row()).acat_auto_link_hold).toBe(true);
  });

  it("rejects stale review versions and a substantive target edit before apply", async () => {
    const item = await prepare(); await confirm(item);
    expect(await confirm(item, "REJECT", 0)).toEqual({ result: "conflict" });
    expect(await apply(item, item.source, 0)).toMatchObject({ outcome: "CONFLICT", reason: "review_changed" });
    await owner.transfer.update({ where: { id: TARGET }, data: { funding_type: "ACAT_PARTIAL" } });
    expect(await apply(item)).toMatchObject({ outcome: "CONFLICT", reason: "target_changed" });
    expect(await applyAudits()).toBe(0);
  });

  it("rechecks a newly reserved record across the complete target population", async () => {
    const item = await prepare(); await confirm(item);
    await createTarget({ id: `${PREFIX}-competitor`, acat_record_id: RECORD, acat_transfer_id: UUID });
    expect(await apply(item)).toMatchObject({ outcome: "CONFLICT", reason: "reserved_link" });
    expect((await row()).acat_record_id).toBeNull(); expect(await applyAudits()).toBe(0);
  });

  it("rechecks newly recorded pair rejection from another prepared review", async () => {
    const item = await prepare(); const rejection = await prepare(item.source, TARGET, "SYNTHETIC-SECOND-REVIEW");
    expect(rejection.decision.id).not.toBe(item.decision.id);
    await confirm(rejection, "REJECT"); await confirm(item);
    expect(await apply(item)).toMatchObject({ outcome: "CONFLICT", reason: "prior_rejection" });
    expect(await applyAudits()).toBe(0);
  });

  it.each(["stale", "incomplete", "changed"] as const)("fails closed on %s source proof after confirmation", async (failure) => {
    const item = await prepare(); await confirm(item);
    const changed = structuredClone(item.source);
    if (failure === "stale") changed.observedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    else if (failure === "incomplete") (changed as { complete: boolean }).complete = false;
    else { changed.records.push({ ...changed.records[0], recordId: `${RECORD}-new` }); reseal(changed); }
    expect(await apply(item, changed)).toMatchObject({ outcome: "CONFLICT", reason: failure === "changed" ? "source_changed" : "source_unavailable" });
    expect((await row()).acat_record_id).toBeNull(); expect(await applyAudits()).toBe(0);
  });

  it.each(["undo-audit", "orphan-provenance", "undone-decision"] as const)("retains %s intent without a matching row-clear audit", async (kind) => {
    if (kind === "undo-audit") {
      await scope((tx) => writeAudit(tx, OPS, { action: "acat_link.undo", entityType: "transfer", entityId: TARGET, detail: {} }));
    } else if (kind === "orphan-provenance") {
      await owner.transfer.update({ where: { id: TARGET }, data: { acat_link_provenance: "UNDO", acat_link_decision_id: null } });
    } else {
      const old = await prepare();
      // Synthetic imported historical receipt, with no corresponding link or
      // field-level audit; missing history must never imply permission.
      await owner.acatLinkDecision.update({ where: { id: old.decision.id }, data: { outcome: "UNDONE" } });
    }
    const intent = await scope((tx) => readHistoricalAcatIntentWithinScope(tx, TARGET));
    expect(intent.linkClears).toHaveLength(1);
    expect(intent.linkClears[0].id).toMatch(kind === "undo-audit" ? /^undo-audit:/ : kind === "orphan-provenance" ? /^current:/ : /^decision:/);
    await expect(prepare()).rejects.toThrow("prior_unlink");
    expect((await row()).acat_record_id).toBeNull();
  });

  it("Undo prevents the same pair but permits a different pair with fresh explicit evidence", async () => {
    const first = await prepare(); await confirm(first);
    expect(await apply(first)).toMatchObject({ outcome: "APPLIED" });
    expect(await scope((tx) => undoAcatDecisionWithinScope(tx, OPS, { decisionId: first.decision.id,
      identity: OPS, expectedReviewVersion: 1 }))).toMatchObject({ outcome: "UNDONE" });
    await expect(prepare(first.source)).rejects.toThrow("prior_unlink");
    const restored = await row();
    const different = snapshot(); different.records[0].recordId = `${RECORD}-different`;
    different.records[0].acatTransferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    different.records[0].recordEvidenceDigest = acatEvidenceHash({ ...different.records[0], recordEvidenceDigest: undefined }); reseal(different);
    const second = await prepare(different, TARGET, "SYNTHETIC-CORRECTED-TRANSFER-DOCUMENT-B");
    expect(await row()).toEqual(restored);
    expect(await apply(second, different, 0)).toMatchObject({ outcome: "CONFLICT", reason: "not_approved" });
    expect(await confirm(second, "ACCEPT", 0, false)).toEqual({ result: "ineligible", reason: "historical_confirmation_required" });
    await confirm(second);
    expect(await apply(second)).toMatchObject({ outcome: "APPLIED", recordId: `${RECORD}-different` });
    expect((await row()).acat_auto_link_hold).toBe(true);
    expect(businessFields(await row())).toEqual(businessFields(restored));
    expect(await applyAudits()).toBe(2);
  });

  it("rechecks an audit-only Undo recorded after preparation", async () => {
    const item = await prepare(); await confirm(item);
    await scope((tx) => writeAudit(tx, OPS, { action: "acat_link.undo", entityType: "transfer", entityId: TARGET, detail: {} }));
    expect(await apply(item)).toMatchObject({ outcome: "CONFLICT", reason: "prior_unlink" });
    expect(await applyAudits()).toBe(0);
  });

  it("ordinary RESUME and ACCEPT cannot bypass the separate historical confirmation", async () => {
    const item = await prepare(); const before = await row();
    expect(await scope((tx) => reviewReconciliationDecision(tx, OPS, { decisionId: item.decision.id, action: "RESUME",
      expectedReviewVersion: 0, expectedEvidenceDigest: item.decision.evidence_digest,
      expectedTargetVersion: item.target.linkVersion, reason: "Synthetic explicit policy change" }, setAcatAutomationHoldWithinScope)))
      .toEqual({ result: "ineligible" });
    expect(await row()).toEqual(before);
    expect(await confirm(item, "ACCEPT", 0, false)).toEqual({ result: "ineligible", reason: "historical_confirmation_required" });
    expect(await confirm(item, "ACCEPT", 0, true)).toMatchObject({ result: "saved", reviewVersion: 1 });
    expect(await apply(item)).toMatchObject({ outcome: "APPLIED" });
    expect((await row()).acat_auto_link_hold).toBe(true);
  });

  it("never replaces an unrecognized existing raw transfer reference with a null UUID", async () => {
    await owner.transfer.update({ where: { id: TARGET }, data: { acat_transfer_id: "SYNTHETIC-NONCANONICAL-REF" } });
    const source = snapshot(); source.records[0].acatTransferId = null;
    source.records[0].recordEvidenceDigest = acatEvidenceHash({ ...source.records[0], recordEvidenceDigest: undefined }); reseal(source);
    await expect(prepare(source)).rejects.toThrow("reserved_link");
    expect((await row()).acat_transfer_id).toBe("SYNTHETIC-NONCANONICAL-REF");
  });

  it("does not turn one holder's identity into complete joint-account proof", async () => {
    const source = snapshot();
    const second = "user-22222222-2222-4222-8222-222222222222";
    source.records[0].cedarRidgeUserIds.push(second);
    source.records[0].receivingAccount.members.push({ ...source.records[0].receivingAccount.members[0], cedarRidgeUserId: second, relationshipType: "JOINT" });
    source.records[0].accountEvidenceDigest = acatEvidenceHash(source.records[0].receivingAccount);
    source.records[0].recordEvidenceDigest = acatEvidenceHash({ ...source.records[0], recordEvidenceDigest: undefined }); reseal(source);
    await expect(prepare(source)).rejects.toThrow("incomplete_joint_evidence");
    expect((await row()).acat_record_id).toBeNull();
  });

  it("rolls back the historical link and application receipt if its business audit fails", async () => {
    const item = await prepare(); await confirm(item); const before = await row();
    await owner.$executeRawUnsafe(`CREATE FUNCTION audit.zztest_historical_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."entityId"='ZZTEST-ACAT-HISTORICAL-target' AND NEW.action='acat_link.apply' THEN
        RAISE EXCEPTION 'synthetic historical audit rejection'; END IF; RETURN NEW; END $$`);
    try {
      await owner.$executeRawUnsafe(`CREATE TRIGGER zztest_historical_audit_failure BEFORE INSERT ON audit."AuditLog"
        FOR EACH ROW EXECUTE FUNCTION audit.zztest_historical_audit_failure()`);
      await expect(apply(item)).rejects.toThrow();
      expect(await row()).toEqual(before);
      expect(await owner.acatLinkDecision.findUnique({ where: { id: item.decision.id } }))
        .toMatchObject({ outcome: "PENDING", application_id: null, applied_version: null, applied_at: null });
      expect(await applyAudits()).toBe(0);
    } finally {
      await owner.$executeRawUnsafe('DROP TRIGGER IF EXISTS zztest_historical_audit_failure ON audit."AuditLog"');
      await owner.$executeRawUnsafe('DROP FUNCTION audit.zztest_historical_audit_failure()');
    }
  });

  it("cannot confirm or apply as VIEWER despite knowing an actual prepared decision id", async () => {
    const item = await prepare(); const viewer = { role: "VIEWER", email: OPS.email };
    await expect(scope((tx) => reviewReconciliationDecision(tx, viewer, { decisionId: item.decision.id,
      action: "ACCEPT", expectedReviewVersion: 0, expectedEvidenceDigest: item.decision.evidence_digest,
      reason: null, historicalConfirmed: true }), "VIEWER")).rejects.toThrow("acat_reconciliation_forbidden");
    expect(await scope((tx) => applyAcatDecisionWithinScope(tx, viewer, { decisionId: item.decision.id,
      mode: "reviewed", expectedReviewVersion: 0, snapshot: item.source, now: new Date() }), "VIEWER"))
      .toMatchObject({ outcome: "BLOCKED", reason: "forbidden" });
    expect((await row()).acat_record_id).toBeNull(); expect(await applyAudits()).toBe(0);
  });

  it("only one of two concurrently confirmed historical targets can claim the same record", async () => {
    const otherId = `${PREFIX}-race`;
    await createTarget({ id: otherId });
    const first = await prepare(); const second = await prepare(first.source, otherId);
    await confirm(first); await confirm(second);
    const results = await Promise.allSettled([apply(first), apply(second)]);
    const successful = results.filter((r) => r.status === "fulfilled" && r.value.outcome === "APPLIED");
    expect(successful).toHaveLength(1);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "P2034" });
        expect(await apply(i === 0 ? first : second)).toMatchObject({ outcome: "CONFLICT", reason: "reserved_link" });
      } else if (result.value.outcome !== "APPLIED") {
        expect(result.value).toMatchObject({ outcome: "CONFLICT", reason: "reserved_link" });
      }
    }
    expect(await owner.transfer.count({ where: { id: { in: [TARGET, otherId] }, acat_record_id: RECORD } })).toBe(1);
    expect(await owner.auditLog.count({ where: { entityId: { in: [TARGET, otherId] }, action: "acat_link.apply" } })).toBe(1);
    expect(await owner.transfer.count({ where: { id: { in: [TARGET, otherId] }, acat_auto_link_hold: true, stage: "FUNDED" } })).toBe(2);
  });

  it("preserves the ordinary reviewed path's terminal-lifecycle rejection", async () => {
    const source = snapshot(); const now = new Date();
    const item = await scope(async (tx) => {
      const targets = await readAcatCandidatesWithinScope(tx); const target = targets.find((t) => t.transferId === TARGET)!;
      const decision = makeAcatMatchDecision(source, target, source.records[0], "missing_transaction_evidence", "review");
      const decisions = matchAcatPopulation(source, targets, { now }).filter((candidate) => candidate.transferId !== TARGET
        && !(candidate.transferId === null && candidate.recordId === source.records[0].recordId));
      decisions.push(decision);
      const proposal = prepareManifestFromMatches({ mode: "PREPARE", snapshot: source, targets, targetBoundary: now, decisions });
      const run = await prepareReconciliationRun(tx, OPS, { manifest: proposal.manifest, sourceBoundary: { source: { ...source.source } }, targetBoundary: now, summary: proposal.summary });
      runs.add(run.runId);
      return { run, source, target, decision: await tx.acatLinkDecision.findFirstOrThrow({ where: { run_id: run.runId, transfer_id: TARGET } }) };
    });
    await confirm(item);
    expect(await apply(item)).toMatchObject({ outcome: "CONFLICT", reason: "ineligible_lifecycle" });
    expect(await applyAudits()).toBe(0);
  });
});
