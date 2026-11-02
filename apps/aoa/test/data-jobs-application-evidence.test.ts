import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationAuditInput, ApplicationSweepInput } from "@/lib/data-jobs/application-evidence-types";

const mock = vi.hoisted(() => ({ scope: vi.fn(), bounds: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: mock.scope }));
vi.mock("@/lib/data/audit-read-bounds", () => ({
  applyAuditReadDatabaseBounds: mock.bounds,
  AUDIT_READ_TRANSACTION_OPTIONS: { timeout: 15000, maxWait: 5000 },
}));
import { evaluateAccountAumEvidence, evaluateReviewQueueEvidence } from "@/lib/data-jobs/application-evidence-evaluation";
import { applicationSourceForJob } from "@/lib/data-jobs/application-evidence-association";
import { collectApplicationEvidence } from "@/lib/data-jobs/application-evidence";
import { applicationEvidenceForDisplay, isApplicationEvidenceStale, validateApplicationEvidence } from "@/lib/data-jobs/application-evidence-validation";

const NOW = new Date("2026-09-18T15:00:00.000Z");
const date = (value: string) => new Date(`2026-09-18T${value}:00.000Z`);
const audit = (detail: Record<string, unknown> = {}, at = date("13:00")): ApplicationAuditInput => ({
  at, detail: JSON.stringify({ dry_run: false, received: 100, upserted: 100, rejected: 0,
    as_of_max: "2026-09-17", trigger: "scheduled_primary", ...detail }),
});
const checkpoint = (overrides: Partial<ApplicationSweepInput> = {}): ApplicationSweepInput => ({
  last_started_at: date("14:30"), last_completed_at: date("14:31"),
  last_failure_at: null, last_failure_source: null, lease_expires_at: null,
  trade_progress: false, crm_progress: false, trade_complete: false, crm_complete: false,
  ...overrides,
});
const evaluateAum = (audits: ApplicationAuditInput[], warning: ApplicationAuditInput | null = null, now = NOW) =>
  evaluateAccountAumEvidence("dev", { audits, warning }, now);

describe("safe application completion evidence", () => {
  it("keeps a committed snapshot separate from provider attempts, data freshness and warning history", () => {
    const value = evaluateAum([audit()]);
    expect(value).toMatchObject({
      sourceKey: "ACCOUNT_AUM", status: "COMPLETE", coverage: "snapshot_only", correlation: "source_only",
      latestCommitAt: date("13:00").toISOString(), lastAttemptAt: date("13:00").toISOString(),
      lastFailureAt: null, recordsCommitted: 100, recordsRejected: 0, businessAsOf: "2026-09-17",
      commitTrigger: "scheduled_primary",
      freshness: { status: "CURRENT", basis: "committed_snapshot_date", expectedBusinessAsOf: "2026-09-17" },
    });
    expect(value).not.toHaveProperty("logicalRunId");
    expect(value).not.toHaveProperty("durationMs");
  });

  it("preserves partial committed row counts without claiming a full successful import", () => {
    expect(evaluateAum([audit({ received: 105, rejected: 5 })])).toMatchObject({
      status: "PARTIAL", code: "partial_commit_recorded", recordsCommitted: 100, recordsRejected: 5,
    });
  });

  it("does not turn zero rows, a dry run, or missing metadata into a successful import", () => {
    expect(evaluateAum([audit({ received: 0, upserted: 0 })])).toMatchObject({
      status: "UNKNOWN", code: "no_rows_committed", latestCommitAt: null, recordsCommitted: null,
    });
    expect(evaluateAum([audit({ dry_run: true })])).toMatchObject({
      status: "UNKNOWN", lastAttemptAt: null, latestCommitAt: null,
    });
    expect(evaluateAum([{ at: date("13:00"), detail: null }])).toMatchObject({
      status: "UNKNOWN", code: "invalid_audit_metadata", recordsRejected: null,
    });
  });

  it.each([
    { upserted: "100" }, { upserted: -1 }, { upserted: 1.5 },
    { upserted: Number.MAX_SAFE_INTEGER + 1 }, { rejected: null },
    { dry_run: "false" }, { received: 105 }, { received: 95 },
  ])("rejects invalid or inconsistent count metadata %j", (changes) => {
    expect(evaluateAum([audit(changes)])).toMatchObject({ status: "UNKNOWN", latestCommitAt: null });
  });

  it("keeps previous committed counts paired with their timestamp when latest audit is malformed", () => {
    expect(evaluateAum([{ at: date("14:00"), detail: "not json" }, audit()])).toMatchObject({
      status: "UNKNOWN", lastAttemptAt: date("14:00").toISOString(),
      latestCommitAt: date("13:00").toISOString(), recordsCommitted: 100,
    });
  });

  it("does not mark a malformed future audit green using an older commit", () => {
    expect(evaluateAum([audit({}, date("16:00")), audit()])).toMatchObject({
      status: "UNKNOWN", latestCommitAt: date("13:00").toISOString(), lastAttemptAt: null,
    });
  });

  it("bounds parsing and outputs allowlisted values only", () => {
    const value = evaluateAum([audit({ trigger: "private@example.test", secret: "DO_NOT_COPY", client: "client-name" })],
      { at: date("14:00"), detail: JSON.stringify({ reason: "DO_NOT_COPY", raw: "client-name" }) });
    expect(value.commitTrigger).toBe("unknown");
    expect(value.latestFeedWarning?.code).toBe("unknown");
    expect(JSON.stringify(value)).not.toMatch(/DO_NOT_COPY|client-name|private@example/);
    expect(evaluateAum([{ at: date("13:00"), detail: "x".repeat(16385) }]).status).toBe("UNKNOWN");
  });

  it("keeps both older and newer health warnings historical without inventing import failure or recovery", () => {
    for (const at of [date("12:00"), date("14:00")]) {
      const value = evaluateAum([audit()], { at, detail: JSON.stringify({ reason: "incomplete_coverage" }) });
      expect(value).toMatchObject({ status: "COMPLETE", lastFailureAt: null,
        latestFeedWarning: { at: at.toISOString(), code: "incomplete_coverage" } });
    }
  });

  it("separates successful stale-snapshot ingestion from snapshot-date freshness", () => {
    expect(evaluateAum([audit({ as_of_max: "2026-09-14" })])).toMatchObject({
      status: "COMPLETE", freshness: { status: "STALE", code: "committed_snapshot_stale" },
    });
  });

  it.each(["2026-02-30", "not a date", "2026-09-19", "2026-09-17T00:00:00Z"])("does not claim freshness from invalid/future date %s", (value) => {
    expect(evaluateAum([audit({ as_of_max: value })]).freshness.status).toBe("UNKNOWN");
  });

  it("uses the existing market calendar across weekend/holiday and fails unknown beyond calendar coverage", () => {
    const monday = new Date("2026-09-21T12:00:00Z");
    expect(evaluateAum([audit({ as_of_max: "2026-09-18" })], null, monday).freshness)
      .toMatchObject({ status: "CURRENT", expectedBusinessAsOf: "2026-09-18" });
    const holiday = new Date("2026-09-07T12:00:00Z");
    expect(evaluateAum([audit({ as_of_max: "2026-09-04" }, new Date("2026-09-04T13:00:00Z"))], null, holiday).freshness)
      .toMatchObject({ status: "CURRENT", expectedBusinessAsOf: "2026-09-04" });
    expect(evaluateAum([audit()], null, new Date("2032-01-05T15:00:00Z")).freshness.status).toBe("UNKNOWN");
  });

  it("treats reset source flags plus a completed singleton as full combined-sweep completion", () => {
    const value = evaluateReviewQueueEvidence("prod", checkpoint(), NOW);
    expect(value).toMatchObject({ status: "COMPLETE", code: "sweep_complete", latestCommitAt: date("14:31").toISOString(),
      recordsCommitted: null, recordsRejected: null, businessAsOf: null,
      freshness: { status: "CURRENT", basis: "complete_sweep_age" } });
    expect(value.stages).toEqual([
      { key: "TRADE_REQUEST", status: "COMPLETE", basis: "last_completed_sweep" },
      { key: "CRM_IDENTITY", status: "COMPLETE", basis: "last_completed_sweep" },
    ]);
  });

  it("never promotes one successful source/page into a completed global sweep", () => {
    const value = evaluateReviewQueueEvidence("prod", checkpoint({
      last_started_at: date("14:55"), last_completed_at: null, trade_complete: true, crm_progress: true,
    }), NOW);
    expect(value).toMatchObject({ status: "PROGRESSING", latestCommitAt: null, recordsCommitted: null,
      freshness: { status: "UNKNOWN" } });
    expect(value.stages.map((stage) => stage.status)).toEqual(["COMPLETE", "PENDING"]);
  });

  it("preserves an older global completion while newer pages progress", () => {
    expect(evaluateReviewQueueEvidence("prod", checkpoint({
      last_started_at: date("14:55"), trade_progress: true,
    }), NOW)).toMatchObject({ status: "PROGRESSING", latestCommitAt: date("14:31").toISOString() });
  });

  it("shows stale partial progress and keeps its previous completion stale separately", () => {
    expect(evaluateReviewQueueEvidence("prod", checkpoint({
      last_started_at: date("14:30"), last_completed_at: date("12:00"), crm_progress: true,
    }), NOW)).toMatchObject({ status: "PARTIAL", code: "sweep_progress_stale", freshness: { status: "STALE" } });
  });

  it("preserves failure during retry without claiming recovery", () => {
    const value = evaluateReviewQueueEvidence("prod", checkpoint({
      last_started_at: date("14:59"), last_failure_at: date("14:58"), last_failure_source: "TRADE_REQUEST",
      lease_expires_at: date("15:05"),
    }), NOW);
    expect(value).toMatchObject({ status: "RUNNING", code: "sweep_page_running",
      lastFailureAt: date("14:58").toISOString(), latestCommitAt: date("14:31").toISOString() });
  });

  it.each(["TRADE_REQUEST", "CRM_IDENTITY", "MULTIPLE", "MATERIALIZATION"])("records latest combined failure %s without losing earlier completion", (source) => {
    const value = evaluateReviewQueueEvidence("prod", checkpoint({
      last_started_at: date("14:55"), last_failure_at: date("14:56"), last_failure_source: source,
      trade_complete: source === "CRM_IDENTITY",
    }), NOW);
    expect(value).toMatchObject({ status: "FAILED", lastFailureSource: source, latestCommitAt: date("14:31").toISOString() });
    if (source === "CRM_IDENTITY") expect(value.stages.map((stage) => stage.status)).toEqual(["COMPLETE", "FAILED"]);
  });

  it("does not infer completion after an expired page lease or from flags alone", () => {
    expect(evaluateReviewQueueEvidence("prod", checkpoint({
      last_started_at: date("14:55"), lease_expires_at: date("14:59"),
    }), NOW)).toMatchObject({ status: "UNKNOWN", code: "sweep_completion_unconfirmed" });
    expect(evaluateReviewQueueEvidence("prod", checkpoint({
      last_started_at: date("14:55"), last_completed_at: null, trade_complete: true, crm_complete: true,
    }), NOW)).toMatchObject({ status: "PROGRESSING", latestCommitAt: null });
  });

  it("keeps missing, invalid, future or untrusted checkpoint evidence explicit", () => {
    expect(evaluateReviewQueueEvidence("prod", null, NOW)).toMatchObject({ status: "UNKNOWN", code: "sweep_not_run" });
    expect(evaluateReviewQueueEvidence("prod", checkpoint({ last_completed_at: date("16:00") }), NOW))
      .toMatchObject({ status: "UNKNOWN", code: "invalid_checkpoint" });
    const value = evaluateReviewQueueEvidence("prod", checkpoint({
      last_failure_at: date("14:58"), last_failure_source: "client-name secret",
    }), NOW);
    expect(value.lastFailureSource).toBe("UNKNOWN");
    expect(JSON.stringify(value)).not.toContain("client-name");
  });
});

describe("application source association", () => {
  it.each(["prod-account-aum", "prod-account-aum-stale-only", "prod-account-aum-health"])("shares source evidence without joining runs: %s", (id) => {
    expect(applicationSourceForJob({ id, environment: "prod", provider: "cloud-scheduler" })).toBe("ACCOUNT_AUM");
  });
  it("associates only reviewed production Scheduler definitions", () => {
    expect(applicationSourceForJob({ id: "prod-review-queue", environment: "prod", provider: "cloud-scheduler" })).toBe("REVIEW_QUEUE");
    expect(applicationSourceForJob({ id: "dev-review-queue", environment: "dev", provider: "cloud-scheduler" })).toBeNull();
    expect(applicationSourceForJob({ id: "prod-review-queue", environment: "prod", provider: "n8n" })).toBeNull();
    expect(applicationSourceForJob({ id: "prod-crm-reconciliation", environment: "prod", provider: "n8n" })).toBeNull();
  });
});

describe("application evidence persistence boundary", () => {
  it("validates both normalized sources and strips unlisted nested payloads", () => {
    const aum = evaluateAum([audit()], { at: date("14:00"), detail: JSON.stringify({ reason: "stale_sync" }) });
    expect(validateApplicationEvidence({ ...aum, raw: "private",
      freshness: { ...aum.freshness, raw: "private" },
      latestFeedWarning: { ...aum.latestFeedWarning, raw: "private" },
    })).toEqual(aum);
    const review = evaluateReviewQueueEvidence("dev", checkpoint(), NOW);
    expect(validateApplicationEvidence({ ...review, stages: review.stages.map((stage) => ({ ...stage, raw: "private" })) })).toEqual(review);
  });

  it.each([
    { correlation: "exact" }, { recordsCommitted: -1 }, { recordsRejected: "0" },
    { code: "raw private exception" }, { businessAsOf: "2026-02-30" },
    { observedAt: "2026-09-18" }, { environment: "test" }, { sourceKey: "OTHER" },
    { latestCommitAt: null }, { latestCommitAt: "2026-09-19T15:00:00.000Z" },
    { lastFailureAt: "2026-09-18T13:00:00.000Z" },
  ])("rejects invalid/contradictory metadata using a static error %j", (changes) => {
    expect(() => validateApplicationEvidence({ ...evaluateAum([audit()]), ...changes }))
      .toThrow("invalid_application_evidence");
  });

  it("rejects duplicate stages and source/date/count mismatches", () => {
    const review = evaluateReviewQueueEvidence("dev", checkpoint(), NOW);
    expect(() => validateApplicationEvidence({ ...review, stages: [review.stages[0], review.stages[0]] }))
      .toThrow("invalid_application_evidence");
    expect(() => validateApplicationEvidence({ ...review, recordsCommitted: 1 })).toThrow("invalid_application_evidence");
    expect(() => validateApplicationEvidence({ ...review, freshness: { ...review.freshness, basis: "committed_snapshot_date" } }))
      .toThrow("invalid_application_evidence");
  });

  it("expires cached CURRENT without erasing a proven historical completion", () => {
    const value = evaluateAum([audit()]);
    expect(applicationEvidenceForDisplay(value, date("15:15"))).toMatchObject({
      monitoringStale: false, evidence: { freshness: { status: "CURRENT" } },
    });
    const stale = applicationEvidenceForDisplay(value, date("15:16"));
    expect(stale).toMatchObject({ monitoringStale: true, evidence: {
      status: "COMPLETE", latestCommitAt: date("13:00").toISOString(),
      freshness: { status: "UNKNOWN", checkedAt: NOW.toISOString() },
    } });
    expect(value.freshness.status).toBe("CURRENT");
    expect(isApplicationEvidenceStale(value, date("14:59"))).toBe(true);
    expect(isApplicationEvidenceStale(value, new Date("invalid"))).toBe(true);
  });
});

describe("read-only bounded application metadata collection", () => {
  let tx: { auditLog: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> }; $queryRaw: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "dev"); mock.scope.mockReset(); mock.bounds.mockReset();
    tx = { auditLog: { findMany: vi.fn().mockResolvedValue([audit()]), findFirst: vi.fn().mockResolvedValue(null) },
      $queryRaw: vi.fn().mockResolvedValue([checkpoint()]) };
    mock.scope.mockImplementation(async (_identity, callback) => callback(tx));
    mock.bounds.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("uses the Operations system scope, statement bounds, exact allowlisted lookups and metadata projections", async () => {
    const values = await collectApplicationEvidence("dev", NOW);
    expect(values.map((value) => value.sourceKey)).toEqual(["ACCOUNT_AUM", "REVIEW_QUEUE"]);
    expect(mock.scope).toHaveBeenCalledTimes(2);
    for (const call of mock.scope.mock.calls) {
      expect(call[0]).toEqual({ role: "OPERATIONS", email: "data-job-collector@system" });
      expect(call[2]).toEqual({ timeout: 15000, maxWait: 5000 });
    }
    expect(mock.bounds).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.findMany).toHaveBeenCalledWith({
      where: { action: "ingest.account_aum", entityType: "ingest_run" },
      orderBy: [{ at: "desc" }, { id: "desc" }], take: 32, select: { at: true, detail: true },
    });
    expect(tx.auditLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { action: "feed.health", entityType: "feed_health", entityId: "account-aum" },
    }));
    const sql = tx.$queryRaw.mock.calls[0][0].join("?");
    expect(sql).toContain("LIMIT 1"); expect(sql).toContain("AS trade_progress");
    expect(sql).not.toMatch(/SELECT\s+\*|lease_token|source_snapshot|client_sf_id/);
  });

  it.each(["ACCOUNT_AUM", "REVIEW_QUEUE"])("isolates %s read failure without raw exceptions or hiding the other source", async (source) => {
    if (source === "ACCOUNT_AUM") tx.auditLog.findMany.mockRejectedValue(new Error("private DB token"));
    else tx.$queryRaw.mockRejectedValue(new Error("private DB token"));
    const values = await collectApplicationEvidence("dev", NOW);
    expect(values.find((value) => value.sourceKey === source)).toMatchObject({
      coverage: "unavailable", status: "UNKNOWN", code: "application_read_unavailable",
    });
    expect(values.find((value) => value.sourceKey !== source)?.coverage).toBe("snapshot_only");
    expect(JSON.stringify(values)).not.toContain("private DB token");
  });

  it("fails closed before any query when environment or observation time is invalid", async () => {
    await expect(collectApplicationEvidence("prod", NOW)).rejects.toThrow("application_environment_mismatch");
    await expect(collectApplicationEvidence("dev", new Date("invalid"))).rejects.toThrow("application_observation_time_invalid");
    expect(mock.scope).not.toHaveBeenCalled();
  });
});
