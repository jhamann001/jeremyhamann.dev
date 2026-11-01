/**
 * SLA SQL predicates.
 *
 * Pure part: predicate shapes (field references, thresholds, OR composition).
 * DB-gated part (shared convention 10, TEST_DATABASE_URL only — never the dev DB, the immutability
 * triggers make fixture rows permanent): seeds a fixture matrix of tickets and asserts that
 * `listTickets` with each `slaStatus` returns exactly the ids `computeSlaStatus` classifies that way.
 * Tolerates pre-existing rows: every assertion is restricted to the ids this run created.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SlaStatus, TicketListQuery, TicketStatus, Viewer } from "@/types/domain";
import {
  METRICS_EXCLUDED_STATUSES,
  OPEN_STATUSES,
  SLA_STATUSES,
  SLA_WARNING_THRESHOLD_MS,
  TICKET_STATUSES,
} from "@/types/domain";
import { computeSlaStatus } from "@/lib/sla";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  // The Prisma datasource reads DATABASE_URL: repoint it BEFORE the first import of @/lib/db.
  process.env.DATABASE_URL = TEST_URL;
}
const { prisma } = await import("@/lib/db");
const {
  breachedOpenWhere,
  loadSlaBands,
  loadWarningMinutes,
  slaBandFor,
  slaStatusWhere,
  warningMinutesFor,
  warningOpenWhere,
} = await import("@/server/sla-where");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Shape = Record<string, unknown>;
function asShape(v: unknown): Shape {
  expect(v).toBeTypeOf("object");
  return v as Shape;
}
function orOf(v: unknown): Shape[] {
  const arr = asShape(v).OR;
  expect(Array.isArray(arr)).toBe(true);
  return arr as Shape[];
}

// ---------------------------------------------------------------------------
// Pure: predicate shapes
// ---------------------------------------------------------------------------

describe("slaStatusWhere — predicate shapes", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  const W = new Date(now.getTime() + SLA_WARNING_THRESHOLD_MS);
  const F = prisma.ticket.fields;

  it("excludes VOIDED always, and emits one OR branch per distinct status (Decision #96)", () => {
    // No status filter is still not "show me everything": a ticket entered in error is nobody's
    // number, so the exclusion is a property of the module rather than of the filter.
    expect(slaStatusWhere([], now)).toEqual({ status: { notIn: [...METRICS_EXCLUDED_STATUSES] } });
    expect(asShape(slaStatusWhere(["BREACHED"], now)).status).toEqual({ notIn: [...METRICS_EXCLUDED_STATUSES] });
    expect(orOf(slaStatusWhere(["MET"], now))).toHaveLength(1);
    expect(orOf(slaStatusWhere(["MET", "MET"], now))).toHaveLength(1);
    expect(orOf(slaStatusWhere(["ON_TRACK", "WARNING", "BREACHED", "MET"], now))).toHaveLength(4);
  });

  it("W is exactly now + 30 minutes", () => {
    expect(W.getTime() - now.getTime()).toBe(30 * MINUTE);
  });

  it("ON_TRACK: unresolved, live clock due at or after W", () => {
    const [p] = orOf(slaStatusWhere(["ON_TRACK"], now));
    expect(p).toEqual({
      resolvedAt: null,
      OR: [
        { firstRespondedAt: null, firstResponseDueAt: { gte: W } },
        { firstRespondedAt: { not: null }, resolutionDueAt: { gte: W } },
      ],
    });
  });

  it("WARNING: unresolved, live clock due in [now, W)", () => {
    const [p] = orOf(slaStatusWhere(["WARNING"], now));
    expect(p).toEqual({
      resolvedAt: null,
      OR: [
        { firstRespondedAt: null, firstResponseDueAt: { gte: now, lt: W } },
        { firstRespondedAt: { not: null }, resolutionDueAt: { gte: now, lt: W } },
      ],
    });
  });

  it("BREACHED: live clocks past due, or resolved with a late resolution / late first response (field refs)", () => {
    const [p] = orOf(slaStatusWhere(["BREACHED"], now));
    const branches = orOf(p);
    expect(branches).toHaveLength(3);
    expect(branches[0]).toEqual({ resolvedAt: null, firstRespondedAt: null, firstResponseDueAt: { lt: now } });
    expect(branches[1]).toEqual({ resolvedAt: null, firstRespondedAt: { not: null }, resolutionDueAt: { lt: now } });
    expect(branches[2].resolvedAt).toEqual({ not: null });
    const resolved = orOf(branches[2]);
    expect(resolved).toHaveLength(3);
    expect(asShape(resolved[0].resolvedAt).gt).toEqual(F.resolutionDueAt);
    expect(resolved[1].firstRespondedAt).toBeNull();
    expect(asShape(resolved[1].resolvedAt).gt).toEqual(F.firstResponseDueAt);
    expect(asShape(resolved[2].firstRespondedAt).gt).toEqual(F.firstResponseDueAt);
  });

  it("MET: resolved on time with an on-time first response (or none, and the resolution before the FR due)", () => {
    const [p] = orOf(slaStatusWhere(["MET"], now));
    expect(asShape(p.resolvedAt)).toEqual({ not: null, lte: F.resolutionDueAt });
    const branches = orOf(p);
    expect(branches).toHaveLength(2);
    expect(branches[0].firstRespondedAt).toBeNull();
    expect(asShape(branches[0].resolvedAt).lte).toEqual(F.firstResponseDueAt);
    expect(asShape(branches[1].firstRespondedAt).lte).toEqual(F.firstResponseDueAt);
  });

  it("collapses to ONE un-partitioned live predicate when every priority shares a warning band", () => {
    // The shipped default (30 everywhere) must cost exactly what Wave A cost: no priority partition
    // in the query plan, and the same shape a reader already knows.
    const flat = { URGENT: 30, HIGH: 30, STANDARD: 30, LOW: 30 } as const;
    expect(orOf(slaStatusWhere(["WARNING"], now, flat))[0]).toEqual(orOf(slaStatusWhere(["WARNING"], now))[0]);
    expect(orOf(slaStatusWhere(["ON_TRACK"], now, flat))[0]).toEqual(orOf(slaStatusWhere(["ON_TRACK"], now))[0]);
  });

  it("partitions the live predicates by warning band when the policies differ (Decision #99)", () => {
    // URGENT warns two hours out, HIGH not at all, the other two at the default: three bands.
    const mixed = { URGENT: 120, HIGH: 0 } as const;
    const branches = orOf(orOf(slaStatusWhere(["WARNING"], now, mixed))[0]);
    expect(branches).toHaveLength(3);

    const urgent = branches.find((b) => b.priority === "URGENT");
    expect(urgent).toBeDefined();
    const urgentWindow = asShape(orOf(urgent as Shape)[0].firstResponseDueAt);
    expect(urgentWindow.gte).toEqual(now);
    expect((urgentWindow.lt as Date).getTime() - now.getTime()).toBe(120 * MINUTE);

    // warningMinutes = 0 is a real choice, not a missing value: [now, now) matches nothing, so HIGH
    // goes ON_TRACK straight to BREACHED.
    const high = branches.find((b) => b.priority === "HIGH");
    const highWindow = asShape(orOf(high as Shape)[0].firstResponseDueAt);
    expect(highWindow.lt).toEqual(now);

    // The two that were not named share the default band and travel together in one branch.
    const defaulted = branches.find((b) => typeof b.priority === "object" && b.priority !== null);
    expect(asShape((defaulted as Shape).priority).in).toEqual(["STANDARD", "LOW"]);
  });

  it("reads an absent, malformed or negative warning band as the 30-minute default", () => {
    expect(warningMinutesFor("URGENT", undefined)).toBe(30);
    expect(warningMinutesFor("URGENT", {})).toBe(30);
    expect(warningMinutesFor("URGENT", { URGENT: Number.NaN })).toBe(30);
    expect(warningMinutesFor("URGENT", { URGENT: -5 })).toBe(30);
    expect(warningMinutesFor("URGENT", { URGENT: 0 })).toBe(0);
    expect(warningMinutesFor("URGENT", { URGENT: 90.9 })).toBe(90);
  });

  it("counter predicates restrict to OPEN_STATUSES and reuse the same BREACHED / WARNING predicate", () => {
    const breached = asShape(breachedOpenWhere(now));
    const warning = asShape(warningOpenWhere(now));
    expect((breached.AND as Shape[])[0]).toEqual({ status: { in: [...OPEN_STATUSES] } });
    expect((warning.AND as Shape[])[0]).toEqual({ status: { in: [...OPEN_STATUSES] } });
    expect((breached.AND as Shape[])[1]).toEqual(orOf(slaStatusWhere(["BREACHED"], now))[0]);
    expect((warning.AND as Shape[])[1]).toEqual(orOf(slaStatusWhere(["WARNING"], now))[0]);
  });
});

// ---------------------------------------------------------------------------
// DB-gated: SQL classification ≡ computeSlaStatus over a fixture matrix
// ---------------------------------------------------------------------------

type Fixture = {
  label: string;
  status: TicketStatus;
  timers: {
    firstResponseDueAt: Date;
    resolutionDueAt: Date;
    firstRespondedAt: Date | null;
    resolvedAt: Date | null;
  };
};

/** Every §d branch plus the exact boundaries (30 min → ON_TRACK, 0 → WARNING, -1 ms → BREACHED, lte → MET). */
function fixtureMatrix(now: Date): Fixture[] {
  const t = (ms: number) => new Date(now.getTime() + ms);
  const open = (label: string, timers: Fixture["timers"]): Fixture => ({ label, status: "OPEN", timers });
  const done = (label: string, timers: Fixture["timers"]): Fixture => ({ label, status: "RESOLVED", timers });
  return [
    // FIRST_RESPONSE clock
    open("fr pending, due in 2h", { firstResponseDueAt: t(2 * HOUR), resolutionDueAt: t(8 * HOUR), firstRespondedAt: null, resolvedAt: null }),
    open("fr pending, due exactly at W", { firstResponseDueAt: t(30 * MINUTE), resolutionDueAt: t(8 * HOUR), firstRespondedAt: null, resolvedAt: null }),
    open("fr pending, due in 10m", { firstResponseDueAt: t(10 * MINUTE), resolutionDueAt: t(8 * HOUR), firstRespondedAt: null, resolvedAt: null }),
    open("fr pending, due exactly now", { firstResponseDueAt: t(0), resolutionDueAt: t(8 * HOUR), firstRespondedAt: null, resolvedAt: null }),
    open("fr pending, due 1ms ago", { firstResponseDueAt: t(-1), resolutionDueAt: t(8 * HOUR), firstRespondedAt: null, resolvedAt: null }),
    open("fr pending, due 3h ago", { firstResponseDueAt: t(-3 * HOUR), resolutionDueAt: t(8 * HOUR), firstRespondedAt: null, resolvedAt: null }),
    // RESOLUTION clock
    open("fr on time, res due in 2h", { firstResponseDueAt: t(-1 * HOUR), resolutionDueAt: t(2 * HOUR), firstRespondedAt: t(-90 * MINUTE), resolvedAt: null }),
    open("fr late, res due in 2h", { firstResponseDueAt: t(-2 * HOUR), resolutionDueAt: t(2 * HOUR), firstRespondedAt: t(-1 * HOUR), resolvedAt: null }),
    open("fr on time, res due in 5m", { firstResponseDueAt: t(-1 * HOUR), resolutionDueAt: t(5 * MINUTE), firstRespondedAt: t(-90 * MINUTE), resolvedAt: null }),
    open("fr on time, res due exactly at W", { firstResponseDueAt: t(-1 * HOUR), resolutionDueAt: t(30 * MINUTE), firstRespondedAt: t(-90 * MINUTE), resolvedAt: null }),
    open("fr on time, res due 1h ago", { firstResponseDueAt: t(-3 * HOUR), resolutionDueAt: t(-1 * HOUR), firstRespondedAt: t(-2 * HOUR), resolvedAt: null }),
    open("fr pending in past but responded, res due exactly now", { firstResponseDueAt: t(-3 * HOUR), resolutionDueAt: t(0), firstRespondedAt: t(-2 * HOUR), resolvedAt: null }),
    // COMPLETE
    done("resolved on time, fr on time", { firstResponseDueAt: t(-3 * HOUR), resolutionDueAt: t(-1 * HOUR), firstRespondedAt: t(-4 * HOUR), resolvedAt: t(-2 * HOUR) }),
    done("resolved exactly at due, fr exactly at due", { firstResponseDueAt: t(-3 * HOUR), resolutionDueAt: t(-1 * HOUR), firstRespondedAt: t(-3 * HOUR), resolvedAt: t(-1 * HOUR) }),
    done("resolved late, fr on time", { firstResponseDueAt: t(-3 * HOUR), resolutionDueAt: t(-2 * HOUR), firstRespondedAt: t(-4 * HOUR), resolvedAt: t(-1 * HOUR) }),
    done("resolved on time, fr late", { firstResponseDueAt: t(-4 * HOUR), resolutionDueAt: t(-1 * HOUR), firstRespondedAt: t(-3 * HOUR), resolvedAt: t(-2 * HOUR) }),
    done("resolved on time, no fr, before fr due", { firstResponseDueAt: t(-1 * HOUR), resolutionDueAt: t(1 * HOUR), firstRespondedAt: null, resolvedAt: t(-2 * HOUR) }),
    done("resolved on time, no fr, after fr due", { firstResponseDueAt: t(-3 * HOUR), resolutionDueAt: t(1 * HOUR), firstRespondedAt: null, resolvedAt: t(-2 * HOUR) }),
    done("resolved late, no fr", { firstResponseDueAt: t(-3 * HOUR), resolutionDueAt: t(-2 * HOUR), firstRespondedAt: null, resolvedAt: t(-1 * HOUR) }),
    done("resolved in the future relative to now (clock skew), on time", { firstResponseDueAt: t(2 * HOUR), resolutionDueAt: t(3 * HOUR), firstRespondedAt: null, resolvedAt: t(1 * HOUR) }),
  ];
}

describe.skipIf(!TEST_URL)("sla-where agreement matrix (TEST_DATABASE_URL)", () => {
  const RUN = randomUUID().slice(0, 8);
  const USER_ID = "sw_user_ops";
  /**
   * The requester address every fixture in THIS run carries, and the predicate every list query is
   * scoped by.
   *
   * The fixtures are permanent — the immutability triggers mean a DB-gated run can only ever add to
   * the OPERATIONS queue — so an unscoped `listTickets` walks every row every previous run left
   * behind, 200 at a time, ten times over. That is the whole of why this suite used to time out at
   * 5 s on a slow local Postgres while passing in isolation. Scoping by `requesterEmail` (an indexed
   * column, and a supported `TicketListQuery` filter) makes each query touch this run's twenty rows
   * and nothing else. It does not weaken the assertion: the comparison was always restricted to
   * these ids — `listAllIds` filtered them out client-side after paging — so the same rows are
   * compared against the same `computeSlaStatus` expectation, with the SLA predicate now ANDed
   * against one more term, which is how a real filtered list query is built anyway.
   */
  const FIXTURE_REQUESTER = `sw.${RUN}@example.test`;
  // Fixed once per run; passed to both the SQL predicates and the pure function.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const fixtures = fixtureMatrix(now);
  const ids = fixtures.map((_, i) => `sw_${RUN}_${String(i).padStart(2, "0")}`);
  const byId = new Map(ids.map((id, i) => [id, fixtures[i]] as const));

  const viewer: Viewer = {
    id: USER_ID,
    email: "sw.ops@wm-helpdesk.local",
    name: "SLA Where",
    image: null,
    groups: ["ops_team"],
    isDev: false,
  };

  /**
   * The band the SQL predicate will actually apply to these STANDARD-priority fixtures, read from the
   * policy table rather than assumed to be 30. `listTickets` now filters on the live bands (Decision
   * #99), so classifying the expectation with anything else would make this matrix assert agreement
   * with a policy nobody is running.
   */
  let standardBand: { warningMinutes: number; policyName: string | null } = { warningMinutes: 30, policyName: null };

  function expectedIds(status: SlaStatus): string[] {
    return ids
      .filter((id) => computeSlaStatus((byId.get(id) as Fixture).timers, now, standardBand).status === status)
      .sort();
  }

  async function listAllIds(slaStatus: SlaStatus[] | undefined): Promise<string[]> {
    const { listTickets } = await import("@/server/tickets");
    const found: string[] = [];
    // Small enough that twenty fixtures still take three pages — the paging behaviour stays
    // exercised, it just no longer walks every row every earlier run left in the queue.
    const pageSize = 7;
    const maxPages = Math.ceil(fixtures.length / pageSize) + 2;
    for (let page = 1; page <= maxPages; page++) {
      const query: TicketListQuery = {
        queueKey: "OPERATIONS",
        status: [...TICKET_STATUSES],
        requesterEmail: FIXTURE_REQUESTER,
        sort: "createdAt",
        dir: "asc",
        page,
        pageSize,
      };
      if (slaStatus) query.slaStatus = slaStatus;
      const result = await listTickets(viewer, query, now);
      found.push(...result.rows.map((r) => r.id));
      if (result.rows.length < pageSize) break;
    }
    // Still filtered by id: the scope predicate must not be the only thing keeping a foreign row out.
    return found.filter((id) => byId.has(id)).sort();
  }

  beforeAll(async () => {
    standardBand = slaBandFor("STANDARD", await loadSlaBands());
    const queue = await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "sla-where fixture", sortOrder: 1 },
    });
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { isActive: true, groups: ["ops_team"] },
      create: {
        id: USER_ID,
        email: viewer.email,
        name: viewer.name,
        groups: ["ops_team"],
        emailVerified: new Date(),
        isActive: true,
      },
    });
    const createdAt = new Date(now.getTime() - 6 * HOUR);
    await prisma.ticket.createMany({
      data: fixtures.map((f, i) => ({
        id: ids[i],
        subject: `sla-where ${RUN}: ${f.label}`,
        description: "sla-where agreement fixture (no PII)",
        requesterName: "Fixture Requester",
        requesterEmail: FIXTURE_REQUESTER,
        category: "OTHER",
        priority: "STANDARD",
        status: f.status,
        queueId: queue.id,
        createdById: USER_ID,
        slaFirstResponseMinutes: 240,
        slaResolutionMinutes: 1440,
        firstResponseDueAt: f.timers.firstResponseDueAt,
        resolutionDueAt: f.timers.resolutionDueAt,
        firstRespondedAt: f.timers.firstRespondedAt,
        resolvedAt: f.timers.resolvedAt,
        createdAt,
      })),
    });
  });

  it("the fixture matrix covers every SlaStatus", () => {
    for (const s of SLA_STATUSES) expect(expectedIds(s).length, s).toBeGreaterThan(0);
  });

  it("stored timers round-trip at millisecond precision", async () => {
    const rows = await prisma.ticket.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstResponseDueAt: true, resolutionDueAt: true, firstRespondedAt: true, resolvedAt: true },
    });
    expect(rows).toHaveLength(ids.length);
    for (const r of rows) {
      const f = byId.get(r.id) as Fixture;
      expect(r.firstResponseDueAt.getTime()).toBe(f.timers.firstResponseDueAt.getTime());
      expect(r.resolutionDueAt.getTime()).toBe(f.timers.resolutionDueAt.getTime());
      expect(r.firstRespondedAt?.getTime() ?? null).toBe(f.timers.firstRespondedAt?.getTime() ?? null);
      expect(r.resolvedAt?.getTime() ?? null).toBe(f.timers.resolvedAt?.getTime() ?? null);
    }
  });

  for (const status of SLA_STATUSES) {
    it(`listTickets slaStatus=[${status}] returns exactly the ids computeSlaStatus calls ${status}`, async () => {
      expect(await listAllIds([status])).toEqual(expectedIds(status));
    });
  }

  it("the four predicates partition the fixtures (union = all, no overlaps)", async () => {
    const all = await listAllIds([...SLA_STATUSES]);
    expect(all).toEqual([...ids].sort());
    const perStatus = await Promise.all(SLA_STATUSES.map((s) => listAllIds([s])));
    const total = perStatus.reduce((n, arr) => n + arr.length, 0);
    expect(total).toBe(ids.length);
    expect(await listAllIds(undefined)).toEqual([...ids].sort());
  });

  it("counter predicates agree with the pure function over OPEN_STATUSES", async () => {
    const openIds = ids.filter((id) => (OPEN_STATUSES as readonly TicketStatus[]).includes((byId.get(id) as Fixture).status));
    const expectedBreached = openIds.filter((id) => computeSlaStatus((byId.get(id) as Fixture).timers, now).status === "BREACHED");
    const expectedWarning = openIds.filter((id) => computeSlaStatus((byId.get(id) as Fixture).timers, now).status === "WARNING");
    const breached = await prisma.ticket.count({ where: { AND: [{ id: { in: ids } }, breachedOpenWhere(now)] } });
    const warning = await prisma.ticket.count({ where: { AND: [{ id: { in: ids } }, warningOpenWhere(now)] } });
    expect(breached).toBe(expectedBreached.length);
    expect(warning).toBe(expectedWarning.length);
    expect(expectedBreached.length).toBeGreaterThan(0);
    expect(expectedWarning.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DB-gated: the `slaStatus` FILTER and the rendered CHIP under a NON-DEFAULT band
// ---------------------------------------------------------------------------

/**
 * The regression this exists for: `buildListWhere` had no `warnings` parameter, so the `slaStatus`
 * filter always ran on the 30-minute default while `listTickets` rendered every chip on the live
 * `/admin/sla` band. Nothing caught it, because the pure tests above call `slaStatusWhere` with an
 * explicit map and never go through `buildListWhere`.
 *
 * So: move ONE priority off the default, then assert the two surfaces still describe the same set —
 * the ids the WARNING filter returns, and the ids whose own chip rendered WARNING. At least one
 * fixture is deliberately WARNING at the edited band and ON_TRACK at 30, so the assertion cannot pass
 * while the filter is still pinned to the default.
 *
 * The band is restored in `afterAll` (a direct write, as `sla-policies.integration.test.ts` does for
 * LOW — restoring a shared fixture is housekeeping, not a desk decision, and must not write
 * `SLA_POLICY_CHANGED` rows claiming somebody changed the policy back). HIGH is used because no other
 * suite classifies HIGH-priority tickets on the live band.
 */
describe.skipIf(!TEST_URL)("slaStatus filter ≡ rendered chip under a non-default band (TEST_DATABASE_URL)", () => {
  const RUN = randomUUID().slice(0, 8);
  const USER_ID = "sw_band_user_ops";
  const EDITED_PRIORITY = "HIGH" as const;
  const EDITED_MINUTES = 120;
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const t = (ms: number) => new Date(now.getTime() + ms);
  const FIXTURE_REQUESTER = `sw.band.${RUN}@example.test`;

  /**
   * `wideOnly` marks the two fixtures that are WARNING at 120 minutes and ON_TRACK at 30 — the pair
   * that separates "the filter reads the live band" from "the filter reads the default".
   */
  const fixtures: {
    id: string;
    label: string;
    wideOnly: boolean;
    timers: Fixture["timers"];
  }[] = [
    {
      id: `swb_${RUN}_0`,
      label: "fr pending, due in 200m — ON_TRACK at either band",
      wideOnly: false,
      timers: { firstResponseDueAt: t(200 * MINUTE), resolutionDueAt: t(8 * HOUR), firstRespondedAt: null, resolvedAt: null },
    },
    {
      id: `swb_${RUN}_1`,
      label: "fr pending, due in 90m — WARNING at 120, ON_TRACK at 30",
      wideOnly: true,
      timers: { firstResponseDueAt: t(90 * MINUTE), resolutionDueAt: t(8 * HOUR), firstRespondedAt: null, resolvedAt: null },
    },
    {
      id: `swb_${RUN}_2`,
      label: "fr pending, due in 10m — WARNING at either band",
      wideOnly: false,
      timers: { firstResponseDueAt: t(10 * MINUTE), resolutionDueAt: t(8 * HOUR), firstRespondedAt: null, resolvedAt: null },
    },
    {
      id: `swb_${RUN}_3`,
      label: "responded, resolution due in 100m — WARNING at 120, ON_TRACK at 30",
      wideOnly: true,
      timers: { firstResponseDueAt: t(-2 * HOUR), resolutionDueAt: t(100 * MINUTE), firstRespondedAt: t(-3 * HOUR), resolvedAt: null },
    },
    {
      id: `swb_${RUN}_4`,
      label: "fr pending, due 1h ago — BREACHED at either band",
      wideOnly: false,
      timers: { firstResponseDueAt: t(-1 * HOUR), resolutionDueAt: t(8 * HOUR), firstRespondedAt: null, resolvedAt: null },
    },
  ];
  const ids = fixtures.map((f) => f.id);

  const viewer: Viewer = {
    id: USER_ID,
    email: "sw.band.ops@wm-helpdesk.local",
    name: "SLA Band",
    image: null,
    groups: ["ops_team"],
    isDev: false,
  };

  let restoreMinutes: number | null = null;

  function queryFor(slaStatus?: SlaStatus[]): TicketListQuery {
    const query: TicketListQuery = {
      queueKey: "OPERATIONS",
      status: [...TICKET_STATUSES],
      requesterEmail: FIXTURE_REQUESTER,
      sort: "createdAt",
      dir: "asc",
      page: 1,
      pageSize: 200,
    };
    if (slaStatus) query.slaStatus = slaStatus;
    return query;
  }

  /** Ids the SQL FILTER returned (this run's rows only). */
  async function filtered(status: SlaStatus): Promise<string[]> {
    const { listTickets } = await import("@/server/tickets");
    const page = await listTickets(viewer, queryFor([status]), now);
    return page.rows.map((r) => r.id).filter((id) => ids.includes(id)).sort();
  }

  /** Ids whose RENDERED chip reads `status`, from the same list with no SLA filter applied. */
  async function charted(status: SlaStatus): Promise<string[]> {
    const { listTickets } = await import("@/server/tickets");
    const page = await listTickets(viewer, queryFor(), now);
    return page.rows
      .filter((r) => ids.includes(r.id) && r.sla.status === status)
      .map((r) => r.id)
      .sort();
  }

  beforeAll(async () => {
    const queue = await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "sla-where fixture", sortOrder: 1 },
    });
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { isActive: true, groups: ["ops_team"] },
      create: {
        id: USER_ID,
        email: viewer.email,
        name: viewer.name,
        groups: ["ops_team"],
        emailVerified: new Date(),
        isActive: true,
      },
    });

    const before = await prisma.sLA.findUnique({
      where: { priority: EDITED_PRIORITY },
      select: { warningMinutes: true },
    });
    restoreMinutes = before?.warningMinutes ?? null;
    await prisma.sLA.upsert({
      where: { priority: EDITED_PRIORITY },
      update: { warningMinutes: EDITED_MINUTES },
      create: {
        priority: EDITED_PRIORITY,
        name: "High",
        firstResponseMinutes: 120,
        resolutionMinutes: 480,
        warningMinutes: EDITED_MINUTES,
      },
    });

    await prisma.ticket.createMany({
      data: fixtures.map((f) => ({
        id: f.id,
        subject: `sla-where band ${RUN}: ${f.label}`,
        description: "sla-where band fixture (no PII)",
        requesterName: "Fixture Requester",
        requesterEmail: FIXTURE_REQUESTER,
        category: "OTHER",
        priority: EDITED_PRIORITY,
        status: "OPEN",
        queueId: queue.id,
        createdById: USER_ID,
        slaFirstResponseMinutes: 120,
        slaResolutionMinutes: 480,
        firstResponseDueAt: f.timers.firstResponseDueAt,
        resolutionDueAt: f.timers.resolutionDueAt,
        firstRespondedAt: f.timers.firstRespondedAt,
        resolvedAt: f.timers.resolvedAt,
        createdAt: new Date(now.getTime() - 6 * HOUR),
      })),
    });
  });

  afterAll(async () => {
    // Tickets stay (the test DB is permanent by design); the SHARED policy row does not.
    if (restoreMinutes !== null) {
      await prisma.sLA.update({ where: { priority: EDITED_PRIORITY }, data: { warningMinutes: restoreMinutes } });
    } else {
      await prisma.sLA.delete({ where: { priority: EDITED_PRIORITY } });
    }
  });

  it("the edited band is what the policy table now reads", async () => {
    expect(warningMinutesFor(EDITED_PRIORITY, await loadWarningMinutes())).toBe(EDITED_MINUTES);
    expect(EDITED_MINUTES).not.toBe(SLA_WARNING_THRESHOLD_MS / MINUTE);
  });

  it("the WARNING filter returns exactly the tickets whose chip renders WARNING", async () => {
    const chips = await charted("WARNING");
    expect(chips).toEqual(await filtered("WARNING"));
    // Not vacuous, and specifically not the 30-minute answer: the two wide-only fixtures are in.
    expect(chips).toEqual(ids.filter((_, i) => fixtures[i].wideOnly || i === 2).sort());
    for (const f of fixtures.filter((x) => x.wideOnly)) expect(chips).toContain(f.id);
  });

  it("the ON_TRACK filter agrees too — the band moves a ticket out of one set and into the other", async () => {
    const chips = await charted("ON_TRACK");
    expect(chips).toEqual(await filtered("ON_TRACK"));
    // At the 30-minute default these two would be HERE instead; at 120 they are amber.
    for (const f of fixtures.filter((x) => x.wideOnly)) expect(chips).not.toContain(f.id);
  });

  it("BREACHED is unaffected by the band, and the four sets still partition the fixtures", async () => {
    expect(await filtered("BREACHED")).toEqual([`swb_${RUN}_4`]);
    const perStatus = await Promise.all(SLA_STATUSES.map((s) => filtered(s)));
    expect(perStatus.flat().sort()).toEqual([...ids].sort());
  });
});
