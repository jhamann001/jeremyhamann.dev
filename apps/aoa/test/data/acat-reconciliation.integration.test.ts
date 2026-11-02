import { PrismaClient, Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { preparedManifest, snapshot, targetRecord, TEST_AT } from "../acat-reconciliation/fixtures";
import type { ManifestJson, PreparedManifest } from "@/lib/data/acat-reconciliation/manifest";
import { prepareManifestFromMatches } from "@/lib/data/acat-reconciliation/prepare";
import { acatEvidenceHash, makeAcatMatchDecision, matchAcatPopulation } from "@/lib/data/acat-match";
import type { LinkageSnapshot } from "@/lib/data/acat-link-contract";

vi.mock("server-only", () => ({}));
const RUN = process.env.ACAT_RECONCILIATION_TEST_DATABASE_URL ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "zztest-acat-reconciliation@example.invalid" };
const ADMIN = { role: "ADMIN", email: "zztest-acat-reconciliation-admin@example.invalid" };

function syntheticUrl(raw: string | undefined, role: "app_rw" | "aoa" | "ingest_rw"): URL {
  if (!raw) throw new Error("explicit_acat_reconciliation_synthetic_database_required");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.port !== "15542" || url.pathname !== "/aoa_acat_reconciliation_synthetic" || url.username !== role
    || [...url.searchParams.keys()].some((key) => !["schema", "connection_limit", "pool_timeout"].includes(key))
    || url.hash || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
    || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
    throw new Error("isolated_acat_reconciliation_synthetic_database_required");
  }
  return url;
}

RUN("ACAT reconciliation on isolated synthetic PostgreSQL", () => {
  let owner: PrismaClient;
  let ingest: PrismaClient;
  let appPrisma: typeof import("@/lib/db").prisma;
  let withUserScope: typeof import("@/lib/rls").withUserScope;
  let prepare: typeof import("@/lib/data/acat-reconciliation/persistence").prepareReconciliationRun;
  let review: typeof import("@/lib/data/acat-reconciliation/persistence").reviewReconciliationDecision;
  let verify: typeof import("@/lib/data/acat-reconciliation/verification").verifyReconciliationRun;
  let apply: typeof import("@/lib/data/acat-auto-link").applyAcatDecisionWithinScope;
  let undo: typeof import("@/lib/data/acat-auto-link").undoAcatDecisionWithinScope;
  let readTargets: typeof import("@/lib/data/acat-match-source").readAcatCandidatesWithinScope;
  let readRejections: typeof import("@/lib/data/acat-auto-link").readAcatRejectedPairsWithinScope;
  let setHold: typeof import("@/lib/data/acat-auto-link").setAcatAutomationHoldWithinScope;
  let unlink: typeof import("@/lib/data/acat-link").unlinkAcatFromTransfer;
  const runIds = new Set<string>();
  const fixtureTransfers = new Set<string>();
  const clientId = "003FZCLYKFLL001";
  const householdId = "001FZCLYKFLL001";

  async function removeFault() {
    await owner.$executeRawUnsafe('DROP TRIGGER IF EXISTS zztest_acat_reconciliation_audit_fault ON audit."AuditLog"');
    await owner.$executeRawUnsafe("DROP FUNCTION IF EXISTS audit.zztest_acat_reconciliation_audit_fault()");
  }
  async function cleanup() {
    if (!owner) return;
    await removeFault();
    const rows = await owner.acatLinkDecision.findMany({ where: { run_id: { in: [...runIds] } }, select: { id: true } });
    const ids = rows.map((row) => row.id);
    await owner.acatLinkReviewEvent.deleteMany({ where: { decision_id: { in: ids } } });
    await owner.acatLinkDecision.deleteMany({ where: { run_id: { in: [...runIds] } } });
    await owner.acatLinkRun.deleteMany({ where: { id: { in: [...runIds] } } });
    await owner.auditLog.deleteMany({ where: { entityType: { in: ["acat_link_run", "acat_link_decision"] }, entityId: { in: [...runIds, ...ids] } } });
    await owner.transfer.deleteMany({ where: { id: { in: [...fixtureTransfers] } } });
    await owner.auditLog.deleteMany({ where: { entityType: "transfer", entityId: { in: [...fixtureTransfers] } } });
    await owner.rowChange.deleteMany({ where: { schema_name: "app", table_name: "transfer", row_pk: { in: [...fixtureTransfers] } } });
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${householdId}`;
    fixtureTransfers.clear();
    runIds.clear();
  }
  async function persist(manifest: PreparedManifest = preparedManifest()) {
    const result = await withUserScope(OPS, (tx) => prepare(tx, OPS, {
      manifest, sourceBoundary: { source: { ...snapshot().source }, observedAt: TEST_AT.toISOString(), complete: true }, targetBoundary: TEST_AT, summary: { synthetic: true },
    }));
    runIds.add(result.runId);
    return result;
  }
  async function preparedDecision() {
    const result = await persist();
    return owner.acatLinkDecision.findFirstOrThrow({ where: { run_id: result.runId } });
  }
  async function databaseState() {
    return {
      runs: await owner.acatLinkRun.findMany({ orderBy: { id: "asc" } }),
      decisions: await owner.acatLinkDecision.findMany({ orderBy: { id: "asc" } }),
      events: await owner.acatLinkReviewEvent.findMany({ orderBy: { id: "asc" } }),
      audits: await owner.auditLog.findMany({ where: { action: { startsWith: "acat_link." } }, orderBy: { id: "asc" } }),
      versions: await owner.$queryRaw<Array<{ id: string; version: string }>>`SELECT id, xmin::text AS version FROM app.acat_link_run ORDER BY id`,
    };
  }
  beforeAll(async () => {
    const explicit = syntheticUrl(process.env.ACAT_RECONCILIATION_TEST_DATABASE_URL, "app_rw");
    const runtime = syntheticUrl(process.env.DATABASE_URL, "app_rw");
    const ownerUrl = syntheticUrl(process.env.ACAT_RECONCILIATION_TEST_OWNER_URL, "aoa");
    const ingestUrl = syntheticUrl(process.env.ACAT_RECONCILIATION_TEST_INGEST_URL, "ingest_rw");
    const ingestRuntime = syntheticUrl(process.env.INGEST_DATABASE_URL, "ingest_rw");
    if (runtime.href !== explicit.href || ingestRuntime.href !== ingestUrl.href
      || [ownerUrl, ingestUrl].some((url) => url.host !== runtime.host || url.pathname !== runtime.pathname)) {
      throw new Error("acat_reconciliation_synthetic_connections_must_match");
    }
    owner = new PrismaClient({ datasourceUrl: ownerUrl.href });
    ingest = new PrismaClient({ datasourceUrl: ingestUrl.href });
    ({ prisma: appPrisma } = await import("@/lib/db"));
    ({ withUserScope } = await import("@/lib/rls"));
    ({ prepareReconciliationRun: prepare, reviewReconciliationDecision: review } = await import("@/lib/data/acat-reconciliation/persistence"));
    ({ verifyReconciliationRun: verify } = await import("@/lib/data/acat-reconciliation/verification"));
    ({ applyAcatDecisionWithinScope: apply, undoAcatDecisionWithinScope: undo, readAcatRejectedPairsWithinScope: readRejections, setAcatAutomationHoldWithinScope: setHold } = await import("@/lib/data/acat-auto-link"));
    ({ readAcatCandidatesWithinScope: readTargets } = await import("@/lib/data/acat-match-source"));
    ({ unlinkAcatFromTransfer: unlink } = await import("@/lib/data/acat-link"));
    const [scope] = await withUserScope(OPS, (tx) => tx.$queryRaw<Array<{ database: string; username: string; superuser: boolean; bypassrls: boolean; rls: boolean; forced: boolean }>>`
      SELECT current_database() AS database, current_user AS username, r.rolsuper AS superuser,
      r.rolbypassrls AS bypassrls, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname = current_user AND c.oid = 'app.acat_link_run'::regclass`);
    expect(scope).toEqual({ database: "aoa_acat_reconciliation_synthetic", username: "app_rw", superuser: false, bypassrls: false, rls: true, forced: true });
    expect(await owner.acatLinkRun.count()).toBe(0);
  });
  beforeEach(async () => { await cleanup(); });
  afterAll(async () => {
    try { await cleanup(); }
    finally { await owner?.$disconnect(); await ingest?.$disconnect(); await appPrisma?.$disconnect(); }
  });

  it("persists one immutable manifest and one audit across concurrent equivalent prepares", async () => {
    const [one, two] = await Promise.all([persist(), persist()]);
    expect(one.runId).toBe(two.runId);
    expect([one.created, two.created].sort()).toEqual([false, true]);
    const state = await databaseState();
    expect(state.runs).toHaveLength(1); expect(state.decisions).toHaveLength(1); expect(state.audits).toHaveLength(1);
    expect(state.runs[0].created_by).toBe(OPS.email);
    expect(state.decisions[0].payload).toMatchObject({ decision: { sourceRecordDigest: "c".repeat(64), sourceAccountDigest: "d".repeat(64) }, context: { synthetic: true } });
    expect(await owner.transfer.count()).toBe(0);
  });

  it("rejects incomplete evidence and service impersonation without persisting anything", async () => {
    const incomplete = preparedManifest(); incomplete.sourceComplete = false;
    await expect(persist(incomplete)).rejects.toThrow("acat_manifest_invalid_scope");
    await expect(withUserScope(OPS, (tx) => prepare(tx, { role: "INGEST", email: OPS.email }, {
      manifest: preparedManifest(), sourceBoundary: {}, targetBoundary: TEST_AT, summary: {},
    }))).rejects.toThrow("acat_reconciliation_forbidden");
    expect((await databaseState()).runs).toEqual([]);
  });

  it("denies unauthorized roles at the service and RLS boundaries", async () => {
    await persist();
    for (const role of ["VIEWER", "ADVISOR", "CLIENT_SERVICE", "UNKNOWN"]) {
      const identity = { role, email: OPS.email };
      expect(await withUserScope(identity, (tx) => tx.acatLinkRun.count())).toBe(0);
      await expect(withUserScope(identity, (tx) => prepare(tx, identity, {
        manifest: preparedManifest(), sourceBoundary: {}, targetBoundary: TEST_AT, summary: {},
      }))).rejects.toThrow("acat_reconciliation_forbidden");
    }
    expect(await withUserScope({ role: "OPERATIONS", email: "" }, (tx) => tx.acatLinkRun.count())).toBe(0);
    expect(await withUserScope(ADMIN, (tx) => tx.acatLinkRun.count())).toBe(1);
  });

  it("refuses prepared evidence mutation at the database boundary", async () => {
    const row = await preparedDecision();
    await expect(withUserScope(OPS, (tx) => tx.acatLinkDecision.update({ where: { id: row.id }, data: { evidence_digest: "f".repeat(64) } })))
      .rejects.toThrow("Prepared ACAT decision evidence is immutable");
    await expect(withUserScope(OPS, (tx) => tx.acatLinkRun.update({ where: { id: row.run_id }, data: { source_digest: "f".repeat(64) } })))
      .rejects.toThrow("Prepared ACAT run evidence is immutable");
    expect((await owner.acatLinkDecision.findUniqueOrThrow({ where: { id: row.id } })).evidence_digest).toBe(row.evidence_digest);
  });

  it("serializes concurrent human reviews and appends one event/audit", async () => {
    const row = await preparedDecision();
    const request = { decisionId: row.id, expectedReviewVersion: 0, expectedEvidenceDigest: row.evidence_digest, action: "ACCEPT" as const, reason: "Synthetic reviewed evidence" };
    const results = await Promise.all([OPS, ADMIN].map((identity) => withUserScope(identity, (tx) => review(tx, identity, request))));
    expect(results.map((result) => result.result).sort()).toEqual(["conflict", "saved"]);
    const state = await databaseState();
    expect(state.decisions[0].review_version).toBe(1); expect(state.events).toHaveLength(1);
    expect(state.audits.filter((audit) => audit.action === "acat_link.review")).toHaveLength(1);
  });

  it("requires guarded hold/resume and refuses stale evidence without a write", async () => {
    const row = await preparedDecision(); const before = await databaseState();
    const request = { decisionId: row.id, expectedReviewVersion: 0, expectedEvidenceDigest: row.evidence_digest, action: "HOLD" as const, reason: null, expectedTargetVersion: 0 };
    expect(await withUserScope(OPS, (tx) => review(tx, OPS, request))).toEqual({ result: "ineligible" });
    const policy = vi.fn(async () => false);
    expect(await withUserScope(OPS, (tx) => review(tx, OPS, request, policy))).toEqual({ result: "conflict" });
    expect(policy).toHaveBeenCalledOnce();
    expect(await withUserScope(OPS, (tx) => review(tx, OPS, { ...request, action: "ACCEPT", expectedEvidenceDigest: "f".repeat(64) })))
      .toEqual({ result: "conflict" });
    expect(await databaseState()).toEqual(before);
  });

  it("rolls back review and event together when audit insertion fails", async () => {
    const row = await preparedDecision(); const before = await databaseState();
    await owner.$executeRawUnsafe(`CREATE FUNCTION audit.zztest_acat_reconciliation_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'acat_link.review' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$`);
    await owner.$executeRawUnsafe('CREATE TRIGGER zztest_acat_reconciliation_audit_fault BEFORE INSERT ON audit."AuditLog" FOR EACH ROW EXECUTE FUNCTION audit.zztest_acat_reconciliation_audit_fault()');
    await expect(withUserScope(OPS, (tx) => review(tx, OPS, {
      decisionId: row.id, expectedReviewVersion: 0, expectedEvidenceDigest: row.evidence_digest, action: "REJECT", reason: "Synthetic rejection",
    }))).rejects.toThrow("synthetic audit fault");
    expect(await databaseState()).toEqual(before);
  });

  it("rejects actual event UPDATE/DELETE and run/decision DELETE under app_rw", async () => {
    const row = await preparedDecision();
    await withUserScope(OPS, (tx) => review(tx, OPS, { decisionId: row.id, expectedReviewVersion: 0, expectedEvidenceDigest: row.evidence_digest, action: "REJECT", reason: null }));
    await expect(withUserScope(OPS, (tx) => tx.$executeRaw`UPDATE app.acat_link_review_event SET action = 'ACCEPT' WHERE decision_id = ${row.id}`)).rejects.toThrow(/permission denied/);
    await expect(withUserScope(OPS, (tx) => tx.$executeRaw`DELETE FROM app.acat_link_review_event WHERE decision_id = ${row.id}`)).rejects.toThrow(/permission denied/);
    await expect(withUserScope(OPS, (tx) => tx.$executeRaw`DELETE FROM app.acat_link_decision WHERE id = ${row.id}`)).rejects.toThrow(/permission denied/);
    await expect(withUserScope(OPS, (tx) => tx.$executeRaw`DELETE FROM app.acat_link_run WHERE id = ${row.run_id}`)).rejects.toThrow(/permission denied/);
  });

  it("permits service preparation but not human review or altered review metadata", async () => {
    const manifest = preparedManifest(); manifest.mode = "AUTOMATIC";
    const result = await ingest.$transaction((tx) => prepare(tx, { role: "INGEST", email: null }, {
      manifest, sourceBoundary: { source: { ...snapshot().source } }, targetBoundary: TEST_AT, summary: {},
    })); runIds.add(result.runId);
    const row = await owner.acatLinkDecision.findFirstOrThrow({ where: { run_id: result.runId } });
    expect((await owner.acatLinkRun.findUniqueOrThrow({ where: { id: result.runId } })).created_by).toBeNull();
    await expect(ingest.$transaction((tx) => review(tx, { role: "INGEST", email: null }, {
      decisionId: row.id, expectedReviewVersion: 0, expectedEvidenceDigest: row.evidence_digest, action: "ACCEPT", reason: null,
    }))).rejects.toThrow("acat_reconciliation_forbidden");
    await expect(ingest.$executeRaw`UPDATE app.acat_link_decision SET disposition = 'ACCEPT' WHERE id = ${row.id}`).rejects.toThrow(/permission denied/);
    await expect(ingest.$executeRaw`INSERT INTO app.acat_link_review_event(id, decision_id, revision, action, actor_email) VALUES ('synthetic-forged-event', ${row.id}, 1, 'ACCEPT', ${OPS.email})`).rejects.toThrow(/permission denied/);
  });

  it("verifies the exact stored manifest read-only and returns only aggregate outcomes", async () => {
    const result = await persist(); const before = await databaseState();
    expect(await withUserScope(OPS, (tx) => verify(tx, OPS, result.runId))).toEqual({
      runId: result.runId, manifestValid: true, decisionCount: 1,
      outcomes: { PENDING: 1, APPLIED: 0, NOOP: 0, CONFLICT: 0, BLOCKED: 0, UNDONE: 0 },
      coverage: {
        aoa: { total: 1, categories: { linked: 0, held: 0, proposed: 1, review: 0, excluded: 0, no_counterpart: 0 } },
        tracker: { total: 1, categories: { linked: 0, held: 0, proposed: 1, review: 0, excluded: 0, no_counterpart: 0 } },
      },
      invalidOutcomeCount: 0, linkStateDriftCount: 0, outcomeMetadataMissingCount: 0,
    });
    expect(await databaseState()).toEqual(before);
  });

  it("detects a foreign appended decision instead of treating partial manifest verification as valid", async () => {
    const row = await preparedDecision();
    const { id: _id, created_at: _createdAt, updated_at: _updatedAt, payload, ...copy } = row;
    await owner.acatLinkDecision.create({ data: { ...copy, decision_key: "synthetic-not-in-manifest", payload: payload as Prisma.InputJsonValue } });
    const result = await withUserScope(OPS, (tx) => verify(tx, OPS, row.run_id));
    expect(result?.manifestValid).toBe(false); expect(result?.decisionCount).toBe(2);
    expect(result?.coverage).toBeNull();
  });

  it("carries a durable pair rejection into repeated preparation and equivalent source refresh", async () => {
    const source = snapshot(); const targets = [targetRecord()];
    const initial = prepareManifestFromMatches({ mode: "PREPARE", snapshot: source, targets, targetBoundary: TEST_AT,
      decisions: matchAcatPopulation(source, targets, { now: TEST_AT, allowLegacyEnrichment: true }),
    });
    expect(initial.summary.aoa.categories.proposed).toBe(1);
    const run = await persist(initial.manifest);
    const row = await owner.acatLinkDecision.findFirstOrThrow({ where: { run_id: run.runId } });
    await withUserScope(OPS, (tx) => review(tx, OPS, {
      decisionId: row.id, expectedReviewVersion: 0, expectedEvidenceDigest: row.evidence_digest, action: "REJECT", reason: "Synthetic wrong journey",
    }));
    const rejectedPairs = await withUserScope(OPS, readRejections);
    source.directory.snapshotId = "synthetic-equivalent-refresh"; source.directory.publishedGeneration += 1;
    const repeat = prepareManifestFromMatches({ mode: "PREPARE", snapshot: source, targets, targetBoundary: TEST_AT,
      decisions: matchAcatPopulation(source, targets, { now: TEST_AT, allowLegacyEnrichment: true, rejectedPairs }),
    });
    expect(repeat.summary.aoa.categories.proposed).toBe(0);
    expect(repeat.manifest.decisions[0].reason).toBe("pair_rejected");
    const repeated = await persist(repeat.manifest);
    expect((await persist(repeat.manifest)).runId).toBe(repeated.runId);
    expect(await owner.transfer.count()).toBe(0);
  });

  it("rolls back the entire prepared run and decisions when its audit fails", async () => {
    await owner.$executeRawUnsafe(`CREATE FUNCTION audit.zztest_acat_reconciliation_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'acat_link.prepare' THEN RAISE EXCEPTION 'synthetic prepare audit fault'; END IF; RETURN NEW; END $$`);
    await owner.$executeRawUnsafe('CREATE TRIGGER zztest_acat_reconciliation_audit_fault BEFORE INSERT ON audit."AuditLog" FOR EACH ROW EXECUTE FUNCTION audit.zztest_acat_reconciliation_audit_fault()');
    await expect(persist()).rejects.toThrow("synthetic prepare audit fault");
    const state = await databaseState();
    expect(state.runs).toEqual([]); expect(state.decisions).toEqual([]); expect(state.audits).toEqual([]);
  });

  it("refuses missing or mismatched source installation/environment metadata before writing", async () => {
    const invalidBoundaries: ManifestJson[] = [{}, { source: { system: "transfer-tracker", installationId: "wrong-installation", environment: "synthetic" } },
      { source: { system: "transfer-tracker", installationId: "synthetic-reconciliation", environment: "unknown" } }];
    for (const sourceBoundary of invalidBoundaries) {
      await expect(withUserScope(OPS, (tx) => prepare(tx, OPS, {
        manifest: preparedManifest(), sourceBoundary, targetBoundary: TEST_AT, summary: {},
      }))).rejects.toThrow("acat_reconciliation_invalid_source_boundary");
    }
    expect((await databaseState()).runs).toEqual([]);
  });

  function refreshDigest(source: LinkageSnapshot) {
    source.snapshotDigest = acatEvidenceHash({ contractVersion: source.contractVersion, source: source.source, scope: source.scope,
      records: [...source.records].sort((a, b) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)
        .map((row) => [row.recordId, row.recordEvidenceDigest, row.accountEvidenceDigest]),
    });
  }
  async function eligibleTransfer(reviewed = false) {
    const transferId = "ZZTEST-ACAT-RECONCILIATION-AUTOMATIC";
    fixtureTransfers.add(transferId);
    await owner.$executeRaw`INSERT INTO mirror.household(sf_id,name,lead_advisor_email) VALUES (${householdId}, 'Synthetic reconciliation household', ${OPS.email})`;
    await owner.$executeRaw`INSERT INTO mirror.client(sf_id,household_id,lead_advisor_email,cedar_ridge_user_id) VALUES (${clientId}, ${householdId}, ${OPS.email}, 'synthetic-person')`;
    const source = snapshot();
    const now = new Date(); source.observedAt = now.toISOString(); source.directory.lastSuccessAt = now.toISOString();
    source.records[0].workflow = "ACAT";
    refreshDigest(source);
    const before = await owner.transfer.create({ data: {
      id: transferId, source: "APP", client_sf_id: clientId, client_first_name: "Synthetic", client_last_name: "Reconciliation",
      value: "999.12", stage: "IN_TRANSFER", funding_type: "ACAT_FULL", next_step: "Synthetic protected workflow step",
      accounts_opened_at_apex: true, acat_transfer_id: reviewed ? null : source.records[0].acatTransferId!.toUpperCase(),
    } });
    const targets = await withUserScope(OPS, readTargets);
    const target = targets.find((candidate) => candidate.transferId === transferId)!;
    // Preserve an old saved AUTOMATIC proposal only for source-change and prior
    // rejection checks. Supported positive writes require a ref-null reviewed pair.
    const decisions = reviewed
      ? [makeAcatMatchDecision(source, target, source.records[0], "missing_transaction_evidence", "review")]
      : matchAcatPopulation(source, targets, { now, allowLegacyEnrichment: true });
    const prepared = prepareManifestFromMatches({ mode: reviewed ? "PREPARE" : "AUTOMATIC", snapshot: source, targets, targetBoundary: now, decisions });
    expect(prepared.summary.aoa.categories.proposed).toBe(reviewed ? 0 : 1);
    const request = { manifest: prepared.manifest,
      sourceBoundary: { source: { ...source.source }, observedAt: source.observedAt }, targetBoundary: now, summary: prepared.summary };
    const run = reviewed
      ? await withUserScope(OPS, (tx) => prepare(tx, OPS, request))
      : await ingest.$transaction((tx) => prepare(tx, { role: "INGEST", email: null }, request));
    runIds.add(run.runId);
    const row = await owner.acatLinkDecision.findFirstOrThrow({ where: { run_id: run.runId, transfer_id: transferId } });
    if (reviewed) {
      expect(await withUserScope(OPS, (tx) => review(tx, OPS, { decisionId: row.id, action: "ACCEPT",
        expectedReviewVersion: 0, expectedEvidenceDigest: row.evidence_digest, reason: "Synthetic exact pair reviewed" })))
        .toEqual({ result: "saved", reviewVersion: 1 });
    }
    return { transferId, source, run, row, before };
  }
  async function automatic(item: Awaited<ReturnType<typeof eligibleTransfer>>, source = item.source) {
    return ingest.$transaction((tx) => apply(tx, { role: "INGEST", email: null }, {
      decisionId: item.row.id, mode: "automatic", expectedReviewVersion: 0, snapshot: source, now: new Date(),
    }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  async function reviewedApply(item: Awaited<ReturnType<typeof eligibleTransfer>>) {
    return withUserScope(OPS, (tx) => apply(tx, OPS, {
      decisionId: item.row.id, mode: "reviewed", expectedReviewVersion: 1, snapshot: item.source, now: new Date(),
    }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  function protectedFields(row: Awaited<ReturnType<typeof eligibleTransfer>>["before"]) {
    const fields = { ...row };
    for (const key of ["acat_record_id", "acat_transfer_id", "acat_link_version", "acat_auto_link_hold", "acat_link_provenance", "acat_link_decision_id", "updated_at", "updated_by"] as const) {
      Reflect.deleteProperty(fields, key);
    }
    return fields;
  }

  it("persists prepare→apply→no-op→undo, preserves business fields and suppresses the next run", async () => {
    const item = await eligibleTransfer(true);
    expect((await reviewedApply(item)).outcome).toBe("APPLIED");
    const applied = await owner.transfer.findUniqueOrThrow({ where: { id: item.transferId } });
    expect(protectedFields(applied)).toEqual(protectedFields(item.before));
    expect(applied.acat_link_version).toBe(item.before.acat_link_version + 1);
    expect(await withUserScope(OPS, (tx) => verify(tx, OPS, item.run.runId))).toMatchObject({ manifestValid: true, linkStateDriftCount: 0, outcomeMetadataMissingCount: 0, outcomes: { APPLIED: 1 } });
    expect((await reviewedApply(item)).outcome).toBe("NOOP");
    expect(await owner.auditLog.count({ where: { entityId: item.transferId, action: "acat_link.apply" } })).toBe(1);
    expect((await withUserScope(OPS, (tx) => undo(tx, OPS, { decisionId: item.row.id, identity: OPS, expectedReviewVersion: 1 }))).outcome).toBe("UNDONE");
    const restored = await owner.transfer.findUniqueOrThrow({ where: { id: item.transferId } });
    expect(restored.acat_record_id).toBeNull(); expect(restored.acat_transfer_id).toBe(item.before.acat_transfer_id);
    expect(restored.acat_auto_link_hold).toBe(true); expect(restored.acat_link_version).toBe(applied.acat_link_version + 1);
    expect(protectedFields(restored)).toEqual(protectedFields(item.before));
    expect(await withUserScope(OPS, (tx) => verify(tx, OPS, item.run.runId))).toMatchObject({ manifestValid: true, linkStateDriftCount: 0, outcomeMetadataMissingCount: 0, outcomes: { UNDONE: 1 } });
    const targets = await withUserScope(OPS, readTargets);
    const repeated = matchAcatPopulation(item.source, targets, { now: new Date(), allowLegacyEnrichment: true });
    expect(repeated.find((row) => row.transferId === item.transferId)?.reason).toBe("manual_hold");
    expect(repeated.some((row) => row.action === "propose")).toBe(false);
    expect((await reviewedApply(item)).outcome).toBe("CONFLICT");
  });

  it("records a conflict for a newly competing source despite unchanged chosen record evidence", async () => {
    const item = await eligibleTransfer(); const changed = structuredClone(item.source);
    changed.records.push({ ...changed.records[0], recordId: "synthetic-new-competitor", acatTransferId: changed.records[0].acatTransferId!.toUpperCase() });
    changed.recordCount += 1; refreshDigest(changed);
    expect(await automatic(item, changed)).toMatchObject({ outcome: "CONFLICT", reason: "source_changed" });
    expect((await owner.transfer.findUniqueOrThrow({ where: { id: item.transferId } })).acat_record_id).toBeNull();
    expect((await owner.acatLinkDecision.findUniqueOrThrow({ where: { id: item.row.id } })).outcome).toBe("CONFLICT");
  });

  it("preserves a rejected pair across hold and resume while recording each policy action", async () => {
    const item = await eligibleTransfer();
    const request = { decisionId: item.row.id, expectedEvidenceDigest: item.row.evidence_digest, reason: "Synthetic wrong journey" };
    expect(await withUserScope(OPS, (tx) => review(tx, OPS, { ...request, action: "REJECT", expectedReviewVersion: 0 })))
      .toEqual({ result: "saved", reviewVersion: 1 });
    const rejected = await owner.acatLinkDecision.findUniqueOrThrow({ where: { id: item.row.id } });
    for (const [index, action] of (["HOLD", "RESUME"] as const).entries()) {
      const before = await owner.transfer.findUniqueOrThrow({ where: { id: item.transferId } });
      expect(await withUserScope(ADMIN, (tx) => review(tx, ADMIN, {
        ...request, action, reason: "Synthetic automation policy change", expectedReviewVersion: index + 1, expectedTargetVersion: before.acat_link_version,
      }, setHold))).toEqual({ result: "saved", reviewVersion: index + 2 });
      const after = await owner.transfer.findUniqueOrThrow({ where: { id: item.transferId } });
      expect(after.acat_auto_link_hold).toBe(action === "HOLD");
      expect(after.acat_link_version).toBe(before.acat_link_version + 1);
      expect(protectedFields(after)).toEqual(protectedFields(item.before));
      expect(await owner.acatLinkDecision.findUniqueOrThrow({ where: { id: item.row.id } })).toMatchObject({
        disposition: "REJECT", reviewed_by: rejected.reviewed_by, reviewed_at: rejected.reviewed_at, review_reason: rejected.review_reason,
      });
    }
    const rejectedPairs = await withUserScope(OPS, readRejections);
    expect(rejectedPairs).toEqual([{ transferId: item.transferId, recordId: item.row.record_id, evidenceDigest: item.row.evidence_digest }]);
    const targets = await withUserScope(OPS, readTargets);
    const matched = matchAcatPopulation(item.source, targets, { now: new Date(), allowLegacyEnrichment: true, rejectedPairs });
    expect(matched.find((row) => row.transferId === item.transferId)).toMatchObject({ reason: "pair_rejected", action: "review" });
    expect(matched.some((row) => row.action === "propose")).toBe(false);
    expect(await owner.acatLinkReviewEvent.findMany({ where: { decision_id: item.row.id }, orderBy: { revision: "asc" }, select: { action: true, revision: true, actor_email: true } }))
      .toEqual([{ action: "REJECT", revision: 1, actor_email: OPS.email }, { action: "HOLD", revision: 2, actor_email: ADMIN.email }, { action: "RESUME", revision: 3, actor_email: ADMIN.email }]);
  });

  it("refuses undo after a manual unlink and reports drift without clearing the successful receipt", async () => {
    const item = await eligibleTransfer(true); expect((await reviewedApply(item)).outcome).toBe("APPLIED");
    await withUserScope(OPS, (tx) => unlink(tx, OPS, item.transferId, { recordId: item.source.records[0].recordId, acatTransferId: item.source.records[0].acatTransferId }));
    expect(await withUserScope(OPS, (tx) => undo(tx, OPS, { decisionId: item.row.id, identity: OPS, expectedReviewVersion: 1 })))
      .toMatchObject({ outcome: "CONFLICT", reason: "target_changed" });
    expect((await owner.acatLinkDecision.findUniqueOrThrow({ where: { id: item.row.id } })).outcome).toBe("APPLIED");
    expect(await withUserScope(OPS, (tx) => verify(tx, OPS, item.run.runId))).toMatchObject({ linkStateDriftCount: 1 });
  });

  it("rolls back reviewed link, decision outcome and audit atomically when apply audit fails", async () => {
    const item = await eligibleTransfer(true);
    await owner.$executeRawUnsafe(`CREATE FUNCTION audit.zztest_acat_reconciliation_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'acat_link.apply' THEN RAISE EXCEPTION 'synthetic apply audit fault'; END IF; RETURN NEW; END $$`);
    await owner.$executeRawUnsafe('CREATE TRIGGER zztest_acat_reconciliation_audit_fault BEFORE INSERT ON audit."AuditLog" FOR EACH ROW EXECUTE FUNCTION audit.zztest_acat_reconciliation_audit_fault()');
    await expect(reviewedApply(item)).rejects.toThrow("synthetic apply audit fault");
    expect(await owner.transfer.findUniqueOrThrow({ where: { id: item.transferId } })).toEqual(item.before);
    expect((await owner.acatLinkDecision.findUniqueOrThrow({ where: { id: item.row.id } })).outcome).toBe("PENDING");
    expect(await owner.auditLog.count({ where: { entityId: item.transferId, action: "acat_link.apply" } })).toBe(0);
  });
});
