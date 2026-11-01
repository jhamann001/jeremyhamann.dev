/**
 * Held inbound mail — reads. Node, layer L4 (the build record `INTAKE_RELEASED`).
 *
 * `ingestInboundEmail` refuses a message by writing a `SuspendedIntake` row: an unknown mailbox, a
 * DMARC failure, a bounce, an auto-reply, spam, a loop, an unparseable or oversized body — and, since
 * the sender-identity gate landed, a reply whose sender is not the thread's requester. Every one of
 * those is a real client message that the desk decided not to file.
 *
 * Until this module existed, NOTHING read that table. The rows accumulated, could not be deleted
 * (the append-only triggers see to that), appeared on no page, and raised no alert — so a client's
 * wire instruction that failed DMARC was correctly refused, correctly audited, and then invisible to
 * everyone who could act on it. That is the failure mode this module and
 * `suspended-intake.actions.ts` close.
 *
 * **This is not a ticket read.** A held message never became a ticket, so §e's "what counts as a
 * view" (a server read returning a single ticket's description or comments) does not reach it, and
 * no `*_VIEWED` action exists for it in the frozen audit enum. The row's `snippet` is already
 * PII-sanitised at write time and the whole surface is capability-gated. If the CCO wants held
 * mail reads in the ledger, that needs an `INTAKE_VIEWED` action and a migration — written up in
 * the build record
 */
import type { Prisma } from "@prisma/client";
import type {
  RequestContext,
  SuspendedIntakeReason,
  SuspendedIntakeStatus,
  UserRef,
  Viewer,
} from "@/types/domain";
import { SUSPENDED_INTAKE_REASONS, SUSPENDED_INTAKE_STATUSES } from "@/types/domain";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { normalizeMailboxAddress } from "@/lib/email/mailboxes";
import { ForbiddenError } from "@/lib/errors";
import { canReleaseHeldIntake, canReviewHeldIntake } from "@/lib/rbac";
// The one spelling of the metadata key the hold writes. Imported rather than restated: a read that
// looked for a different string would silently report every message as verified. No cycle —
// `email-intake.ts` does not import this module.
import { SENDER_VERIFIED_METADATA_KEY } from "@/server/email-intake";

/**
 * The two held-mail predicates now live in the RBAC matrix (`src/lib/rbac.ts`) behind the named
 * capabilities `intake:review` and `intake:release`, which is where the integration notes asked for
 * them; they are re-exported here so every existing import of `@/server/suspended-intake` is unchanged
 * and the module still reads as one surface.
 */
export { canReleaseHeldIntake, canReviewHeldIntake };

/** One row of the held-mail review list. Metadata plus the sanitised preview — never a ticket body. */
export type HeldIntakeRow = {
  id: string;
  reason: SuspendedIntakeReason;
  status: SuspendedIntakeStatus;
  mailbox: string;
  fromAddress: string;
  subject: string;
  messageId: string | null;
  rawRef: string | null;
  /** PII-sanitised preview, <= 2 000 chars, exactly as it was stored. */
  snippet: string | null;
  /** The ledger's `metadata.detail` for this row — `SENDER_MISMATCH` today, usually null. */
  detail: string | null;
  /**
   * False when nothing proved this message came from the address it claims — computed by
   * {@link heldIntakeSenderVerified} from the reason AND the ledger's recorded verdict, so it is
   * false on a row whose reason says something else entirely.
   *
   * This is the fact the reason alone could not carry. The gates in `ingestInboundEmail` are
   * ordered and `SuspendedIntakeReason` holds one value, so an unauthenticated message that also
   * arrived on an unmapped address is held as `UNKNOWN_MAILBOX` — and the review card used to show
   * it the benign "not in the mailbox map" banner and no sender caution at all, which is the wrong
   * thing to tell the person deciding whether to release a wire or address-change instruction.
   */
  senderVerified: boolean;
  createdAt: string;
  ticketId: string | null;
  ticketNumber: number | null;
  releasedAt: string | null;
  releasedBy: UserRef | null;
  /**
   * False when `fromAddress` is not an address a ticket could be answered at — which is exactly what
   * `PARSE_FAILED` usually means. `releaseHeldIntake` refuses such a row, so the page renders its
   * release control disabled with the reason rather than a button whose only outcome is a toast.
   */
  hasUsableSender: boolean;
  /**
   * Fix round 1 (B9's open integration gap). The ORIGINAL sender parsed out of a forwarded block, for
   * a `FORWARDED` hold; null on every other row and on a forward whose inner sender could not be read.
   *
   * The server half of "release as the person inside the forward" was complete —
   * `releaseHeldIntake`'s `releaseAsCandidate`, `resolveForwardedRelease`, the stored column — and the
   * client half did not exist and could not: no DTO carried the address, so `/admin/intake` offered a
   * forwarded client message no way to act on the attribution the parser had already computed. The
   * value is display-and-confirm only; the server never takes an address from the client, it takes a
   * boolean and checks it against this same stored column.
   */
  candidateRequesterEmail: string | null;
  /**
   * The discard disposition, from the ledger. `SuspendedIntake` has no `discardedBy` / `discardedAt`
   * columns and this wave runs no migration, so the audit row IS the record of who marked it and why;
   * the columns are requested in the build record.
   */
  discardedAt: string | null;
  /** Actor email snapshot from the discard audit row. Staff identity, never the sender's. */
  discardedBy: string | null;
  /** The reviewer's sanitized words, from the discard audit row's `metadata.note`. */
  discardNote: string | null;
};

export type HeldIntakeQuery = {
  /** Unset means NEW — the work queue, which is what a reviewer opens the page for. */
  status?: SuspendedIntakeStatus | "ALL";
  reason?: SuspendedIntakeReason;
  /** Case-insensitive substring over the inbound mailbox. */
  mailbox?: string;
  /** Hard-capped at `HELD_INTAKE_MAX_ROWS`. */
  limit?: number;
  /**
   * Keyset cursor from `encodeHeldIntakeCursor` — the LAST row of the page already on screen. A
   * malformed or hand-edited value is ignored and the read starts from the newest row, which mirrors
   * how `queryAuditLog` treats a non-numeric `cursor`: a bad cursor shows the top of the list, never
   * an error page over a reviewer's queue.
   */
  cursor?: string;
};

/** One page of held mail plus the two numbers the page footer needs to stop over-claiming. */
export type HeldIntakePage = {
  rows: HeldIntakeRow[];
  /** Cursor for the page after this one, or `null` when this is the last page. */
  nextCursor: string | null;
  /**
   * Rows matching the WHOLE filter — status, reason AND mailbox — ignoring the cursor and the page
   * size. This is the `N` in "Showing 100 of N": `heldIntakeCounts.total` is scoped to status and
   * mailbox only, so it would over-count whenever a reason chip is on.
   */
  total: number;
};

export const HELD_INTAKE_DEFAULT_ROWS = 100;
export const HELD_INTAKE_MAX_ROWS = 500;

/**
 * `<createdAt epoch ms>.<id>` — the keyset this list pages on.
 *
 * `createdAt` alone is not unique (an intake batch holds several messages in the same millisecond),
 * so the id is the tie-break and both halves are in the token. The column is `TIMESTAMP(3)`, so the
 * millisecond value round-trips through JS exactly and `lt` cannot skip or repeat a row.
 *
 * Deliberately NOT a Prisma `cursor`/`skip` pair: that needs a compound unique index on
 * `(createdAt, id)`, and this wave runs no migration.
 */
const HELD_INTAKE_CURSOR = /^(\d{1,15})\.([A-Za-z0-9_-]{1,64})$/;

export function encodeHeldIntakeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.getTime()}.${row.id}`;
}

/** The parsed keyset, or `null` for anything this module did not write. */
export function decodeHeldIntakeCursor(raw: string | null | undefined): { createdAt: Date; id: string } | null {
  if (typeof raw !== "string") return null;
  const m = HELD_INTAKE_CURSOR.exec(raw);
  if (m === null) return null;
  const ms = Number(m[1]);
  if (!Number.isSafeInteger(ms)) return null;
  const createdAt = new Date(ms);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: m[2] };
}

/** True for a value the review page may put in the `cursor` search param. */
export function isHeldIntakeCursor(value: string): boolean {
  return decodeHeldIntakeCursor(value) !== null;
}

const ROW_SELECT = {
  id: true,
  reason: true,
  status: true,
  mailbox: true,
  fromAddress: true,
  subject: true,
  messageId: true,
  rawRef: true,
  snippet: true,
  createdAt: true,
  ticketId: true,
  releasedAt: true,
  candidateRequesterEmail: true,
  ticket: { select: { number: true } },
  releasedBy: { select: { id: true, name: true, email: true, image: true } },
} as const;

async function denyAndThrow(viewer: Viewer, ctx: RequestContext | undefined, what: string): Promise<never> {
  if (ctx !== undefined) await recordDenied(actorFromViewer(viewer), ctx, what);
  throw new ForbiddenError(`Forbidden: ${what}`);
}

/** What the ledger knows about one held message that its own row cannot carry. */
type HeldIntakeAuditFacts = {
  detail: string | null;
  /**
   * The sender-authentication verdict the hold recorded, or `null` for a row written before the
   * verdict was carried (and for the fixture holds that do not supply one). `null` is UNKNOWN, never
   * "verified" — {@link heldIntakeSenderVerified} decides what to do with it.
   */
  senderAuthenticated: boolean | null;
  discardedAt: string | null;
  discardedBy: string | null;
  discardNote: string | null;
};

function emptyFacts(): HeldIntakeAuditFacts {
  return { detail: null, senderAuthenticated: null, discardedAt: null, discardedBy: null, discardNote: null };
}

/**
 * Whether a held message's sender was proven — the ONE rule, shared by the review surface and the
 * release gate so the card a reviewer reads and the gate the server charges can never disagree.
 *
 * Fail-closed in both directions:
 *
 *   - reason `UNAUTHENTICATED` is always unverified. It covers the DMARC failure AND the
 *     `SENDER_MISMATCH` hold, whose sender DID pass authentication but is not this thread's client;
 *     releasing either one adopts an address the desk has no business trusting, so neither may be
 *     loosened by the recorded verdict.
 *   - any other reason is unverified whenever the ledger recorded `false`. This is the case the
 *     ordered gates used to swallow: `UNKNOWN_MAILBOX` (or `AUTO_REPLY`, `SPAM`, …) winning over an
 *     authentication failure that happened on the same message.
 *
 * `null` — no verdict recorded — keeps the pre-fix behaviour for rows written before the verdict
 * existed: the reason decides, and nothing is retroactively claimed about a message nobody measured.
 */
export function heldIntakeSenderVerified(
  reason: SuspendedIntakeReason,
  senderAuthenticated: boolean | null,
): boolean {
  if (reason === "UNAUTHENTICATED") return false;
  return senderAuthenticated !== false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * The `INTAKE_SUSPENDED` facts for a page of held messages, per SuspendedIntake id. One query.
 *
 * Two different rows share that action, and they are told apart by `fieldChanged` — never by the
 * action alone, which is why this read is explicit about it:
 *
 *   - `fieldChanged: "reason"` is the row `suspendIntake` writes when the message is held. Its
 *     `metadata.detail` is the distinction the frozen enum cannot express: `SuspendedIntakeReason`
 *     has nine values and this wave runs no migration, so a reply whose sender is not the thread's
 *     requester shares `UNAUTHENTICATED` with a DMARC failure. One is usually a spouse or an
 *     accountant, the other is a spoof, and they are handled differently.
 *   - `fieldChanged: "status"` with `newValue: "DISCARDED"` is the row `discardHeldIntake` writes.
 *     `SuspendedIntake` has no discard columns, so who marked it, when, and in what words live only
 *     here — and a disposition nobody can read is not a disposition.
 */
async function auditFactsFor(ids: readonly string[]): Promise<Map<string, HeldIntakeAuditFacts>> {
  const out = new Map<string, HeldIntakeAuditFacts>();
  if (ids.length === 0) return out;
  const rows = await prisma.auditLog.findMany({
    // `INTAKE_DISCARDED` landed as its own enum value, so the disposition
    // row no longer borrows `INTAKE_SUSPENDED`. BOTH are read here, deliberately: rows written before
    // the change carry the old action, and the partition below is on `fieldChanged` — a HOLD carries
    // "reason", a disposition carries "status" — so the two eras read identically.
    where: { action: { in: ["INTAKE_SUSPENDED", "INTAKE_DISCARDED"] }, entityId: { in: [...ids] } },
    select: { entityId: true, fieldChanged: true, newValue: true, metadata: true, actorEmail: true, occurredAt: true },
    orderBy: { seq: "asc" },
  });
  for (const row of rows) {
    if (row.entityId === null) continue;
    const facts = out.get(row.entityId) ?? emptyFacts();
    const metadata = asRecord(row.metadata);
    if (row.fieldChanged === "reason") {
      facts.detail = metadata === null ? facts.detail : (stringOrNull(metadata.detail) ?? facts.detail);
      // `??`, not `||`: `false` is the whole point of this field, and it must survive the read.
      facts.senderAuthenticated =
        metadata === null
          ? facts.senderAuthenticated
          : (booleanOrNull(metadata[SENDER_VERIFIED_METADATA_KEY]) ?? facts.senderAuthenticated);
    } else if (row.fieldChanged === "status" && row.newValue === "DISCARDED") {
      facts.discardedAt = row.occurredAt.toISOString();
      facts.discardedBy = row.actorEmail;
      facts.discardNote = metadata === null ? null : stringOrNull(metadata.note);
    }
    out.set(row.entityId, facts);
  }
  return out;
}

/**
 * The sender-authentication verdict recorded for ONE held message, or `null` when none was.
 *
 * `releaseHeldIntake` needs it: the acknowledgement it charges for adopting an unproven address, and
 * the "SENDER NOT VERIFIED" line it writes onto the ticket, keyed off the reason alone — so a message
 * that failed authentication AND arrived on an unmapped address was released as though its sender
 * were proven, with nothing on the resulting ticket to say otherwise. The gate now reads this and
 * passes it through {@link heldIntakeSenderVerified}, the same rule the review card renders.
 *
 * Ungated on purpose: it reads one boolean out of the ledger for a row the caller has already been
 * authorised to act on, and it is the fail-closed half of a security gate. Every caller is inside a
 * `runAction` that has already charged `intake:review`.
 */
export async function heldIntakeSenderAuthenticated(suspendedId: string): Promise<boolean | null> {
  const facts = await auditFactsFor([suspendedId]);
  return facts.get(suspendedId)?.senderAuthenticated ?? null;
}

/** The status / reason / mailbox filter, shared by the page read and its `total` count. */
function heldIntakeWhere(query: HeldIntakeQuery): Prisma.SuspendedIntakeWhereInput {
  const status = query.status ?? "NEW";
  const mailbox = (query.mailbox ?? "").trim().slice(0, 320);
  return {
    ...(status === "ALL" ? {} : { status }),
    ...(query.reason === undefined ? {} : { reason: query.reason }),
    ...(mailbox === "" ? {} : { mailbox: { contains: mailbox, mode: "insensitive" as const } }),
  };
}

type HeldIntakeDbRow = Prisma.SuspendedIntakeGetPayload<{ select: typeof ROW_SELECT }>;

function toHeldIntakeRow(r: HeldIntakeDbRow, f: HeldIntakeAuditFacts): HeldIntakeRow {
  return {
    id: r.id,
    reason: r.reason,
    status: r.status,
    mailbox: r.mailbox,
    fromAddress: r.fromAddress,
    subject: r.subject,
    messageId: r.messageId,
    rawRef: r.rawRef,
    snippet: r.snippet,
    detail: f.detail,
    senderVerified: heldIntakeSenderVerified(r.reason, f.senderAuthenticated),
    createdAt: r.createdAt.toISOString(),
    ticketId: r.ticketId,
    ticketNumber: r.ticket?.number ?? null,
    releasedAt: r.releasedAt === null ? null : r.releasedAt.toISOString(),
    releasedBy:
      r.releasedBy === null
        ? null
        : { id: r.releasedBy.id, name: r.releasedBy.name, email: r.releasedBy.email, image: r.releasedBy.image },
    hasUsableSender: normalizeMailboxAddress(r.fromAddress) !== null,
    // Only meaningful on a FORWARDED hold; narrowed here so no other reason can render the choice.
    candidateRequesterEmail: r.reason === "FORWARDED" ? r.candidateRequesterEmail : null,
    discardedAt: f.discardedAt,
    discardedBy: f.discardedBy,
    discardNote: f.discardNote,
  };
}

/**
 * One page of held messages, newest first, with the matched total and the next keyset cursor.
 *
 * Newest first, not oldest first: held mail is triaged like an inbox, and the message that just
 * failed DMARC is the one a reviewer is looking for. `status` defaults to NEW for the same reason.
 *
 * Why this exists at all: the read used to `take` 100 and stop, and the page printed "100 messages
 * shown" with no pager. Nothing in `SuspendedIntake` is ever deleted — the append-only triggers see
 * to that — so the All view crosses 100 permanently, and the rows past the cut were the OLDEST ones:
 * on the one surface whose whole justification is that a wire instruction which fails DMARC must not
 * sit unseen, they were unreachable at any width. So: `take: limit + 1` to detect the next page, a
 * `(createdAt, id)` keyset cursor, and a `total` that counts the whole filter.
 *
 * `total` deliberately ignores the cursor, exactly as `queryAuditLog`'s does: a figure that shrank
 * as the reviewer paged would read as messages leaving the table.
 *
 * `ctx` is optional and matches `listStaffUsers`' convention: with a request context the denial is
 * recorded as `AUTHZ_DENIED` before the throw; without it the caller's own gate writes the row.
 */
export async function listHeldIntakePage(
  viewer: Viewer,
  query: HeldIntakeQuery = {},
  ctx?: RequestContext,
): Promise<HeldIntakePage> {
  if (!canReviewHeldIntake(viewer.groups)) await denyAndThrow(viewer, ctx, "intake:review list");

  const take = Math.min(Math.max(query.limit ?? HELD_INTAKE_DEFAULT_ROWS, 1), HELD_INTAKE_MAX_ROWS);
  const where = heldIntakeWhere(query);
  const after = decodeHeldIntakeCursor(query.cursor);

  // Keyset, not offset: "everything strictly older than the last row on screen", with the id as the
  // tie-break for rows that share a millisecond. An offset would skip or repeat rows whenever the
  // intake path held a new message between two taps of Load more.
  const keyset: Prisma.SuspendedIntakeWhereInput =
    after === null
      ? where
      : {
          AND: [
            where,
            {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            },
          ],
        };

  const [found, total] = await Promise.all([
    prisma.suspendedIntake.findMany({
      where: keyset,
      select: ROW_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
    }),
    prisma.suspendedIntake.count({ where }),
  ]);

  const hasMore = found.length > take;
  const rows = hasMore ? found.slice(0, take) : found;
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last !== undefined ? encodeHeldIntakeCursor(last) : null;

  const facts = await auditFactsFor(rows.map((r) => r.id));

  return { rows: rows.map((r) => toHeldIntakeRow(r, facts.get(r.id) ?? emptyFacts())), nextCursor, total };
}

/**
 * The rows of the first (or cursored) page, without the pager metadata.
 *
 * Kept as its own export because it is what every caller outside `/admin/intake` wants — the tests
 * and any future read that only needs the rows — and because changing its shape would change a
 * signature several call sites already depend on.
 */
export async function listHeldIntake(
  viewer: Viewer,
  query: HeldIntakeQuery = {},
  ctx?: RequestContext,
): Promise<HeldIntakeRow[]> {
  return (await listHeldIntakePage(viewer, query, ctx)).rows;
}

/** Held messages per reason for the list being shown, plus the NEW backlog the page's banner claims. */
export type HeldIntakeCounts = {
  /**
   * Per-reason counts for the SAME status and mailbox filter the list is running under — these are
   * what the reason chips label themselves with, so a chip can never describe rows that are not on
   * screen. Unbounded by `HELD_INTAKE_MAX_ROWS`: a count is the truth about the table, not about the
   * page of rows.
   */
  byReason: Record<SuspendedIntakeReason, number>;
  /** The sum of `byReason` — how many rows match the current filter. */
  total: number;
  /**
   * `NEW` rows across every mailbox. The amber banner and the Held chip's badge claim the whole
   * backlog, so they are counted on the whole backlog and do not move when the reviewer widens the
   * status filter or types a mailbox.
   */
  waitingTotal: number;
  /** `NEW` rows held as `UNAUTHENTICATED` — the "check those first" figure in the banner. */
  waitingUnauthenticated: number;
};

/**
 * The counts behind `/admin/intake`.
 *
 * `query` is the SAME status and mailbox the list is showing. Counting only `NEW` (which this did
 * until the round-2 fix) put two wrong numbers on the page: switching the status filter to Released,
 * Discarded or All left the chips describing the NEW backlog while the rows below them were something
 * else, and once the desk had worked the queue to zero every count was 0, so `reasonsPresent` was
 * empty and the entire reason-filter row vanished at exactly the moment an operator widened the
 * filter to look at history.
 *
 * `ctx` stays the second parameter so every existing call site is unchanged.
 */
export async function heldIntakeCounts(
  viewer: Viewer,
  ctx?: RequestContext,
  query: { status?: SuspendedIntakeStatus | "ALL"; mailbox?: string } = {},
): Promise<HeldIntakeCounts> {
  if (!canReviewHeldIntake(viewer.groups)) await denyAndThrow(viewer, ctx, "intake:review counts");

  const [scoped, waiting] = await Promise.all([
    prisma.suspendedIntake.groupBy({
      by: ["reason"],
      // The SAME filter builder the list runs on, minus the reason (which is the grouping key here),
      // so a chip's number and the rows it filters to can never be computed two different ways.
      where: heldIntakeWhere({ status: query.status, mailbox: query.mailbox }),
      _count: { _all: true },
    }),
    prisma.suspendedIntake.groupBy({
      by: ["reason"],
      where: { status: "NEW" },
      _count: { _all: true },
    }),
  ]);

  const byReason = Object.fromEntries(SUSPENDED_INTAKE_REASONS.map((r) => [r, 0])) as Record<
    SuspendedIntakeReason,
    number
  >;
  let total = 0;
  for (const g of scoped) {
    byReason[g.reason] = g._count._all;
    total += g._count._all;
  }

  let waitingTotal = 0;
  let waitingUnauthenticated = 0;
  for (const g of waiting) {
    waitingTotal += g._count._all;
    if (g.reason === "UNAUTHENTICATED") waitingUnauthenticated = g._count._all;
  }

  return { byReason, total, waitingTotal, waitingUnauthenticated };
}

/** True for a value the review page may put in the `status` filter. */
export function isHeldIntakeStatus(value: string): value is SuspendedIntakeStatus {
  return (SUSPENDED_INTAKE_STATUSES as readonly string[]).includes(value);
}

/** True for a value the review page may put in the `reason` filter. */
export function isHeldIntakeReason(value: string): value is SuspendedIntakeReason {
  return (SUSPENDED_INTAKE_REASONS as readonly string[]).includes(value);
}
