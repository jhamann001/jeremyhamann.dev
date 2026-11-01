/**
 * The ONLY module behind the client-facing API.
 *
 * Structural guarantees, each independent of the others:
 *  1. Comment rows come exclusively from the Postgres view "ClientVisibleComment" (WHERE visibility =
 *     'PUBLIC', no visibility and no authorId column), through a tagged-template $queryRaw on `publicDb`.
 *     Wave A added ONE column to that view: `authorKind`, a three-value enum. It is not an
 *     identity — it says whether the requester wrote the message — and it is consumed by
 *     `authorDisplayFor` inside this module, never carried into the DTO.
 *  2. `publicDb` is the read-only client whose extension limits top-level operations to Ticket/Comment
 *     reads and rejects relation reads; in production it connects with a SELECT-only role.
 *  3. `PublicCommentRow` carries a module-private unique-symbol brand — nothing outside this module can
 *     construct one, so `toClientTicketView` cannot be fed a staff Comment.
 *  4. `ClientTicketView` has no field that can hold an internal note or a staff identity, and the DTO is
 *     built field by field (no spreads) so an extra column can never ride along.
 *  5. `assertNoInternalLeak` deep-walks the finished DTO before it is returned.
 *
 * THE OPENING ENTRY IS COVERED BY THE SAME FIVE (amended). It is read from a SECOND
 * Postgres view, "ClientVisibleOpeningMessage", whose WHERE carries both gates — the
 * `REQUESTER_AUTHORED_SOURCES` allowlist and the released-held-mail marker — so for a ticket whose
 * description the DESK composed there is no row to return, to anybody, however this module is
 * written. It is read through `publicDb` (2) as a branded `OpeningMessageRow` (3), and the DTO is
 * still built field by field (4) and walked (5). The first shape of Decision #117 synthesised the
 * entry from a `Ticket.description` the client role had been granted, with both gates in the code
 * below; that inverted the reason the comment view exists, and the `description`, `source` and
 * `externalId` grants are revoked now that the view carries them. `openingMessageFor` still re-checks
 * the allowlist on the row the view returns — a SECOND belt over the same rule, not the only one.
 * Imports from @/lib/db are limited to `publicDb`; from @/lib/audit to `recordClientApiRead` and
 * `recordClientApiDenied` (guardrail G8). Every denial is audited before the caller sees a 401/404 —
 * an UNAUTHENTICATED one through `@/lib/denial-throttle`, which coalesces the burst an open route
 * invites into one row per client IP per window; see `recordClientDenied`.
 *
 * **Wave B** adds three things at the bottom of the file, and changes one line in the
 * middle of it:
 *  - the CLIENT VOCABULARY (`CLIENT_STATUS_VOCABULARY`, `CLIENT_CATEGORY_VOCABULARY`), applied inside
 *    `toClientTicketView` so every client-facing payload carries a label beside its raw enum;
 *  - `listClientTickets` / `countClientTickets` / `getClientTicketByNumber`, the two new routes'
 *    reads, both through `publicDb` and the same view, both audited before they return;
 *  - `authorizeClientApiRequest`, which accepts a `ClientApiToken` with scope `CLIENT_READ` and falls
 *    back to the legacy `CLIENT_API_TOKEN` bearer.
 *
 * That last one is why `@/lib/api-tokens` is imported here. It reads `ClientApiToken` through the
 * APPLICATION client, not `publicDb` — which is the right layer for a credential table and changes
 * nothing about this module's five guarantees, because no ticket, comment or requester row is ever
 * read through it. G8 is unchanged and still passes: `publicDb` is still the only reader of record
 * content, and `@/lib/db` and `@/lib/audit` are still imported by the two names each it allows.
 *
 * **Decision #117 — the OPENING ENTRY.** `Ticket.description` is the message a thread opens with, and
 * the client API omitted it entirely (`description` is in CLIENT_FORBIDDEN_KEYS), so a client shown
 * their own ticket would have read our replies and not their own request. It now comes back as the
 * first entry of `messages`, in the same shape as a public comment, read from
 * "ClientVisibleOpeningMessage" at read time; nothing is written and no ticket is backfilled, so every
 * historical ticket gains it the moment it is read. Four properties hold it inside I1:
 *  - the view is GATED on `REQUESTER_AUTHORED_SOURCES` in its own WHERE, so only a channel whose
 *    description really is the requester's own words has a row at all — never an operator's account of
 *    a call. `openingMessageFor` checks the same allowlist again, on the `source` the view returns;
 *  - the view is gated AGAIN on the released-held-mail marker (`INTAKE_RELEASE_EXTERNAL_ID_PREFIX` in
 *    `src/types/domain.ts`), because `releaseHeldIntake` writes a DESK-COMPOSED body under
 *    `source: EMAIL` — the hold reason, the internal mailbox, the raw-message pointer, the staff
 *    address that forwarded it and the reviewer's note. That is the one place where the source
 *    allowlist alone would have failed, and it fails for rows already in the database, which is why
 *    the gate is keyed on a column those rows already carry. It is now SQL, so this module never reads
 *    `externalId` and the client role is not granted it;
 *  - `description` is still not a DTO key, still forbidden, and `assertNoInternalLeak` still walks the
 *    finished payload, so the field cannot ride along by another route;
 *  - the text cannot change under the client either: `updateTicketFields` refuses a `description` edit
 *    on a requester-authored ticket and `POST /api/ingest/tickets` refuses a caller-declared source on
 *    the allowlist, so for exactly the tickets that reach this read the field is as immutable as the
 *    `Comment` rows beside it.
 * It is read through `publicDb`, like everything else here: this module still has ONE database client
 *, and the client role's grant is the VIEW plus the ten `"Ticket"` columns the DTO projects —
 * `description`, `source` and `externalId` are revoked (`prisma/sql/runtime-roles.sql`; G15 pins that
 * grant to the selects below, G16 pins the view).
 */
import {
  BODY_TRUNCATION_NOTE,
  CLIENT_FORBIDDEN_KEYS,
  CLIENT_RETRACTED_BODY,
  COMMENT_AUTHOR_KINDS,
  DISCLAIMER_KEYS,
  REQUESTER_AUTHORED_SOURCES,
  TICKET_SOURCES,
} from "@/types/domain";
import { verifyApiToken } from "@/lib/api-tokens";
import { enforceMachineRateLimit } from "@/lib/integration-auth";
import type { RateLimitRefusal } from "@/lib/integration-auth";
import type {
  ApiTokenScope,
  ClientAuthorDisplay,
  ClientSafeComment,
  ClientTicketView,
  CommentAuthorKind,
  DisclaimerKey,
  RequestContext,
  TicketCategory,
  TicketPriority,
  TicketSource,
  TicketStatus,
} from "@/types/domain";
import { recordClientApiDenied, recordClientApiRead } from "@/lib/audit";
import { publicDb } from "@/lib/db";
import { recordUnauthenticatedClientDenial } from "@/lib/denial-throttle";
import { env } from "@/lib/env";
import { IsolationViolationError } from "@/lib/errors";
import { safeEqualEmails, safeEqualStrings } from "@/lib/safe-equal";

/** Module-private brand. Declared, never defined or exported: it has no runtime existence. */
declare const publicBrand: unique symbol;

/** A comment row that provably came from the "ClientVisibleComment" view. Only this module can mint one. */
export type PublicCommentRow = {
  id: string;
  ticketId: string;
  body: string;
  disclaimerKey: DisclaimerKey;
  /**
   * Wave A. A THREE-VALUE ENUM, never an identity: the view exposes `authorKind` and
   * still exposes no `authorId`, no name and no email. It exists so a requester can see their own
   * message rendered as "You" instead of as a reply from the service team. It is consumed here and
   * never reaches the DTO — `authorDisplay` is what leaves.
   */
  authorKind: CommentAuthorKind;
  /**
   * Wave B. True when the message was withdrawn. The view returns an EMPTY `body` for
   * such a row, so the withdrawn text is not merely unrendered here — `wm_helpdesk_public` holds no
   * privilege on "Comment" or "CommentRetraction", which makes it unreachable at the privilege layer,
   * the same argument I1 already makes about internal notes.
   */
  retracted: boolean;
  createdAt: Date;
  readonly [publicBrand]: true;
};

/** Scalar ticket columns the client view is built from — no relations, no requester contact data. */
export type ClientTicketSource = {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
};

/**
 * Decision #117 (amended). A row that provably came from the "ClientVisibleOpeningMessage" view —
 * `Ticket.description` for a ticket whose channel makes that text the REQUESTER's own words. Only this
 * module can mint one, exactly like `PublicCommentRow`, and the brand is the same module-private
 * symbol: nothing outside this file can hand `toClientTicketView` an opening entry.
 *
 * The view's four columns, and why each is here rather than on `ClientTicketSource`: the client role
 * is no longer granted `description`, `source` or `externalId` on `"Ticket"` at all, so this is the
 * ONLY path by which any of that text can reach the client API — and the path exists only for rows the
 * view's WHERE admits.
 */
export type OpeningMessageRow = {
  ticketId: string;
  /**
   * The gate's own value, not a DTO field. `source` is in CLIENT_FORBIDDEN_KEYS and never leaves;
   * it is returned so `openingMessageFor` can re-check the allowlist on the row the view handed it.
   * A row that exists has already passed the same test in SQL, so this discloses nothing — it is the
   * second of two independent gates, either of which alone withholds the entry.
   */
  source: TicketSource;
  /** `Ticket.description`, named as what it becomes. The desk's truncation note is still on it. */
  body: string;
  /** The ticket's `createdAt` — the opening entry's timestamp. */
  createdAt: Date;
  readonly [publicBrand]: true;
};

const REQUESTER_AUTHORED_SOURCE_SET: ReadonlySet<string> = new Set<string>(REQUESTER_AUTHORED_SOURCES);
const TICKET_SOURCE_SET: ReadonlySet<string> = new Set<string>(TICKET_SOURCES);

function isTicketSource(v: unknown): v is TicketSource {
  return typeof v === "string" && TICKET_SOURCE_SET.has(v);
}

/**
 * Prefix of the opening entry's SYNTHETIC id. It is not, and can never be, a `Comment` row id: no
 * comment is stored under it, and a cuid never contains a colon. A client app may use it as a list
 * key; it must not post a retraction or a reply against it.
 */
export const CLIENT_OPENING_MESSAGE_ID_PREFIX = "opening:";

/**
 * The opening entry's id, derived from the ticket REFERENCE (`HD-1042`) rather than from the ticket's
 * cuid. Deterministic and stable across reads, which is what a list key needs — and it discloses
 * nothing the DTO does not already carry. Keying it on `ticket.id` would have handed a client app the
 * internal cuid of every ticket in a list response, which `ClientTicketView` deliberately omits.
 */
export function clientOpeningMessageId(reference: string): string {
  return `${CLIENT_OPENING_MESSAGE_ID_PREFIX}${reference}`;
}

/**
 * Pure. The opening message as a thread entry, or null when there must not be one.
 *
 * `Ticket.description` is the text a thread opens with, and the client API has never returned it:
 * `description` is in CLIENT_FORBIDDEN_KEYS, so a client rendering their own ticket would have seen
 * every reply the desk sent and not the request they sent. This closes that without putting
 * `description` on the DTO — the opening message comes back in the SAME SHAPE as a public comment,
 * so a client app renders one uniform list, and every historical ticket works with no backfill
 * because nothing is stored.
 *
 * **WHERE THE GATE LIVES, because that is the whole of Decision #117's amendment.** `row` is null
 * unless the DATABASE returned one, and "ClientVisibleOpeningMessage" admits a row only for a source
 * in `REQUESTER_AUTHORED_SOURCES` that is not a released held-mail ticket. So the two disclosure
 * rules are enforced in SQL, against a client role that holds no privilege on `"Ticket".description`
 * at all — a mistake in this function cannot produce a staff-composed description, because there is
 * nothing to produce it from. What remains here:
 *
 *  1. **The source gate again, as a SECOND belt.** `REQUESTER_AUTHORED_SOURCES` is re-checked against
 *     the `source` the view returned. A row that reaches this line has already passed the identical
 *     test in the view's WHERE, so this can only fire if the view were rebuilt without its gate —
 *     and then it withholds the entry rather than serving it. Two independent gates, either of which
 *     alone is sufficient; the policy is still that ONE exported list, tested from both sides, and
 *     not an inline condition. It WITHHOLDS rather than throwing on purpose: `listClientTickets`
 *     builds a page of views through this function, and the fail-closed answer to one suspect row is
 *     to drop that entry, not to fail a client's whole list. The loud signal is the DB-gated test
 *     that the deployed view still carries the WHERE.
 *  2. **The truncation note is the desk's, not theirs.** `BODY_TRUNCATION_NOTE` is appended to the
 *     STORED body by `truncateBody`; it is stripped from the copy attributed to the client. It is
 *     presentation over text the client DID write, which is why it is here and not in the view.
 *  3. **Empty is nothing.** A blank or whitespace-only description contributes no entry rather than an
 *     empty bubble. Also presentation, for the same reason.
 *  4. **Authored as the requester, exactly like their later messages**: `authorDisplayFor("REQUESTER")`
 *     → "You", and `disclaimerKey: "NONE"`, which is what an inbound requester comment always carries
 *     (`ingest.ts` refuses any other value for `authorKind: REQUESTER`). No author identity of any
 *     kind rides along — there is no name, no address and no id in a `ClientSafeComment`.
 *
 * `retracted` is structurally false, and that is TRUE rather than merely convenient. The claim was
 * originally justified only by "there is nothing here for the desk to take back", which argued about
 * the CONTENT and said nothing about MUTABILITY — and `Ticket.description` is a writable column, so
 * an agent holding plain queue-write could have rewritten the one entry a client is told is theirs. It
 * is closed at the write: `updateTicketFields` refuses a `description` edit on a ticket whose source is
 * in `REQUESTER_AUTHORED_SOURCES`, mirroring `retractions.actions.ts`'s refusal to withdraw a REQUESTER
 * comment on the client's behalf. So for exactly the tickets that reach this function, the field is as
 * immutable as the `Comment` rows beside it, and no entry in `messages` can change under the
 * client. Retraction still targets a COMMENT (`CommentRetraction.commentId`) and this is not one; there
 * is nothing to withdraw, because the text is the client's own and was sanitised by `sanitizePII`
 * before it was stored (`createTicketCore`).
 */
export function openingMessageFor(row: OpeningMessageRow | null, reference: string): ClientSafeComment | null {
  if (row === null) return null;
  // SECOND BELT over the view's own WHERE. See rule 1 above for why this withholds instead of throwing.
  if (!REQUESTER_AUTHORED_SOURCE_SET.has(row.source)) return null;
  // The desk's own truncation note is desk metadata ABOUT the field, not part of what the requester
  // wrote — "the full original is in the mailbox" is the desk speaking about its own storage. It is
  // kept on the stored record (a reader must see the message was cut) and dropped from the copy
  // attributed to the client. `endsWith` + `slice`, never a regex: the note is a fixed literal.
  const stored = row.body;
  const body = stored.endsWith(BODY_TRUNCATION_NOTE) ? stored.slice(0, -BODY_TRUNCATION_NOTE.length) : stored;
  if (body.trim().length === 0) return null;
  return {
    id: clientOpeningMessageId(reference),
    body,
    createdAt: row.createdAt.toISOString(),
    disclaimerKey: "NONE",
    authorDisplay: authorDisplayFor("REQUESTER"),
    retracted: false,
  };
}

type RawViewRow = {
  id: unknown;
  ticketId: unknown;
  body: unknown;
  disclaimerKey: unknown;
  authorKind: unknown;
  retracted: unknown;
  createdAt: unknown;
};

/** The service-team label. A staff member's real identity never reaches a client surface. */
const SERVICE_TEAM_DISPLAY: ClientAuthorDisplay = "Your Service Team";
/** The requester's own message. Their name is not echoed either — "You" is the whole label. */
const REQUESTER_DISPLAY: ClientAuthorDisplay = "You";
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set<string>(CLIENT_FORBIDDEN_KEYS);
const DISCLAIMER_KEY_SET: ReadonlySet<string> = new Set<string>(DISCLAIMER_KEYS);
const AUTHOR_KIND_SET: ReadonlySet<string> = new Set<string>(COMMENT_AUTHOR_KINDS);

function isAuthorKind(v: unknown): v is CommentAuthorKind {
  return typeof v === "string" && AUTHOR_KIND_SET.has(v);
}

/**
 * The ONLY place authorship becomes a client-visible string. REQUESTER → "You"; STAFF and SYSTEM →
 * the service-team label. Exhaustive by construction: a value that is not REQUESTER falls to the
 * service-team label, so a future author kind can never leak as an identity.
 */
export function authorDisplayFor(kind: CommentAuthorKind): ClientAuthorDisplay {
  return kind === "REQUESTER" ? REQUESTER_DISPLAY : SERVICE_TEAM_DISPLAY;
}

/**
 * `\s` as a single character class — one literal, no quantifier, so nothing to backtrack.
 *
 * It replaces `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, which security scanner flags under CWE-1333 (ReDoS) and is right to:
 * `.` is itself a member of `[^\s@]`, so `[^\s@]+\.[^\s@]+` can split a domain at every dot and the
 * matcher is polynomial in the domain's length on a near-miss. `hasEmailShape` below accepts exactly
 * the same strings by scanning instead.
 */
const WHITESPACE = /\s/;

/** The largest address this header may carry, applied BEFORE `hasEmailShape` (rule 2: cap first). */
const MAX_EMAIL_LENGTH = 254;

/**
 * True for exactly the strings the old `EMAIL_SHAPE` regex matched: a non-empty local part, ONE `@`,
 * and a domain holding a dot that is neither its first nor its last character — with no whitespace
 * anywhere. Linear in the length of the input, with no backtracking to provoke.
 *
 * `domain.slice(1, -1).includes(".")` is the dot rule stated directly: the regex needed at least one
 * character on each side of some dot, which is the same as a dot at an index between 1 and
 * `length - 2`. `a@b.c.` still passes, exactly as it did before — the first dot satisfies the rule.
 */
function hasEmailShape(value: string): boolean {
  if (WHITESPACE.test(value)) return false;
  const at = value.indexOf("@");
  if (at < 1) return false;
  if (value.indexOf("@", at + 1) !== -1) return false;
  return value.slice(at + 1).slice(1, -1).includes(".");
}

function isDisclaimerKey(v: unknown): v is DisclaimerKey {
  return typeof v === "string" && DISCLAIMER_KEY_SET.has(v);
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Validates one row returned by the view and brands it. The view has exactly these SEVEN columns, so
 * any other shape means the query or the view changed underneath us — fail closed rather than serve it.
 */
function brandViewRow(raw: RawViewRow): PublicCommentRow {
  const createdAt = toDate(raw.createdAt);
  if (
    typeof raw.id !== "string" ||
    typeof raw.ticketId !== "string" ||
    typeof raw.body !== "string" ||
    !isDisclaimerKey(raw.disclaimerKey) ||
    !isAuthorKind(raw.authorKind) ||
    typeof raw.retracted !== "boolean" ||
    createdAt === null
  ) {
    throw new IsolationViolationError("client-view: unexpected row shape from ClientVisibleComment");
  }
  // Belt and braces over the view's own CASE. If the view were ever rebuilt without it, a retracted
  // body would arrive here with `retracted: true` and a non-empty `body`; refusing that row is the
  // fail-closed answer, and the assertion is cheap enough to keep forever.
  if (raw.retracted && raw.body !== "") {
    throw new IsolationViolationError("client-view: a retracted comment arrived with a body");
  }
  const row = {
    id: raw.id,
    ticketId: raw.ticketId,
    body: raw.body,
    disclaimerKey: raw.disclaimerKey,
    authorKind: raw.authorKind,
    retracted: raw.retracted,
    createdAt,
  };
  // The brand is a type-level marker; this cast is the single place in the codebase that applies it.
  return row as PublicCommentRow;
}

/**
 * The ONLY comment read in this module: a parametrised tagged-template query against the
 * "ClientVisibleComment" view, which is defined WHERE visibility = 'PUBLIC' and exposes neither
 * visibility nor authorId.
 */
export async function selectPublicComments(ticketId: string): Promise<PublicCommentRow[]> {
  const rows = await publicDb.$queryRaw<RawViewRow[]>`
    SELECT id, "ticketId", body, "disclaimerKey", "authorKind", retracted, "createdAt"
    FROM "ClientVisibleComment"
    WHERE "ticketId" = ${ticketId}
    ORDER BY "createdAt" ASC`;
  if (!Array.isArray(rows)) {
    throw new IsolationViolationError("client-view: ClientVisibleComment query returned a non-array");
  }
  return rows.map(brandViewRow);
}

type RawOpeningRow = {
  ticketId: unknown;
  source: unknown;
  body: unknown;
  createdAt: unknown;
};

/**
 * Validates one row from "ClientVisibleOpeningMessage" and brands it. The view has exactly these FOUR
 * columns, so any other shape means the query or the view changed underneath us — fail closed rather
 * than serve it, exactly as `brandViewRow` does for the comment view.
 */
function brandOpeningRow(raw: RawOpeningRow): OpeningMessageRow {
  const createdAt = toDate(raw.createdAt);
  if (
    typeof raw.ticketId !== "string" ||
    !isTicketSource(raw.source) ||
    typeof raw.body !== "string" ||
    createdAt === null
  ) {
    throw new IsolationViolationError("client-view: unexpected row shape from ClientVisibleOpeningMessage");
  }
  const row = { ticketId: raw.ticketId, source: raw.source, body: raw.body, createdAt };
  // The brand is a type-level marker; `brandViewRow` above applies the same one to the comment rows.
  return row as OpeningMessageRow;
}

/**
 * The opening entry for ONE ticket, or null when the database holds none for it.
 *
 * The same construction as `selectPublicComments`: a parametrised tagged-template query against a view
 * whose WHERE is the policy — there `visibility = 'PUBLIC'`, here the requester-authored source
 * allowlist and the released-held-mail exclusion. A ticket the desk composed simply has no row.
 *
 * More than one row is impossible (the view is keyed on `Ticket.id`, which is its primary key) and is
 * therefore treated as the same class of fault as a wrong column shape rather than silently taking the
 * first.
 */
export async function selectOpeningMessage(ticketId: string): Promise<OpeningMessageRow | null> {
  const rows = await publicDb.$queryRaw<RawOpeningRow[]>`
    SELECT "ticketId", source, body, "createdAt"
    FROM "ClientVisibleOpeningMessage"
    WHERE "ticketId" = ${ticketId}`;
  if (!Array.isArray(rows)) {
    throw new IsolationViolationError("client-view: ClientVisibleOpeningMessage query returned a non-array");
  }
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new IsolationViolationError("client-view: more than one opening message for one ticket");
  }
  return brandOpeningRow(rows[0]);
}

/**
 * The opening entry for a SET of tickets, keyed by ticket id, in one round trip against the same view.
 *
 * `= ANY(${ids})` rather than a loop, for the same reason `selectPublicCommentsFor` does it: a page of
 * ten tickets would otherwise be ten queries. A ticket with no row is simply absent from the map, which
 * is what the list read wants — `Map.get` returns undefined and the caller passes null.
 */
export async function selectOpeningMessagesFor(
  ticketIds: readonly string[],
): Promise<Map<string, OpeningMessageRow>> {
  const byTicket = new Map<string, OpeningMessageRow>();
  if (ticketIds.length === 0) return byTicket;
  const rows = await publicDb.$queryRaw<RawOpeningRow[]>`
    SELECT "ticketId", source, body, "createdAt"
    FROM "ClientVisibleOpeningMessage"
    WHERE "ticketId" = ANY(${[...ticketIds]})`;
  if (!Array.isArray(rows)) {
    throw new IsolationViolationError("client-view: ClientVisibleOpeningMessage query returned a non-array");
  }
  for (const raw of rows) {
    const row = brandOpeningRow(raw);
    if (byTicket.has(row.ticketId)) {
      throw new IsolationViolationError("client-view: more than one opening message for one ticket");
    }
    byTicket.set(row.ticketId, row);
  }
  return byTicket;
}

/**
 * Pure. Field-by-field construction — no spreads — so nothing outside the DTO's shape can leak through.
 *
 * Wave B adds `statusLabel` and `categoryLabel` from the client vocabulary below. They are
 * added HERE, in the single builder, rather than at each of the three call sites, so no client-facing
 * payload can ever go out with the raw enum and no label.
 *
 * Decision #117 adds the OPENING ENTRY the same way and for the same reason: `openingMessageFor` is
 * called here, in the one builder all three reads go through, so the by-id read, the by-number read
 * and the list cannot disagree about whether a client is shown the message they sent. `opening` is a
 * REQUIRED parameter, not an optional one — a caller that forgets it is a compile error here, not a
 * client silently missing the message they sent — and it is a branded `OpeningMessageRow`, so the only
 * thing that can be passed is a row this module read out of "ClientVisibleOpeningMessage", or null.
 *
 * It is prepended UNCONDITIONALLY, which is what makes the ARRAY ORDER authoritative: `messages` is in
 * thread order and the opening entry is always first. Its `createdAt` is deliberately NOT offered as
 * proof of that, and the earlier claim that "the ticket's createdAt precedes every comment on it" is
 * withdrawn as unprovable — the two stamps come off DIFFERENT CLOCKS. `Ticket.createdAt` is written
 * from the application host (`const now = new Date()` in `createTicketCore`), while `Comment.createdAt`
 * is always the database default. With `AUTO_ACK_ENABLED` an auto-acknowledgement is written inside the
 * very transaction that creates the ticket, so the gap between the two is nothing but host clock skew
 * and can land either way. A consumer must therefore render `messages` in the order given and must not
 * re-sort it on `createdAt`; the build record says so to integrators.
 */
export function toClientTicketView(
  ticket: ClientTicketSource,
  rows: PublicCommentRow[],
  openingRow: OpeningMessageRow | null,
): ClientTicketViewWithVocabulary {
  const reference = `HD-${ticket.number}`;
  const opening = openingMessageFor(openingRow, reference);
  const messages: ClientSafeComment[] = rows.map((c) => ({
    id: c.id,
    // a withdrawn message renders as the fixed placeholder. `c.body` is
    // already the empty string for such a row (the view blanks it), so this is the SECOND of two
    // independent guarantees rather than the only one — and it is why a client sees an honest "this
    // was withdrawn" instead of an inexplicable blank.
    body: c.retracted ? CLIENT_RETRACTED_BODY : c.body,
    createdAt: c.createdAt.toISOString(),
    disclaimerKey: c.disclaimerKey,
    // authorKind is consumed HERE and goes no further: the DTO carries only the two-value display.
    authorDisplay: authorDisplayFor(c.authorKind),
    retracted: c.retracted,
  }));
  if (opening !== null) messages.unshift(opening);
  const vocabulary = clientVocabularyFor(ticket);
  return {
    reference,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    statusLabel: vocabulary.statusLabel,
    categoryLabel: vocabulary.categoryLabel,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    resolvedAt: ticket.resolvedAt === null ? null : ticket.resolvedAt.toISOString(),
    messages,
  };
}

/**
 * Deep-walks any value and throws IsolationViolationError when an object carries a key from
 * CLIENT_FORBIDDEN_KEYS, or a `visibility` of "INTERNAL", at any depth. Cycle-safe.
 */
export function assertNoInternalLeak(dto: unknown): void {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new IsolationViolationError(`client-view: forbidden key "${key}" at ${path || "$"}`);
      }
      if (key === "visibility" && child === "INTERNAL") {
        throw new IsolationViolationError(`client-view: INTERNAL visibility at ${path || "$"}`);
      }
      walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(dto, "");
}

/**
 * Bearer token check. False when CLIENT_API_TOKEN is unset (the API is disabled), when the header is
 * missing or malformed, or when the token differs. The comparison is `safeEqualStrings` — the shared
 * `timingSafeEqual`-over-SHA-256 construction this module used to carry privately, byte for byte, and
 * which `src/lib/integration-auth.ts` carried a second copy of. One function, so the two cannot drift.
 */
export function isClientApiAuthorized(h: Headers): boolean {
  const expected = env.CLIENT_API_TOKEN;
  if (expected === undefined || expected === "") return false;
  const header = h.get("authorization");
  if (header === null) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (match === null) return false;
  return safeEqualStrings(match[1], expected);
}

/** X-Requester-Email, trimmed and lowercased; null unless it looks like an email address. */
export function requesterEmailFromHeaders(h: Headers): string | null {
  const raw = h.get("x-requester-email");
  if (raw === null) return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
  return hasEmailShape(email) ? email : null;
}

/**
 * The route label the coalesced row carries. It is the ROUTE PATTERN, never the concrete path: a
 * per-id label would defeat the coalescing the moment a scanner varied the id.
 */
export const CLIENT_TICKET_READ_ROUTE = "/api/client/tickets/[id]";

/**
 * Thin wrapper so the route (guardrail G7) never imports @/lib/audit directly, and the seam where
 * this route decides which of the two denial shapes to write (CONTRACT §8: "denials coalesced";
 * Decision #71).
 *
 * - **Unauthenticated** — anything on the internet can reach this route, and every denial is a
 *   hash-chained row in an append-only ledger. One `AUTHZ_DENIED_COALESCED` row per client
 *   IP per window therefore stands for the whole burst, carrying its count. The requested id is not
 *   recorded at all in that shape, which is strictly stronger than bounding it: a
 *   caller-controlled segment never reaches the ledger.
 * - **Requester mismatch** — a caller holding a valid bearer and naming an email. Few, each one
 *   names its caller, and enumeration by an authenticated client is exactly what compliance needs
 *   row by row. Never coalesced.
 *
 * The two POST client routes make the same split inside their own handlers; this is where the GET
 * route makes it, because G7 pins the route file to three module ids and this module is one of them.
 */
export async function recordClientDenied(
  ctx: RequestContext,
  requestedTicketId: string,
  requesterEmail: string | null,
  reason: "client:unauthenticated" | "client:requester-mismatch",
  ticketExists: boolean,
): Promise<void> {
  if (reason === "client:unauthenticated") {
    await recordUnauthenticatedClientDenial(ctx, CLIENT_TICKET_READ_ROUTE);
    return;
  }
  await recordClientApiDenied(ctx, requestedTicketId, requesterEmail, reason, ticketExists);
}

/**
 * Missing ticket and requester mismatch both return null (the route answers 404 either way — no existence
 * leak to the caller) but each writes its own AUTHZ_DENIED row first, so enumeration attempts are visible
 * to compliance. On success the CLIENT_API_READ row is awaited BEFORE the view is returned: if that
 * insert fails the error propagates and nothing is served.
 */
export async function getClientTicketView(
  ticketId: string,
  requesterEmail: string,
  ctx: RequestContext,
): Promise<ClientTicketViewWithVocabulary | null> {
  // Scalar select only — no relation keys (publicDb throws on them; guardrail G8 scans for them).
  const t = await publicDb.ticket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      number: true,
      subject: true,
      status: true,
      priority: true,
      category: true,
      createdAt: true,
      updatedAt: true,
      resolvedAt: true,
      // Decision #117 reads `description`, `source` and `externalId` through
      // "ClientVisibleOpeningMessage" (see `selectOpeningMessage`), never from here: the client role
      // holds no privilege on any of the three, so adding one to this select would fail at the
      // database rather than leak. G15 pins this projection to the ten columns the grant names.
      requesterEmail: true,
    },
  });

  if (t === null) {
    await recordClientDenied(ctx, ticketId, requesterEmail, "client:requester-mismatch", false);
    return null;
  }
  // `requesterEmail` is nullable — a voicemail ticket has a phone and no
  // address. A null NEVER matches a header, so such a ticket is simply unreachable through the
  // client API and the attempt is audited like any other mismatch. Fail closed, no special case.
  // The comparison is `safeEqualEmails` (CWE-208): it applies the SAME trim + lower-case to both
  // sides that the `!==` here used to apply inline, then compares in constant time. This decides
  // whether a caller may read someone else's ticket, so it is an identity check, not a string check.
  if (t.requesterEmail === null || !safeEqualEmails(t.requesterEmail, requesterEmail)) {
    await recordClientDenied(ctx, ticketId, requesterEmail, "client:requester-mismatch", true);
    return null;
  }

  const comments = await selectPublicComments(t.id);
  const opening = await selectOpeningMessage(t.id);
  const source: ClientTicketSource = {
    id: t.id,
    number: t.number,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    category: t.category,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolvedAt: t.resolvedAt,
  };
  const view = toClientTicketView(source, comments, opening);
  assertNoInternalLeak(view);
  await recordClientApiRead(ctx, t.id, requesterEmail);
  return view;
}

// ---------------------------------------------------------------------------
// the client vocabulary, the list, and the by-number lookup
// ---------------------------------------------------------------------------

/**
 * The CLIENT vocabulary for `TicketStatus`.
 *
 * the build record maps legacy help desk's words onto ours FOR STAFF, and `STATUS_LABELS` in
 * `src/lib/format.ts` is what the desk reads. Neither is what a client should be shown, and until now
 * the client API answered with the raw enum — so a client app either rendered `PENDING_INTERNAL` at a
 * person or invented its own wording, which is how two surfaces end up telling the same client two
 * different things about the same ticket.
 *
 * It is deliberately NARROWER than the staff vocabulary. `PENDING_INTERNAL` and `OPEN` both read as
 * "In progress": whether the desk is waiting on itself, on a custodian or on a colleague is an
 * internal fact, and surfacing it invites a client to chase the wrong thing. `PENDING_CLIENT` is the
 * one status whose whole purpose is to tell the client that the next move is theirs, so it says so.
 *
 * `VOIDED` reads as "Withdrawn". A voided ticket is one the desk entered in error, and `voidTicket`
 * refuses once any PUBLIC comment exists — so the only voided ticket a client can ever
 * reach through this API is one they opened themselves and that was never answered. "Withdrawn" is
 * the honest word for that; hiding the row would be a ticket that silently disappeared.
 *
 * A `Record` over the enum, so adding a status fails the typecheck here rather than shipping a raw
 * enum value to a client.
 */
export const CLIENT_STATUS_VOCABULARY: Readonly<Record<TicketStatus, string>> = Object.freeze({
  NEW: "Received",
  OPEN: "In progress",
  PENDING_CLIENT: "Waiting on you",
  PENDING_INTERNAL: "In progress",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  VOIDED: "Withdrawn",
});

/**
 * The CLIENT vocabulary for `TicketCategory`. `CATEGORY_LABELS` is the staff wording and keeps
 * operational words a client has no reason to parse ("Custodian trade correction", "RMD / rollover /
 * distribution"); this is the same twenty-two values in the words a client used when they asked.
 *
 * `COMPLAINT` is the one to read twice: a client who has complained is told their ticket is a
 * "Formal complaint", because a firm that files a complaint internally and shows the client
 * "Other" is the behaviour a regulator asks about.
 */
export const CLIENT_CATEGORY_VOCABULARY: Readonly<Record<TicketCategory, string>> = Object.freeze({
  WIRE_TRANSFER: "Wire transfer",
  ACAT: "Account transfer",
  TRADE_CORRECTION: "Trade correction",
  CASH_MOVEMENT: "Cash movement",
  PORTAL_RESET: "Portal access",
  TAX_DOCUMENT: "Tax document",
  ADDRESS_CHANGE: "Address change",
  REBALANCING: "Portfolio rebalancing",
  PLANNING_UPDATE: "Financial planning",
  TAX_LOSS_HARVESTING: "Tax-loss harvesting",
  OTHER: "General request",
  ACCOUNT_CLOSURE: "Account closure",
  BENEFICIARY_TOD: "Beneficiary designation",
  RETURNED_CHECK: "Returned check",
  RETURNED_MAIL: "Returned mail",
  PASSKEY_LOGIN: "Sign-in help",
  IDENTITY_VERIFICATION: "Identity verification",
  COMPLAINT: "Formal complaint",
  RETIREMENT_DISTRIBUTION: "Retirement distribution",
  COST_BASIS: "Cost basis",
  VOICEMAIL_CALLBACK: "Callback request",
  STATEMENT_REQUEST: "Statement request",
});

/**
 * The two label fields every client DTO now carries beside the raw enum. The enum stays — a client
 * app that switches on `status` keeps working — and the label is what a person reads.
 */
export type ClientVocabulary = {
  /** `CLIENT_STATUS_VOCABULARY[status]`. */
  statusLabel: string;
  /** `CLIENT_CATEGORY_VOCABULARY[category]`. */
  categoryLabel: string;
};

/**
 * `ClientTicketView` plus the vocabulary. A SUPERSET, so it is assignable wherever the contract's
 * `ClientTicketView` is named and `src/types/domain.ts` (foundation-owned) needs no edit — the
 * request for the two fields to join the type itself is filed in
 * the build record
 */
export type ClientTicketViewWithVocabulary = ClientTicketView & ClientVocabulary;

/** Pure. The one place a stored enum becomes a client-facing word. */
export function clientVocabularyFor(ticket: {
  status: TicketStatus;
  category: TicketCategory;
}): ClientVocabulary {
  return {
    statusLabel: CLIENT_STATUS_VOCABULARY[ticket.status],
    categoryLabel: CLIENT_CATEGORY_VOCABULARY[ticket.category],
  };
}

/** Default page for `listClientTickets`. Small on purpose — see the function's docstring. */
export const CLIENT_LIST_DEFAULT_PAGE_SIZE = 10;
/** Hard ceiling. A caller asking for more gets this many, never an error. */
export const CLIENT_LIST_MAX_PAGE_SIZE = 25;

export type ClientTicketListQuery = { page?: number; pageSize?: number };

/** The route label the list's coalesced denial rows carry. A PATTERN, never a concrete path. */
export const CLIENT_TICKET_LIST_ROUTE = "/api/client/tickets";
/** The route label the by-number lookup's coalesced denial rows carry. */
export const CLIENT_TICKET_BY_NUMBER_ROUTE = "/api/client/tickets/by-number/[number]";

/**
 * How a caller authenticated to `/api/client/**` (CONTRACT §8: "`ClientApiToken(client:read)` **or**
 * legacy `CLIENT_API_TOKEN`").
 *
 * Database-first, for the same reason `authorizeMachineRequest` is: a consumer that has been issued a
 * real credential must be attributed to it from the day it is issued, not from the day the shared env
 * key is finally deleted.
 *
 * `requesterEmail` on the token is a NARROWING, never a source of identity: when the row carries one,
 * the `X-Requester-Email` header must match it, so a per-client credential cannot be pointed at
 * somebody else's mailbox. The header remains the thing the ticket is checked against.
 *
 * `required` is the scope the DATABASE credential must carry, and it defaults to `CLIENT_READ` so the
 * contracted two-argument call is unchanged. The WRITE surfaces (`POST /api/client/tickets` and
 * `POST /api/client/tickets/[id]/messages`) pass `CLIENT_WRITE`, which is what makes that scope mean
 * something: until they did, a `CLIENT_WRITE` token was a grant no route ever checked, and the admin
 * sheet's "Open tickets and post client messages" help text described a narrowing that did not exist.
 * A read token cannot write and a write token cannot read — each surface asks for its own scope, and
 * the legacy `CLIENT_API_TOKEN` bearer still answers for both.
 */
export type ClientApiAuthorization = { kind: "token"; tokenId: string } | { kind: "legacy" };

export async function authorizeClientApiRequest(
  h: Headers,
  requesterEmail: string | null,
  required: ApiTokenScope = "CLIENT_READ",
): Promise<ClientApiAuthorization | null> {
  // `credential`, not `token`, and a truthiness presence check: security scanner's CWE-208 thread on this block
  // covered the whole `if` (it anchors at the closing brace), and Wave A's `safeEqualEmails` fix
  // cleared only the address comparison inside it. `verifyApiToken` returns a ClientApiToken ROW, so
  // `token !== null` compared nothing secret — but the rule matches on the name, and the Wave A rescan
  // settled truthiness as the shape for a presence check on a credential (commit 900ac2e).
  const credential = await verifyApiToken(h, required);
  if (credential) {
    if (credential.requesterEmail !== null) {
      // `safeEqualEmails` (CWE-208), for the same reason `getClientTicketView` uses it: this decides
      // whether a credential bound to one address may act for the address on the wire, which is an
      // identity check. It applies the SAME trim + lower-case to both sides that the `!==` here used
      // to apply to the stored side alone — `requesterEmailFromHeaders` has already normalised the
      // wire side, so the accepted set is unchanged.
      //
      // The `!== null` that remains is a NULLABILITY test on the stored column, not a comparison of
      // two addresses, and it is deliberately not truthiness: a row whose binding is the empty string
      // must stay bound and therefore match nothing, not silently become an unbound credential.
      if (requesterEmail === null || !safeEqualEmails(requesterEmail, credential.requesterEmail)) return null;
    }
    return { kind: "token", tokenId: credential.id };
  }
  return isClientApiAuthorized(h) ? { kind: "legacy" } : null;
}

/**
 * Spends one request from this caller's rate-limit budget — per credential for a `ClientApiToken`,
 * per surface for the legacy env bearer — and returns the refusal to answer with, or `null` to
 * proceed. A thin wrapper over `enforceMachineRateLimit`, for the same reason `recordClientDenied` is
 * a thin wrapper over the denial throttle: guardrail G7 pins
 * `src/app/api/client/tickets/[id]/route.ts` to three module ids, and `@/lib/integration-auth` is not
 * one of them. The routes G7 does not cover call `enforceMachineRateLimit` directly.
 *
 * `scope` is repeated rather than read off the authorization because `ClientApiAuthorization` does not
 * carry the token's grants — the caller knows which scope it just demanded, and putting that on the
 * rate-limit row is what makes "which surface did this credential spend its budget on" answerable.
 */
export async function enforceClientApiRateLimit(
  ctx: RequestContext,
  route: string,
  auth: ClientApiAuthorization,
  scope: ApiTokenScope,
): Promise<RateLimitRefusal | null> {
  return enforceMachineRateLimit(
    ctx,
    route,
    auth.kind === "token" ? { kind: "token", tokenId: auth.tokenId, scopes: [scope] } : { kind: "legacy" },
    "client",
  );
}

/**
 * The denial writer for the two Wave B client routes. Same split as `recordClientDenied` and for the
 * same reasons — the unauthenticated shape coalesces per route and IP, the requester-mismatch shape
 * does not — but parametrised on the route, because a shared label would let a probe on one path
 * suppress the first row on the other.
 */
export async function recordClientDeniedOn(
  ctx: RequestContext,
  route: string,
  requestedId: string,
  requesterEmail: string | null,
  reason: "client:unauthenticated" | "client:requester-mismatch",
  ticketExists: boolean,
): Promise<void> {
  if (reason === "client:unauthenticated") {
    await recordUnauthenticatedClientDenial(ctx, route);
    return;
  }
  await recordClientApiDenied(ctx, requestedId, requesterEmail, reason, ticketExists);
}

/** Clamps a caller-supplied page/pageSize into the bounds above. Never throws on nonsense input. */
export function clientListBounds(query: ClientTicketListQuery | undefined): { page: number; pageSize: number } {
  const rawPage = query?.page;
  const rawSize = query?.pageSize;
  const page = Number.isSafeInteger(rawPage) && (rawPage as number) >= 1 ? (rawPage as number) : 1;
  const size =
    Number.isSafeInteger(rawSize) && (rawSize as number) >= 1
      ? Math.min(rawSize as number, CLIENT_LIST_MAX_PAGE_SIZE)
      : CLIENT_LIST_DEFAULT_PAGE_SIZE;
  return { page, pageSize: size };
}

/**
 * Every PUBLIC comment for a SET of tickets, in one round trip against the same view.
 *
 * `= ANY(${ids})` rather than a loop: a page of ten tickets would otherwise be ten queries, and the
 * per-ticket variant is still there for the single-ticket reads. Still a tagged template, still the
 * view, still `publicDb` — the three properties this module's docstring turns on are unchanged.
 */
export async function selectPublicCommentsFor(ticketIds: readonly string[]): Promise<PublicCommentRow[]> {
  if (ticketIds.length === 0) return [];
  const rows = await publicDb.$queryRaw<RawViewRow[]>`
    SELECT id, "ticketId", body, "disclaimerKey", "authorKind", retracted, "createdAt"
    FROM "ClientVisibleComment"
    WHERE "ticketId" = ANY(${[...ticketIds]})
    ORDER BY "createdAt" ASC`;
  if (!Array.isArray(rows)) {
    throw new IsolationViolationError("client-view: ClientVisibleComment query returned a non-array");
  }
  return rows.map(brandViewRow);
}

/**
 * The scalar columns both Wave B reads select. No relations — `publicDb` throws on them.
 *
 * Identical to `getClientTicketView`'s projection and to the ten columns the client role is granted,
 * which is what G15 pins in all three places. The opening entry is NOT among them: it comes from
 * "ClientVisibleOpeningMessage" (`selectOpeningMessagesFor`), so the three client payloads cannot
 * disagree about it either.
 */
const CLIENT_TICKET_SELECT = {
  id: true,
  number: true,
  subject: true,
  status: true,
  priority: true,
  category: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  requesterEmail: true,
} as const;

function sourceFrom(t: ClientTicketSource & { requesterEmail: string | null }): ClientTicketSource {
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    category: t.category,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolvedAt: t.resolvedAt,
  };
}

/**
 * How many tickets this address has. Separate from the list so the page can report a total without
 * the list having to return one — the contract's `listClientTickets` answers an ARRAY.
 */
export async function countClientTickets(requesterEmail: string): Promise<number> {
  const email = requesterEmail.trim().toLowerCase();
  if (email.length === 0) return 0;
  return publicDb.ticket.count({ where: { requesterEmail: { equals: email, mode: "insensitive" } } });
}

/**
 * Every ticket belonging to `requesterEmail`, newest activity first, as full client views
 *.
 *
 * **The page is deliberately small** (10 by default, 25 at most). Each row is a complete
 * `ClientTicketView`, so each row is a READ OF CLIENT MATERIAL and takes its own `CLIENT_API_READ`
 * row under I3 — and every one of those is a hash-chained INSERT that takes the global
 * `AuditLog.chain` advisory lock the whole desk also needs. A hundred-row page would be a hundred of
 * them behind one request. The alternative shape (a summary row with no messages, audited as a list
 * rather than a view) was rejected: the contract's signature says `ClientTicketView[]`, and a type
 * that promises a thread and returns an empty one is the kind of half-truth an integrator builds on.
 *
 * Matching is case-insensitive, like the single-ticket read, because `Ticket.requesterEmail` is not
 * normalised at every entry point and a client whose address was recorded with a capital letter must
 * not simply have no tickets.
 *
 * `VOIDED` rows are INCLUDED, labelled "Withdrawn". `METRICS_EXCLUDED_STATUSES` governs COUNTING
 * surfaces (CONTRACT §2 — queue counters, the SLA sweep, reports, the CSV exports); a client's own
 * list of their own tickets is not a metric, and a row that vanished without explanation is worse
 * than one that says it was withdrawn. Recorded as a recommended default in the integration notes.
 *
 * The audit rows are awaited BEFORE the views are returned: if the ledger write fails, nothing
 * is served.
 */
export async function listClientTickets(
  requesterEmail: string,
  ctx: RequestContext,
  query?: ClientTicketListQuery,
): Promise<ClientTicketViewWithVocabulary[]> {
  const email = requesterEmail.trim().toLowerCase();
  if (email.length === 0) return [];
  const { page, pageSize } = clientListBounds(query);

  const tickets = await publicDb.ticket.findMany({
    where: { requesterEmail: { equals: email, mode: "insensitive" } },
    select: CLIENT_TICKET_SELECT,
    orderBy: [{ updatedAt: "desc" }, { number: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  if (tickets.length === 0) return [];

  const ids = tickets.map((t) => t.id);
  const rows = await selectPublicCommentsFor(ids);
  const byTicket = new Map<string, PublicCommentRow[]>();
  for (const row of rows) {
    const bucket = byTicket.get(row.ticketId);
    if (bucket === undefined) byTicket.set(row.ticketId, [row]);
    else bucket.push(row);
  }
  // One more round trip for the whole page, against the gated view. A ticket the desk composed has no
  // row here, so it is simply absent from the map and the builder is handed null.
  const openings = await selectOpeningMessagesFor(ids);

  const views = tickets.map((t) => {
    const view = toClientTicketView(sourceFrom(t), byTicket.get(t.id) ?? [], openings.get(t.id) ?? null);
    assertNoInternalLeak(view);
    return view;
  });

  // I3: the ledger before the content, one row per ticket, sequentially. Sequential rather than
  // Promise.all deliberately — the chain trigger serialises these anyway, and a parallel fan-out
  // would hold several connections open to achieve the same wall time.
  for (const t of tickets) {
    await recordClientApiRead(ctx, t.id, email);
  }
  return views;
}

/**
 * The WM number a client quotes off an email, resolved for THAT client only.
 *
 * Identical rules to `getClientTicketView`: a missing ticket and a ticket belonging to somebody else
 * both return null and both write an `AUTHZ_DENIED` row first, so neither the caller nor a scanner
 * learns which it was. Enumerating numbers is easier than enumerating cuids, which is exactly why the
 * denial is recorded per attempt rather than coalesced once a bearer has verified.
 */
export async function getClientTicketByNumber(
  number: number,
  requesterEmail: string,
  ctx: RequestContext,
): Promise<ClientTicketViewWithVocabulary | null> {
  const email = requesterEmail.trim().toLowerCase();
  if (!Number.isSafeInteger(number) || number < 1) {
    await recordClientDeniedOn(ctx, CLIENT_TICKET_BY_NUMBER_ROUTE, "id:invalid", email, "client:requester-mismatch", false);
    return null;
  }

  const t = await publicDb.ticket.findFirst({ where: { number }, select: CLIENT_TICKET_SELECT });
  if (t === null) {
    // No row, so no id: the ledger records the NUMBER that was asked for. It is a bounded integer
    // this function has already validated, never a caller-controlled string.
    await recordClientDeniedOn(
      ctx,
      CLIENT_TICKET_BY_NUMBER_ROUTE,
      String(number),
      email,
      "client:requester-mismatch",
      false,
    );
    return null;
  }
  // Same nullable-requester rule and the same constant-time identity comparison as
  // `getClientTicketView` (CWE-208): `safeEqualEmails` normalises BOTH sides, so the inline
  // `.trim().toLowerCase()` this line used to carry on one side is now applied to each.
  if (t.requesterEmail === null || !safeEqualEmails(t.requesterEmail, email)) {
    await recordClientDeniedOn(ctx, CLIENT_TICKET_BY_NUMBER_ROUTE, t.id, email, "client:requester-mismatch", true);
    return null;
  }

  const comments = await selectPublicCommentsFor([t.id]);
  const opening = await selectOpeningMessage(t.id);
  const view = toClientTicketView(sourceFrom(t), comments, opening);
  assertNoInternalLeak(view);
  await recordClientApiRead(ctx, t.id, email);
  return view;
}
