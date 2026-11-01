/**
 * Ticket status/priority policy — pure, layer L1.
 * The state machine is `ALLOWED_STATUS_TRANSITIONS` in src/types/domain.ts; CLOSED is terminal.
 */
import { ALLOWED_STATUS_TRANSITIONS, OPEN_STATUSES, TICKET_PRIORITIES } from "@/types/domain";
import type { TicketPriority, TicketStatus } from "@/types/domain";

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: TicketStatus): TicketStatus[] {
  return [...ALLOWED_STATUS_TRANSITIONS[from]];
}

/**
 * A status with no transitions out of it. CLOSED and, since Wave B, VOIDED.
 *
 * VOIDED is terminal for a stronger reason than CLOSED: a closed ticket can still be reopened by a
 * requester's reply (Decision #70 opens a NEW ticket linked back to it), whereas a voided ticket is
 * asserted never to have happened. Nothing transitions out of it and nothing transitions INTO it
 * through this state machine either — `voidTicket` writes that one edge itself.
 */
export function isTerminalStatus(s: TicketStatus): boolean {
  return s === "CLOSED" || s === "VOIDED";
}

/** Member of OPEN_STATUSES (NEW, OPEN, PENDING_CLIENT, PENDING_INTERNAL). */
export function isOpenStatus(s: TicketStatus): boolean {
  return (OPEN_STATUSES as readonly TicketStatus[]).includes(s);
}

/** Index in TICKET_PRIORITIES: URGENT 0 … LOW 3 (lower is more urgent). */
export function priorityRank(p: TicketPriority): number {
  return TICKET_PRIORITIES.indexOf(p);
}
