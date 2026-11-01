import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditActor } from "@/types/domain";
import {
  DEMO_LIMITS,
  DemoLimitError,
  DemoVisitorLimitError,
  enforceDemoDraftLimit,
  enforceDemoLimits,
  resetDemoVisitorMemory,
  shouldRecordDemoDenial,
  shouldRecordDemoView,
  spendVisitorAllowance,
} from "./limits";
import { DEMO_TEXT_MAX, demoTextMax } from "./mode";

const helen = { id: "staff_helen", email: "helen.carver@example.com", groups: ["client_services"] } as AuditActor;
const visitorA = "2001:db8:1:2:3:4:5:6";
const visitorB = "2001:db8:9:8:7:6:5:4";

type Counts = {
  rows?: number;
  bytes?: number;
  database?: number;
  tickets?: number;
  comments?: number;
  recentViews?: number;
  drafts?: number;
  draftExists?: boolean;
};

function fakeDb(counts: Counts) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      $executeRaw: vi.fn(async () => {
        calls.push("lock");
        return 0;
      }),
      $queryRaw: vi.fn(async () => [
        { rows: BigInt(counts.rows ?? 0), bytes: BigInt(counts.bytes ?? 0), database: BigInt(counts.database ?? 0) },
      ]),
      ticket: { count: async () => counts.tickets ?? 0 },
      comment: { count: async () => counts.comments ?? 0 },
      macro: { count: async () => 0 },
      requesterSuppression: { count: async () => 0 },
      auditLog: { count: async () => counts.recentViews ?? 0 },
      composerDraft: {
        count: async (args?: { where?: unknown }) => (args?.where ? (counts.draftExists ? 1 : 0) : (counts.drafts ?? 0)),
      },
    } as never,
  };
}

const ledgerFull = { rows: DEMO_LIMITS.ledgerRows };

describe("the demo's limits", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    vi.stubEnv("APP_ENV", "demo");
    resetDemoVisitorMemory();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("takes the limits lock, then lets a change under every cap through", async () => {
    const { db, calls } = fakeDb({ rows: 2_000, tickets: 200 });
    await expect(enforceDemoLimits(db, ["TICKET_CREATED"], visitorA)).resolves.toBe(true);
    expect(calls).toEqual(["lock"]);
  });

  it("refuses a new ticket past the ticket cap, and any change once the ledger or the database is full", async () => {
    await expect(enforceDemoLimits(fakeDb({ tickets: DEMO_LIMITS.tickets + 1 }).db, ["TICKET_INGESTED"])).rejects.toThrow(
      DemoLimitError,
    );
    await expect(enforceDemoLimits(fakeDb(ledgerFull).db, ["TICKET_STATUS_CHANGED"])).rejects.toThrow(
      "resets daily at 14:00 UTC",
    );
    for (const full of [{ bytes: DEMO_LIMITS.ledgerBytes }, { database: DEMO_LIMITS.databaseBytes }]) {
      await expect(enforceDemoLimits(fakeDb(full).db, ["TICKET_STATUS_CHANGED"])).rejects.toThrow(DemoLimitError);
    }
  });

  it("still lets visitors in and looking once the ledger is full: their rows are skipped, not refused", async () => {
    for (const action of ["USER_SIGNED_IN", "USER_SIGNED_OUT", "TICKET_VIEWED", "ATTACHMENT_VIEWED", "AUTHZ_DENIED", "REPORT_EXPORTED"]) {
      await expect(enforceDemoLimits(fakeDb(ledgerFull).db, [action], visitorA), action).resolves.toBe(false);
      await expect(enforceDemoLimits(fakeDb({ database: DEMO_LIMITS.databaseBytes }).db, [action]), action).resolves.toBe(false);
    }
    // A batch with any change in it is a change.
    await expect(enforceDemoLimits(fakeDb(ledgerFull).db, ["TICKET_VIEWED", "COMMENT_ADDED_INTERNAL"])).rejects.toThrow(
      DemoLimitError,
    );
  });

  it("gives each visitor an hourly allowance: past it their looks go unrecorded and their changes are refused", async () => {
    const at = new Date("2026-10-28T14:00:00Z");
    expect(spendVisitorAllowance(visitorA, DEMO_LIMITS.visitorRowsPerHour - 1, at)).toBe(true);
    await expect(enforceDemoLimits(fakeDb({}).db, ["TICKET_STATUS_CHANGED"], visitorA, at)).resolves.toBe(true);
    await expect(enforceDemoLimits(fakeDb({}).db, ["TICKET_VIEWED"], visitorA, at)).resolves.toBe(false);
    await expect(enforceDemoLimits(fakeDb({}).db, ["TICKET_STATUS_CHANGED"], visitorA, at)).rejects.toThrow(
      DemoVisitorLimitError,
    );
    // Another visitor is unaffected, and the first gets a fresh hour.
    await expect(enforceDemoLimits(fakeDb({}).db, ["TICKET_STATUS_CHANGED"], visitorB, at)).resolves.toBe(true);
    const later = new Date(at.getTime() + 60 * 60_000);
    await expect(enforceDemoLimits(fakeDb({}).db, ["TICKET_STATUS_CHANGED"], visitorA, later)).resolves.toBe(true);
  });

  it("counts every row of a batch, and refuses a batch that would pass the allowance without spending it", () => {
    const at = new Date("2026-10-28T14:00:00Z");
    expect(spendVisitorAllowance(visitorA, DEMO_LIMITS.visitorRowsPerHour + 1, at)).toBe(false);
    expect(spendVisitorAllowance(visitorA, DEMO_LIMITS.visitorRowsPerHour, at)).toBe(true);
    expect(spendVisitorAllowance(visitorA, 1, at)).toBe(false);
  });

  it("holds no allowance against the container's own callers: loopback and the jobs' unknown address", () => {
    for (const internal of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "unknown", ""]) {
      expect(spendVisitorAllowance(internal, DEMO_LIMITS.visitorRowsPerHour * 10), internal).toBe(true);
    }
  });

  it("never applies outside demo mode", async () => {
    const { db, calls } = fakeDb({ rows: DEMO_LIMITS.ledgerRows, tickets: DEMO_LIMITS.tickets + 1 });
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "off");
    await expect(enforceDemoLimits(db, ["TICKET_CREATED"], visitorA)).resolves.toBe(true);
    expect(calls).toEqual([]);
    expect(shouldRecordDemoDenial(helen.id, visitorA)).toBe(true);
    expect(shouldRecordDemoDenial(helen.id, visitorA)).toBe(true);
    expect(demoTextMax(20_000)).toBe(20_000);
  });

  it("records one view per persona, ticket and hour, and none once the ledger is full", async () => {
    expect(await shouldRecordDemoView(fakeDb({ recentViews: 0 }).db, helen, "hd-2479")).toBe(true);
    expect(await shouldRecordDemoView(fakeDb({ recentViews: 1 }).db, helen, "hd-2479")).toBe(false);
    expect(await shouldRecordDemoView(fakeDb(ledgerFull).db, helen, "hd-2479")).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "off");
    expect(await shouldRecordDemoView(fakeDb({ recentViews: 1 }).db, helen, "hd-2479")).toBe(true);
  });

  it("records one refusal per persona and visitor a minute", () => {
    const at = new Date("2026-10-28T14:00:00Z");
    expect(shouldRecordDemoDenial(helen.id, visitorA, at)).toBe(true);
    expect(shouldRecordDemoDenial(helen.id, visitorA, new Date(at.getTime() + 59_000))).toBe(false);
    expect(shouldRecordDemoDenial(helen.id, visitorB, at)).toBe(true);
    expect(shouldRecordDemoDenial("staff_marco", visitorA, at)).toBe(true);
    expect(shouldRecordDemoDenial(helen.id, visitorA, new Date(at.getTime() + 60_000))).toBe(true);
  });

  it("caps new drafts, keeps saving an existing one, and refuses any save once the database is full", async () => {
    const key = { ticketId: "hd-2479", userId: "staff_helen", channel: "PUBLIC" as const };
    await expect(enforceDemoDraftLimit(fakeDb({ drafts: 10 }).db, key)).resolves.toBeUndefined();
    await expect(enforceDemoDraftLimit(fakeDb({ drafts: DEMO_LIMITS.drafts }).db, key)).rejects.toThrow("saved drafts");
    await expect(
      enforceDemoDraftLimit(fakeDb({ drafts: DEMO_LIMITS.drafts, draftExists: true }).db, key),
    ).resolves.toBeUndefined();
    // A full ledger doesn't stop a draft, which writes no ledger row; a full database does.
    await expect(enforceDemoDraftLimit(fakeDb(ledgerFull).db, key)).resolves.toBeUndefined();
    await expect(enforceDemoDraftLimit(fakeDb({ database: DEMO_LIMITS.databaseBytes }).db, key)).rejects.toThrow(
      DemoLimitError,
    );
  });

  it("keeps a visitor's text short", () => {
    expect(demoTextMax(20_000)).toBe(DEMO_TEXT_MAX);
    expect(demoTextMax(200)).toBe(200);
  });
});

describe("the audit writer and the demo's limits", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    vi.stubEnv("APP_ENV", "demo");
    resetDemoVisitorMemory();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const tx = (rows: number) => {
    const calls: string[] = [];
    const db = {
      $executeRaw: async () => void calls.push("lock"),
      $queryRaw: async () => [{ rows: BigInt(rows), bytes: BigInt(0), database: BigInt(0) }],
      auditLog: { create: async () => void calls.push("insert"), createMany: async () => void calls.push("insert") },
    };
    return { calls, db: db as never };
  };

  it("exempts only SYSTEM_ACTOR, by identity: an anonymous actor with no id is still capped", async () => {
    const { SYSTEM_ACTOR, systemRequestContext, writeAudit } = await import("@/lib/audit");
    const ctx = systemRequestContext("test");
    const entry = { action: "TICKET_STATUS_CHANGED", entityType: "TICKET", entityId: "t", ticketId: "t" } as const;

    const seed = tx(DEMO_LIMITS.ledgerRows);
    await writeAudit(seed.db, SYSTEM_ACTOR, ctx, entry);
    expect(seed.calls).toEqual(["insert"]);

    const anonymous = tx(DEMO_LIMITS.ledgerRows);
    const lookalike = { id: null, email: "client:anonymous", groups: [] } as unknown as AuditActor;
    await expect(writeAudit(anonymous.db, lookalike, ctx, entry)).rejects.toThrow(DemoLimitError);
    expect(anonymous.calls).toEqual(["lock"]);
  });

  it("lets a sign-in through at the cap, writing no row, where a change is refused", async () => {
    const { writeAudit, writeAuditMany } = await import("@/lib/audit");
    const ctx = { ipAddress: visitorA, userAgent: "Mozilla/5.0", requestId: "r", isPrefetch: false };
    const signIn = { action: "USER_SIGNED_IN", entityType: "SESSION", entityId: helen.id } as const;

    const full = tx(DEMO_LIMITS.ledgerRows);
    await expect(writeAudit(full.db, helen, ctx, signIn)).resolves.toBeUndefined();
    expect(full.calls).toEqual(["lock"]);

    const bulk = tx(DEMO_LIMITS.ledgerRows);
    const change = { action: "BULK_ACTION_APPLIED", entityType: "TICKET", entityId: "t", ticketId: "t" } as const;
    await expect(writeAuditMany(bulk.db, helen, ctx, [change, change])).rejects.toThrow(DemoLimitError);
    expect(bulk.calls).toEqual(["lock"]);

    const room = tx(10);
    await writeAudit(room.db, helen, ctx, signIn);
    expect(room.calls).toEqual(["lock", "insert"]);
  });

  it("records a refusal once a minute per persona and visitor", async () => {
    const audit = await import("@/lib/audit");
    const { prisma } = await import("@/lib/db");
    const rows: string[] = [];
    vi.spyOn(prisma, "$executeRaw").mockResolvedValue(0 as never);
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ rows: BigInt(0), bytes: BigInt(0), database: BigInt(0) }] as never);
    vi.spyOn(prisma.auditLog, "create").mockImplementation((async () => void rows.push("AUTHZ_DENIED")) as never);
    const ctx = { ipAddress: visitorA, userAgent: "Mozilla/5.0", requestId: "r", isPrefetch: false };

    await audit.recordDenied(helen, ctx, "path:/admin/users");
    await audit.recordDenied(helen, ctx, "path:/admin/sla");
    await audit.recordDenied(helen, { ...ctx, ipAddress: visitorB }, "path:/admin/users");
    expect(rows).toHaveLength(2);
  });

  it("records a browser by its family alone in the demo", async () => {
    const { prepareUserAgent } = await import("@/lib/audit");
    const chrome =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    expect(prepareUserAgent(chrome)).toBe("Chrome");
    expect(prepareUserAgent(iphone)).toBe("Safari (mobile)");
    expect(prepareUserAgent("web-push:prune")).toBe("web-push:prune");
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "off");
    expect(prepareUserAgent(chrome)).toBe(chrome);
  });
});
