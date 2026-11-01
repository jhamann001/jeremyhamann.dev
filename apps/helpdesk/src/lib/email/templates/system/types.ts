/**
 * SYSTEM message template shapes — pure, layer L1.
 *
 * The two SYSTEM messages this desk can write — the auto-acknowledgement and the resolved notice — are
 * CODE, for the same reason `src/lib/disclaimers.ts` and `src/lib/brand.ts` are code (Decision #7,
 * Decision #73): they are firm wording a client reads, and wording a client reads belongs in a diff a
 * reviewer approved, not in a console field where a typo becomes a compliance question nobody can date.
 *
 * Every template is PER BRAND. Cedar Ridge Wealth and Cedar Ridge Direct answer different clients with
 * different expectations, and the identity that sends the mail already differs (`BRAND_IDENTITIES`);
 * the body has to be able to differ with it.
 *
 * WHAT A TEMPLATE MAY CONTAIN: the WM number, what happens next, how to reply, and the one safety
 * sentence about not emailing account numbers. WHAT IT MAY NOT CONTAIN: the requester's name, their
 * address, the subject line, or anything read out of the ticket other than its number. That is not a
 * PII rule borrowed from §7.3 (which governs webhook and Slack payloads) — it is a plainer one: the
 * fewer ticket fields a machine-authored message interpolates, the fewer ways an automatic message can
 * quote a client's own words back at the wrong person.
 */
import type { DisclaimerKey, TicketBrand } from "@/types/domain";

/** The two SYSTEM messages. There will not casually be a third: each one needs its own env key and approval. */
export const SYSTEM_MESSAGE_KINDS = ["AUTO_ACK", "RESOLVED_NOTICE"] as const;
export type SystemMessageKind = (typeof SYSTEM_MESSAGE_KINDS)[number];

/** Everything a template may interpolate. One field, deliberately. */
export type SystemMessageVars = {
  /** The ticket's WM number. The only ticket fact a SYSTEM body ever carries. */
  ticketNumber: number;
};

export type SystemMessageTemplate = {
  kind: SystemMessageKind;
  brand: TicketBrand;
  /**
   * The disclaimer appended into the STORED body by `appendDisclaimer`, so the Comment row is exactly
   * what the client received. Never `NONE`: this is a PUBLIC reply like any other.
   */
  disclaimerKey: DisclaimerKey;
  /** Markdown, rendered by `renderOutbound` into the text and html parts. */
  body(vars: SystemMessageVars): string;
};

/** A template set is total over the two kinds — a brand cannot half-implement the feature. */
export type SystemMessageTemplateSet = Readonly<Record<SystemMessageKind, SystemMessageTemplate>>;
