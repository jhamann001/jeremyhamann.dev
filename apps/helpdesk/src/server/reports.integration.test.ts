/**
 * DB-gated (shared convention 10; `TEST_DATABASE_URL` only — never the dev database, because the
 * immutability triggers make fixture rows permanent). Proves the things about B7 that only a database
 * can prove:
 *
 *  1. Every report is bounded by the viewer's READABLE queues — a client_services viewer's numbers
 *     never contain an ADVICE ticket, and an ops_team viewer's do.
 *  2. Every report excludes VOIDED (`METRICS_EXCLUDED_STATUSES`). The fixture void is breached on its
 *     raw timers and flagged as a complaint, so a surface that forgot the filter would show it in the
 *     backlog, the breach counter AND the complaint counter at once.
 *  3. Buckets are FIRM-LOCAL days. A ticket created at 20:00 ET is 00:00 UTC the next day, and it has to
 *     land in the day the desk worked it.
 *  4. The percentiles are Postgres's, over the whole range — not an average of daily medians — and the
 *     callback credit lands automatically because `firstRespondedAt` is the column.
 *  5. `/api/reports/export` writes `REPORT_EXPORTED` with the row count before the first byte, and
 *     refuses a viewer without `reports:read` with a recorded denial and no export row.
 *
 * **Isolation.** The shared test database is permanent and other slices run against it concurrently, so
 * every fixture lives in a four-day window derived from this run's id — tens of thousands of distinct
 * windows, none of them near the dates any other suite uses ("2026-09-19" and `now()`). Every assertion
 * is then scoped to that window, to this run's user ids, or to a relation that holds regardless of what
 * else the database contains (`current >= inRange`).
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OktaGroup, RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const REQUESTER_EMAIL = `reports.${RUN}@example.com`;
const OPS_USER_ID = `it_rp_ops_${RUN}`;
const CS_USER_ID = `it_rp_cs_${RUN}`;
const NOBODY_USER_ID = `it_rp_none_${RUN}`;
const AGENT_A = `it_rp_agent_a_${RUN}`;
const AGENT_B = `it_rp_agent_b_${RUN}`;

const hoisted = vi.hoisted(() => ({ viewer: null as unknown as Viewer, ctx: null as unknown as RequestContext }));

function viewerOf(id: string, groups: OktaGroup[]): Viewer {
  return { id, email: `${id}@wm-helpdesk.local`, name: `Reports ${groups[0] ?? "none"}`, image: null, groups, isDev: false };
}

hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
hoisted.ctx = {
  ipAddress: "203.0.113.77",
  userAgent: `it-reports/${RUN}`,
  requestId: `it-reports-${RUN}`,
  isPrefetch: false,
};

vi.mock("@/lib/session", () => ({
  requireViewerOrThrow: vi.fn(async () => hoisted.viewer),
  getViewer: vi.fn(async () => hoisted.viewer),
  requireUser: vi.fn(async () => hoisted.viewer),
  requireGroup: vi.fn(async () => hoisted.viewer),
}));
vi.mock("@/lib/request-context", () => ({
  getRequestContext: vi.fn(async () => hoisted.ctx),
  getRequestContextFromRequest: vi.fn(() => hoisted.ctx),
}));

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const reportsModule = TEST_URL ? await import("@/server/reports") : null;
const queryModule = await import("@/server/reports-query");
const routeModule = TEST_URL ? await import("@/app/api/reports/export/route") : null;

const { addCivilDays, civilToString, firmDayStart } = queryModule;

function mods() {
  if (!dbModule || !reportsModule || !routeModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { prisma: dbModule.prisma, reports: reportsModule, GET: routeModule.GET };
}

/**
 * A four-day window nobody else is using. 1970-06-01 + an offset in days keeps every fixture between
 * 1970 and 2003: far from every other suite's dates, inside the era both Node's ICU and Postgres's
 * tzdata describe identically, and recognisable as a fixture at a glance.
 *
 * The offset is SEEDED from this run's id and then PROBED against the database rather than used as
 * it falls. Every report under test is bounded by a queue and a date range and by nothing else — it
 * cannot be scoped to "the rows this run created" the way the other DB-gated suites are — so
 * isolation here means owning the days outright. The test database is permanent, so every previous
 * run of this file still occupies its span: 139 of them when this was written, over the 12,000
 * offsets the era allows. A run spans D0 through C_DAY (D0 + 20), so two runs collide whenever their
 * offsets land within 21 days of each other — about 43 conflicting offsets each, not one. That is a
 * birthday problem with roughly five expected collisions at 139 runs, and it duly produced one: run
 * `9841e9ca` (D0 1983-01-30) overlapped run `ee9b27dc` (D0 1983-02-02), whose `reopen`, `met` and
 * `late` fixtures landed in `9841e9ca`'s D3 bucket and added three to every created count. All ten
 * assertions failed in a full run while the file passed alone. Seeding without probing makes that
 * recur, and more often as the database fills.
 */
const ERA_START = { y: 1970, m: 6, d: 1 } as const;
const ERA_DAYS = 12_000;
const UTC_DAY = 86_400_000;
/** Days on either side of D0 a single run touches: the D0-20:00 fixture is D0+1 in UTC, C_DAY is D0+20. */
const SPAN_BEFORE = 1;
const SPAN_AFTER = 22;
const SEED = Number.parseInt(createHash("sha256").update(RUN).digest("hex").slice(0, 8), 16) % ERA_DAYS;

/** The UTC day-number the firm-local day at `offset` begins on. */
function utcDayOf(offset: number): number {
  return Math.floor(firmDayStart(addCivilDays(ERA_START, offset)).getTime() / UTC_DAY);
}

/**
 * The first offset at or after the seed whose whole span is untouched, wrapping so that a near miss
 * costs a day rather than the run. One read of the era — a few hundred rows against an indexed
 * column — in exchange for an isolation guarantee instead of an isolation probability.
 */
async function freeOffset(): Promise<number> {
  if (!dbModule) return SEED;
  const rows = await dbModule.prisma.$queryRaw<Array<{ day: Date }>>`
    SELECT DISTINCT date_trunc('day', "createdAt") AS day
      FROM "Ticket"
     WHERE "createdAt" >= '1969-01-01'::timestamp
       AND "createdAt" < '2010-01-01'::timestamp`;
  const occupied = new Set(rows.map((r) => Math.floor(r.day.getTime() / UTC_DAY)));
  for (let i = 0; i < ERA_DAYS; i += 1) {
    const offset = (SEED + i) % ERA_DAYS;
    const d0 = utcDayOf(offset);
    let clear = true;
    for (let d = d0 - SPAN_BEFORE; d <= d0 + SPAN_AFTER && clear; d += 1) clear = !occupied.has(d);
    if (clear) return offset;
  }
  throw new Error(
    `reports.integration.test: no free ${SPAN_BEFORE + SPAN_AFTER + 1}-day span left in the fixture era ` +
      `(${occupied.size} of ${ERA_DAYS} days occupied). Recreate wm_helpdesk_test, or widen the era.`,
  );
}

const OFFSET = await freeOffset();
const D0 = addCivilDays(ERA_START, OFFSET);
const D1 = addCivilDays(D0, 1);
const D2 = addCivilDays(D0, 2);
const D3 = addCivilDays(D0, 3);
const WINDOW = { from: civilToString(D0), to: civilToString(D3) };

const MIN = 60_000;
const HOUR = 60 * MIN;

/** An instant `hours` into the firm-local day `d`. DST inside the window shifts the wall clock, never the day. */
function at(d: { y: number; m: number; d: number }, hours: number, minutes = 0): Date {
  return new Date(firmDayStart(d).getTime() + hours * HOUR + minutes * MIN);
}

const T = {
  met: `it_rp_met_${RUN}`,
  late: `it_rp_late_${RUN}`,
  open: `it_rp_open_${RUN}`,
  void: `it_rp_void_${RUN}`,
  advice: `it_rp_advice_${RUN}`,
  reopened: `it_rp_reopen_${RUN}`,
  complaint: `it_rp_complaint_${RUN}`,
  edgeBefore: `it_rp_edge_before_${RUN}`,
  edgeOpen: `it_rp_edge_open_${RUN}`,
  edgeClose: `it_rp_edge_close_${RUN}`,
  edgeAfter: `it_rp_edge_after_${RUN}`,
};

/**
 * A SECOND window — ONE firm-local day, ten days clear of the first — for the range-edge regressions.
 *
 * The four-day window above cannot catch a mis-typed range bound: every fixture in it sits between
 * 08:00 and 20:00 firm-local, so a bound that is silently read four or five hours early still lands on
 * the same side of every one of them. A bound bound as `timestamptz` against a `timestamp` column is
 * only visible from WITHIN that shift of an edge, which is where these four fixtures sit — two half an
 * hour inside the day and two half an hour outside it, on either end.
 *
 * `from === to` as well, because a one-day range is the shortest range there is: with a four-hour
 * shift it retains a sixth of the day it names and gains five sixths of the day before, which is how
 * the same CSV row came to report a headline total that its own daily rows did not sum to.
 */
const E_DAY = addCivilDays(D0, 10);
const EDGE_WINDOW = { from: civilToString(E_DAY), to: civilToString(E_DAY) };

/** The instants the edge window opens and closes. Every edge fixture is defined relative to these. */
const E_OPENS_AT = firmDayStart(E_DAY);
const E_CLOSES_AT = firmDayStart(addCivilDays(E_DAY, 1));

/**
 * Offsets from a boundary, not wall-clock hours: `at(d, 23, 30)` is 00:30 the NEXT day on a
 * spring-forward Sunday, and an edge fixture that wanders across the boundary it is meant to sit
 * beside would assert nothing. Arithmetic on the boundary instant itself is DST-proof.
 */
function before(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() - minutes * MIN);
}
function after(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MIN);
}

/**
 * A THIRD window — one firm-local day, twenty days clear of the first — for the concurrency
 * regression, which creates its own tickets while a report is running and must therefore move no
 * count any other assertion in this file pins.
 */
const C_DAY = addCivilDays(D0, 20);
const CONC_WINDOW = { from: civilToString(C_DAY), to: civilToString(C_DAY) };
/** How many tickets the writer inserts underneath the reader. Enough to interleave, few enough to be quick. */
const CONC_TICKETS = 12;

function query(key: string, extra?: Record<string, string | string[]>) {
  return queryModule.parseReportQuery({ report: key, ...WINDOW, granularity: "day", ...extra });
}

function edgeQuery(key: string) {
  return queryModule.parseReportQuery({ report: key, ...EDGE_WINDOW, granularity: "day" });
}

function concQuery(key: string) {
  return queryModule.parseReportQuery({ report: key, ...CONC_WINDOW, granularity: "day" });
}

describe.skipIf(!TEST_URL)("reports (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();

    // `createMany({ skipDuplicates: true })` — an atomic `ON CONFLICT DO NOTHING` — rather than three
    // `upsert`s. Prisma's upsert is update-then-insert, which is NOT atomic against a concurrent
    // inserter: thirty-six DB-gated suites share these three queue keys on one permanent test
    // database, and when two of them reach this line at the same instant one loses the insert race
    // with P2002 and every test in that file fails in `beforeAll`. Observed once in a full run.
    // Nothing here needs to UPDATE an existing queue, so "create it if it is missing" is both the
    // honest statement and the race-free one.
    await prisma.queue.createMany({
      data: [
        { key: "OPERATIONS", name: "Operations", description: "integration fixture", sortOrder: 1 },
        { key: "CLIENT_SERVICE", name: "Client Service", description: "integration fixture", sortOrder: 2 },
        { key: "ADVICE", name: "Advice", description: "integration fixture", sortOrder: 3 },
      ],
      skipDuplicates: true,
    });
    const ops = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    const advice = await prisma.queue.findUniqueOrThrow({ where: { key: "ADVICE" } });

    for (const [id, groups] of [
      [OPS_USER_ID, ["ops_team"]],
      [CS_USER_ID, ["client_services"]],
      [NOBODY_USER_ID, []],
      [AGENT_A, ["ops_team"]],
      [AGENT_B, ["ops_team"]],
    ] as const) {
      await prisma.user.upsert({
        where: { id },
        update: { groups: [...groups], isActive: true },
        create: {
          id,
          email: `${id}@wm-helpdesk.local`,
          name: `Reports ${id}`,
          groups: [...groups],
          emailVerified: new Date(),
          isActive: true,
        },
      });
    }

    type Fixture = {
      id: string;
      queueId: string;
      createdAt: Date;
      category: "WIRE_TRANSFER" | "ACAT" | "PORTAL_RESET" | "COMPLAINT" | "COST_BASIS";
      priority: "URGENT" | "HIGH" | "STANDARD";
      status: "OPEN" | "RESOLVED" | "VOIDED";
      resolution?: "ANSWERED" | "COMPLETED";
      firstResponseMinutes: number;
      resolutionMinutes: number;
      firstRespondedAt?: Date;
      resolvedAt?: Date;
      assigneeId?: string;
      isComplaint?: boolean;
      voidedAt?: Date;
    };

    const fixtures: Fixture[] = [
      // Met both clocks: created 09:00 on D0, answered in 30 minutes, resolved in two hours.
      {
        id: T.met,
        queueId: ops.id,
        createdAt: at(D0, 9),
        category: "WIRE_TRANSFER",
        priority: "URGENT",
        status: "RESOLVED",
        resolution: "ANSWERED",
        firstResponseMinutes: 60,
        resolutionMinutes: 240,
        firstRespondedAt: at(D0, 9, 30),
        resolvedAt: at(D0, 11),
        assigneeId: AGENT_A,
      },
      // 20:00 ET on D0 — 00:00 UTC on D1. It belongs to D0. Late on both clocks.
      {
        id: T.late,
        queueId: ops.id,
        createdAt: at(D0, 20),
        category: "ACAT",
        priority: "HIGH",
        status: "RESOLVED",
        resolution: "COMPLETED",
        firstResponseMinutes: 60,
        resolutionMinutes: 300,
        firstRespondedAt: at(D0, 21, 30),
        resolvedAt: at(D1, 10),
        assigneeId: AGENT_A,
      },
      // Still open, never answered: backlog, breach, and an unanswered first response.
      {
        id: T.open,
        queueId: ops.id,
        createdAt: at(D1, 9),
        category: "PORTAL_RESET",
        priority: "STANDARD",
        status: "OPEN",
        firstResponseMinutes: 60,
        resolutionMinutes: 480,
        assigneeId: AGENT_B,
      },
      // Entered in error: breached on its raw timers AND flagged as a complaint, so every report that
      // forgot `METRICS_EXCLUDED_STATUSES` would show it somewhere.
      {
        id: T.void,
        queueId: ops.id,
        createdAt: at(D1, 10),
        category: "WIRE_TRANSFER",
        priority: "URGENT",
        status: "VOIDED",
        firstResponseMinutes: 30,
        resolutionMinutes: 60,
        isComplaint: true,
        voidedAt: at(D1, 12),
      },
      // ADVICE: invisible to client_services, counted for ops_team.
      {
        id: T.advice,
        queueId: advice.id,
        createdAt: at(D1, 9),
        category: "COST_BASIS",
        priority: "STANDARD",
        status: "OPEN",
        firstResponseMinutes: 60,
        resolutionMinutes: 480,
      },
      // Resolved on D1 and reopened on D2: `resolvedAt` is cleared, exactly as changeTicketStatus does.
      {
        id: T.reopened,
        queueId: ops.id,
        createdAt: at(D0, 8),
        category: "COST_BASIS",
        priority: "STANDARD",
        status: "OPEN",
        firstResponseMinutes: 60,
        resolutionMinutes: 240,
        firstRespondedAt: at(D0, 8, 20),
        assigneeId: AGENT_B,
      },
      {
        id: T.complaint,
        queueId: ops.id,
        createdAt: at(D2, 9),
        category: "COMPLAINT",
        priority: "HIGH",
        status: "OPEN",
        firstResponseMinutes: 60,
        resolutionMinutes: 480,
        isComplaint: true,
      },
      // The four range-edge fixtures, in the SEPARATE one-day window (see E_DAY). Deliberately
      // unassigned and never complaints, so they move no assertion in the four-day window above: the
      // only per-agent counters that are not range-bounded are asserted by agent id, and the
      // `unassigned` row is asserted as a relation. They are also created AFTER D3, so the cumulative
      // backlog report's edges — which all fall inside the first window — never reach them.
      { id: T.edgeBefore, queueId: ops.id, createdAt: before(E_OPENS_AT, 30), category: "PORTAL_RESET", priority: "STANDARD", status: "OPEN", firstResponseMinutes: 60, resolutionMinutes: 480 },
      { id: T.edgeOpen, queueId: ops.id, createdAt: after(E_OPENS_AT, 30), category: "PORTAL_RESET", priority: "STANDARD", status: "OPEN", firstResponseMinutes: 60, resolutionMinutes: 480 },
      { id: T.edgeClose, queueId: ops.id, createdAt: before(E_CLOSES_AT, 30), category: "PORTAL_RESET", priority: "STANDARD", status: "OPEN", firstResponseMinutes: 60, resolutionMinutes: 480 },
      { id: T.edgeAfter, queueId: ops.id, createdAt: after(E_CLOSES_AT, 30), category: "PORTAL_RESET", priority: "STANDARD", status: "OPEN", firstResponseMinutes: 60, resolutionMinutes: 480 },
    ];

    for (const f of fixtures) {
      await prisma.ticket.upsert({
        where: { id: f.id },
        update: {},
        create: {
          id: f.id,
          subject: `Reports fixture ${f.id}`,
          description: "integration fixture",
          requesterName: "Margaret Thompson",
          requesterEmail: REQUESTER_EMAIL,
          category: f.category,
          priority: f.priority,
          status: f.status,
          resolution: f.resolution ?? "NONE",
          isComplaint: f.isComplaint ?? false,
          complaintFiledAt: f.isComplaint === true ? f.createdAt : null,
          queue: { connect: { id: f.queueId } },
          createdBy: { connect: { id: OPS_USER_ID } },
          ...(f.assigneeId === undefined ? {} : { assignee: { connect: { id: f.assigneeId } } }),
          slaFirstResponseMinutes: f.firstResponseMinutes,
          slaResolutionMinutes: f.resolutionMinutes,
          firstResponseDueAt: new Date(f.createdAt.getTime() + f.firstResponseMinutes * MIN),
          resolutionDueAt: new Date(f.createdAt.getTime() + f.resolutionMinutes * MIN),
          firstRespondedAt: f.firstRespondedAt ?? null,
          resolvedAt: f.resolvedAt ?? null,
          createdAt: f.createdAt,
          ...(f.voidedAt === undefined
            ? {}
            : {
                voidedAt: f.voidedAt,
                voidReason: "entered in error by the desk",
                voidedBy: { connect: { id: OPS_USER_ID } },
              }),
        },
      });
    }

    // The reopen edge, as the ledger records it. AuditLog is append-only, so this is find-or-create.
    const reopenAuditId = `it_rp_audit_${RUN}`;
    if ((await prisma.auditLog.findUnique({ where: { id: reopenAuditId } })) === null) {
      await prisma.auditLog.create({
        data: {
          id: reopenAuditId,
          occurredAt: at(D2, 9),
          actorId: AGENT_B,
          actorEmail: `${AGENT_B}@wm-helpdesk.local`,
          actorGroups: ["ops_team"],
          action: "TICKET_STATUS_CHANGED",
          entityType: "TICKET",
          entityId: T.reopened,
          ticketId: T.reopened,
          fieldChanged: "status",
          oldValue: "RESOLVED",
          newValue: "OPEN",
          ipAddress: "203.0.113.77",
          requestId: `it-reports-seed-${RUN}`,
        },
      });
    }
  });

  afterAll(async () => {
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  const ops = (): Viewer => viewerOf(OPS_USER_ID, ["ops_team"]);
  const cs = (): Viewer => viewerOf(CS_USER_ID, ["client_services"]);

  it("volume buckets on the FIRM clock and excludes the voided ticket", async () => {
    const { reports } = mods();
    const result = await reports.runExtendedReport(cs(), query("volume"), hoisted.ctx);

    expect(result.rows.map((r) => r.bucket)).toEqual([WINDOW.from, civilToString(D1), civilToString(D2), WINDOW.to]);
    // Five OPERATIONS tickets created in the window; the VOIDED one is not one of them.
    expect(result.totals.created).toBe(5);
    // D0 carries the 08:00, the 09:00 AND the 20:00 ticket — the last of which is 00:00 UTC on D1.
    expect(result.rows[0].values.created).toBe(3);
    expect(result.rows[1].values.created).toBe(1); // D1: the open one; the void is excluded
    expect(result.rows[2].values.created).toBe(1); // D2: the complaint
    expect(result.rows[3].values.created).toBe(0);
    expect(result.totals.resolved).toBe(2);
    expect(result.totals.net).toBe(3);
    expect(result.totals["created.OPERATIONS"]).toBe(5);
  });

  /**
   * The regression for the range bounds. `Ticket.createdAt` is `timestamp WITHOUT time zone` holding
   * UTC; a JS `Date` interpolated into a tagged `$queryRaw` is bound as `timestamptz`, and Postgres
   * resolves that comparison by promoting the COLUMN through the session `TimeZone`. On a session set
   * to America/New_York the whole range therefore slid four or five hours earlier — invisibly, and
   * only on a cluster configured that way, which is why a UTC CI box would have shipped it.
   *
   * Half an hour is inside that shift on either side of both edges, so each of the four fixtures is on
   * the wrong side of its boundary under the defect and on the right side under the fix.
   */
  it("reads a range edge on the firm clock, not on the Postgres session clock", async () => {
    const { reports } = mods();
    const result = await reports.runExtendedReport(cs(), edgeQuery("volume"), hoisted.ctx);

    // Exactly the two fixtures half an hour INSIDE the day; neither of the two half an hour outside it.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].bucket).toBe(EDGE_WINDOW.from);
    expect(result.rows[0].values.created).toBe(2);
    expect(result.totals.created).toBe(2);

    // The per-queue split is built by a TYPED `groupBy` over the same two bounds — the half of the
    // module that was always right. The raw half and the typed half of one rendered row must agree.
    expect(result.totals["created.OPERATIONS"]).toBe(result.totals.created);

    // And the two outside it land in the adjacent days rather than nowhere: "2" above is the boundary
    // falling where it should, not two arbitrary tickets.
    const neighbour = async (day: { y: number; m: number; d: number }) =>
      reports.runExtendedReport(
        cs(),
        queryModule.parseReportQuery({ report: "volume", from: civilToString(day), to: civilToString(day), granularity: "day" }),
        hoisted.ctx,
      );
    expect((await neighbour(addCivilDays(E_DAY, -1))).totals.created).toBe(1);
    expect((await neighbour(addCivilDays(E_DAY, 1))).totals.created).toBe(1);
  });

  /**
   * The same defect stated the way an operator meets it, and the reason this guard is separate from the
   * two above: "how many came in on the 19th" must not depend on what ELSE the range asks for. Under the
   * `timestamptz` bound a one-day range retained a sixth of the day it named, so the day answered 0
   * alone and 2 inside a three-day range — the same question, two answers, and no way to tell from the
   * screen which was the lie.
   *
   * A day bucket that lies wholly inside both ranges is grouped over exactly the same rows either way,
   * so the whole `values` record must match — counts, percentiles and percentages alike. `E_DAY` sits a
   * clear day inside `wide` on both sides, and the two fixtures half an hour OUTSIDE it are what make
   * the comparison sharp: they are in the wider range's population and must stay out of this bucket.
   * Every time-series report is covered, because all six bucket through the same two bounds.
   */
  it("answers a one-day range exactly as it answers that day inside a wider range", async () => {
    const { reports } = mods();
    const wide = { from: civilToString(addCivilDays(E_DAY, -1)), to: civilToString(addCivilDays(E_DAY, 1)) };

    let compared = 0;
    for (const key of queryModule.EXTENDED_REPORT_KEYS) {
      if (!queryModule.isTimeSeriesReport(key)) continue;
      const alone = await reports.runExtendedReport(cs(), edgeQuery(key), hoisted.ctx);
      const within = await reports.runExtendedReport(
        cs(),
        queryModule.parseReportQuery({ report: key, ...wide, granularity: "day" }),
        hoisted.ctx,
      );

      const aloneRow = alone.rows.find((r) => r.bucket === EDGE_WINDOW.from);
      const withinRow = within.rows.find((r) => r.bucket === EDGE_WINDOW.from);
      expect(aloneRow, `${key}: the one-day range produced no row for the day it names`).toBeDefined();
      expect(withinRow, `${key}: ${EDGE_WINDOW.from} is missing from ${wide.from}..${wide.to}`).toBeDefined();
      expect(
        withinRow?.values,
        `${key}: ${EDGE_WINDOW.from} alone vs inside ${wide.from}..${wide.to}`,
      ).toEqual(aloneRow?.values);
      compared += 1;
    }
    expect(compared, "no time-series report was compared").toBe(6);

    // Volume spelled out, because it is the report the operator asks this of: the day's own two
    // tickets, the headline total that must equal them, and the per-queue split that must too.
    const volume = await reports.runExtendedReport(cs(), edgeQuery("volume"), hoisted.ctx);
    expect(volume.rows[0].values.created).toBe(2);
    expect(volume.totals.created).toBe(2);
    expect(volume.totals["created.OPERATIONS"]).toBe(2);
  });

  /**
   * The other face of the same defect, and the one an auditor meets: a shifted range admits rows whose
   * firm-local `date_trunc` bucket is OUTSIDE the range, so they reach the headline total through the
   * map but never appear as a row. The total and the rows under it then disagree inside one CSV.
   */
  it("reconciles the headline total with its own rows and its own per-queue columns", async () => {
    const { reports } = mods();

    for (const q of [edgeQuery("volume"), query("volume")]) {
      const result = await reports.runExtendedReport(cs(), q, hoisted.ctx);
      const fromRows = result.rows.reduce((a, r) => a + r.values.created, 0);
      const fromQueues = Object.entries(result.totals)
        .filter(([k]) => k.startsWith("created."))
        .reduce((a, [, n]) => a + n, 0);

      expect(fromRows).toBe(result.totals.created);
      expect(fromQueues).toBe(result.totals.created);
    }
  });

  /**
   * The THIRD face of the same defect, and the one that survived the two tests above: the report was
   * built from three separate statements issued through `Promise.all` — a bucketed raw count, a
   * bucketed raw count of resolutions, and a Prisma `groupBy` for the per-queue split. Three
   * statements are three READ COMMITTED snapshots, so a ticket inserted while the report ran was seen
   * by whichever of them had not started yet and not by the others. On a quiescent database that is
   * invisible; on a desk with anything else writing, one CSV reported a headline `created` that its
   * own daily rows and its own `created.<queue>` columns did not sum to (38 against 37 and 37).
   *
   * Reading under a live writer is the only way to assert the property that fixes it — the whole
   * report comes from ONE statement, so every rendering of it describes one population.
   *
   * This test cannot FAIL spuriously: the invariant it asserts is internal to a single result, so a
   * run where the writer happened not to interleave simply proves less. It never fails a correct
   * implementation.
   */
  it("keeps the headline, the rows and the per-queue split consistent under a concurrent writer", async () => {
    const { prisma, reports } = mods();
    const opsQueue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });

    let writing = true;
    const writer = (async () => {
      try {
        for (let i = 0; i < CONC_TICKETS; i += 1) {
          const id = `it_rp_conc_${RUN}_${i}`;
          if ((await prisma.ticket.findUnique({ where: { id }, select: { id: true } })) !== null) continue;
          await prisma.ticket.create({
            data: {
              id,
              subject: `Reports concurrency fixture ${i}`,
              description: "integration fixture",
              requesterName: "Margaret Thompson",
              requesterEmail: REQUESTER_EMAIL,
              category: "PORTAL_RESET",
              priority: "STANDARD",
              status: "OPEN",
              queue: { connect: { id: opsQueue.id } },
              createdBy: { connect: { id: OPS_USER_ID } },
              slaFirstResponseMinutes: 60,
              slaResolutionMinutes: 480,
              firstResponseDueAt: new Date(at(C_DAY, 9).getTime() + 60 * MIN),
              resolutionDueAt: new Date(at(C_DAY, 9).getTime() + 480 * MIN),
              createdAt: at(C_DAY, 9, i),
            },
          });
        }
      } finally {
        writing = false;
      }
    })();

    const readings: Array<{ created: number; fromRows: number; fromQueues: number }> = [];
    for (let guard = 0; guard < 200 && (writing || readings.length === 0); guard += 1) {
      const result = await reports.runExtendedReport(ops(), concQuery("volume"), hoisted.ctx);
      readings.push({
        created: result.totals.created,
        fromRows: result.rows.reduce((a, r) => a + r.values.created, 0),
        fromQueues: Object.entries(result.totals)
          .filter(([k]) => k.startsWith("created."))
          .reduce((a, [, n]) => a + n, 0),
      });
    }
    await writer;

    // One more after the writer has finished, so the final population is asserted too.
    const settled = await reports.runExtendedReport(ops(), concQuery("volume"), hoisted.ctx);
    readings.push({
      created: settled.totals.created,
      fromRows: settled.rows.reduce((a, r) => a + r.values.created, 0),
      fromQueues: Object.entries(settled.totals)
        .filter(([k]) => k.startsWith("created."))
        .reduce((a, [, n]) => a + n, 0),
    });

    for (const r of readings) {
      expect(r.fromRows).toBe(r.created);
      expect(r.fromQueues).toBe(r.created);
    }
    // Scoped to the rows this run created: the window is this run's alone.
    expect(settled.totals.created).toBe(CONC_TICKETS);
  });

  /**
   * The same reconciliation, generalised — one population, three renderings, for EVERY report and
   * EVERY granularity.
   *
   * The two tests above pin `volume`, which is where the defect was measured. The defect itself was
   * not in `volume`: nine raw queries across five reports bound a JS `Date` into `$queryRaw` the same
   * way, and each of them disagreed with the Prisma-built half of its own report by the session zone's
   * offset. A guard that only knows about `volume` would have passed the other four.
   *
   * `backlog` is excluded on purpose and not as an exception to be tidied away later: its totals are
   * point-in-time readings (`current` is the last edge, `peak` is the maximum), so summing its rows
   * would assert something the report does not claim. Percentiles and percentages are skipped by name
   * for the same reason — a median of medians is not a median.
   */
  it("reconciles totals with rows for every report and every granularity", async () => {
    const { reports } = mods();
    const POINT_IN_TIME: ReadonlySet<string> = new Set(["backlog"]);
    const notSummable = (name: string): boolean => /^p\d+$/.test(name) || name.endsWith("Pct");

    let checked = 0;
    for (const key of queryModule.EXTENDED_REPORT_KEYS) {
      if (POINT_IN_TIME.has(key)) continue;
      for (const granularity of ["day", "week", "month"] as const) {
        for (const window of [WINDOW, EDGE_WINDOW]) {
          const q = queryModule.parseReportQuery({ report: key, ...window, granularity });
          const result = await reports.runExtendedReport(ops(), q, hoisted.ctx);
          const where = `${key}/${granularity}/${window.from}..${window.to}`;

          for (const name of result.series) {
            if (notSummable(name)) continue;
            const total = result.totals[name];
            if (total === undefined) continue;
            const fromRows = result.rows.reduce((a, r) => a + (r.values[name] ?? 0), 0);
            expect(fromRows, `${where}: rows sum to ${fromRows} but totals.${name} is ${total}`).toBe(total);
            checked += 1;
          }

          // The per-queue split, where the report emits one. It is built by a TYPED `groupBy` over the
          // same two bounds — the half that was always right — so it is the third reading of the one
          // population, and the three must agree.
          for (const name of result.series) {
            const split = Object.entries(result.totals).filter(([k]) => k.startsWith(`${name}.`));
            if (split.length === 0) continue;
            const summed = split.reduce((a, [, n]) => a + n, 0);
            expect(summed, `${where}: per-queue ${name} sums to ${summed}, headline is ${result.totals[name]}`).toBe(
              result.totals[name],
            );
            checked += 1;
          }
        }
      }
    }
    // The loop must actually have asserted something: a report whose series stopped matching its
    // totals keys would otherwise pass by checking nothing at all.
    expect(checked, "the invariant asserted nothing").toBeGreaterThan(20);
  });

  it("bounds every number by the viewer's readable queues (I5)", async () => {
    const { reports } = mods();
    const forCs = await reports.runExtendedReport(cs(), query("volume"), hoisted.ctx);
    const forOps = await reports.runExtendedReport(ops(), query("volume"), hoisted.ctx);

    // client_services holds no access to ADVICE; ops_team reads it.
    expect(forCs.totals.created).toBe(5);
    expect(forOps.totals.created).toBe(6);
    expect(forCs.totals["created.ADVICE"]).toBeUndefined();
    expect(forOps.totals["created.ADVICE"]).toBe(1);

    // An explicit queue filter narrows further but can never widen past what the viewer may read.
    const csAskingForAdvice = await reports.runExtendedReport(cs(), query("volume", { queueKey: "ADVICE" }), hoisted.ctx);
    expect(csAskingForAdvice.totals).toEqual({});
    expect(csAskingForAdvice.rows).toEqual([]);
  });

  it("backlog counts what was open at each period end, and never the voided ticket", async () => {
    const { reports } = mods();

    // Backlog is the one CUMULATIVE report: "open at this instant" has no lower date bound, so it
    // necessarily counts every still-open ticket the shared test database holds from before this run's
    // window. The baseline is therefore measured, not assumed — one period ending the day BEFORE the
    // first fixture exists — and every assertion below is against it. (A ticket created before that
    // edge and still open is equally open, and equally breached, at every later edge.)
    const dayBefore = civilToString(addCivilDays(D0, -1));
    const before = await reports.runExtendedReport(
      cs(),
      queryModule.parseReportQuery({ report: "backlog", from: dayBefore, to: dayBefore, granularity: "day" }),
      hoisted.ctx,
    );
    const baseOpen = before.rows[0].values.backlog;
    const baseBreached = before.rows[0].values.breached;

    const result = await reports.runExtendedReport(cs(), query("backlog"), hoisted.ctx);

    // End of D0: the 20:00 ticket (resolved next morning) and the reopened one.
    expect(result.rows[0].values.backlog - baseOpen).toBe(2);
    // Only the reopened one is past its resolution clock at that edge.
    expect(result.rows[0].values.breached - baseBreached).toBe(1);
    // End of D1: the 20:00 ticket has been resolved and the never-answered one has arrived.
    expect(result.rows[1].values.backlog - baseOpen).toBe(2);
    // End of the window: the open one, the reopened one and the complaint. The void is breached on its
    // raw timers and still absent.
    expect(result.rows[3].values.backlog - baseOpen).toBe(3);
    expect(result.totals.current - baseOpen).toBe(3);
    expect(result.totals.peak).toBeGreaterThanOrEqual(result.totals.current);
  });

  it("first response uses Postgres percentiles over the whole range, not an average of days", async () => {
    const { reports } = mods();
    const result = await reports.runExtendedReport(cs(), query("first-response"), hoisted.ctx);

    // Answered in 20, 30 and 90 minutes.
    expect(result.totals.responded).toBe(3);
    expect(result.totals.created).toBe(5);
    expect(result.totals.unanswered).toBe(2);
    expect(result.totals.p50).toBe(30);
    expect(result.totals.p90).toBe(78); // percentile_cont interpolates; an average of daily medians would not
    expect(result.totals.respondedPct).toBe(60);
    // The daily medians are genuinely different numbers, which is why the range figure is its own query.
    expect(result.rows[0].values.p50).toBe(30);
  });

  it("resolution time buckets on when the ticket was resolved", async () => {
    const { reports } = mods();
    const result = await reports.runExtendedReport(cs(), query("resolution"), hoisted.ctx);

    expect(result.totals.resolved).toBe(2);
    expect(result.rows[0].values.resolved).toBe(1); // resolved on D0
    expect(result.rows[1].values.resolved).toBe(1); // resolved on D1, though created on D0
    // Median of the met ticket's 120 minutes and the late one's D0 20:00 to D1 10:00: 840 minutes, but 780 or
    // 900 when D0 is a DST-change day (23 or 25 hours long). D0 is a random day, so measure it, don't assume it.
    const lateMinutes = (at(D1, 10).getTime() - at(D0, 20).getTime()) / MIN;
    expect(result.totals.p50).toBe((120 + lateMinutes) / 2);
  });

  it("SLA attainment uses the same MET rule as computeSlaStatus", async () => {
    const { reports } = mods();
    const result = await reports.runExtendedReport(cs(), query("sla-attainment"), hoisted.ctx);

    expect(result.totals.resolved).toBe(2);
    expect(result.totals.firstResponseMet).toBe(1);
    expect(result.totals.resolutionMet).toBe(1);
    expect(result.totals.met).toBe(1);
    expect(result.totals.metPct).toBe(50);
    expect(result.rows[0].values.metPct).toBe(100); // D0 resolved only the ticket that met both
    expect(result.rows[1].values.metPct).toBe(0);
  });

  it("agent load separates the standing queue from the range's resolutions", async () => {
    const { reports } = mods();
    const result = await reports.runExtendedReport(cs(), query("agent-load"), hoisted.ctx);

    const a = result.rows.find((r) => r.bucket === AGENT_A);
    const b = result.rows.find((r) => r.bucket === AGENT_B);
    expect(a?.values).toMatchObject({ open: 0, resolved: 2 });
    expect(b?.values).toMatchObject({ open: 2, resolved: 0 });
    expect(b?.values.breached).toBe(2); // both of B's are past a clock
    // The unassigned row aggregates the whole readable book, so only the relation is assertable.
    const unassigned = result.rows.find((r) => r.bucket === "unassigned");
    expect((unassigned?.values.open ?? 0) >= 1).toBe(true);
  });

  it("category mix shares add up over the tickets created in the range", async () => {
    const { reports } = mods();
    const result = await reports.runExtendedReport(cs(), query("category-mix"), hoisted.ctx);

    const byCategory = new Map(result.rows.map((r) => [r.bucket, r.values] as const));
    expect(byCategory.get("WIRE_TRANSFER")?.created).toBe(1); // the void's WIRE_TRANSFER is excluded
    expect(byCategory.get("ACAT")?.created).toBe(1);
    expect(byCategory.get("COMPLAINT")?.created).toBe(1);
    expect(result.totals.created).toBe(5);
    expect(byCategory.get("ACAT")?.sharePct).toBe(20);
  });

  it("reopen rate reads the ledger, which remembers what the ticket row forgot", async () => {
    const { reports } = mods();
    const result = await reports.runExtendedReport(cs(), query("reopen-rate"), hoisted.ctx);

    expect(result.totals.reopened).toBe(1);
    expect(result.totals.ticketsReopened).toBe(1);
    expect(result.totals.resolved).toBe(2);
    expect(result.totals.ratePct).toBe(50);
    expect(result.rows[2].values.reopened).toBe(1); // the reopen happened on D2
    // And the ticket itself no longer claims a resolution.
    const { prisma } = mods();
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: T.reopened }, select: { resolvedAt: true } });
    expect(row.resolvedAt).toBeNull();
  });

  it("resolution mix lists every value, zeros included", async () => {
    const { reports } = mods();
    const result = await reports.runExtendedReport(cs(), query("resolution-mix"), hoisted.ctx);

    const byResolution = new Map(result.rows.map((r) => [r.bucket, r.values] as const));
    expect(byResolution.get("ANSWERED")?.tickets).toBe(1);
    expect(byResolution.get("COMPLETED")?.tickets).toBe(1);
    expect(byResolution.get("WITHDRAWN")?.tickets).toBe(0);
    expect(byResolution.get("ANSWERED")?.sharePct).toBe(50);
    expect(result.totals.resolved).toBe(2);
    expect(result.totals.unrecorded).toBe(0);
  });

  it("desk health gates the counters that are not queue-scoped, and surfaces the void", async () => {
    const { reports } = mods();
    const forOps = await reports.runExtendedReport(ops(), query("desk-health"), hoisted.ctx);
    const forCs = await reports.runExtendedReport(cs(), query("desk-health"), hoisted.ctx);

    const opsRows = new Map(forOps.rows.map((r) => [r.bucket, r.values] as const));
    const csRows = new Map(forCs.rows.map((r) => [r.bucket, r.values] as const));

    // ops_team holds intake review and webhook admin; client_services holds neither, so the rows are
    // ABSENT rather than zero — a zero would read as "nothing is stuck".
    expect(opsRows.has("held-intake")).toBe(true);
    expect(opsRows.has("webhook-dead")).toBe(true);
    expect(csRows.has("held-intake")).toBe(false);
    expect(csRows.has("webhook-dead")).toBe(false);

    // One complaint filed in the window: the voided ticket is flagged as one and is not counted.
    expect(csRows.get("complaints")?.inRange).toBe(1);
    expect((csRows.get("complaints")?.current ?? 0) >= 1).toBe(true);
    // The void itself is visible here and nowhere else.
    expect(csRows.get("voided")?.inRange).toBe(1);
    expect((csRows.get("voided")?.current ?? 0) >= 1).toBe(true);
  });

  it("a viewer with no readable queue gets an empty report rather than an error", async () => {
    const { reports } = mods();
    const result = await reports.runExtendedReport(viewerOf(NOBODY_USER_ID, []), query("volume"), hoisted.ctx);
    expect(result.rows).toEqual([]);
    expect(result.totals).toEqual({});
    expect(result.from).toBe(WINDOW.from);
  });

  it("the CSV carries the same numbers as the page, plus a lossless TOTAL row", async () => {
    const { reports } = mods();
    const result = await reports.runExtendedReport(cs(), query("first-response"), hoisted.ctx);
    const csv = reports.reportToCsv(result);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);

    expect(lines[0].startsWith("bucket,label,p50,p90,responded")).toBe(true);
    expect(lines).toHaveLength(result.rows.length + 2);
    const total = lines.at(-1) ?? "";
    expect(total.startsWith("TOTAL,")).toBe(true);
    expect(total).toContain(",30,78,3,");
  });

  it("/api/reports/export records REPORT_EXPORTED with the row count before the first byte (I14)", async () => {
    const { GET, prisma } = mods();
    hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);

    const params = new URLSearchParams({ report: "volume", from: WINDOW.from, to: WINDOW.to, granularity: "day" });
    const res = await GET(new Request(`http://localhost/api/reports/export?${params.toString()}`));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toContain("report-volume-day-");

    const csv = await res.text();
    const dataLines = csv.split("\r\n").filter((l) => l.length > 0).slice(1);
    expect(dataLines).toHaveLength(5); // four daily buckets plus the TOTAL row

    const exportRow = await prisma.auditLog.findFirst({
      where: { action: "REPORT_EXPORTED", actorId: OPS_USER_ID, requestId: hoisted.ctx.requestId },
      orderBy: { seq: "desc" },
    });
    expect(exportRow).not.toBeNull();
    expect(exportRow!.entityType).toBe("REPORT");
    expect(exportRow!.entityId).toBe("volume");
    expect(exportRow!.newValue).toBe("4"); // the data rows, as the report produced them
    expect(exportRow!.fieldChanged).toBeNull();
    expect(exportRow!.oldValue).toBeNull();
    const meta = exportRow!.metadata as { range?: Record<string, string>; filters?: Record<string, unknown> } | null;
    expect(meta?.range?.from).toBe(WINDOW.from);
    expect(meta?.range?.granularity).toBe("day");
    expect(meta?.filters).toEqual({ granularity: "day" });
    // A report carries no record content, so nothing in the ledger row can leak one.
    expect(JSON.stringify(exportRow!.metadata)).not.toContain(REQUESTER_EMAIL);
  });

  it("refuses an export to a viewer without reports:read, records the denial, and writes no export row", async () => {
    const { GET, prisma } = mods();
    hoisted.viewer = viewerOf(NOBODY_USER_ID, []);

    const res = await GET(new Request(`http://localhost/api/reports/export?report=volume`));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });

    const denial = await prisma.auditLog.findFirst({
      where: { action: "AUTHZ_DENIED", actorId: NOBODY_USER_ID },
      orderBy: { seq: "desc" },
    });
    expect(denial).not.toBeNull();
    expect(denial!.newValue).toContain("reports:read");

    const exported = await prisma.auditLog.count({
      where: { action: "REPORT_EXPORTED", actorId: NOBODY_USER_ID },
    });
    expect(exported).toBe(0);

    hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
  });
});
