/**
 * RBAC policy — pure and edge-safe.
 *
 * Imports only `@/types/domain` and `@/lib/errors`. Every helper is a pure function over the caller's
 * group list; the grant table below IS the policy (Queue rows in the DB carry names only).
 * Multi-group users hold the UNION of grants; there are no deny rules.
 */
import type {
  Capability,
  CapabilityContext,
  CommentVisibility,
  OktaGroup,
  QueueAccess,
  QueueKey,
} from "@/types/domain";
import { OKTA_GROUPS, QUEUE_KEYS, QUEUE_SLUGS } from "@/types/domain";
import { ForbiddenError } from "@/lib/errors";

/** Groups that may perform operational work (create, write, reply). compliance_officers is not one. */
export const OPERATIONAL_GROUPS: readonly OktaGroup[] = ["ops_team", "advisors", "client_services"];

/** Queue access table. WRITE implies READ; null means no access. */
export const QUEUE_ACCESS: Readonly<Record<OktaGroup, Readonly<Record<QueueKey, QueueAccess | null>>>> = {
  ops_team: { OPERATIONS: "WRITE", CLIENT_SERVICE: "READ", ADVICE: "READ" },
  advisors: { OPERATIONS: "READ", CLIENT_SERVICE: "READ", ADVICE: "WRITE" },
  client_services: { OPERATIONS: "READ", CLIENT_SERVICE: "WRITE", ADVICE: null },
  compliance_officers: { OPERATIONS: "READ", CLIENT_SERVICE: "READ", ADVICE: "READ" },
};

export function isGroup(v: unknown): v is OktaGroup {
  return typeof v === "string" && (OKTA_GROUPS as readonly string[]).includes(v);
}

/**
 * Normalizes a raw `groups` claim (string | string[] | anything else) to the known groups only,
 * deduplicated and ordered per OKTA_GROUPS. Unknown values are dropped silently.
 */
export function parseGroups(raw: unknown): OktaGroup[] {
  const candidates: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const present = new Set<OktaGroup>();
  for (const c of candidates) {
    if (isGroup(c)) present.add(c);
  }
  return OKTA_GROUPS.filter((g) => present.has(g));
}

export function hasAny(groups: readonly OktaGroup[], wanted: readonly OktaGroup[]): boolean {
  return groups.some((g) => wanted.includes(g));
}

export function canReadQueue(groups: readonly OktaGroup[], q: QueueKey): boolean {
  return groups.some((g) => QUEUE_ACCESS[g]?.[q] != null);
}

export function canWriteQueue(groups: readonly OktaGroup[], q: QueueKey): boolean {
  return groups.some((g) => QUEUE_ACCESS[g]?.[q] === "WRITE");
}

/** Create requires read on the destination AND an operational group (compliance never creates). */
export function canCreateTicket(groups: readonly OktaGroup[], q: QueueKey): boolean {
  return canReadQueue(groups, q) && hasAny(groups, OPERATIONAL_GROUPS);
}

/**
 * Cross-queue move (amending Decision 21).
 *
 * Wave A widens the destination side: an operational group may HAND OFF a ticket to any queue it can
 * READ, provided it can WRITE the queue the ticket is in now. Client Service hands wires, ACAT
 * statements and cost-basis tickets to Operations several times a day; before this, CS could file
 * directly into OPERATIONS at create but could not push an existing ticket, so day one produced Slack
 * pings and duplicate tickets.
 *
 * What did NOT change, and why it is still safe:
 *  - WRITE on the SOURCE is still required, so nobody moves a ticket out of a queue they only read
 *    (an advisor cannot push a Client Service ticket anywhere).
 *  - READ on the DESTINATION is still required, so a ticket never lands somewhere the mover cannot
 *    see — `client_services` has no access to ADVICE and therefore still cannot move a ticket there.
 *  - compliance_officers holds no WRITE anywhere, so it still cannot move anything: read-plus-annotate
 *    is unchanged (§b rule 2, Section 9 item 7).
 *  - `moveTicketQueue` still clears an assignee who cannot write the destination (§b rule 5) and still
 *    writes TICKET_QUEUE_CHANGED, so the hand-off is as auditable as before.
 * ops_team keeps any → any because it can read every queue anyway — the general rule now covers it.
 */
export function canMoveTicket(groups: readonly OktaGroup[], from: QueueKey, to: QueueKey): boolean {
  if (from === to) return false;
  return canWriteQueue(groups, from) && canReadQueue(groups, to);
}

/** INTERNAL notes need read on the queue; PUBLIC replies need write. */
export function canComment(groups: readonly OktaGroup[], q: QueueKey, visibility: CommentVisibility): boolean {
  return visibility === "PUBLIC" ? canWriteQueue(groups, q) : canReadQueue(groups, q);
}

export function canViewAudit(groups: readonly OktaGroup[]): boolean {
  return groups.includes("compliance_officers");
}

export function canExportAudit(groups: readonly OktaGroup[]): boolean {
  return canViewAudit(groups);
}

export function canVerifyAudit(groups: readonly OktaGroup[]): boolean {
  return canViewAudit(groups);
}

// ---------------------------------------------------------------------------
// Wave A capabilities (#68). Pure, edge-safe, same union semantics as everything above.
// ---------------------------------------------------------------------------

/**
 * Uploading, finalizing and removing an attachment is a WRITE on the ticket's queue — the same bar as
 * a public reply. compliance_officers is read-plus-annotate and therefore never uploads (§b rule 2);
 * it can still DOWNLOAD what others attached, which is what an examiner-facing reviewer needs.
 */
export function canWriteAttachment(groups: readonly OktaGroup[], q: QueueKey): boolean {
  return canWriteQueue(groups, q);
}

/** Downloading an attachment needs READ on the queue. Every download writes ATTACHMENT_VIEWED. */
export function canReadAttachment(groups: readonly OktaGroup[], q: QueueKey): boolean {
  return canReadQueue(groups, q);
}

/**
 * Macro administration: ops_team (the desk admins) or compliance_officers (the wording approver).
 * This is the ONE capability compliance holds that mutates something, and it is deliberate: macro
 * bodies are client-facing wording, which is the CCO's to own. It touches no ticket and no client
 * record, so read-plus-annotate on TICKETS is untouched.
 */
export function canAdminMacros(groups: readonly OktaGroup[]): boolean {
  return hasAny(groups, ["ops_team", "compliance_officers"]);
}

/** Staff account administration (deactivate / reactivate): ops_team only. */
export function canAdminUsers(groups: readonly OktaGroup[]): boolean {
  return groups.includes("ops_team");
}

/** Exporting ticket rows: anyone who can read a queue. Rows are limited to the readable queues. */
export function canExportTickets(groups: readonly OktaGroup[]): boolean {
  return readableQueues(groups).length > 0;
}

/**
 * Who may look at held inbound mail at /admin/intake: `user:admin` (ops_team) or `audit:view`
 * (compliance_officers). Held mail is client correspondence the desk REFUSED — a DMARC failure, an
 * unknown mailbox, a sender who is not the ticket's client — so the two groups that need to see it are
 * the desk admins who fix the routing and the officers who have to know what was turned away.
 *
 * Composes existing predicates and grants nothing new: every group that passes this already holds one
 * of the two capabilities it is built from.
 */
export function canReviewHeldIntake(groups: readonly OktaGroup[]): boolean {
  return canAdminUsers(groups) || canViewAudit(groups);
}

/**
 * Who may RELEASE held mail into a ticket: a reviewer who can also WRITE the destination queue.
 *
 * Release is a mutation that puts a record into someone's work queue, so `audit:view` alone is not
 * enough — compliance stays read-plus-annotate (§b rule 2). ops_team without write on the chosen queue
 * is refused too: the capability is about the queue, not the reviewer's seniority.
 */
export function canReleaseHeldIntake(groups: readonly OktaGroup[], q: QueueKey): boolean {
  return canReviewHeldIntake(groups) && canWriteQueue(groups, q);
}

/**
 * Re-pointing `Ticket.requesterEmail` is queue WRITE — the confirmation and the recorded reason are
 * enforced by `changeRequesterEmail`, not by the group table.
 *
 * Deliberately NOT a narrower group bar. The address is the client API's authorization subject and the
 * destination of every outbound reply, so a redirect is privileged; but no group combination expresses
 * "may redirect" — `ops_team` holds only READ on CLIENT_SERVICE, so a group-based bar would lock the CS
 * desk out of its own tickets. The control that makes it privileged is the two-step action, and the
 * evidence is the audit row it writes with `metadata.privileged`.
 */
export function canChangeRequesterEmail(groups: readonly OktaGroup[], q: QueueKey): boolean {
  return canWriteQueue(groups, q);
}

// ---------------------------------------------------------------------------
// Wave B capabilities. Pure, edge-safe, same union semantics as everything above.
// Nothing here invents a new group: every predicate is composed from the queue table or from the two
// group predicates that already exist, so the matrix in docs/ARCHITECTURE.md §b still describes the
// whole policy.
// ---------------------------------------------------------------------------

/**
 * Reading /reports and exporting a report CSV: anyone who can read a queue. Reports are counts,
 * medians and attainment rates over rows the viewer can already list — the export honours the same
 * readable-queue scoping as the ticket CSV, so this grants no row a viewer could not already open.
 *
 * Deliberately NOT ops-only: the CS lead judging whether the seeded SLA minutes match reality is the
 * person the reporting suite exists for, and locking them out would put engineering back in the loop
 * for every "how are we doing" question (gap analysis §9 item 8).
 */
export function canReadReports(groups: readonly OktaGroup[]): boolean {
  return readableQueues(groups).length > 0;
}

/**
 * Editing the SLA policy table at /admin/sla: ops_team. Changing `firstResponseMinutes` moves every
 * open ticket's due date the next time one is stamped, and `warningMinutes` re-colours the board, so
 * it is desk administration rather than casework. Compliance reads the resulting numbers in the
 * ledger (SLA_POLICY_CHANGED carries old and new); it does not set them.
 */
export function canAdminSla(groups: readonly OktaGroup[]): boolean {
  return groups.includes("ops_team");
}

/** Outbound webhook endpoints at /admin/webhooks: ops_team. A webhook is egress to a third party. */
export function canAdminWebhooks(groups: readonly OktaGroup[]): boolean {
  return groups.includes("ops_team");
}

/** Machine tokens at /admin/api-tokens: ops_team. Minting a credential is the narrowest thing here. */
export function canAdminTokens(groups: readonly OktaGroup[]): boolean {
  return groups.includes("ops_team");
}

/** The outbound suppression list at /admin/suppression: ops_team. It decides whose mail stops. */
export function canAdminSuppression(groups: readonly OktaGroup[]): boolean {
  return groups.includes("ops_team");
}

/**
 * The read-only environment-capability view at /admin/flags: ops_team or compliance_officers. It lists
 * which features a deployment has switched on and never shows a value, so it is the same audience as
 * held mail — the people who fix the configuration and the people who have to know what it is.
 */
export function canReadFlags(groups: readonly OktaGroup[]): boolean {
  return canAdminUsers(groups) || canViewAudit(groups);
}

/**
 * Stamping a supervisory review on a PUBLIC reply: compliance_officers or ops_team.
 *
 * This is annotation, not operation — it writes a ReviewStamp and touches no ticket field, no status
 * and no client record — so it sits on the same side of §b rule 2 as an INTERNAL note. ops_team is
 * included because supervision of correspondence is a desk-lead duty before it is a CCO duty, and a
 * two-person desk cannot wait for the officer to be at a keyboard.
 */
export function canStampReview(groups: readonly OktaGroup[]): boolean {
  return canViewAudit(groups) || groups.includes("ops_team");
}

/**
 * Recording an identity verification on a ticket: queue WRITE.
 *
 * The person who made the callback is the person who records it, and that person is whoever is working
 * the ticket. A narrower bar would push the record into a free-text note, which is precisely the prose
 * the structured record replaces. Compliance still holds no WRITE anywhere and therefore records none.
 */
export function canVerifyIdentity(groups: readonly OktaGroup[], q: QueueKey): boolean {
  return canWriteQueue(groups, q);
}

/**
 * Voiding a ticket: ops_team AND queue WRITE.
 *
 * Both halves matter. WRITE keeps it inside the queue the ticket lives in; ops_team is the extra bar,
 * because a void removes a ticket from every counter, every SLA number and every export at once, and
 * the honest failure mode of a status anyone can set is a desk that voids its way to a clean board.
 * `voidTicket` adds the rest: a recorded reason, and a refusal once a PUBLIC reply exists — once the
 * client has been written to, the ticket is correspondence and the answer is a correction, not a void.
 */
export function canVoidTicket(groups: readonly OktaGroup[], q: QueueKey): boolean {
  return groups.includes("ops_team") && canWriteQueue(groups, q);
}

/**
 * Adding or removing a ticket-to-ticket link, and merging as duplicate: queue WRITE.
 *
 * `addTicketLink` and `mergeTickets` check this on BOTH tickets — linking is a write on two records,
 * and a one-sided check would let someone with CS write attach an ADVICE ticket they cannot even read.
 */
export function canWriteLinks(groups: readonly OktaGroup[], q: QueueKey): boolean {
  return canWriteQueue(groups, q);
}

/**
 * Applying a bulk action: queue WRITE on the ticket in question. There is no separate "bulk" grant —
 * a bulk action is N ordinary actions, each re-checked, each versioned and each audited, and a ticket
 * the viewer may not write is SKIPPED with a reason rather than failing the whole batch.
 */
export function canApplyBulk(groups: readonly OktaGroup[], q: QueueKey): boolean {
  return canWriteQueue(groups, q);
}

/** The personal inbox at /inbox: any authenticated viewer with a recognised group (§b rule 3). */
export function canUseInbox(groups: readonly OktaGroup[]): boolean {
  return groups.length > 0;
}

/** Dispatcher over the helpers above. Queue-scoped capabilities without the needed context are denied. */
export function can(groups: readonly OktaGroup[], capability: Capability, ctx?: CapabilityContext): boolean {
  switch (capability) {
    case "queue:read":
      return ctx?.queueKey !== undefined && canReadQueue(groups, ctx.queueKey);
    case "queue:write":
      return ctx?.queueKey !== undefined && canWriteQueue(groups, ctx.queueKey);
    case "ticket:create":
      return ctx?.queueKey !== undefined && canCreateTicket(groups, ctx.queueKey);
    case "ticket:move":
      return (
        ctx?.fromQueueKey !== undefined &&
        ctx.toQueueKey !== undefined &&
        canMoveTicket(groups, ctx.fromQueueKey, ctx.toQueueKey)
      );
    case "comment:internal":
      return ctx?.queueKey !== undefined && canComment(groups, ctx.queueKey, "INTERNAL");
    case "comment:public":
      return ctx?.queueKey !== undefined && canComment(groups, ctx.queueKey, "PUBLIC");
    case "audit:view":
      return canViewAudit(groups);
    case "audit:export":
      return canExportAudit(groups);
    case "audit:verify":
      return canVerifyAudit(groups);
    case "attachment:write":
      return ctx?.queueKey !== undefined && canWriteAttachment(groups, ctx.queueKey);
    case "attachment:read":
      return ctx?.queueKey !== undefined && canReadAttachment(groups, ctx.queueKey);
    case "macro:admin":
      return canAdminMacros(groups);
    case "user:admin":
      return canAdminUsers(groups);
    case "ticket:export":
      return canExportTickets(groups);
    case "intake:review":
      return canReviewHeldIntake(groups);
    case "intake:release":
      return ctx?.queueKey !== undefined && canReleaseHeldIntake(groups, ctx.queueKey);
    case "ticket:requester-email":
      return ctx?.queueKey !== undefined && canChangeRequesterEmail(groups, ctx.queueKey);
    // --- Wave B ---
    case "reports:read":
      return canReadReports(groups);
    case "sla:admin":
      return canAdminSla(groups);
    case "webhooks:admin":
      return canAdminWebhooks(groups);
    case "tokens:admin":
      return canAdminTokens(groups);
    case "suppression:admin":
      return canAdminSuppression(groups);
    case "flags:read":
      return canReadFlags(groups);
    case "review:stamp":
      return canStampReview(groups);
    case "identity:verify":
      return ctx?.queueKey !== undefined && canVerifyIdentity(groups, ctx.queueKey);
    case "ticket:void":
      return ctx?.queueKey !== undefined && canVoidTicket(groups, ctx.queueKey);
    case "links:write":
      return ctx?.queueKey !== undefined && canWriteLinks(groups, ctx.queueKey);
    case "bulk:apply":
      return ctx?.queueKey !== undefined && canApplyBulk(groups, ctx.queueKey);
    case "inbox":
      return canUseInbox(groups);
    default: {
      const exhaustive: never = capability;
      return exhaustive;
    }
  }
}

export function readableQueues(groups: readonly OktaGroup[]): QueueKey[] {
  return QUEUE_KEYS.filter((q) => canReadQueue(groups, q));
}

export function writableQueues(groups: readonly OktaGroup[]): QueueKey[] {
  return QUEUE_KEYS.filter((q) => canWriteQueue(groups, q));
}

export function creatableQueues(groups: readonly OktaGroup[]): QueueKey[] {
  return QUEUE_KEYS.filter((q) => canCreateTicket(groups, q));
}

/** compliance_officers together with any operational group — flagged on every audit row and in the topbar. */
export function isDualRole(groups: readonly OktaGroup[]): boolean {
  return groups.includes("compliance_officers") && hasAny(groups, OPERATIONAL_GROUPS);
}

export function queueKeyFromSlug(slug: string): QueueKey | null {
  for (const q of QUEUE_KEYS) {
    if (QUEUE_SLUGS[q] === slug) return q;
  }
  return null;
}

export function queueSlug(q: QueueKey): string {
  return QUEUE_SLUGS[q];
}

/**
 * Coarse middleware gate. First match wins:
 *   /compliance*, /api/compliance* → audit:view
 *   /queues/<slug>                 → canReadQueue (unknown slug → allowed; the page 404s)
 *   /tickets/new                   → creatableQueues(groups).length > 0
 *   /admin/macros                  → canAdminMacros; /admin/users → canAdminUsers;
  *   /compliance/reviews            → review:stamp (checked BEFORE the /compliance branch)
 *   /inbox                         → inbox;  /reports → reports:read
 *   /admin/intake                  → canReviewHeldIntake; /admin/sla → sla:admin;
 *   /admin/webhooks → webhooks:admin; /admin/api-tokens → tokens:admin;
 *   /admin/suppression → suppression:admin; /admin/flags → flags:read;
 *   other /admin                   → canAdminMacros || canAdminUsers
 *   everything else                → groups.length > 0
 * Zero recognized groups fails every path. The server re-checks everything.
 */
export function isPathAllowed(pathname: string, groups: readonly OktaGroup[]): boolean {
  if (groups.length === 0) return false;
  // the supervisory review queue lives under /compliance but is NOT an audit surface — it
  // lists PUBLIC replies awaiting a stamp, which ops_team supervises too. Checked BEFORE the generic
  // /compliance branch, because first match wins and that branch is audit-only.
  if (pathname === "/compliance/reviews" || pathname.startsWith("/compliance/reviews/")) {
    return canStampReview(groups);
  }
  if (pathname.startsWith("/compliance") || pathname.startsWith("/api/compliance")) {
    return canViewAudit(groups);
  }
  // the personal inbox and the reporting suite.
  if (pathname === "/inbox" || pathname.startsWith("/inbox/")) return canUseInbox(groups);
  if (pathname === "/reports" || pathname.startsWith("/reports/")) return canReadReports(groups);
  const queueMatch = /^\/queues\/([^/?#]+)/.exec(pathname);
  if (queueMatch) {
    const key = queueKeyFromSlug(queueMatch[1]);
    return key === null ? true : canReadQueue(groups, key);
  }
  if (pathname === "/tickets/new" || pathname.startsWith("/tickets/new/")) {
    return creatableQueues(groups).length > 0;
  }
  // the admin section. Unknown /admin/* subpaths are refused outright rather than falling
  // through to "any group" — a new admin page is opt-in here, not opt-out.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (pathname === "/admin/macros" || pathname.startsWith("/admin/macros/")) return canAdminMacros(groups);
    if (pathname === "/admin/users" || pathname.startsWith("/admin/users/")) return canAdminUsers(groups);
    if (pathname === "/admin/intake" || pathname.startsWith("/admin/intake/")) return canReviewHeldIntake(groups);
    // --- Wave B admin pages. Each is named explicitly for the same reason Wave A named the first
    // three: the fallthrough below is "any admin", which is not a policy, and a new admin page must
    // be opt-in. ---
    if (pathname === "/admin/sla" || pathname.startsWith("/admin/sla/")) return canAdminSla(groups);
    if (pathname === "/admin/webhooks" || pathname.startsWith("/admin/webhooks/")) return canAdminWebhooks(groups);
    if (pathname === "/admin/api-tokens" || pathname.startsWith("/admin/api-tokens/")) return canAdminTokens(groups);
    if (pathname === "/admin/suppression" || pathname.startsWith("/admin/suppression/")) return canAdminSuppression(groups);
    if (pathname === "/admin/flags" || pathname.startsWith("/admin/flags/")) return canReadFlags(groups);
    return canAdminMacros(groups) || canAdminUsers(groups);
  }
  return true;
}

/** Throws ForbiddenError(`Forbidden: ${what}`, ticketId) when `ok` is false. */
export function assertCan(ok: boolean, what: string, ticketId?: string | null): asserts ok {
  if (!ok) throw new ForbiddenError(`Forbidden: ${what}`, ticketId ?? null);
}

/**
 * Returns `raw` only when it is a same-origin relative path: a string of 1..512 chars that starts
 * with "/" but not "//", contains no backslash and no whitespace/control characters. Otherwise the
 * fallback. Shared by sign-in.actions (callbackUrl → "/dashboard") and /no-access (from → "invalid").
 */
export function safeRelativePath(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  if (raw.length < 1 || raw.length > 512) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (raw.includes("\\")) return fallback;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    // Whitespace (incl. Unicode spaces via \s) and C0/DEL control characters are never part of a path.
    if (code <= 0x1f || code === 0x7f || /\s/.test(ch)) return fallback;
  }
  return raw;
}
