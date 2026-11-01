/**
 * The public demo's limits (plan §6). Every visitor shares four accounts on one database, so what visitors can
 * add is capped, and so are the ledger and the database; past a cap, changes are refused until the daily reset.
 * Looking never is: a view, a download, an export, a sign-in or a refusal is still served once the ledger is
 * full, and only its row is skipped, so a full ledger can't lock visitors out of the demo.
 *
 * The check runs from the audit writer, because every change ends in a ledger batch inside its own
 * transaction: the entity row is already written, so the count includes it, and a refusal rolls the whole
 * change back. One advisory lock is taken first, so two visitors cannot both pass a cap at once; the ledger's
 * own chain lock (its insert trigger) comes after it, always in that order. A row written outside a
 * transaction (`writeAudit(prisma, …)`: sign-ins, views outside the demo, downloads, refusals) takes the lock
 * as a statement of its own, which orders nothing, so those can pass the ledger cap by a few rows at once.
 *
 * Each visitor (the pseudonym the Worker puts in X-Forwarded-For) also has an hourly allowance of ledger rows,
 * so no one visitor can spend everyone's: past it their looks go unrecorded and their changes are refused.
 *
 * SYSTEM_ACTOR (the seed, and the jobs when their machine user is missing) is exempt by identity in the audit
 * writer (src/lib/audit.ts); every other actor is held to the caps, including machine and anonymous ones.
 */
import type { DbTx } from "@/lib/db";
import { demoMode } from "@/lib/demo/mode";
import { ValidationError } from "@/lib/errors";
import type { AuditActor } from "@/types/domain";

export const DEMO_LIMITS = {
  tickets: 600,
  comments: 3_000,
  macros: 60,
  suppressions: 100,
  drafts: 1_000,
  ledgerRows: 50_000,
  ledgerBytes: 50 * 1024 * 1024,
  databaseBytes: 256 * 1024 * 1024,
  visitorRowsPerHour: 2_000,
} as const;

/** The refusal a visitor sees: what ran out, and when it comes back. */
export class DemoLimitError extends ValidationError {
  constructor(what: string) {
    super(`This demo has reached its limit for ${what}. Everything resets daily at 14:00 UTC.`);
    this.name = "DemoLimitError";
  }
}

/** The refusal once one visitor has spent their hourly allowance. */
export class DemoVisitorLimitError extends ValidationError {
  constructor() {
    super("That's as many changes as one visitor can make in an hour. Please try again a little later.");
    this.name = "DemoVisitorLimitError";
  }
}

/**
 * Rows that record a look rather than a change. Past a limit they are skipped, not refused, so the page they
 * belong to is still served.
 */
export const DEMO_LOOK_ACTIONS: ReadonlySet<string> = new Set([
  "TICKET_VIEWED",
  "TICKET_PREVIEWED",
  "ATTACHMENT_VIEWED",
  "AUDIT_LOG_VIEWED",
  "AUDIT_LOG_EXPORTED",
  "AUDIT_CHAIN_VERIFIED",
  "TICKET_LIST_EXPORTED",
  "TICKET_EXPORT_READ",
  "REPORT_EXPORTED",
  "CLIENT_API_READ",
  "USER_SIGNED_IN",
  "USER_SIGNED_OUT",
  "AUTHZ_DENIED",
  "AUTHZ_DENIED_COALESCED",
]);

type Db = Pick<DbTx, "$queryRaw" | "$executeRaw" | "ticket" | "comment" | "macro" | "requesterSuppression">;

/** The caps an audit action implies: the action that records a new row of that kind. */
const CAPS: Readonly<Record<string, { what: string; limit: number; count: (db: Db) => Promise<number> }>> = {
  TICKET_CREATED: { what: "new tickets", limit: DEMO_LIMITS.tickets, count: (db) => db.ticket.count() },
  TICKET_INGESTED: { what: "new tickets", limit: DEMO_LIMITS.tickets, count: (db) => db.ticket.count() },
  COMMENT_ADDED_PUBLIC: { what: "replies and notes", limit: DEMO_LIMITS.comments, count: (db) => db.comment.count() },
  COMMENT_ADDED_INTERNAL: { what: "replies and notes", limit: DEMO_LIMITS.comments, count: (db) => db.comment.count() },
  COMMENT_ADDED_REQUESTER: { what: "replies and notes", limit: DEMO_LIMITS.comments, count: (db) => db.comment.count() },
  MACRO_CREATED: { what: "macros", limit: DEMO_LIMITS.macros, count: (db) => db.macro.count() },
  SUPPRESSION_ADDED: {
    what: "suppression entries",
    limit: DEMO_LIMITS.suppressions,
    count: (db) => db.requesterSuppression.count(),
  },
};

/** Which store is at its cap, if any: the ledger (rows or bytes) or the whole database. */
export async function storageFull(db: Pick<DbTx, "$queryRaw">): Promise<"ledger" | "database" | null> {
  const [row] = await db.$queryRaw<Array<{ rows: bigint; bytes: bigint; database: bigint }>>`
    SELECT (SELECT count(*) FROM "AuditLog") AS rows, pg_total_relation_size('"AuditLog"') AS bytes,
      pg_database_size(current_database()) AS database`;
  if (Number(row?.database ?? 0) >= DEMO_LIMITS.databaseBytes) return "database";
  if (Number(row?.rows ?? 0) >= DEMO_LIMITS.ledgerRows || Number(row?.bytes ?? 0) >= DEMO_LIMITS.ledgerBytes) {
    return "ledger";
  }
  return null;
}

/** The one lock every capped write takes, inside its own transaction, before it reads a count. */
export async function lockDemoLimits(db: Pick<DbTx, "$executeRaw">): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('helpdesk.demo.limits'))`;
}

// The hourly allowances, in memory: the demo runs one container (wrangler.jsonc max_instances: 1), and a restart
// only hands everyone a fresh hour. Bounded, so a caller rotating addresses cannot grow it.
const HOUR_MS = 60 * 60_000;
const MAX_TRACKED_VISITORS = 10_000;
const allowances = new Map<string, { startedAt: number; rows: number }>();

/**
 * A visitor the allowance applies to: an address from the network. Loopback is the container's own stand-ins
 * (the mail sender reports over it), and "unknown" is the jobs' context; neither is a visitor.
 */
function networkVisitor(visitor: string | undefined): visitor is string {
  if (!visitor || visitor === "unknown") return false;
  return !/^(127\.|::1$|::ffff:127\.)/i.test(visitor);
}

/** Counts `rows` against the visitor's hour, and says whether they fit. A refused batch is not counted. */
export function spendVisitorAllowance(visitor: string | undefined, rows: number, now: Date = new Date()): boolean {
  if (!networkVisitor(visitor)) return true;
  const at = now.getTime();
  let window = allowances.get(visitor);
  if (window === undefined || at - window.startedAt >= HOUR_MS) window = { startedAt: at, rows: 0 };
  allowances.delete(visitor);
  allowances.set(visitor, window);
  while (allowances.size > MAX_TRACKED_VISITORS) allowances.delete(allowances.keys().next().value as string);
  if (window.rows + rows > DEMO_LIMITS.visitorRowsPerHour) return false;
  window.rows += rows;
  return true;
}

/** For tests: forgets every visitor's hour, last recorded refusal and quotas. */
export function resetDemoVisitorMemory(): void {
  allowances.clear();
  denials.clear();
  quotas.clear();
}

// Small per-visitor quotas for what every visitor would otherwise share, such as the Outbox buttons' one intake
// key. In memory, like the allowances.
const quotas = new Map<string, { startedAt: number; used: number }>();

/** Takes one use of `key`'s quota of `limit` per `windowMs`; false once it is spent. */
export function takeDemoQuota(key: string, limit: number, windowMs: number, now: Date = new Date()): boolean {
  const at = now.getTime();
  let window = quotas.get(key);
  if (window === undefined || at - window.startedAt >= windowMs) window = { startedAt: at, used: 0 };
  quotas.delete(key);
  quotas.set(key, window);
  while (quotas.size > MAX_TRACKED_VISITORS) quotas.delete(quotas.keys().next().value as string);
  if (window.used >= limit) return false;
  window.used += 1;
  return true;
}

/**
 * Whether an audit batch with these actions may be written. True: write it. False: skip it, which happens only
 * to a batch of looks (DEMO_LOOK_ACTIONS) once the ledger or the database is full or the visitor's allowance is
 * spent. A change past any limit throws instead, rolling the change back. Always true outside demo mode.
 */
export async function enforceDemoLimits(
  db: Db,
  actions: readonly string[],
  visitor?: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!demoMode()) return true;
  await lockDemoLimits(db);
  const looksOnly = actions.every((a) => DEMO_LOOK_ACTIONS.has(a));
  if ((await storageFull(db)) !== null) {
    if (looksOnly) return false;
    throw new DemoLimitError("changes");
  }
  if (!looksOnly) {
    for (const action of new Set(actions)) {
      const cap = CAPS[action];
      if (cap && (await cap.count(db)) > cap.limit) throw new DemoLimitError(cap.what);
    }
  }
  if (!spendVisitorAllowance(visitor, actions.length, now)) {
    if (looksOnly) return false;
    throw new DemoVisitorLimitError();
  }
  return true;
}

/**
 * The view rule: every visitor shares four accounts, so the demo records at most one view per persona, ticket
 * and hour, and none once the ledger is full, in the spirit of the app's own coalesced access denials. True
 * when the view should be recorded. The caller holds the limits lock in the same transaction (recordView).
 */
export async function shouldRecordDemoView(
  db: Pick<DbTx, "$queryRaw" | "auditLog">,
  actor: AuditActor,
  ticketId: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!demoMode()) return true;
  if ((await storageFull(db)) !== null) return false;
  const recent = await db.auditLog.count({
    where: {
      actorId: actor.id,
      ticketId,
      action: { in: ["TICKET_VIEWED", "TICKET_PREVIEWED"] },
      occurredAt: { gte: new Date(now.getTime() - 60 * 60_000) },
    },
  });
  return recent === 0;
}

// The denial rule's memory: when each persona and visitor last had a refusal recorded.
const DENIAL_WINDOW_MS = 60_000;
const denials = new Map<string, number>();

/**
 * The denial rule: the demo records at most one refusal per persona and visitor a minute, as the app already
 * does for unauthenticated ones. Without it, reloading /no-access writes a row per load. Always true outside
 * demo mode.
 */
export function shouldRecordDemoDenial(actorId: string | null, visitor: string, now: Date = new Date()): boolean {
  if (!demoMode()) return true;
  const key = `${actorId ?? "anonymous"}|${visitor}`;
  const at = now.getTime();
  const last = denials.get(key);
  if (last !== undefined && at - last < DENIAL_WINDOW_MS) return false;
  denials.delete(key);
  denials.set(key, at);
  while (denials.size > MAX_TRACKED_VISITORS) denials.delete(denials.keys().next().value as string);
  return true;
}

/**
 * The drafts cap. A draft writes no ledger row, so the audit writer never sees it: the save checks for itself,
 * under the same lock, refusing a new draft past the count and any save once the database is full. A no-op
 * outside demo mode.
 */
export async function enforceDemoDraftLimit(
  db: Pick<DbTx, "$queryRaw" | "$executeRaw" | "composerDraft">,
  key: { ticketId: string; userId: string; channel: "PUBLIC" | "INTERNAL" },
): Promise<void> {
  if (!demoMode()) return;
  await lockDemoLimits(db);
  if ((await storageFull(db)) === "database") throw new DemoLimitError("changes");
  const exists = await db.composerDraft.count({ where: key });
  if (exists === 0 && (await db.composerDraft.count()) >= DEMO_LIMITS.drafts) throw new DemoLimitError("saved drafts");
}
