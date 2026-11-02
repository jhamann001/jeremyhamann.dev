/**
 * Ticket-to-ticket links — reads and pure policy. Node, layer L4 (the build record B2,
 * Decision #95). The WRITE half lives in `src/server/ticket-links.actions.ts`; this module is the
 * plain read module a `"use server"` file may not be.
 *
 * NO AUDIT ROW, deliberately (docs/ARCHITECTURE.md §e "What counts as a view", restated in
 * the build record rule 3): a link carries a number, a subject and a status — list-row
 * material the viewer can already see on the dashboard — and no description, no comment body and no
 * requester address. Opening the other ticket is the audited view.
 *
 * Queue scoping is the same as every other list read: the ticket's own queue must be READABLE, and a
 * link whose OTHER end sits in a queue the viewer cannot read is dropped from the result rather than
 * rendered as a bare number. A link is a fact about two tickets, so it must not become a way to learn
 * that a ticket exists in a queue you are not allowed to see.
 */
import type { Prisma } from "@prisma/client";
import type { TicketLinkDTO, TicketLinkKind, Viewer } from "@/types/domain";
import { WAVE_B_LIMITS } from "@/types/domain";
import { prisma } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { canReadQueue, readableQueues } from "@/lib/rbac";
import { USER_REF_SELECT, toUserRef } from "@/server/tickets";

// ---------------------------------------------------------------------------
// Pure policy — exported so the UI, the action and the tests read the SAME rules
// ---------------------------------------------------------------------------

/** Ceiling on the optional "why are these two linked" note. The floor is zero: the note is optional. */
export const LINK_NOTE_MAX_CHARS = 500 as const;

/**
 * Kinds an operator may create BY HAND.
 *
 * `DUPLICATE_OF` is deliberately absent: it is the link `mergeTickets` writes, in the same transaction
 * as `Ticket.mergedIntoId`, `resolution: DUPLICATE` and the loser's status change. Letting the panel
 * write a bare `DUPLICATE_OF` would produce a ticket that CLAIMS to be a duplicate while still counting
 * as open work — the row and the link disagreeing about the same fact, which is the failure mode the
 * merge exists to prevent. "Mark as duplicate" in the UI calls the merge.
 *
 * RECOMMENDED DEFAULT, pending the owner's confirmation.
 */
export const MANUAL_LINK_KINDS = ["RELATED", "BLOCKS"] as const satisfies readonly TicketLinkKind[];
export type ManualLinkKind = (typeof MANUAL_LINK_KINDS)[number];

export function isManualLinkKind(kind: TicketLinkKind): kind is ManualLinkKind {
  return (MANUAL_LINK_KINDS as readonly TicketLinkKind[]).includes(kind);
}

/**
 * The URL allowlist, per kind (the brief's "URL allowlist per kind").
 *
 * The shipped `TicketLink` is ticket-to-ticket and has NO url column — the gap analysis's external-link
 * model (CRM task, the advisor platform transfer, Apex case, e-signature envelope, issue-tracker issue) became the ticket
 * link plus the existing `Ticket.externalRef`. The one place a URL can still reach this table is the
 * free-text `note`, so that is where the allowlist applies: a note may point at a system the firm
 * actually runs, and may not carry a link to anywhere else. Anything not on the list is refused with
 * the host named, rather than silently stripped — a stripped link is a note that lies about itself.
 *
 * `DUPLICATE_OF` allows nothing: a duplicate is another WM ticket, and the link IS the pointer.
 *
 * RECOMMENDED DEFAULT, pending the owner's confirmation. Hosts are matched on the
 * registrable suffix — `x.example.com` matches `example.com` — and the scheme must be
 * https, because an http link in a books-and-records note is a link nobody can prove was not tampered with.
 */
export const LINK_URL_ALLOWLIST: Readonly<Record<TicketLinkKind, readonly string[]>> = {
  RELATED: ["example.com", "issues.example.com", "esign.example.com", "apex.example.com", "crm.example.com"],
  BLOCKS: ["example.com", "issues.example.com", "esign.example.com", "apex.example.com", "crm.example.com"],
  DUPLICATE_OF: [],
};

/** Scheme-qualified or `www.`-prefixed runs of non-space. Deliberately greedy: a near-URL is still a URL. */
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()[\]"'`]+/gi;

export type NoteUrlVerdict = {
  /** As it appeared in the note, trailing punctuation trimmed. */
  url: string;
  host: string | null;
  allowed: boolean;
  reason: "ok" | "not-https" | "host-not-allowed" | "unparseable";
};

function trimTrailingPunctuation(raw: string): string {
  return raw.replace(/[.,;:!?)\]}>'"]+$/u, "");
}

function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allow.some((entry) => h === entry || h.endsWith(`.${entry}`));
}

/** Every URL in `note`, with the verdict the allowlist gives it for `kind`. Pure. */
export function inspectNoteUrls(kind: TicketLinkKind, note: string | null | undefined): NoteUrlVerdict[] {
  if (typeof note !== "string" || note.length === 0) return [];
  const allow = LINK_URL_ALLOWLIST[kind];
  const out: NoteUrlVerdict[] = [];
  for (const match of note.matchAll(URL_PATTERN)) {
    const raw = trimTrailingPunctuation(match[0]);
    if (raw.length === 0) continue;
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      out.push({ url: raw, host: null, allowed: false, reason: "unparseable" });
      continue;
    }
    if (/^http:\/\//i.test(raw)) {
      out.push({ url: raw, host: parsed.hostname, allowed: false, reason: "not-https" });
      continue;
    }
    const ok = hostAllowed(parsed.hostname, allow);
    out.push({ url: raw, host: parsed.hostname, allowed: ok, reason: ok ? "ok" : "host-not-allowed" });
  }
  return out;
}

/** The subset a human has to fix before the link can be saved. Pure. */
export function disallowedNoteUrls(kind: TicketLinkKind, note: string | null | undefined): NoteUrlVerdict[] {
  return inspectNoteUrls(kind, note).filter((v) => !v.allowed);
}

/** One sentence naming what is wrong, for the field error and the sheet. Pure. */
export function describeDisallowedUrls(verdicts: readonly NoteUrlVerdict[]): string {
  if (verdicts.length === 0) return "";
  const first = verdicts[0];
  if (first === undefined) return "";
  switch (first.reason) {
    case "not-https":
      return `Links in a note must be https — ${first.url} is not.`;
    case "unparseable":
      return `${first.url} is not a link this desk can store.`;
    default:
      return `${first.host ?? first.url} is not an approved system to link to. Paste the WM number instead, or use the external reference field.`;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const LINK_TICKET_SELECT = {
  id: true,
  number: true,
  subject: true,
  status: true,
  queue: { select: { key: true } },
} as const;

export const TICKET_LINK_SELECT = {
  id: true,
  kind: true,
  note: true,
  createdAt: true,
  fromTicketId: true,
  toTicketId: true,
  createdBy: { select: USER_REF_SELECT },
  fromTicket: { select: LINK_TICKET_SELECT },
  toTicket: { select: LINK_TICKET_SELECT },
} as const;

export type TicketLinkRow = Prisma.TicketLinkGetPayload<{ select: typeof TICKET_LINK_SELECT }>;

/**
 * One stored row, rendered from the point of view of `ticketId`.
 *
 * `inbound` is what tells the panel which label map to use: the SAME row reads "Duplicate of HD-12" on
 * the loser and "Has duplicate HD-9" on the survivor (`TICKET_LINK_INVERSE_LABELS`). Storing one row
 * and inverting the label is why a merge cannot leave the two ends disagreeing.
 */
export function toTicketLinkDTO(row: TicketLinkRow, ticketId: string): TicketLinkDTO {
  const inbound = row.toTicketId === ticketId;
  const other = inbound ? row.fromTicket : row.toTicket;
  return {
    id: row.id,
    kind: row.kind,
    otherTicketId: other.id,
    otherTicketNumber: other.number,
    otherTicketSubject: other.subject,
    otherTicketStatus: other.status,
    inbound,
    note: row.note,
    createdBy: toUserRef(row.createdBy),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Live links on a ticket, both directions. `where` shape shared by the reads and the count guard. */
export function liveLinksWhere(ticketId: string): Prisma.TicketLinkWhereInput {
  return { removedAt: null, OR: [{ fromTicketId: ticketId }, { toTicketId: ticketId }] };
}

/**
 * Live links on a ticket, newest first, restricted to links whose OTHER end the viewer may read.
 *
 * Throws `ForbiddenError` when the ticket's own queue is unreadable; the caller's `runAction` (or the
 * panel's absence of one) turns that into an audited denial. Returns `[]` for a missing ticket, so a
 * deleted-then-recreated id never distinguishes itself from an unreadable one.
 */
export async function listTicketLinks(viewer: Viewer, ticketId: string): Promise<TicketLinkDTO[]> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, queue: { select: { key: true } } },
  });
  if (!ticket) return [];
  if (!canReadQueue(viewer.groups, ticket.queue.key)) {
    throw new ForbiddenError("Forbidden: queue:read", ticket.id);
  }
  const queues = readableQueues(viewer.groups);
  if (queues.length === 0) return [];

  const rows = await prisma.ticketLink.findMany({
    where: {
      ...liveLinksWhere(ticket.id),
      // Both ends must be readable. The ticket itself already is (checked above); this clause is what
      // keeps a link from announcing a ticket in a queue the viewer cannot see.
      fromTicket: { queue: { key: { in: queues } } },
      toTicket: { queue: { key: { in: queues } } },
    },
    select: TICKET_LINK_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: WAVE_B_LIMITS.maxLinksPerTicket * 2,
  });
  return rows.map((r) => toTicketLinkDTO(r, ticket.id));
}

/** How many live links a ticket already carries, for the `WAVE_B_LIMITS.maxLinksPerTicket` guard. */
export async function countLiveLinks(tx: { ticketLink: { count(args: { where: Prisma.TicketLinkWhereInput }): Promise<number> } }, ticketId: string): Promise<number> {
  return tx.ticketLink.count({ where: liveLinksWhere(ticketId) });
}
