import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  scopeSpy,
  aumSpy,
  fundingAvailabilitySpy,
  fundingSourceDateSpy,
} = vi.hoisted(() => ({
  scopeSpy: vi.fn(),
  aumSpy: vi.fn(),
  fundingAvailabilitySpy: vi.fn(),
  fundingSourceDateSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("@/lib/data/feed-health", () => ({ checkAumFreshness: aumSpy }));
vi.mock("@/lib/data/account-funding", () => ({
  checkExternalFundingAvailability: fundingAvailabilitySpy,
  getExternalFundingSourceDate: fundingSourceDateSpy,
}));

import { getSourceHealth } from "@/lib/data/source-health";

const saved = process.env.DATA_HEALTH;
const savedReviewQueue = process.env.REVIEW_QUEUE;
const savedSchedulerActive = process.env.REVIEW_QUEUE_SCHEDULER_ACTIVE;
const NOW = new Date("2026-08-19T16:00:00.000Z");

function wireLocal(overrides: {
  sweepFailureAt?: Date | null;
  sweepFailureSource?: string | null;
  sweepStartedAt?: Date;
  sweepCompletedAt?: Date;
  sweepTradeCursor?: string | null;
  sweepTradeComplete?: boolean;
  aumSuccessAt?: Date;
  aumAuditRows?: Array<{ at: Date; detail: string | null }>;
  feedHealthAt?: Date | null;
  crmSuccessAt?: Date;
  zendeskAuditRows?: Array<{ action: string; at: Date; detail: string | null }>;
  zendeskAggregate?: {
    ticket_count: number;
    comment_count: number;
    linked_count: number;
    unmatched_count: number;
    ambiguous_count: number;
    truncated_count: number;
    latest_source_update: Date | null;
    latest_mirror_write: Date | null;
  };
} = {}) {
  const tx = {
    auditLog: {
      findMany: vi.fn().mockImplementation(({ where }: { where: { action: string } }) => {
        if (where.action === "ingest.zendesk_tickets") {
          return overrides.zendeskAuditRows ?? [{
            action: "ingest.zendesk_tickets",
            at: new Date("2026-08-19T10:45:00Z"),
            detail: JSON.stringify({ rejected: 0, dry_run: false }),
          }];
        }
        return overrides.aumAuditRows ?? [{
          action: "ingest.account_aum",
          at: overrides.aumSuccessAt ?? new Date("2026-08-19T14:00:00Z"),
          detail: JSON.stringify({ upserted: 1200, as_of_max: "2026-08-18" }),
        }];
      }),
      findFirst: vi.fn().mockImplementation(({ where }: { where: { action: string } }) => {
        if (where.action === "feed.health") {
          return overrides.feedHealthAt
            ? { action: where.action, at: overrides.feedHealthAt, detail: null }
            : null;
        }
        if (where.action === "crm.identity.reconcile") {
          return {
            action: where.action,
            at: overrides.crmSuccessAt ?? new Date("2026-08-19T15:05:00Z"),
            detail: null,
          };
        }
        return null;
      }),
    },
    reviewQueueSweepState: {
      findUnique: vi.fn().mockResolvedValue({
        last_started_at: overrides.sweepStartedAt ?? new Date("2026-08-19T12:00:00Z"),
        last_completed_at: overrides.sweepCompletedAt ?? new Date("2026-08-19T12:00:00Z"),
        last_failure_at: overrides.sweepFailureAt ?? null,
        last_failure_source: overrides.sweepFailureSource ?? null,
        lease_expires_at: null,
        trade_cursor: overrides.sweepTradeCursor ?? null,
        crm_cursor: null,
        trade_complete: overrides.sweepTradeComplete ?? false,
        crm_complete: false,
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue([
      overrides.zendeskAggregate ?? {
        ticket_count: 100,
        comment_count: 240,
        linked_count: 70,
        unmatched_count: 30,
        ambiguous_count: 0,
        truncated_count: 2,
        latest_source_update: new Date("2026-08-19T10:30:00Z"),
        latest_mirror_write: new Date("2026-08-19T10:45:00Z"),
      },
    ]),
  };
  scopeSpy.mockImplementation(async (_identity, callback) => callback(tx));
  return tx;
}

describe("source-health data seam", () => {
  beforeEach(() => {
    process.env.DATA_HEALTH = "1";
    process.env.REVIEW_QUEUE = "1";
    scopeSpy.mockReset();
    aumSpy.mockReset();
    fundingAvailabilitySpy.mockReset();
    fundingSourceDateSpy.mockReset();
    fundingAvailabilitySpy.mockResolvedValue(undefined);
    fundingSourceDateSpy.mockResolvedValue("2026-08-18");
    aumSpy.mockResolvedValue({
      ok: true,
      reason: "ok",
      expectedMinAsOf: "2026-08-18",
      maxAsOf: "2026-08-18",
      staleByTradingDays: 0,
      rowCount: 1200,
      syncAgeHours: 2,
      maxSyncedAt: new Date("2026-08-19T14:00:00Z"),
    });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DATA_HEALTH;
    else process.env.DATA_HEALTH = saved;
    if (savedReviewQueue === undefined) delete process.env.REVIEW_QUEUE;
    else process.env.REVIEW_QUEUE = savedReviewQueue;
    if (savedSchedulerActive === undefined) delete process.env.REVIEW_QUEUE_SCHEDULER_ACTIVE;
    else process.env.REVIEW_QUEUE_SCHEDULER_ACTIVE = savedSchedulerActive;
  });

  it("fails closed before any DB or feed read for non-Operations roles", async () => {
    await expect(getSourceHealth({ role: "ADVISOR", email: "a@example.test" }, NOW))
      .resolves.toEqual({ ok: false, reason: "forbidden" });
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(aumSpy).not.toHaveBeenCalled();
  });

  it("keeps the default-off flag ahead of all reads", async () => {
    process.env.DATA_HEALTH = "0";
    await expect(getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, NOW))
      .resolves.toEqual({ ok: false, reason: "disabled" });
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(aumSpy).not.toHaveBeenCalled();
  });

  it("hides review CTAs when the queue UI is dark without changing health", async () => {
    process.env.REVIEW_QUEUE = "0";
    wireLocal();
    const result = await getSourceHealth(
      { role: "OPERATIONS", email: "o@example.test" },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "CRM_IDENTITY")).toMatchObject({
      status: "HEALTHY",
      actionHref: null,
      actionLabel: null,
    });
    expect(result.rows.find((row) => row.key === "TRADE_REQUEST")).toMatchObject({
      status: "UNKNOWN",
      actionHref: null,
      actionLabel: null,
    });
  });

  it("separates source dates, committed successes, attempts and unsupported metadata", async () => {
    const tx = wireLocal();
    const result = await getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const aum = result.rows.find((row) => row.key === "ACCOUNT_AUM");
    expect(aum).toMatchObject({
      status: "HEALTHY",
      businessAsOf: "2026-08-18",
      latestSuccessAt: "2026-08-19T14:00:00.000Z",
      lastAttemptAt: "2026-08-19T14:00:00.000Z",
    });
    const crm = result.rows.find((row) => row.key === "CRM_IDENTITY");
    expect(crm).toMatchObject({
      status: "HEALTHY",
      businessAsOf: null,
      lastAttemptAt: null,
      lastFailureAt: null,
    });
    expect(crm?.attemptEvidence).toContain("not yet durable metadata");
    const funding = result.rows.find((row) => row.key === "EXTERNAL_FUNDING");
    expect(funding).toMatchObject({
      status: "HEALTHY",
      businessAsOf: "2026-08-18",
      expectedBusinessAsOf: "2026-08-18",
      latestSuccessAt: null,
      availabilityCheckedAt: NOW.toISOString(),
      coverage: "Source date and live query availability",
    });
    expect(tx.auditLog.findMany).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.findMany.mock.calls.map(([arg]) => arg.where.action)).toEqual([
      "ingest.account_aum",
      "ingest.zendesk_tickets",
    ]);
    expect(tx.auditLog.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.findFirst.mock.calls.map(([arg]) => arg.where.action)).toEqual([
      "feed.health",
      "crm.identity.reconcile",
    ]);
    expect(tx.auditLog.findFirst.mock.calls[0][0].where).toEqual({
      action: "feed.health",
      entityType: "feed_health",
      entityId: "account-aum",
    });
  });

  it("reports aggregate Zendesk linkage without exposing ticket or requester data", async () => {
    wireLocal();
    const result = await getSourceHealth(
      { role: "OPERATIONS", email: "o@example.test" },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const zendesk = result.rows.find((row) => row.key === "ZENDESK");
    expect(zendesk).toMatchObject({
      status: "HEALTHY",
      statusReason: "recent success",
      latestSuccessAt: "2026-08-19T10:45:00.000Z",
      lastAttemptAt: "2026-08-19T10:45:00.000Z",
      latestSuccessLabel: "Latest accepted batch",
      lastAttemptLabel: "Latest observed batch",
      metrics: [
        { label: "Tickets", value: "100" },
        { label: "Public comments", value: "240" },
        { label: "Linked", value: "70", tone: "green" },
        { label: "Unmatched", value: "30", tone: "amber" },
        { label: "Ambiguous", value: "0" },
        { label: "Comment history capped", value: "2", tone: "amber" },
      ],
    });
    expect(zendesk?.attemptEvidence).toContain("does not prove that the entire n8n execution completed");
    expect(JSON.stringify(zendesk)).not.toContain("requester_email");
    expect(JSON.stringify(zendesk)).not.toContain("ticket_url");
  });

  it("makes ambiguous Zendesk requester matches actionable", async () => {
    wireLocal({
      zendeskAggregate: {
        ticket_count: 100,
        comment_count: 240,
        linked_count: 69,
        unmatched_count: 30,
        ambiguous_count: 1,
        truncated_count: 0,
        latest_source_update: new Date("2026-08-19T10:30:00Z"),
        latest_mirror_write: new Date("2026-08-19T10:45:00Z"),
      },
    });
    const result = await getSourceHealth(
      { role: "OPERATIONS", email: "o@example.test" },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "ZENDESK")).toMatchObject({
      status: "ATTENTION",
      statusReason: "Ambiguous requester matches need attention",
    });
  });

  it("marks stale Zendesk accepted-batch evidence for attention", async () => {
    wireLocal({
      zendeskAuditRows: [{
        action: "ingest.zendesk_tickets",
        at: new Date("2026-08-17T10:45:00Z"),
        detail: JSON.stringify({ rejected: 0, dry_run: false }),
      }],
    });
    const result = await getSourceHealth(
      { role: "OPERATIONS", email: "o@example.test" },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "ZENDESK")).toMatchObject({
      status: "ATTENTION",
      statusReason: "stale success",
    });
  });

  it("isolates a Zendesk aggregate failure from the other source cards", async () => {
    const tx = wireLocal();
    tx.$queryRaw.mockRejectedValue(new Error("unavailable"));
    const result = await getSourceHealth(
      { role: "OPERATIONS", email: "o@example.test" },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "ZENDESK")).toMatchObject({
      status: "UNKNOWN",
      statusReason: "Aggregate sync evidence unavailable",
    });
    expect(result.rows.find((row) => row.key === "ACCOUNT_AUM")?.status).toBe("HEALTHY");
    expect(result.rows.find((row) => row.key === "CRM_IDENTITY")?.status).toBe("HEALTHY");
    expect(result.warnings).toContain(
      "Zendesk sync and aggregate linkage evidence is temporarily unavailable.",
    );
  });

  it("reads each audit action independently so noisy health warnings cannot crowd out successes", async () => {
    const tx = wireLocal();
    tx.auditLog.findFirst.mockImplementation(({ where }: { where: { action: string } }) => {
      const at = where.action === "feed.health"
        ? new Date("2026-08-19T15:00:00Z")
        : new Date("2026-08-19T13:00:00Z");
      return { action: where.action, at, detail: null };
    });
    const result = await getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "CRM_IDENTITY")?.latestSuccessAt)
      .toBe("2026-08-19T13:00:00.000Z");
    expect(result.rows.find((row) => row.key === "ACCOUNT_AUM")?.lastFailureAt)
      .toBe("2026-08-19T15:00:00.000Z");
  });

  it("scopes AUM feed-health evidence so another feed cannot poison the row", async () => {
    const tx = wireLocal();
    await getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, NOW);
    expect(tx.auditLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        action: "feed.health",
        entityType: "feed_health",
        entityId: "account-aum",
      },
    }));
  });

  it("treats a zero-upsert AUM audit as an issue, not a completed data load", async () => {
    const noDataAt = new Date("2026-08-19T15:30:00Z");
    wireLocal({
      aumAuditRows: [
        {
          at: noDataAt,
          detail: JSON.stringify({ upserted: 0, as_of_max: null }),
        },
        {
          at: new Date("2026-08-19T14:00:00Z"),
          detail: JSON.stringify({ upserted: 1200, as_of_max: "2026-08-18" }),
        },
      ],
    });
    const result = await getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "ACCOUNT_AUM")).toMatchObject({
      status: "ATTENTION",
      latestSuccessAt: "2026-08-19T14:00:00.000Z",
      lastAttemptAt: "2026-08-19T15:30:00.000Z",
      lastFailureAt: "2026-08-19T15:30:00.000Z",
      statusReason: "newer failure",
    });
  });

  it("surfaces a newer Trade Request sweep failure as actionable", async () => {
    wireLocal({
      sweepFailureAt: new Date("2026-08-19T15:00:00Z"),
      sweepFailureSource: "TRADE_REQUEST",
    });
    const result = await getSourceHealth({ role: "ADMIN", email: "a@example.test" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "TRADE_REQUEST")).toMatchObject({
      status: "ATTENTION",
      lastFailureAt: "2026-08-19T15:00:00.000Z",
      reviewQueueSource: "TRADE_REQUEST",
    });
  });

  it("does not claim Trade Request freshness until scheduler activation is verifiable", async () => {
    wireLocal();
    const result = await getSourceHealth({ role: "ADMIN", email: "a@example.test" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "TRADE_REQUEST")).toMatchObject({
      status: "UNKNOWN",
      statusReason: "schedule unverified",
      latestSuccessAt: "2026-08-19T12:00:00.000Z",
    });
  });

  it("uses the configured recurring scheduler and complete checkpoint as Trade Request health", async () => {
    process.env.REVIEW_QUEUE_SCHEDULER_ACTIVE = "1";
    wireLocal({
      sweepStartedAt: new Date("2026-08-19T15:55:00Z"),
      sweepCompletedAt: new Date("2026-08-19T15:55:00Z"),
    });
    const result = await getSourceHealth({ role: "ADMIN", email: "a@example.test" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "TRADE_REQUEST")).toMatchObject({
      status: "HEALTHY",
      statusReason: "Complete sweep within two-hour target",
      coverage: "Recurring complete-sweep freshness",
    });
  });

  it("keeps an active multi-page Trade Request sweep healthy while progress is recent", async () => {
    process.env.REVIEW_QUEUE_SCHEDULER_ACTIVE = "1";
    wireLocal({
      sweepStartedAt: new Date("2026-08-19T15:55:00Z"),
      sweepCompletedAt: new Date("2026-08-19T12:00:00Z"),
      sweepTradeCursor: "opaque",
    });
    const result = await getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "TRADE_REQUEST")).toMatchObject({
      status: "HEALTHY",
      statusReason: "Scheduled sweep progressing",
    });
  });

  it("surfaces a live External Funding card failure even when the source date is current", async () => {
    wireLocal();
    fundingAvailabilitySpy.mockRejectedValue(new Error("unavailable"));
    const result = await getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "EXTERNAL_FUNDING")).toMatchObject({
      status: "ATTENTION",
      statusReason: "Live card query failed",
      businessAsOf: "2026-08-18",
      availabilityCheckedAt: NOW.toISOString(),
      lastFailureAt: null,
    });
  });

  it("marks External Funding attention when the activity-feed source date is stale", async () => {
    wireLocal();
    fundingSourceDateSpy.mockResolvedValue("2026-08-17");
    const result = await getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "EXTERNAL_FUNDING")).toMatchObject({
      status: "ATTENTION",
      statusReason: "Source-date check stale",
      businessAsOf: "2026-08-17",
      expectedBusinessAsOf: "2026-08-18",
    });
  });

  it("falls back to live availability without inventing a source date", async () => {
    wireLocal();
    fundingSourceDateSpy.mockRejectedValue(new Error("unavailable"));
    const result = await getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "EXTERNAL_FUNDING")).toMatchObject({
      status: "AVAILABLE",
      statusReason: "Live card query available; freshness check unavailable",
      businessAsOf: null,
      expectedBusinessAsOf: null,
      coverage: "Live query availability only",
    });
  });

  it("never reports AUM healthy when the source-date check itself is unavailable", async () => {
    wireLocal();
    aumSpy.mockRejectedValue(new Error("unavailable"));
    const result = await getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "ACCOUNT_AUM")).toMatchObject({
      status: "UNKNOWN",
      statusReason: "Source-date check unavailable",
    });
  });

  it.each([
    ["weekend", new Date("2026-08-22T16:00:00Z")],
    ["Monday before the run boundary", new Date("2026-08-24T14:59:00Z")],
  ])("does not turn the probe's fixed stale-sync age into false AUM attention on %s", async (_label, now) => {
    wireLocal({ aumSuccessAt: new Date("2026-08-21T13:15:00Z") });
    aumSpy.mockResolvedValue({
      ok: false,
      reason: "stale_sync",
      expectedMinAsOf: "2026-08-21",
      maxAsOf: "2026-08-21",
      staleByTradingDays: 0,
      rowCount: 1200,
      syncAgeHours: 50,
      maxSyncedAt: new Date("2026-08-21T13:15:00Z"),
    });
    const result = await getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "ACCOUNT_AUM")).toMatchObject({
      status: "HEALTHY",
      businessAsOf: "2026-08-21",
      latestSuccessAt: "2026-08-21T13:15:00.000Z",
    });
  });

  it("keeps stale mirror sync actionable after the weekday 11 ET boundary", async () => {
    wireLocal({ aumSuccessAt: new Date("2026-08-19T14:00:00Z") });
    aumSpy.mockResolvedValue({
      ok: false,
      reason: "stale_sync",
      expectedMinAsOf: "2026-08-18",
      maxAsOf: "2026-08-18",
      staleByTradingDays: 0,
      rowCount: 1200,
      syncAgeHours: 50,
      maxSyncedAt: new Date("2026-08-17T14:00:00Z"),
    });
    const result = await getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "ACCOUNT_AUM")).toMatchObject({
      status: "ATTENTION",
      statusReason: "Mirror sync check: stale sync",
    });
  });

  it.each([
    ["weekend", new Date("2026-08-22T16:00:00Z")],
    ["Monday before the first-run grace boundary", new Date("2026-08-24T04:14:00Z")],
  ])("keeps Friday's final CRM completion current on %s", async (_label, now) => {
    wireLocal({ crmSuccessAt: new Date("2026-08-22T03:05:00Z") });
    const result = await getSourceHealth({ role: "OPERATIONS", email: "o@example.test" }, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "CRM_IDENTITY")).toMatchObject({
      status: "HEALTHY",
      latestSuccessAt: "2026-08-22T03:05:00.000Z",
    });
  });

  it("requires the latest CRM hour after the weekday grace window", async () => {
    wireLocal({ crmSuccessAt: new Date("2026-08-19T15:05:00Z") });
    const result = await getSourceHealth(
      { role: "OPERATIONS", email: "o@example.test" },
      new Date("2026-08-19T16:16:00Z"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((row) => row.key === "CRM_IDENTITY")).toMatchObject({
      status: "ATTENTION",
      statusReason: "stale success",
    });
  });
});
