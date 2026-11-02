import { NextResponse } from "next/server";
import { $Enums } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { verifyAcatReadCaller, verifyAcatWriteCaller } from "@/lib/machine-auth";
import {
  redactAcatForMachine,
  redactAcatForMachineBook,
  redactAcatForMachineList,
} from "@/lib/mcp/redaction";
import { applyAcatCreate } from "@/lib/acat-record-write";
import { acatClientLinksSelection } from "@/lib/acat-identity-dto";
import { rateLimit } from "@/lib/rate-limit-redis";

// Authenticated + live: never cache. The gate is per-request OIDC
// verification, not a session, so there is nothing to statically render.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Keyed per verified caller email (not IP) once auth succeeds.
const MACHINE_LIST_LIMIT = { maxTokens: 60, interval: 60_000 };

// ---- Status sets, DERIVED FROM THE AcatStatus ENUM BY EXCLUSION ----
// Deriving by exclusion (rather than hardcoding ~15 names) means a future
// enum value defaults into LIVE — it shows in the lane and acts as a
// suppressing successor — instead of silently vanishing.

// Dead ends: never loaded, never shown, never a suppressing successor.
const TERMINAL_EXCLUDED: ReadonlySet<string> = new Set([
  $Enums.AcatStatus.Canceled,
  $Enums.AcatStatus.Purged,
]);

// LIVE = every status EXCEPT the terminals, Completed, and Rejected. These are
// shown in the lane AND count as suppressing successors. Includes AcatReceived
// (the schema default) so brand-new records appear.
const LIVE_STATUSES: $Enums.AcatStatus[] = Object.values($Enums.AcatStatus).filter(
  (s) => !TERMINAL_EXCLUDED.has(s) && s !== "Completed" && s !== "Rejected"
);
const LIVE_STATUS_SET: ReadonlySet<string> = new Set(LIVE_STATUSES);

// Suppressing successors = LIVE ∪ {Completed} (every status except the
// terminals and Rejected). Completed graduates to the app's Funded stage and
// is never shown, but a Completed STRICTLY LATER than a Rejected on the same
// account pair still suppresses that Rejected. Rejected is NOT a successor.
const SUCCESSOR_STATUS_SET: ReadonlySet<string> = new Set<string>([
  ...LIVE_STATUSES,
  $Enums.AcatStatus.Completed,
]);

// Unbounded load set — the current in-flight population (LIVE + Rejected) is
// naturally small.
const LOAD_LIVE_AND_REJECTED: $Enums.AcatStatus[] = [
  ...LIVE_STATUSES,
  $Enums.AcatStatus.Rejected,
];

// Completed is loaded ONLY as a suppression signal, and ONLY within a recency
// window: loading all Completed history would be unbounded, and pointless.
// ACAT retries happen within weeks, and the temporal guard means only a
// Completed LATER than a given Rejected can suppress it anyway. Bounded on
// `createdAt` (a reliable DateTime; `lastUpdated` is a String that can be
// empty). Tradeoff: a Rejected OLDER than the window whose only successor is
// an equally-old Completed would surface as needs-attention — which errs
// visible and is acceptable, since a Rejected that old is itself an anomaly.
const COMPLETED_WINDOW_DAYS = 365;

/**
 * GET /api/machine/acats  (list)
 *
 * Server-to-server list of the IN-FLIGHT ACATs for the advisor platform "In Transfer"
 * lane, authenticated by a Google OIDC ID token (see `verifyAcatReadCaller`).
 * Returns a redacted-but-NAMED projection (`redactAcatForMachineList`):
 * account identifiers masked and `wealthAdvisor`/`notes` omitted, but
 * `clientName` is kept because the lane displays it. NOT gated by NextAuth;
 * this is a separate machine path (sibling to the single-record read).
 *
 * Returned (in-lane) = LIVE ∪ surviving Rejected. LIVE is every AcatStatus
 * except {Canceled, Purged, Completed, Rejected}. Completed / Canceled /
 * Purged are never shown.
 *
 * SUPPRESSION (TEMPORAL): records are grouped by delivering->receiving account
 * (`statementAccountNumber` + `apexAccountId`, with `clientName` as a
 * tiebreaker). Within a group, a Rejected is dropped ONLY when a suppressing
 * successor (LIVE or Completed) is STRICTLY LATER than it — compared by
 * `lastUpdated` (ISO string), falling back to `createdAt` when equal/missing.
 * A Rejected with no *later* successor is RETURNED — a genuine needs-attention
 * rejection. (An older Completed must NOT bury a newer real Rejection.)
 *
 * SCOPING: this endpoint returns the FIRM-WIDE in-flight list. Per-advisor
 * book-scoping is NOT applied here — it is enforced downstream in the advisor platform, which
 * filters the list to the calling advisor's book. Do not add advisor
 * filtering to this endpoint.
 *
 * Rows are sorted most-recent-first by last-activity (`lastUpdated`); that
 * timestamp is also returned per row (`lastActivityAt`) so the consumer can
 * re-sort.
 */
export async function GET(request: Request) {
  const caller = await verifyAcatReadCaller(request, "list");
  if (!caller) {
    // Opaque 401 — no reason, no caller, nothing that helps probe the gate.
    logger.warn({ status: 401 }, "machine ACAT list: unauthorized");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { allowed } = await rateLimit("machine-acat-list", caller.email, MACHINE_LIST_LIMIT);
  if (!allowed) {
    logger.warn(
      { caller: caller.email, status: 429 },
      "machine ACAT list: rate limited"
    );
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    const query = new URL(request.url).searchParams;
    if (query.get("book") === "full") {
      const removed = query.get("removed");
      if (removed !== null && removed !== "only") {
        logger.warn({ caller: caller.email, status: 400 }, "machine ACAT list: invalid removed");
        return NextResponse.json({ error: "invalid_removed" }, { status: 400 });
      }
      if (removed === "only") {
        // Removed rows are a separate list, newest removal first; they never
        // mix into the live book that the advisor platform renders by default.
        const removedRecords = await prisma.acatRecord.findMany({
          where: { deletedAt: { not: null } },
          include: { assets: true, clientLinks: acatClientLinksSelection, custodian: { select: { avgProcessingDays: true } } },
          orderBy: [{ deletedAt: "desc" }, { createdAt: "desc" }],
        });
        logger.info(
          { caller: caller.email, count: removedRecords.length, status: 200, book: "removed" },
          "machine ACAT list: ok"
        );
        return NextResponse.json({ acats: removedRecords.map(redactAcatForMachineBook) });
      }
      const records = await prisma.acatRecord.findMany({
        where: { deletedAt: null },
        include: { assets: true, clientLinks: acatClientLinksSelection, custodian: { select: { avgProcessingDays: true } } },
      });
      records.sort((a, b) => {
        if (a.lastUpdated !== b.lastUpdated) {
          return a.lastUpdated < b.lastUpdated ? 1 : -1;
        }
        return b.createdAt.getTime() - a.createdAt.getTime();
      });
      logger.info(
        { caller: caller.email, count: records.length, status: 200, book: "full" },
        "machine ACAT list: ok"
      );
      return NextResponse.json({ acats: records.map(redactAcatForMachineBook) });
    }

    // Load LIVE + Rejected unbounded, plus Completed only within the recency
    // window (suppression signal). Exclude soft-deleted rows to match the rest
    // of the app's read surface. Order is finalised in code after suppression.
    const completedSince = new Date(
      Date.now() - COMPLETED_WINDOW_DAYS * 24 * 60 * 60 * 1000
    );
    const records = await prisma.acatRecord.findMany({
      where: {
        deletedAt: null,
        OR: [
          { status: { in: LOAD_LIVE_AND_REJECTED } },
          { status: $Enums.AcatStatus.Completed, createdAt: { gte: completedSince } },
        ],
      },
      include: { assets: true },
    });

    type Row = (typeof records)[number];

    // Group by delivering->receiving account. `apexAccountId` is required;
    // `statementAccountNumber` is nullable. `clientName` disambiguates the rare
    // case where two clients share an account pair. JSON.stringify makes the
    // key un-collidable: a literal delimiter inside a field can't merge/split
    // groups, and a null statement number (-> JSON `null`) is distinct from any
    // string value.
    const groupKey = (r: Row) =>
      JSON.stringify([r.statementAccountNumber ?? null, r.apexAccountId, r.clientName]);

    const groups = new Map<string, Row[]>();
    for (const r of records) {
      const key = groupKey(r);
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }

    // Is `a` strictly later than `b`? Prefer `lastUpdated` (ISO-8601 string,
    // sorts chronologically); fall back to `createdAt` when the two stamps are
    // equal or either is missing/empty.
    const isStrictlyLater = (a: Row, b: Row): boolean => {
      if (a.lastUpdated && b.lastUpdated && a.lastUpdated !== b.lastUpdated) {
        return a.lastUpdated > b.lastUpdated;
      }
      return a.createdAt.getTime() > b.createdAt.getTime();
    };

    const surviving = records.filter((r) => {
      // Completed is load-only (suppression signal); never returned.
      if (r.status === $Enums.AcatStatus.Completed) return false;
      if (r.status === $Enums.AcatStatus.Rejected) {
        // Suppress ONLY if a suppressing successor in the group is STRICTLY
        // LATER than this Rejected — an older successor must not bury it.
        const group = groups.get(groupKey(r)) ?? [];
        const superseded = group.some(
          (s) =>
            s !== r &&
            SUCCESSOR_STATUS_SET.has(s.status) &&
            isStrictlyLater(s, r)
        );
        return !superseded;
      }
      // Explicit whitelist: only LIVE statuses are returnable. (Canceled/Purged
      // aren't loaded, but this keeps the output robust if the load set widens.)
      return LIVE_STATUS_SET.has(r.status);
    });

    // Most-recent-first by last-activity. `lastUpdated` is an ISO-8601 string
    // (sorts chronologically); createdAt breaks ties deterministically.
    surviving.sort((a, b) => {
      if (a.lastUpdated !== b.lastUpdated) {
        return a.lastUpdated < b.lastUpdated ? 1 : -1;
      }
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    logger.info(
      { caller: caller.email, count: surviving.length, status: 200 },
      "machine ACAT list: ok"
    );
    return NextResponse.json({ acats: surviving.map(redactAcatForMachineList) });
  } catch (err) {
    logger.error(
      { err, caller: caller.email, status: 500 },
      "machine ACAT list: failed"
    );
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const caller = await verifyAcatWriteCaller(request, "create");
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { allowed } = await rateLimit("machine-acat-write", caller.email, {
    maxTokens: 60,
    interval: 60_000,
    failClosed: true,
  });
  if (!allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const body = await request.json();
  const result = await applyAcatCreate({ body, performedBy: caller.email });
  if (result.kind === "response") return result.response;
  return NextResponse.json(redactAcatForMachine(result.record), { status: 201 });
}
