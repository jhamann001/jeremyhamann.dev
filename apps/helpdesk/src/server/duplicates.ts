/**
 * Duplicate detection — node, layer L4, with a PURE scorer at its centre
 *.
 *
 * **The banner offers, a person decides.** Nothing in this module merges anything. A false positive
 * that silently merged two clients' tickets would put one client's correspondence on another's record,
 * and that is the one failure this desk cannot walk back. So the scorer is a ranking, the UI is a
 * suggestion, and `mergeTickets` is a deliberate act with a recorded reason.
 *
 * The scorer is pure and exported for exactly that reason: the rule that decides what an operator is
 * shown about two clients has to be readable and testable without a database.
 *
 * NO AUDIT ROW: candidates are list rows — number, subject, status, created — carrying no
 * description and no comment body, and every one of them is in a queue the viewer can already list.
 */
import type { Prisma } from "@prisma/client";
import type { DuplicateCandidateDTO, TicketStatus, Viewer } from "@/types/domain";
import { METRICS_EXCLUDED_STATUSES } from "@/types/domain";
import { prisma } from "@/lib/db";
import { readableQueues } from "@/lib/rbac";

// ---------------------------------------------------------------------------
// Tuning — code-owned, so the rule is in the diff rather than in a settings table
// ---------------------------------------------------------------------------

/** How far back "the same person wrote again" counts. RECOMMENDED DEFAULT, pending confirmation. */
export const DUPLICATE_WINDOW_DAYS = 7 as const;
export const DUPLICATE_WINDOW_MS = DUPLICATE_WINDOW_DAYS * 24 * 60 * 60_000;

/** Below this, a candidate is noise and is not shown at all. */
export const DUPLICATE_MIN_SCORE = 0.35;

/** Subject overlap at or above which two tickets from one requester read as the same request. */
export const SUBJECT_SIMILARITY_FLOOR = 0.5;

/** The banner never lists more than this: a list nobody reads is a control nobody applies. */
export const DUPLICATE_MAX_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// Pure scoring
// ---------------------------------------------------------------------------

/**
 * Words that carry no signal about WHAT was asked. Kept short on purpose: an aggressive stop list makes
 * "wire not received" and "check not received" look alike, which is the expensive direction to be wrong in.
 */
const SUBJECT_STOPWORDS = new Set([
  "a", "an", "and", "the", "for", "of", "to", "on", "in", "is", "it", "my", "our", "your",
  "please", "pls", "hi", "hello", "thanks", "thank", "you", "re", "fw", "fwd", "urgent",
]);

/** `Re:`, `Fwd:`, `[EXTERNAL]`, a leading `HD-1042` — envelope noise, not subject. */
const SUBJECT_PREFIX = /^\s*(?:(?:re|fw|fwd|aw|tr)\s*:|\[[^\]]{1,40}\]|hd-\d+\s*[-:]?)\s*/i;

/**
 * Lower-cased, prefix-stripped, punctuation-free, stop-word-free token string.
 * Exported because the UI explains a match by showing what it matched on.
 */
export function normalizeSubject(subject: string): string {
  let s = typeof subject === "string" ? subject : "";
  // Strip repeated envelope prefixes: "Re: Fwd: Re: wire".
  for (let i = 0; i < 5; i++) {
    const next = s.replace(SUBJECT_PREFIX, "");
    if (next === s) break;
    s = next;
  }
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/u)
    .filter((t) => t.length > 1 && !SUBJECT_STOPWORDS.has(t))
    .join(" ");
}

export function subjectTokens(subject: string): string[] {
  const n = normalizeSubject(subject);
  return n.length === 0 ? [] : n.split(" ");
}

/**
 * Sørensen–Dice over the two token SETS: `2|A∩B| / (|A|+|B|)`, in [0, 1].
 *
 * A set coefficient rather than an edit distance because subject lines are reordered constantly
 * ("wire not received" / "not received — wire") and an edit distance calls those two different.
 * Two empty subjects score 0, not 1: no evidence is not agreement.
 */
export function subjectSimilarity(a: string, b: string): number {
  const A = new Set(subjectTokens(a));
  const B = new Set(subjectTokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/** Digits only, so `+1 (212) 555-0100` and `12125550100` are the same person. */
export function normalizePhone(phone: string | null | undefined): string {
  return typeof phone === "string" ? phone.replace(/\D+/gu, "") : "";
}

export function normalizeEmail(email: string | null | undefined): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function normalizeExternalRef(ref: string | null | undefined): string {
  return typeof ref === "string" ? ref.trim().toUpperCase().replace(/\s+/gu, "") : "";
}

/** What the scorer compares. Both sides use the same shape, so a draft and a saved ticket score alike. */
export type DuplicateSubject = {
  requesterEmail: string | null;
  requesterPhone: string | null;
  subject: string;
  externalRef?: string | null;
  createdAt: Date;
};

export type DuplicateScore = { score: number; reason: DuplicateCandidateDTO["reason"] };

/**
 * Score one candidate against one base. Pure; `null` means "do not show this".
 *
 * Three rules, in the order a person would apply them:
 *  1. **Same external reference** — one e-signature envelope, one ACAT control number, one `REQ-`. That is
 *     not a similarity, it is an identity, so it outranks everything and needs no time window.
 *  2. **Same requester inside the window AND a similar subject** — the ordinary duplicate: the client
 *     wrote twice, or wrote and then phoned.
 *  3. **Same requester inside the window, any subject** — weak, and ranked as such, but worth showing:
 *     "this person already has something open" is the question the banner exists to answer.
 *
 * Recency breaks ties within a rule: a ticket raised an hour ago is a better duplicate than one from
 * six days ago, and the operator should see it first.
 */
export function scoreDuplicateCandidate(
  base: DuplicateSubject,
  candidate: DuplicateSubject,
  windowMs: number = DUPLICATE_WINDOW_MS,
): DuplicateScore | null {
  const baseRef = normalizeExternalRef(base.externalRef);
  const candRef = normalizeExternalRef(candidate.externalRef);
  if (baseRef.length > 0 && baseRef === candRef) return { score: 0.98, reason: "same-external-ref" };

  const email = normalizeEmail(base.requesterEmail);
  const phone = normalizePhone(base.requesterPhone);
  const sameRequester =
    (email.length > 0 && email === normalizeEmail(candidate.requesterEmail)) ||
    (phone.length >= 7 && phone === normalizePhone(candidate.requesterPhone));
  if (!sameRequester) return null;

  const ageMs = Math.abs(base.createdAt.getTime() - candidate.createdAt.getTime());
  if (ageMs > windowMs) return null;
  // 1 at the same instant, 0 at the edge of the window.
  const recency = windowMs <= 0 ? 0 : Math.max(0, 1 - ageMs / windowMs);

  const similarity = subjectSimilarity(base.subject, candidate.subject);
  if (similarity >= SUBJECT_SIMILARITY_FLOOR) {
    // 0.60 … 0.95, similarity dominant, recency as the tie-break.
    return { score: round2(0.6 + 0.3 * similarity + 0.05 * recency), reason: "same-requester-subject" };
  }
  // 0.35 … 0.55: present, ranked last, never mistakable for the strong signal.
  return { score: round2(0.35 + 0.2 * recency), reason: "same-requester-recent" };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Rank, cut at the floor, cap the list. Pure — the ordering rule is testable without a database. */
export function rankCandidates(scored: DuplicateCandidateDTO[]): DuplicateCandidateDTO[] {
  return scored
    .filter((c) => c.score >= DUPLICATE_MIN_SCORE)
    .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt) || b.ticketNumber - a.ticketNumber)
    .slice(0, DUPLICATE_MAX_CANDIDATES);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const CANDIDATE_SELECT = {
  id: true,
  number: true,
  subject: true,
  status: true,
  createdAt: true,
  requesterEmail: true,
  requesterPhone: true,
  externalRef: true,
} as const;

type CandidateRow = Prisma.TicketGetPayload<{ select: typeof CANDIDATE_SELECT }>;

function toCandidate(row: CandidateRow, scored: DuplicateScore): DuplicateCandidateDTO {
  return {
    ticketId: row.id,
    ticketNumber: row.number,
    subject: row.subject,
    status: row.status as TicketStatus,
    createdAt: row.createdAt.toISOString(),
    score: scored.score,
    reason: scored.reason,
  };
}

/**
 * The candidate pool: same requester (email or phone) or same external reference, inside the window,
 * in a queue the viewer may READ.
 *
 * Excluded at the database, not in the ranking:
 *  - `METRICS_EXCLUDED_STATUSES` — a VOIDED ticket never happened, so nothing is a duplicate of it;
 *  - anything already merged (`mergedIntoId != null`) — it already points somewhere, and offering it
 *    would invite a chain of merges no reader can follow.
 */
async function candidatePool(
  viewer: Viewer,
  base: DuplicateSubject,
  excludeTicketId: string | null,
): Promise<CandidateRow[]> {
  const queues = readableQueues(viewer.groups);
  if (queues.length === 0) return [];

  const email = normalizeEmail(base.requesterEmail);
  const phone = normalizePhone(base.requesterPhone);
  const ref = normalizeExternalRef(base.externalRef);

  const identity: Prisma.TicketWhereInput[] = [];
  if (email.length > 0) identity.push({ requesterEmail: email });
  if (phone.length >= 7) identity.push({ requesterPhone: base.requesterPhone ?? undefined });
  if (ref.length > 0) identity.push({ externalRef: { equals: base.externalRef ?? undefined, mode: "insensitive" } });
  if (identity.length === 0) return [];

  const since = new Date(base.createdAt.getTime() - DUPLICATE_WINDOW_MS);
  const until = new Date(base.createdAt.getTime() + DUPLICATE_WINDOW_MS);

  return prisma.ticket.findMany({
    where: {
      AND: [
        { queue: { key: { in: queues } } },
        { status: { notIn: [...METRICS_EXCLUDED_STATUSES] } },
        { mergedIntoId: null },
        ...(excludeTicketId === null ? [] : [{ id: { not: excludeTicketId } }]),
        {
          OR: [
            // The external-reference rule has no time window; the requester rules do.
            ...(ref.length > 0 ? [{ externalRef: { equals: base.externalRef ?? undefined, mode: "insensitive" as const } }] : []),
            { AND: [{ OR: identity }, { createdAt: { gte: since, lte: until } }] },
          ],
        },
      ],
    },
    select: CANDIDATE_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // A generous pool: the scorer, not the query, decides what is shown.
    take: 50,
  });
}

/** Score a pool against a base and rank it. Shared by both public entry points. */
function scorePool(base: DuplicateSubject, rows: readonly CandidateRow[]): DuplicateCandidateDTO[] {
  const out: DuplicateCandidateDTO[] = [];
  for (const row of rows) {
    const scored = scoreDuplicateCandidate(base, {
      requesterEmail: row.requesterEmail,
      requesterPhone: row.requesterPhone,
      subject: row.subject,
      externalRef: row.externalRef,
      createdAt: row.createdAt,
    });
    if (scored !== null) out.push(toCandidate(row, scored));
  }
  return rankCandidates(out);
}

/**
 * Candidates for an EXISTING ticket. Returns `[]` for a ticket that is missing, unreadable, already
 * merged or voided — all four answer identically, so the banner never becomes an existence oracle.
 */
export async function findDuplicateCandidates(viewer: Viewer, ticketId: string): Promise<DuplicateCandidateDTO[]> {
  const queues = readableQueues(viewer.groups);
  if (queues.length === 0) return [];
  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, queue: { key: { in: queues } } },
    select: { ...CANDIDATE_SELECT, mergedIntoId: true },
  });
  if (!ticket) return [];
  if (ticket.mergedIntoId !== null) return [];
  if ((METRICS_EXCLUDED_STATUSES as readonly string[]).includes(ticket.status)) return [];

  const base: DuplicateSubject = {
    requesterEmail: ticket.requesterEmail,
    requesterPhone: ticket.requesterPhone,
    subject: ticket.subject,
    externalRef: ticket.externalRef,
    createdAt: ticket.createdAt,
  };
  return scorePool(base, await candidatePool(viewer, base, ticket.id));
}

/** Candidates for a ticket that does not exist yet — B11's new-ticket form, scored as it is typed. */
export async function findDuplicateCandidatesFor(
  viewer: Viewer,
  draft: DuplicateSubject,
  excludeTicketId: string | null = null,
): Promise<DuplicateCandidateDTO[]> {
  return scorePool(draft, await candidatePool(viewer, draft, excludeTicketId));
}
