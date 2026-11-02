import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import { runReviewQueueMaterialization } from "@/lib/data/review-queue-materialize";
import { runReviewQueueSweepStep } from "@/lib/data/review-queue-sweep";
import { compareAndSaveReviewQueueWorkflow } from "@/lib/data/review-queue-workflow";
import { withUserScope } from "@/lib/rls";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const DEAL_ID = "TEST-REVIEW-QUEUE-DEAL";
const IDENTITY_ID = "dea_reviewqueuefixture";
const MAPPING_ID = "review-queue-mapping";
const EXCEPTION_A = "000reviewqueuea";
const EXCEPTION_B = "000reviewqueueb";

gated("central review queue database/RLS and CRM lifecycle", () => {
  let su: PrismaClient;
  const priorFixture = process.env.TRADE_REQUEST_FIXTURE;

  async function cleanup() {
    await su.reviewQueueSweepState.deleteMany({ where: { id: "default" } });
    await su.reviewQueueEvent.deleteMany({
      where: { item: { source_record_ref: { in: [EXCEPTION_A, EXCEPTION_B] } } },
    });
    await su.reviewQueueItem.deleteMany({
      where: { source_record_ref: { in: [EXCEPTION_A, EXCEPTION_B] } },
    });
    await su.crmIdentityException.deleteMany({ where: { id: { in: [EXCEPTION_A, EXCEPTION_B] } } });
    await su.crmSourceMapping.deleteMany({ where: { id: MAPPING_ID } });
    await su.crmIdentity.deleteMany({ where: { id: IDENTITY_ID } });
    await su.deal.deleteMany({ where: { id: DEAL_ID } });
  }

  beforeAll(async () => {
    process.env.TRADE_REQUEST_FIXTURE = "1";
    su = new PrismaClient({
      datasources: {
        db: { url: process.env.AUDIT_TEST_CLEANUP_URL ?? "postgresql://aoa@localhost:5432/aoa" },
      },
    });
    await cleanup();
    await su.deal.create({
      data: {
        id: DEAL_ID, source: "APP", name: "Review queue fixture",
        client_first_name: "Synthetic", client_last_name: "Fixture",
        amount: "1000.00", stage: "POTENTIAL", created_date: new Date("2026-08-01"),
      },
    });
    await su.crmIdentity.create({ data: { id: IDENTITY_ID, identity_type: "DEAL" } });
    await su.crmSourceMapping.create({
      data: {
        id: MAPPING_ID, identity_id: IDENTITY_ID, source_system: "AOA",
        source_namespace: "deal", source_key: DEAL_ID,
      },
    });
    await su.crmIdentityException.createMany({
      data: [
        { id: EXCEPTION_A, source_mapping_id: MAPPING_ID, reason_code: "SOURCE_KEY_COLLISION" },
        { id: EXCEPTION_B, source_mapping_id: MAPPING_ID, reason_code: "IDENTITY_TYPE_MISMATCH" },
      ],
    });
  });

  afterAll(async () => {
    await cleanup();
    await su.$disconnect();
    if (priorFixture === undefined) delete process.env.TRADE_REQUEST_FIXTURE;
    else process.env.TRADE_REQUEST_FIXTURE = priorFixture;
  });

  it("materializes paged CRM exceptions idempotently with a valid anchored local href", async () => {
    const first = await runReviewQueueMaterialization({ limit: 1, crmLimit: 1 });
    expect(first.crm).toMatchObject({ processed: 1, failed: false, hasMore: true, nextCursor: EXCEPTION_A });
    const second = await runReviewQueueMaterialization({
      limit: 1, crmLimit: 1, crmCursor: EXCEPTION_A,
    });
    expect(second.crm).toMatchObject({ processed: 1, failed: false });

    const rows = await su.reviewQueueItem.findMany({
      where: { source_record_ref: { in: [EXCEPTION_A, EXCEPTION_B] } },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => (
      row.resolution_href.startsWith(`/crm/${IDENTITY_ID}?resolutionException=`)
      && row.resolution_href.endsWith("#resolve-parent-mapping")
    ))).toBe(true);

    const retry = await runReviewQueueMaterialization({ limit: 1, crmLimit: 1 });
    expect(retry.changes.opened).toBe(0);
    expect(await su.reviewQueueItem.count({
      where: { source_record_ref: { in: [EXCEPTION_A, EXCEPTION_B] } },
    })).toBe(2);
  });

  it("enforces Ops/Admin RLS and append-only event grants", async () => {
    const viewerRows = await withUserScope(
      { role: "VIEWER", email: "viewer@example.com" },
      (tx) => tx.reviewQueueItem.findMany({ where: { source_record_ref: EXCEPTION_A } }),
    );
    expect(viewerRows).toHaveLength(0);
    const adminRows = await withUserScope(
      { role: "ADMIN", email: "admin@example.com" },
      (tx) => tx.reviewQueueItem.findMany({ where: { source_record_ref: EXCEPTION_A } }),
    );
    expect(adminRows).toHaveLength(1);

    const event = await su.reviewQueueEvent.findFirstOrThrow({
      where: { item: { source_record_ref: EXCEPTION_A } },
    });
    await expect(withUserScope(
      { role: "ADMIN", email: "admin@example.com" },
      (tx) => tx.reviewQueueEvent.update({ where: { id: event.id }, data: { action: "TAMPERED" } }),
    )).rejects.toThrow();
  });

  it("persists resumable sweep freshness behind the same Ops/Admin RLS", async () => {
    const step = await runReviewQueueSweepStep({ limit: 1, crmLimit: 1 });
    expect(step.sweep.lastFailureAt).toBeNull();
    const stored = await su.reviewQueueSweepState.findUniqueOrThrow({
      where: { id: "default" },
    });
    expect(stored.last_started_at).toBeInstanceOf(Date);

    expect(await withUserScope(
      { role: "VIEWER", email: "viewer@example.com" },
      (tx) => tx.reviewQueueSweepState.findMany(),
    )).toHaveLength(0);
    expect(await withUserScope(
      { role: "OPERATIONS", email: "ops@example.com" },
      (tx) => tx.reviewQueueSweepState.findMany(),
    )).toHaveLength(1);
  });

  it("allows only one of two concurrent editors to save the same row version", async () => {
    const item = await su.reviewQueueItem.findFirstOrThrow({
      where: { source_record_ref: EXCEPTION_A },
    });
    const before = await su.reviewQueueEvent.count({
      where: { item_id: item.id, action: "WORKFLOW_UPDATED" },
    });
    const save = (actor: string, note: string) => withUserScope(
      { role: "OPERATIONS", email: actor },
      (tx) => compareAndSaveReviewQueueWorkflow(tx, { role: "OPERATIONS", email: actor }, {
        id: item.id,
        expectedUpdatedAt: item.updated_at,
        status: "IN_REVIEW",
        assignedTo: null,
        note,
        snoozedUntil: null,
      }),
    );

    const outcomes = await Promise.all([
      save("first.ops@example.com", "First editor context"),
      save("second.ops@example.com", "Second editor context"),
    ]);
    expect(outcomes.sort()).toEqual(["conflict", "updated"]);
    expect(await su.reviewQueueEvent.count({
      where: { item_id: item.id, action: "WORKFLOW_UPDATED" },
    })).toBe(before + 1);
    const saved = await su.reviewQueueItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(["First editor context", "Second editor context"]).toContain(saved.resolution_note);
  });

  it("wakes expired snoozes, source-clears, and reopens without erasing the current note", async () => {
    const item = await su.reviewQueueItem.findFirstOrThrow({
      where: { source_record_ref: EXCEPTION_A },
    });
    await su.reviewQueueItem.update({
      where: { id: item.id },
      data: {
        status: "SNOOZED", snoozed_until: new Date("2026-08-01T00:00:00Z"),
        resolution_note: "Preserve this current context",
      },
    });
    const awakened = await runReviewQueueMaterialization({
      limit: 1, crmCursor: "zzzzzz", crmLimit: 1,
    });
    expect(awakened.changes.awakened).toBeGreaterThanOrEqual(1);
    expect(await su.reviewQueueItem.findUnique({ where: { id: item.id } })).toMatchObject({
      status: "NEW", snoozed_until: null, resolution_note: "Preserve this current context",
    });
    expect(await su.reviewQueueEvent.count({
      where: { item_id: item.id, action: "SNOOZE_EXPIRED" },
    })).toBe(1);

    await su.crmIdentityException.update({
      where: { id: EXCEPTION_A },
      data: {
        exception_state: "RESOLVED", resolution_code: "SOURCE_CORRECTED",
        resolved_at: new Date(),
      },
    });
    await runReviewQueueMaterialization({ limit: 1, crmCursor: "zzzzzz", crmLimit: 1 });
    expect(await su.reviewQueueItem.findUnique({ where: { id: item.id } })).toMatchObject({
      source_active: false, status: "RESOLVED",
      resolution_note: "Preserve this current context",
    });

    await su.crmIdentityException.update({
      where: { id: EXCEPTION_A },
      data: { exception_state: "OPEN", resolution_code: null, resolved_at: null },
    });
    await runReviewQueueMaterialization({ limit: 1, crmLimit: 1 });
    expect(await su.reviewQueueItem.findUnique({ where: { id: item.id } })).toMatchObject({
      source_active: true, status: "NEW",
      resolution_note: "Preserve this current context",
    });
    expect(await su.reviewQueueEvent.count({
      where: { item_id: item.id, action: "SOURCE_REOPENED" },
    })).toBe(1);
  });
});
