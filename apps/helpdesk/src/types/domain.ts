/**
 * Shared, hand-written domain types and constants for the WM Help Desk.
 *
 * Owner of record: S2 (compliance-core). FROZEN — this file is part of the architecture contract
 *. Slices import from it; nobody edits it without a contract amendment.
 *
 * Rules this file follows so it is safe in every runtime (edge middleware, browser, node):
 * - `@prisma/client` is imported with `import type` ONLY. Type imports are erased at compile time,
 *   so importing this module never pulls the Prisma runtime into an edge or browser bundle.
 * - Enum VALUES are declared here as `as const` arrays / objects. Each one is checked against the
 *   generated Prisma enum type at compile time (see `EnumParityChecks` at the bottom): if the schema
 *   and this file drift, `npm run typecheck` fails.
 * - Everything that crosses an RSC → client or server → JSON boundary uses ISO-8601 strings for dates
 *   and decimal strings for BigInt (`AuditLog.seq`). Never `Date`, never `bigint` in a DTO.
 */

import type {
  ApiTokenScope as PrismaApiTokenScope,
  AttachmentKind as PrismaAttachmentKind,
  AttachmentState as PrismaAttachmentState,
  AttachmentVisibility as PrismaAttachmentVisibility,
  AuditAction as PrismaAuditAction,
  AuditEntityType as PrismaAuditEntityType,
  ClientContactChannel as PrismaClientContactChannel,
  CommentAuthorKind as PrismaCommentAuthorKind,
  CommentVisibility as PrismaCommentVisibility,
  DisclaimerKey as PrismaDisclaimerKey,
  EscalationTarget as PrismaEscalationTarget,
  FollowerSource as PrismaFollowerSource,
  IdentityVerificationMethod as PrismaIdentityVerificationMethod,
  IdentityVerificationResult as PrismaIdentityVerificationResult,
  MessageDeliveryStatus as PrismaMessageDeliveryStatus,
  NotificationChannel as PrismaNotificationChannel,
  NotificationKind as PrismaNotificationKind,
  OktaGroup as PrismaOktaGroup,
  Prisma,
  QueueKey as PrismaQueueKey,
  ReviewVerdict as PrismaReviewVerdict,
  SlaAlertKind as PrismaSlaAlertKind,
  SlaAlertPhase as PrismaSlaAlertPhase,
  SuppressionReason as PrismaSuppressionReason,
  SuspendedIntakeReason as PrismaSuspendedIntakeReason,
  SuspendedIntakeStatus as PrismaSuspendedIntakeStatus,
  TicketBrand as PrismaTicketBrand,
  TicketCategory as PrismaTicketCategory,
  TicketLinkKind as PrismaTicketLinkKind,
  TicketPriority as PrismaTicketPriority,
  TicketResolution as PrismaTicketResolution,
  TicketSource as PrismaTicketSource,
  TicketStatus as PrismaTicketStatus,
  WebhookDeliveryStatus as PrismaWebhookDeliveryStatus,
} from "@prisma/client";

// ---------------------------------------------------------------------------
// Compile-time helpers
// ---------------------------------------------------------------------------

/** True iff A and B are the same type (mutual assignability, distinguishing `any`). */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
export type Expect<T extends true> = T;

// ---------------------------------------------------------------------------
// Enum mirrors (values). Types are derived from the arrays and checked against Prisma below.
// ---------------------------------------------------------------------------

/** Okta group claim values, verbatim as they arrive on the id_token `groups` claim. */
export const OKTA_GROUPS = ["ops_team", "advisors", "client_services", "compliance_officers"] as const;
export type OktaGroup = (typeof OKTA_GROUPS)[number];

export const QUEUE_KEYS = ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"] as const;
export type QueueKey = (typeof QUEUE_KEYS)[number];

export const TICKET_CATEGORIES = [
  "WIRE_TRANSFER",
  "ACAT",
  "TRADE_CORRECTION",
  "CASH_MOVEMENT",
  "PORTAL_RESET",
  "TAX_DOCUMENT",
  "ADDRESS_CHANGE",
  "REBALANCING",
  "PLANNING_UPDATE",
  "TAX_LOSS_HARVESTING",
  "OTHER",
  // Cedar Ridge's real intake, appended after the original eleven.
  "ACCOUNT_CLOSURE",
  "BENEFICIARY_TOD",
  "RETURNED_CHECK",
  "RETURNED_MAIL",
  "PASSKEY_LOGIN",
  "IDENTITY_VERIFICATION",
  "COMPLAINT",
  "RETIREMENT_DISTRIBUTION",
  "COST_BASIS",
  "VOICEMAIL_CALLBACK",
  "STATEMENT_REQUEST",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** Ordered from most to least urgent; the index is the sort rank. */
export const TICKET_PRIORITIES = ["URGENT", "HIGH", "STANDARD", "LOW"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = [
  "NEW",
  "OPEN",
  "PENDING_CLIENT",
  "PENDING_INTERNAL",
  "RESOLVED",
  "CLOSED",
  /** entered in error. Reached only through `voidTicket`, never a transition. */
  "VOIDED",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses that count as "open" for queue counters and the default dashboard filter. */
export const OPEN_STATUSES = ["NEW", "OPEN", "PENDING_CLIENT", "PENDING_INTERNAL"] as const satisfies readonly TicketStatus[];

export const COMMENT_VISIBILITIES = ["INTERNAL", "PUBLIC"] as const;
export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];

// --- Wave A enum mirrors. Same rules: closed, parity-checked against Prisma below. ---

/** Who wrote a comment. STAFF rows carry an authorId; REQUESTER and SYSTEM rows never do. */
export const COMMENT_AUTHOR_KINDS = ["STAFF", "REQUESTER", "SYSTEM"] as const;
export type CommentAuthorKind = (typeof COMMENT_AUTHOR_KINDS)[number];

/** Sending identity family: drives From / Reply-To / display name and the disclaimer variant. */
export const TICKET_BRANDS = ["CEDAR_RIDGE_WEALTH", "CEDAR_RIDGE_DIRECT"] as const;
export type TicketBrand = (typeof TICKET_BRANDS)[number];

/** How a ticket entered the desk. STAFF_FORM is the default and describes every pre-Wave-A row. */
export const TICKET_SOURCES = [
  "STAFF_FORM",
  "EMAIL",
  "CLIENT_APP",
  "PHONE",
  "VOICEMAIL",
  "SLACK",
  "SYSTEM",
  "IMPORT",
  "API",
] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

/**
 * The sources whose `Ticket.description` is **the requester's own words**.
 *
 * `description` holds the opening message of a thread, and who wrote it depends entirely on how the
 * ticket arrived. On an emailed or client-app ticket it is the text the client themselves sent; on
 * every other channel it is an operator's account of a request, written with colleagues as the
 * audience. `src/server/client-view.ts` renders the opening message back to the client as the first
 * entry of the thread, and this list is the ONE gate on that: a source not named here contributes no
 * opening entry at all.
 *
 * An ALLOWLIST, deliberately, so the default for anything new is exclusion. Each exclusion, in the
 * enum's own order:
 *
 *  - `STAFF_FORM` — an associate typed it at the desk. It is their summary of a call, an email they
 *    were forwarded, or a walk-in; showing it back would show the client our paraphrase of them.
 *  - `PHONE` — the same, written by the associate who was on the call (`logCall`, `src/lib/log-call.ts`).
 *  - `VOICEMAIL` — a judgement call, resolved to EXCLUDE. Two live paths produce this source and only
 *    one of them is a machine transcript: `logCall` maps the staff "Log a call → Voicemail" form to it
 *    (an operator's typed note), and the phone system ingest workflow composes the description from a
 *    transcript PLUS desk-internal material — the phone system line name, the call duration, and a link to
 *    the recording asset (`integrations/n8n/code/phone-system-voicemail-intake/build-voicemail-ticket.js`).
 *    Its withheld-number branch prepends "this ticket is addressed to the service desk so it can be
 *    worked as a callback task", which is the desk talking to itself. The transcript half is the
 *    client's words; the field as a whole is not, and the field is what would be sent.
 *  - `SLACK` — the Slack workflow's modal is filled in by the STAFF member who raised it, never by the
 *    client (`integrations/n8n/code/slack-to-ticket/build-the-ticket.js`).
 *  - `SYSTEM`, `API`, `IMPORT` — the desk talking to itself: a machine alert, a webhook payload, or an
 *    archived legacy help desk ticket whose opening text may be an agent's, with no way to tell after the fact.
 *
 * NOT THE SAME LIST AS {@link AUTO_ACK_SOURCES} (`src/server/system-messages.ts`), and the difference
 * is deliberate: that list asks WHO CREATED THE TICKET (does a receipt make sense?) and includes
 * `VOICEMAIL`; this one asks WHO WROTE THE TEXT OF `description` (may we show it back?) and excludes it.
 * A voicemail is a requester's call, but the stored field is a transcript wrapped in desk metadata.
 * Neither list may be derived from the other.
 *
 * WHAT THIS LIST DOES AND DOES NOT PROVE. It proves how a ticket ARRIVED. It does NOT, on its own,
 * prove that the CURRENT value of `description` is still the requester's verbatim text, because
 * `Ticket.description` is a stored, writable column. Two paths could break that and are closed at the
 * WRITE side rather than here, because a read-time gate cannot see who typed a field:
 *  - `updateTicketFields` (`src/server/tickets.actions.ts`) REFUSES a `description` edit on a ticket
 *    whose source is on this list — a client's own words are not the desk's to rewrite, mirroring
 *    `retractions.actions.ts`'s refusal to withdraw a REQUESTER comment on their behalf.
 *  - `POST /api/ingest/tickets` REFUSES a caller-declared source on this list, so one integration
 *    credential cannot post arbitrary text and have it rendered to a named client as their own words.
 * The one path that legitimately writes a DESK-COMPOSED body under `source: EMAIL` — releasing held
 * inbound mail — is excluded by {@link INTAKE_RELEASE_EXTERNAL_ID_PREFIX}; see there.
 *
 * WHERE THIS LIST IS ENFORCED (amended). Its authority is the `WHERE` of the
 * "ClientVisibleOpeningMessage" view, which admits a row only for these sources — the client-API role
 * is not granted `"Ticket".description` or `.source` at all, so an excluded channel has no row for any
 * code path to return. `openingMessageFor` re-checks this set on the `source` the view returns, as a
 * second belt. Guardrail G16 compares the view's SQL to this list in both directions, so adding a
 * source here without rebuilding the view fails the build.
 *
 * `src/types/domain.test.ts` pins this list against `TICKET_SOURCES` from both sides, so a tenth
 * source has to be classified on purpose rather than fall into (or silently out of) a client's view.
 */
export const REQUESTER_AUTHORED_SOURCES = ["EMAIL", "CLIENT_APP"] as const satisfies readonly TicketSource[];
export type RequesterAuthoredSource = (typeof REQUESTER_AUTHORED_SOURCES)[number];

/**
 * `Ticket.externalId` prefix written by `releaseHeldIntake` (`src/server/suspended-intake.actions.ts`),
 * and the SECOND gate on the opening entry.
 *
 * Releasing a held inbound message creates a ticket with `source: EMAIL` and a description the DESK
 * composed: the stored preview PLUS why the message was held, which internal mailbox it landed on, the
 * Message-ID, the raw-message pointer, a "SENDER NOT VERIFIED" instruction, the staff address that
 * forwarded it and the reviewer's note. `sanitizePII` redacts SSN, card and account numbers only
 *, so every one of those survives verbatim. Returning that field as the opening entry
 * would show a client the desk's review material attributed to them as "You" — the exact I1 class the
 * invariant names. On a FORWARDED release the preview is not even theirs: it is the colleague's
 * forwarding note, and the requester is the address parsed out from inside it.
 *
 * So the gate is the `externalId` and not the source: it is already on every released ticket ever
 * written, which a new `TicketSource` or a rewrite of the composer would not be — those fix tomorrow's
 * rows and leave history leaking. It fails SAFE in both directions: a row that merely looks like a
 * release loses its opening entry (no disclosure), and nothing can forge its way INTO the entry by
 * removing it, because the source allowlist still has to pass.
 *
 * It is enforced in the "ClientVisibleOpeningMessage" view's `WHERE`, as
 * `left(t."externalId", length('intake-release.')) <> 'intake-release.'` — a prefix test with no
 * pattern semantics, which is the same test `String.prototype.startsWith` performs with this constant.
 * Guardrail G16 pins that literal against this declaration, and no application code reads the column:
 * the client-API role is not granted `"Ticket"."externalId"`.
 */
export const INTAKE_RELEASE_EXTERNAL_ID_PREFIX = "intake-release." as const;

export const ESCALATION_TARGETS = ["NONE", "COMPLIANCE", "FRAUD", "OPERATIONS", "ADVISOR"] as const;
export type EscalationTarget = (typeof ESCALATION_TARGETS)[number];

export const SUSPENDED_INTAKE_REASONS = [
  "UNAUTHENTICATED",
  "AUTO_REPLY",
  "BOUNCE",
  "SYSTEM_SENDER",
  "SPAM",
  "UNKNOWN_MAILBOX",
  "LOOP_DETECTED",
  "PARSE_FAILED",
  "OVERSIZE",
  // --- Wave B ---
  "FORWARDED",
] as const;
export type SuspendedIntakeReason = (typeof SUSPENDED_INTAKE_REASONS)[number];

export const SUSPENDED_INTAKE_STATUSES = ["NEW", "RELEASED", "DISCARDED"] as const;
export type SuspendedIntakeStatus = (typeof SUSPENDED_INTAKE_STATUSES)[number];

export const MESSAGE_DELIVERY_STATUSES = [
  "QUEUED",
  "LEASED",
  "SENT",
  "FAILED",
  // --- Wave B ---
  "CANCELLED",
  "BOUNCED",
  "FAILED_SUPPRESSED",
] as const;
export type MessageDeliveryStatus = (typeof MESSAGE_DELIVERY_STATUSES)[number];

export const ATTACHMENT_KINDS = ["UPLOAD", "EMAIL_PART", "SYSTEM"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const ATTACHMENT_STATES = ["PENDING", "READY", "REMOVED"] as const;
export type AttachmentState = (typeof ATTACHMENT_STATES)[number];

/** v1 is INTERNAL-only: an attachment never travels through the client view or the export routes. */
export const ATTACHMENT_VISIBILITIES = ["INTERNAL"] as const;
export type AttachmentVisibility = (typeof ATTACHMENT_VISIBILITIES)[number];

export const SLA_ALERT_PHASES = ["FIRST_RESPONSE", "RESOLUTION"] as const;
export type SlaAlertPhase = (typeof SLA_ALERT_PHASES)[number];

export const SLA_ALERT_KINDS = ["WARNING", "BREACHED"] as const;
export type SlaAlertKind = (typeof SLA_ALERT_KINDS)[number];

/** Non-reply contact that legitimately stops the first-response clock. */
export const CLIENT_CONTACT_CHANNELS = ["PHONE", "VOICEMAIL_RETURNED", "IN_PERSON", "SMS"] as const;
export type ClientContactChannel = (typeof CLIENT_CONTACT_CHANNELS)[number];

// --- Wave B enum mirrors. Same rules: closed, parity-checked against Prisma below. ---

/** How a ticket ended, independent of how it was closed. NONE while it is live. */
export const TICKET_RESOLUTIONS = [
  "NONE",
  "ANSWERED",
  "COMPLETED",
  "DUPLICATE",
  "WITHDRAWN",
  "NO_RESPONSE",
  "ENTERED_IN_ERROR",
] as const;
export type TicketResolution = (typeof TICKET_RESOLUTIONS)[number];

/**
 * The four outcomes a member of staff records when a ticket ends.
 *
 * `NONE` is absent because "not recorded" is the DEFAULT, not a choice — omitting the field leaves the
 * column alone, and offering NONE as a value would make "I did not answer this question" and "the
 * outcome is nothing" the same audited write. `DUPLICATE` and `ENTERED_IN_ERROR` are absent because
 * they are not an operator's to write: `mergeTickets` sets DUPLICATE with the merge it describes, and
 * `voidTicket` sets ENTERED_IN_ERROR with the void reason that justifies it. Accepting either on a
 * plain status change would let it claim a merge or a void that never happened.
 *
 * Here rather than in `tickets.actions.ts` because the Resolve control renders this list
 * and a `"use server"` file may export nothing but actions. The server still owns the RULE — it
 * re-checks every value in `assertResolutionAllowed`; this is the vocabulary both halves read.
 */
export const OPERATOR_RESOLUTIONS = [
  "ANSWERED",
  "COMPLETED",
  "WITHDRAWN",
  "NO_RESPONSE",
] as const satisfies readonly TicketResolution[];
export type OperatorResolution = (typeof OPERATOR_RESOLUTIONS)[number];

/** The two statuses that END a ticket through a status change. VOIDED is not a transition. */
export const RESOLUTION_BEARING_STATUSES = ["RESOLVED", "CLOSED"] as const;

export function isOperatorResolution(r: string): r is OperatorResolution {
  return (OPERATOR_RESOLUTIONS as readonly string[]).includes(r);
}

export const NOTIFICATION_KINDS = [
  "MENTION",
  "ASSIGNED",
  "FOLLOWED_UPDATE",
  "REQUESTER_REPLY",
  "SLA_WARNING",
  "SLA_BREACH",
  "REVIEW_REQUESTED",
  "FOLLOW_UP_DUE",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * The `NotificationKind` values NOTHING in the tree writes yet, and therefore the ones no operator
 * may be offered as a promise.
 *
 * The enum member, the label and the channel default all exist for each of these (they are part of
 * the contract's enum list and the schema's `NotificationKind`, so they are NOT removed here), but no
 * code path creates a `Notification` with one: the SLA sweep records `SlaAlert` rows and a Slack
 * digest line through its own path and never touches `Notification`, and the review surfaces stamp
 * `CommentReview` rows without telling the reviewer's inbox. Listing them is the deferral, recorded
 * rather than hidden — the same hole shape as Decision #114 (`TicketResolution` had a column, an
 * index, a label map and a report, and no way for anyone to write one).
 *
 * Consequence, and the reason this table exists rather than a comment: every surface that ENUMERATES
 * the enum must enumerate {@link LIVE_NOTIFICATION_KINDS} instead, so the preferences sheet does not
 * draw a switch for a delivery that cannot happen and the inbox does not offer a filter that can only
 * return an empty page. The stored defaults are left exactly as they are (`SLA_BREACH` still defaults
 * to Slack DM + push) so that the day a writer lands, restoring the kind is one line here and the
 * intent behind the default is still on the record.
 *
 * Whoever lands the writer: `recordSlaAlert` in `src/jobs/sla-sweep.ts` already holds the ticket, the
 * phase and the assignee for `SLA_WARNING` / `SLA_BREACH`; the review stamp is the natural
 * `REVIEW_REQUESTED` source. Remove the kind from this list in the same change — the pairing test in
 * `src/types/domain.test.ts` fails while a kind has both a writer and a place on this list.
 */
export const NOTIFICATION_KINDS_PENDING_WRITER = [
  "SLA_WARNING",
  "SLA_BREACH",
  "REVIEW_REQUESTED",
] as const satisfies readonly NotificationKind[];
export type PendingWriterNotificationKind = (typeof NOTIFICATION_KINDS_PENDING_WRITER)[number];

/**
 * The kinds a running system can actually produce today: every `NotificationKind` that is not on
 * {@link NOTIFICATION_KINDS_PENDING_WRITER}. Derived rather than listed, so a NINTH kind added to the
 * enum is live (and visible) by default and has to be deliberately deferred to disappear from the UI.
 */
export const LIVE_NOTIFICATION_KINDS: readonly Exclude<NotificationKind, PendingWriterNotificationKind>[] =
  NOTIFICATION_KINDS.filter(
    (k): k is Exclude<NotificationKind, PendingWriterNotificationKind> =>
      !(NOTIFICATION_KINDS_PENDING_WRITER as readonly string[]).includes(k),
  );
export type LiveNotificationKind = (typeof LIVE_NOTIFICATION_KINDS)[number];

/** True iff something in the tree can actually create a notification of this kind today. */
export function isLiveNotificationKind(kind: NotificationKind): kind is LiveNotificationKind {
  return !(NOTIFICATION_KINDS_PENDING_WRITER as readonly string[]).includes(kind);
}

/** IN_APP is unconditional; SLACK_DM and WEB_PUSH are env-gated and silently skipped when unset. */
export const NOTIFICATION_CHANNELS = ["IN_APP", "SLACK_DM", "WEB_PUSH"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const FOLLOWER_SOURCES = ["MANUAL", "MENTION", "ASSIGNEE", "AUTHOR"] as const;
export type FollowerSource = (typeof FOLLOWER_SOURCES)[number];

export const TICKET_LINK_KINDS = ["RELATED", "DUPLICATE_OF", "BLOCKS"] as const;
export type TicketLinkKind = (typeof TICKET_LINK_KINDS)[number];

export const WEBHOOK_DELIVERY_STATUSES = ["PENDING", "SENT", "FAILED", "DEAD"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const API_TOKEN_SCOPES = [
  "CLIENT_READ",
  "CLIENT_WRITE",
  "INTEGRATION_INGEST",
  "INTEGRATION_OUTBOX",
  "EXPORT_READ",
  "MCP",
] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const IDENTITY_VERIFICATION_METHODS = [
  "CALLBACK_KNOWN_NUMBER",
  "IN_PERSON",
  "VIDEO",
  "DOCUMENT",
  "KBA",
  "ADVISOR_CONFIRMED",
  "OTHER",
] as const;
export type IdentityVerificationMethod = (typeof IDENTITY_VERIFICATION_METHODS)[number];

export const IDENTITY_VERIFICATION_RESULTS = ["VERIFIED", "FAILED", "OVERRIDDEN"] as const;
export type IdentityVerificationResult = (typeof IDENTITY_VERIFICATION_RESULTS)[number];

export const REVIEW_VERDICTS = ["APPROVED", "FLAGGED"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const SUPPRESSION_REASONS = [
  "HARD_BOUNCE",
  "COMPLAINT",
  "MANUAL",
  "UNSUBSCRIBE_REQUEST",
  "LOOP",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const DISCLAIMER_KEYS = [
  "NONE",
  "GENERAL_SERVICE",
  "WIRE_VERIFICATION",
  "TAX_DOCUMENT",
  "NOT_TAX_OR_LEGAL_ADVICE",
  "INVESTMENT_ADVICE",
] as const;
export type DisclaimerKey = (typeof DISCLAIMER_KEYS)[number];

/** Closed audit action catalog (mirrors the Prisma enum). See docs/ARCHITECTURE.md §e. */
export const AuditAction = {
  TICKET_CREATED: "TICKET_CREATED",
  TICKET_VIEWED: "TICKET_VIEWED",
  TICKET_PREVIEWED: "TICKET_PREVIEWED",
  TICKET_FIELD_CHANGED: "TICKET_FIELD_CHANGED",
  TICKET_STATUS_CHANGED: "TICKET_STATUS_CHANGED",
  TICKET_PRIORITY_CHANGED: "TICKET_PRIORITY_CHANGED",
  TICKET_ASSIGNED: "TICKET_ASSIGNED",
  TICKET_QUEUE_CHANGED: "TICKET_QUEUE_CHANGED",
  COMMENT_ADDED_INTERNAL: "COMMENT_ADDED_INTERNAL",
  COMMENT_ADDED_PUBLIC: "COMMENT_ADDED_PUBLIC",
  MACRO_APPLIED: "MACRO_APPLIED",
  PII_REDACTED: "PII_REDACTED",
  AUDIT_LOG_VIEWED: "AUDIT_LOG_VIEWED",
  AUDIT_LOG_EXPORTED: "AUDIT_LOG_EXPORTED",
  AUDIT_CHAIN_VERIFIED: "AUDIT_CHAIN_VERIFIED",
  CLIENT_API_READ: "CLIENT_API_READ",
  USER_SIGNED_IN: "USER_SIGNED_IN",
  USER_SIGNED_OUT: "USER_SIGNED_OUT",
  AUTHZ_DENIED: "AUTHZ_DENIED",
  // --- Wave A. Semantics: the build record "Audit catalog additions". ---
  COMMENT_ADDED_REQUESTER: "COMMENT_ADDED_REQUESTER",
  TICKET_REOPENED_BY_REQUESTER: "TICKET_REOPENED_BY_REQUESTER",
  TICKET_INGESTED: "TICKET_INGESTED",
  TICKET_LINKED: "TICKET_LINKED",
  INTAKE_SUSPENDED: "INTAKE_SUSPENDED",
  INTAKE_RELEASED: "INTAKE_RELEASED",
  MESSAGE_QUEUED: "MESSAGE_QUEUED",
  MESSAGE_LEASED: "MESSAGE_LEASED",
  MESSAGE_SENT: "MESSAGE_SENT",
  MESSAGE_FAILED: "MESSAGE_FAILED",
  ATTACHMENT_ADDED: "ATTACHMENT_ADDED",
  ATTACHMENT_VIEWED: "ATTACHMENT_VIEWED",
  ATTACHMENT_REMOVED: "ATTACHMENT_REMOVED",
  SLA_ALERT: "SLA_ALERT",
  TICKET_LIST_EXPORTED: "TICKET_LIST_EXPORTED",
  TICKET_EXPORT_READ: "TICKET_EXPORT_READ",
  CLIENT_CONTACT_RECORDED: "CLIENT_CONTACT_RECORDED",
  USER_DEACTIVATED: "USER_DEACTIVATED",
  USER_REACTIVATED: "USER_REACTIVATED",
  MACRO_CREATED: "MACRO_CREATED",
  MACRO_UPDATED: "MACRO_UPDATED",
  MACRO_DEACTIVATED: "MACRO_DEACTIVATED",
  MACRO_REACTIVATED: "MACRO_REACTIVATED",
  AUTHZ_DENIED_COALESCED: "AUTHZ_DENIED_COALESCED",
  JOB_RUN: "JOB_RUN",
  // --- Carried from Wave A CONTRACT §14: three actions that were borrowed from a neighbour + metadata. ---
  TICKET_REQUESTER_EMAIL_CHANGED: "TICKET_REQUESTER_EMAIL_CHANGED",
  INTAKE_DISCARDED: "INTAKE_DISCARDED",
  ATTACHMENT_INTENT_CREATED: "ATTACHMENT_INTENT_CREATED",
  // --- Wave B. Semantics: the build record ---
  NOTIFICATION_PREFS_CHANGED: "NOTIFICATION_PREFS_CHANGED",
  TICKET_FOLLOWED: "TICKET_FOLLOWED",
  TICKET_UNFOLLOWED: "TICKET_UNFOLLOWED",
  TICKET_LINK_ADDED: "TICKET_LINK_ADDED",
  TICKET_LINK_REMOVED: "TICKET_LINK_REMOVED",
  TICKET_MERGED: "TICKET_MERGED",
  TICKET_VOIDED: "TICKET_VOIDED",
  BULK_ACTION_APPLIED: "BULK_ACTION_APPLIED",
  COMMENT_RETRACTED: "COMMENT_RETRACTED",
  MESSAGE_CANCELLED: "MESSAGE_CANCELLED",
  MESSAGE_BOUNCED: "MESSAGE_BOUNCED",
  MACRO_ACTIONS_APPLIED: "MACRO_ACTIONS_APPLIED",
  AI_DRAFT_REQUESTED: "AI_DRAFT_REQUESTED",
  SLA_POLICY_CHANGED: "SLA_POLICY_CHANGED",
  WEBHOOK_ENDPOINT_CREATED: "WEBHOOK_ENDPOINT_CREATED",
  WEBHOOK_ENDPOINT_UPDATED: "WEBHOOK_ENDPOINT_UPDATED",
  WEBHOOK_ENDPOINT_REVOKED: "WEBHOOK_ENDPOINT_REVOKED",
  WEBHOOK_DELIVERY_SENT: "WEBHOOK_DELIVERY_SENT",
  WEBHOOK_DELIVERY_FAILED: "WEBHOOK_DELIVERY_FAILED",
  WEBHOOK_DELIVERY_DEAD: "WEBHOOK_DELIVERY_DEAD",
  REVIEW_STAMPED: "REVIEW_STAMPED",
  IDENTITY_VERIFIED: "IDENTITY_VERIFIED",
  IDENTITY_GATE_OVERRIDDEN: "IDENTITY_GATE_OVERRIDDEN",
  REPORT_EXPORTED: "REPORT_EXPORTED",
  API_TOKEN_CREATED: "API_TOKEN_CREATED",
  API_TOKEN_REVOKED: "API_TOKEN_REVOKED",
  API_TOKEN_ROTATED: "API_TOKEN_ROTATED",
  PUSH_SUBSCRIBED: "PUSH_SUBSCRIBED",
  PUSH_UNSUBSCRIBED: "PUSH_UNSUBSCRIBED",
  SUPPRESSION_ADDED: "SUPPRESSION_ADDED",
  SUPPRESSION_REMOVED: "SUPPRESSION_REMOVED",
  TICKET_IMPORTED: "TICKET_IMPORTED",
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
export const AUDIT_ACTIONS = Object.values(AuditAction) as readonly AuditAction[];

export const AuditEntityType = {
  TICKET: "TICKET",
  COMMENT: "COMMENT",
  USER: "USER",
  QUEUE: "QUEUE",
  MACRO: "MACRO",
  AUDIT_LOG: "AUDIT_LOG",
  SESSION: "SESSION",
  // --- Wave A ---
  ATTACHMENT: "ATTACHMENT",
  MESSAGE_DELIVERY: "MESSAGE_DELIVERY",
  SUSPENDED_INTAKE: "SUSPENDED_INTAKE",
  JOB: "JOB",
  /** A route, not a record: AUTHZ_DENIED_COALESCED stores the route path as entityId. */
  ENDPOINT: "ENDPOINT",
  // --- Wave B ---
  NOTIFICATION: "NOTIFICATION",
  TICKET_LINK: "TICKET_LINK",
  WEBHOOK_ENDPOINT: "WEBHOOK_ENDPOINT",
  WEBHOOK_DELIVERY: "WEBHOOK_DELIVERY",
  API_TOKEN: "API_TOKEN",
  REVIEW_STAMP: "REVIEW_STAMP",
  IDENTITY_VERIFICATION: "IDENTITY_VERIFICATION",
  PUSH_SUBSCRIPTION: "PUSH_SUBSCRIPTION",
  SUPPRESSION: "SUPPRESSION",
  /** One row of the SLA policy table (entityId = the SLA row id). */
  SLA_POLICY: "SLA_POLICY",
  /** A report, not a record: REPORT_EXPORTED stores the report key as entityId. */
  REPORT: "REPORT",
} as const;
export type AuditEntityType = (typeof AuditEntityType)[keyof typeof AuditEntityType];
export const AUDIT_ENTITY_TYPES = Object.values(AuditEntityType) as readonly AuditEntityType[];

/** Audit actions that are reads of ticket content. Excluded from the ticket-page activity feed. */
export const VIEW_AUDIT_ACTIONS = [
  "TICKET_VIEWED",
  "TICKET_PREVIEWED",
  "CLIENT_API_READ",
  // reads of client material that are audited but are not ticket-content views.
  "ATTACHMENT_VIEWED",
  "TICKET_EXPORT_READ",
] as const satisfies readonly AuditAction[];

/** Whitelist rendered as system events on the ticket timeline (S3 listTicketActivity, S6 Timeline). */
export const TIMELINE_AUDIT_ACTIONS = [
  "TICKET_CREATED",
  "TICKET_FIELD_CHANGED",
  "TICKET_STATUS_CHANGED",
  "TICKET_PRIORITY_CHANGED",
  "TICKET_ASSIGNED",
  "TICKET_QUEUE_CHANGED",
  "MACRO_APPLIED",
  "PII_REDACTED",
  // system events a staff reader needs in the chronology. MESSAGE_QUEUED / MESSAGE_SENT /
  // MESSAGE_FAILED are deliberately EXCLUDED — delivery state renders as a chip on the comment itself
  //, and a second rendering on the timeline would double every reply.
  "TICKET_INGESTED",
  "TICKET_REOPENED_BY_REQUESTER",
  "TICKET_LINKED",
  "INTAKE_RELEASED",
  "CLIENT_CONTACT_RECORDED",
  "ATTACHMENT_ADDED",
  "ATTACHMENT_REMOVED",
  "SLA_ALERT",
  // events a staff reader needs in the chronology of ONE ticket. Deliberately excluded:
  // TICKET_FOLLOWED / TICKET_UNFOLLOWED (housekeeping, one row per watcher per change),
  // BULK_ACTION_APPLIED (the per-ticket field/status row beside it already says what changed),
  // WEBHOOK_* and NOTIFICATION_* (fan-out of events already on the timeline), and MESSAGE_CANCELLED /
  // MESSAGE_BOUNCED (delivery state renders as a chip on the comment, like the other MESSAGE_* rows).
  "TICKET_LINK_ADDED",
  "TICKET_LINK_REMOVED",
  "TICKET_MERGED",
  "TICKET_VOIDED",
  "COMMENT_RETRACTED",
  "MACRO_ACTIONS_APPLIED",
  "REVIEW_STAMPED",
  "IDENTITY_VERIFIED",
  "IDENTITY_GATE_OVERRIDDEN",
  "TICKET_IMPORTED",
  "TICKET_REQUESTER_EMAIL_CHANGED",
] as const satisfies readonly AuditAction[];

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

/** Capability names. The grant table lives in src/lib/rbac.ts; see docs/ARCHITECTURE.md §b. */
export const CAPABILITIES = [
  "queue:read",
  "queue:write",
  "ticket:create",
  "ticket:move",
  "comment:internal",
  "comment:public",
  "audit:view",
  "audit:export",
  "audit:verify",
  // --- Wave A (#68) ---
  /** Upload / finalize / remove an attachment on a ticket: queue WRITE. */
  "attachment:write",
  /** Download an attachment: queue READ (every download writes ATTACHMENT_VIEWED). */
  "attachment:read",
  /** Create, edit, (de)activate macros at /admin/macros: ops_team or compliance_officers. */
  "macro:admin",
  /** Deactivate / reactivate staff accounts at /admin/users: ops_team only. */
  "user:admin",
  /** Export ticket rows as CSV: any group that can read at least one queue. */
  "ticket:export",
  /** Read held inbound mail at /admin/intake: ops_team or compliance_officers. */
  "intake:review",
  /** Release held mail into a ticket: intake:review PLUS queue WRITE on the destination queue. */
  "intake:release",
  /**
   * Re-point a ticket's `requesterEmail` at a different address. Queue WRITE, plus an explicit
   * confirmation and a recorded reason enforced by `changeRequesterEmail` — the address is the client
   * API's authorization subject and the destination of every outbound reply, not a data column.
   */
  "ticket:requester-email",
  // --- Wave B. Grant table: src/lib/rbac.ts; matrix: the build record ---
  /** Read /reports and export a report CSV: any group that can read at least one queue. */
  "reports:read",
  /** Edit SLA policy rows at /admin/sla: ops_team. */
  "sla:admin",
  /** Manage outbound webhook endpoints at /admin/webhooks: ops_team. */
  "webhooks:admin",
  /** Mint and revoke machine tokens at /admin/api-tokens: ops_team. */
  "tokens:admin",
  /** Stamp a supervisory review on a PUBLIC reply: compliance_officers or ops_team. */
  "review:stamp",
  /** Record an identity verification on a ticket: queue WRITE (the person who made the callback). */
  "identity:verify",
  /** Void a ticket as entered in error: ops_team AND queue WRITE. */
  "ticket:void",
  /** Add or remove a ticket-to-ticket link, and merge as duplicate: queue WRITE on BOTH tickets. */
  "links:write",
  /** Apply a bulk action: queue WRITE (re-checked per ticket, so a mixed selection partially applies). */
  "bulk:apply",
  /** See the personal inbox at /inbox: every authenticated staff member with any group. */
  "inbox",
  /** Manage the outbound suppression list at /admin/suppression: ops_team. */
  "suppression:admin",
  /** Read the environment-capability view at /admin/flags: ops_team or compliance_officers. */
  "flags:read",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Context for capability checks that depend on a queue. */
export type CapabilityContext = {
  queueKey?: QueueKey;
  fromQueueKey?: QueueKey;
  toQueueKey?: QueueKey;
};

export type QueueAccess = "READ" | "WRITE";

/** URL slugs for /queues/[queue]. */
export const QUEUE_SLUGS = {
  OPERATIONS: "operations",
  CLIENT_SERVICE: "client-service",
  ADVICE: "advice",
} as const satisfies Record<QueueKey, string>;
export type QueueSlug = (typeof QUEUE_SLUGS)[QueueKey];

export const QUEUE_LABELS: Readonly<Record<QueueKey, string>> = {
  OPERATIONS: "Operations",
  CLIENT_SERVICE: "Client Service",
  ADVICE: "Advice",
};

// ---------------------------------------------------------------------------
// Viewer / request context / dev personas
// ---------------------------------------------------------------------------

/** The authenticated staff member as seen by server code. Built only by src/lib/session.ts. */
export type Viewer = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  groups: OktaGroup[];
  /** True for dev-persona sessions (never true in production). */
  isDev: boolean;
};

/** Per-request evidentiary context. Built only by src/lib/client-ip.ts / src/lib/request-context.ts. */
export type RequestContext = {
  /** Client IP from the trusted-hop resolver; the literal "unknown" when it cannot be determined. */
  ipAddress: string;
  userAgent: string | null;
  /** `x-request-id` when the edge sets one, else a UUID minted once per request. */
  requestId: string;
  /** True when the request carries Next.js router-prefetch headers; such requests never log views. */
  isPrefetch: boolean;
};

export type DevPersonaKey = "ops" | "cs" | "advisor" | "compliance";
export type DevPersona = {
  key: DevPersonaKey;
  /** Fixed User.id (e.g. "staff_marco"), the same id the demo seed gives that staff member. */
  id: string;
  name: string;
  email: string;
  groups: OktaGroup[];
  /** One line on what this person does at the desk, shown on the sign-in page. */
  title: string;
};

// ---------------------------------------------------------------------------
// Action results (every server action returns one of these; actions never throw to the client)
// ---------------------------------------------------------------------------

export const ACTION_ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "VALIDATION",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL",
] as const;
export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

export type ActionError = {
  ok: false;
  code: ActionErrorCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
};
export type ActionSuccess<T> = { ok: true; data: T };
export type ActionResult<T> = ActionSuccess<T> | ActionError;

// ---------------------------------------------------------------------------
// PII
// ---------------------------------------------------------------------------

/**
 * The three kinds the desk redacts (2026-09-20).
 *
 * The list has been four and seven and is now three. `ROUTING` came out
 * because a routing number identifies a BANK, is published by the Fed, and cost the wire desk real
 * time for no protection once `ACCOUNT` stayed redacted — the routing+account PAIR is still broken.
 * `DOB`, `PASSPORT` and `DL` came out because a date of birth is working data on this desk (required
 * minimum distributions, beneficiary forms, caller verification), and the three were never in the
 * original spec.
 *
 * Redaction is irreversible, so rows written under the four-kind and seven-kind sets keep their old
 * tokens. Nothing is backfilled, and `[REDACTED:ROUTING]` / `[REDACTED:DOB]` / `[REDACTED:PASSPORT]`
 * / `[REDACTED:DL]` therefore still exist in the database. They are simply no longer WRITTEN.
 */
export const PII_KINDS = ["SSN", "CARD", "ACCOUNT"] as const;
export type PiiKind = (typeof PII_KINDS)[number];

/** Offsets are into the ORIGINAL text. The raw matched value is never included. */
export type PiiFinding = { kind: PiiKind; start: number; end: number; replacement: string };

export type SanitizeResult = {
  text: string;
  redacted: boolean;
  count: number;
  byKind: Record<PiiKind, number>;
  findings: PiiFinding[];
};

/**
 * Matches the replacement tokens `sanitizePII` WRITES, so the UI can highlight them. Narrowed with
 * `PII_KINDS`; `src/types/domain.test.ts` pins the alternation to `PII_KINDS`.
 */
export const PII_REPLACEMENT_PATTERN = /\[REDACTED:(SSN|CARD|ACCOUNT)(?: \*{4}\d{4})?\]/g;

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

export const SLA_STATUSES = ["ON_TRACK", "WARNING", "BREACHED", "MET"] as const;
export type SlaStatus = (typeof SLA_STATUSES)[number];

export const SLA_PHASES = ["FIRST_RESPONSE", "RESOLUTION", "COMPLETE"] as const;
export type SlaPhase = (typeof SLA_PHASES)[number];

/** WARNING when 0 <= remainingMs < this (strictly less than 30 minutes remaining). */
export const SLA_WARNING_THRESHOLD_MS = 30 * 60 * 1000;

export type SlaPolicyInput = { firstResponseMinutes: number; resolutionMinutes: number };

/**
 * Seed source of truth for the `SLA` table and code fallback if a row is missing.
 * Decision: calendar minutes, 24x7.
 * "Urgent wires: 2-hour SLA" → URGENT resolution 120; "Standard request: 24-hour SLA" → STANDARD resolution 1440.
 */
export const DEFAULT_SLA_POLICIES: Readonly<Record<TicketPriority, SlaPolicyInput & { name: string }>> = {
  URGENT: { name: "Urgent (wires, trade corrections)", firstResponseMinutes: 30, resolutionMinutes: 120 },
  HIGH: { name: "High", firstResponseMinutes: 60, resolutionMinutes: 480 },
  STANDARD: { name: "Standard request", firstResponseMinutes: 240, resolutionMinutes: 1440 },
  LOW: { name: "Low / planning", firstResponseMinutes: 480, resolutionMinutes: 4320 },
};

/** Timer fields as stored on Ticket; accepts Date or ISO string so DTOs and Prisma rows both work. */
export type SlaTimerFields = {
  firstResponseDueAt: Date | string;
  resolutionDueAt: Date | string;
  firstRespondedAt: Date | string | null;
  resolvedAt: Date | string | null;
};

export type SlaEvaluation = {
  phase: SlaPhase;
  status: SlaStatus;
  /** ISO string of the live clock's due date (resolutionDueAt when COMPLETE). */
  dueAt: string | null;
  /** dueAt - now (negative when overdue); for COMPLETE, resolutionDueAt - resolvedAt. */
  remainingMs: number | null;
  firstResponseMet: boolean | null;
  resolutionMet: boolean | null;
  /**
   * Wave B, both OPTIONAL so every existing reader is unchanged: the live policy that
   * produced this verdict, so B2's `SlaDetailPopover` — whose props are fixed at
   * `{ sla, ticketNumber }` — can say WHICH band coloured the chip rather than only the colour.
   * `policyName` is the `SLA` row's display name, null when the verdict came from the code default.
   */
  policyName?: string | null;
  /** The warning band that produced this verdict, in minutes. 0 means the band is disabled. */
  warningMinutes?: number | null;
};

// ---------------------------------------------------------------------------
// Routing (category → queue → default priority → default public-reply disclaimer)
// ---------------------------------------------------------------------------

export type RoutingRule = { queueKey: QueueKey; priority: TicketPriority; disclaimerKey: DisclaimerKey };

/** docs/ARCHITECTURE.md §c. Code-owned so it is versioned and reviewable. */
export const ROUTING_TABLE: Readonly<Record<TicketCategory, RoutingRule>> = {
  WIRE_TRANSFER: { queueKey: "OPERATIONS", priority: "URGENT", disclaimerKey: "WIRE_VERIFICATION" },
  ACAT: { queueKey: "OPERATIONS", priority: "STANDARD", disclaimerKey: "GENERAL_SERVICE" },
  TRADE_CORRECTION: { queueKey: "OPERATIONS", priority: "URGENT", disclaimerKey: "GENERAL_SERVICE" },
  CASH_MOVEMENT: { queueKey: "OPERATIONS", priority: "HIGH", disclaimerKey: "WIRE_VERIFICATION" },
  PORTAL_RESET: { queueKey: "CLIENT_SERVICE", priority: "HIGH", disclaimerKey: "GENERAL_SERVICE" },
  TAX_DOCUMENT: { queueKey: "CLIENT_SERVICE", priority: "STANDARD", disclaimerKey: "TAX_DOCUMENT" },
  ADDRESS_CHANGE: { queueKey: "CLIENT_SERVICE", priority: "STANDARD", disclaimerKey: "GENERAL_SERVICE" },
  REBALANCING: { queueKey: "ADVICE", priority: "STANDARD", disclaimerKey: "INVESTMENT_ADVICE" },
  PLANNING_UPDATE: { queueKey: "ADVICE", priority: "LOW", disclaimerKey: "INVESTMENT_ADVICE" },
  TAX_LOSS_HARVESTING: { queueKey: "ADVICE", priority: "STANDARD", disclaimerKey: "NOT_TAX_OR_LEGAL_ADVICE" },
  OTHER: { queueKey: "CLIENT_SERVICE", priority: "STANDARD", disclaimerKey: "GENERAL_SERVICE" },
  // --- Wave A. Queue follows who actually works the request today; priority follows the
  // money-movement / identity risk; the disclaimer follows §f's "never advice unless it is advice" rule. ---
  ACCOUNT_CLOSURE: { queueKey: "OPERATIONS", priority: "HIGH", disclaimerKey: "GENERAL_SERVICE" },
  BENEFICIARY_TOD: { queueKey: "OPERATIONS", priority: "STANDARD", disclaimerKey: "NOT_TAX_OR_LEGAL_ADVICE" },
  RETURNED_CHECK: { queueKey: "OPERATIONS", priority: "HIGH", disclaimerKey: "WIRE_VERIFICATION" },
  RETURNED_MAIL: { queueKey: "CLIENT_SERVICE", priority: "STANDARD", disclaimerKey: "GENERAL_SERVICE" },
  PASSKEY_LOGIN: { queueKey: "CLIENT_SERVICE", priority: "HIGH", disclaimerKey: "GENERAL_SERVICE" },
  IDENTITY_VERIFICATION: { queueKey: "CLIENT_SERVICE", priority: "HIGH", disclaimerKey: "GENERAL_SERVICE" },
  COMPLAINT: { queueKey: "CLIENT_SERVICE", priority: "URGENT", disclaimerKey: "GENERAL_SERVICE" },
  RETIREMENT_DISTRIBUTION: { queueKey: "OPERATIONS", priority: "HIGH", disclaimerKey: "NOT_TAX_OR_LEGAL_ADVICE" },
  COST_BASIS: { queueKey: "OPERATIONS", priority: "STANDARD", disclaimerKey: "NOT_TAX_OR_LEGAL_ADVICE" },
  VOICEMAIL_CALLBACK: { queueKey: "CLIENT_SERVICE", priority: "HIGH", disclaimerKey: "GENERAL_SERVICE" },
  STATEMENT_REQUEST: { queueKey: "CLIENT_SERVICE", priority: "STANDARD", disclaimerKey: "GENERAL_SERVICE" },
};

export const CATEGORY_LABELS: Readonly<Record<TicketCategory, string>> = {
  WIRE_TRANSFER: "Wire transfer",
  ACAT: "ACAT / account transfer",
  TRADE_CORRECTION: "Custodian trade correction",
  CASH_MOVEMENT: "Cash movement",
  PORTAL_RESET: "Portal access / reset",
  TAX_DOCUMENT: "Tax document / 1099",
  ADDRESS_CHANGE: "Address change",
  REBALANCING: "Portfolio rebalancing",
  PLANNING_UPDATE: "Financial planning update",
  TAX_LOSS_HARVESTING: "Tax-loss harvesting",
  OTHER: "Other",
  ACCOUNT_CLOSURE: "Account closure",
  BENEFICIARY_TOD: "Beneficiary / TOD",
  RETURNED_CHECK: "Returned check",
  RETURNED_MAIL: "Returned mail",
  PASSKEY_LOGIN: "Passkey / login",
  IDENTITY_VERIFICATION: "Identity verification",
  COMPLAINT: "Complaint",
  RETIREMENT_DISTRIBUTION: "RMD / rollover / distribution",
  COST_BASIS: "Cost basis",
  VOICEMAIL_CALLBACK: "Voicemail / callback",
  STATEMENT_REQUEST: "Statement request",
};

/** Display labels for the Wave A enums. UI never renders a raw enum value. */
export const BRAND_LABELS: Readonly<Record<TicketBrand, string>> = {
  CEDAR_RIDGE_WEALTH: "Cedar Ridge Wealth",
  CEDAR_RIDGE_DIRECT: "Cedar Ridge Direct",
};

export const SOURCE_LABELS: Readonly<Record<TicketSource, string>> = {
  STAFF_FORM: "Staff form",
  EMAIL: "Email",
  CLIENT_APP: "Client app",
  PHONE: "Phone",
  VOICEMAIL: "Voicemail",
  SLACK: "Slack",
  SYSTEM: "System",
  IMPORT: "Import",
  API: "API",
};

export const ESCALATION_TARGET_LABELS: Readonly<Record<EscalationTarget, string>> = {
  NONE: "Not escalated",
  COMPLIANCE: "Compliance",
  FRAUD: "Fraud",
  OPERATIONS: "Operations",
  ADVISOR: "Advisor",
};

export const CLIENT_CONTACT_CHANNEL_LABELS: Readonly<Record<ClientContactChannel, string>> = {
  PHONE: "Phone call",
  VOICEMAIL_RETURNED: "Voicemail returned",
  IN_PERSON: "In person",
  SMS: "SMS",
};

export const MESSAGE_DELIVERY_STATUS_LABELS: Readonly<Record<MessageDeliveryStatus, string>> = {  QUEUED: "Queued",
  LEASED: "Sending",
  SENT: "Sent",
  FAILED: "Failed",
  // Wave B. "Cancelled" and "Not sent" both mean nothing left the desk; "Bounced" means a provider
  // accepted it and then could not deliver it, which is the one case where the client's mailbox is the
  // reason and the desk has to act.
  CANCELLED: "Cancelled",
  BOUNCED: "Bounced",
  FAILED_SUPPRESSED: "Not sent (suppressed)",
};

export const SUSPENDED_INTAKE_REASON_LABELS: Readonly<Record<SuspendedIntakeReason, string>> = {  UNAUTHENTICATED: "Sender not authenticated",
  AUTO_REPLY: "Automatic reply",
  BOUNCE: "Bounce / delivery report",
  SYSTEM_SENDER: "System sender",
  SPAM: "Flagged as spam",
  UNKNOWN_MAILBOX: "Unknown mailbox",
  LOOP_DETECTED: "Mail loop",
  PARSE_FAILED: "Could not be parsed",
  OVERSIZE: "Too large",
  FORWARDED: "Forwarded message",
};

// --- Wave B label maps. The UI never renders a raw enum value. ---

export const RESOLUTION_LABELS: Readonly<Record<TicketResolution, string>> = {
  NONE: "—",
  ANSWERED: "Answered",
  COMPLETED: "Completed",
  DUPLICATE: "Duplicate",
  WITHDRAWN: "Withdrawn by client",
  NO_RESPONSE: "No client response",
  ENTERED_IN_ERROR: "Entered in error",
};

export const NOTIFICATION_KIND_LABELS: Readonly<Record<NotificationKind, string>> = {
  MENTION: "Mentioned you",
  ASSIGNED: "Assigned to you",
  FOLLOWED_UPDATE: "Ticket you follow",
  REQUESTER_REPLY: "Client replied",
  SLA_WARNING: "SLA warning",
  SLA_BREACH: "SLA breached",
  REVIEW_REQUESTED: "Awaiting your review",
  FOLLOW_UP_DUE: "Follow-up due",
};

export const NOTIFICATION_CHANNEL_LABELS: Readonly<Record<NotificationChannel, string>> = {
  IN_APP: "In app",
  SLACK_DM: "Slack DM",
  WEB_PUSH: "Push",
};

export const TICKET_LINK_KIND_LABELS: Readonly<Record<TicketLinkKind, string>> = {
  RELATED: "Related to",
  DUPLICATE_OF: "Duplicate of",
  BLOCKS: "Blocks",
};

/** How the same link reads from the OTHER ticket. RELATED is symmetric; the other two invert. */
export const TICKET_LINK_INVERSE_LABELS: Readonly<Record<TicketLinkKind, string>> = {
  RELATED: "Related to",
  DUPLICATE_OF: "Has duplicate",
  BLOCKS: "Blocked by",
};

export const WEBHOOK_DELIVERY_STATUS_LABELS: Readonly<Record<WebhookDeliveryStatus, string>> = {
  PENDING: "Pending",
  SENT: "Sent",
  FAILED: "Retrying",
  DEAD: "Given up",
};

export const API_TOKEN_SCOPE_LABELS: Readonly<Record<ApiTokenScope, string>> = {
  CLIENT_READ: "Client API — read",
  CLIENT_WRITE: "Client API — write",
  INTEGRATION_INGEST: "Ingest",
  INTEGRATION_OUTBOX: "Outbox",
  EXPORT_READ: "Export",
  MCP: "MCP",
};

export const IDENTITY_VERIFICATION_METHOD_LABELS: Readonly<Record<IdentityVerificationMethod, string>> = {
  CALLBACK_KNOWN_NUMBER: "Callback to the number on file",
  IN_PERSON: "In person",
  VIDEO: "Video call",
  DOCUMENT: "Document reviewed",
  KBA: "Knowledge-based questions",
  ADVISOR_CONFIRMED: "Confirmed by the advisor",
  OTHER: "Other",
};

export const IDENTITY_VERIFICATION_RESULT_LABELS: Readonly<Record<IdentityVerificationResult, string>> = {
  VERIFIED: "Verified",
  FAILED: "Not verified",
  OVERRIDDEN: "Gate overridden",
};

export const REVIEW_VERDICT_LABELS: Readonly<Record<ReviewVerdict, string>> = {
  APPROVED: "Approved",
  FLAGGED: "Flagged",
};

export const SUPPRESSION_REASON_LABELS: Readonly<Record<SuppressionReason, string>> = {
  HARD_BOUNCE: "Hard bounce",
  COMPLAINT: "Spam complaint",
  MANUAL: "Added by staff",
  UNSUBSCRIBE_REQUEST: "Client asked to stop",
  LOOP: "Mail loop",
};

export const FOLLOWER_SOURCE_LABELS: Readonly<Record<FollowerSource, string>> = {
  MANUAL: "Followed",
  MENTION: "Mentioned",
  ASSIGNEE: "Assigned",
  AUTHOR: "Replied",
};

/**
 * The INTERNAL prefix `recordClientContact` writes into its note, and the marker the UI keys on.
 * Kept here (not in a server module) so the composer, the timeline and the server all agree.
 */
export const CLIENT_CONTACT_NOTE_PREFIX = "CLIENT CONTACT" as const;

/** Hard caps shared by the machine write paths, the composer and the attachment server. */
export const INGEST_LIMITS = {
  /** Max characters of an ingested subject before truncation. */
  subjectMaxChars: 200,
  /** Max characters of an ingested body; the remainder is replaced by BODY_TRUNCATION_NOTE. */
  bodyMaxChars: 20_000,
  /** Max bytes of a single ingest/client JSON request. */
  requestMaxBytes: 1_048_576,
  /** Max bytes of one attachment object. */
  attachmentMaxBytes: 26_214_400,
  /** Max attachments accepted on one inbound message. */
  attachmentsPerMessage: 10,
  /** Max characters of a SuspendedIntake.snippet. */
  snippetMaxChars: 2_000,
} as const;

/** Appended verbatim when an inbound body is cut at `INGEST_LIMITS.bodyMaxChars`. */
export const BODY_TRUNCATION_NOTE = "\n\n[Message truncated by the help desk — the full original is in the mailbox.]" as const;

/** MIME types an attachment may carry in v1. Anything else is refused at intent time. */
export const ATTACHMENT_MIME_ALLOWLIST = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/heic",
  "image/heif",
  "text/csv",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIME_ALLOWLIST)[number];

/** Status state machine. CLOSED is terminal. */
/**
 * `VOIDED` appears here ONLY as a key with an empty list. It is never a TARGET.
 *
 * Voiding is not a status change an agent makes from the status control: it needs ops_team, a recorded
 * reason of at least twelve characters, and a refusal once any PUBLIC reply exists. Putting it in this
 * table would hand every holder of `queue:write` a one-click way to make a ticket disappear from every
 * counter. `voidTicket` writes the transition itself, exactly as `changeRequesterEmail` writes the
 * privileged half of the requester-address edit rather than widening `updateTicketFields`.
 */
export const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  NEW: ["OPEN", "PENDING_CLIENT", "PENDING_INTERNAL", "RESOLVED"],
  OPEN: ["PENDING_CLIENT", "PENDING_INTERNAL", "RESOLVED"],
  PENDING_CLIENT: ["OPEN", "RESOLVED"],
  PENDING_INTERNAL: ["OPEN", "RESOLVED"],
  RESOLVED: ["OPEN", "CLOSED"],
  CLOSED: [],
  VOIDED: [],
};

/**
 * Statuses a ticket can be in and still be nobody's work and nobody's number. Every counter, every SLA
 * predicate, every report and every CSV export applies `status: { notIn: METRICS_EXCLUDED_STATUSES }`.
 *
 * Only VOIDED is here, and that is the whole point of the status: a ticket entered in error never
 * happened, so counting it as backlog, as a breach or as volume would make the desk's own numbers wrong
 * in the direction that flatters nobody. CLOSED is deliberately NOT here — a closed ticket is real work.
 */
export const METRICS_EXCLUDED_STATUSES = ["VOIDED"] as const satisfies readonly TicketStatus[];

/**
 * Categories whose tickets may not reach RESOLVED without an IdentityVerification row, or an audited
 * ops_team override. These are the five where an impostor's success is irreversible:
 * money leaves, an account closes, or the address every future statement goes to changes.
 */
export const MONEY_MOVEMENT_CATEGORIES = [
  "WIRE_TRANSFER",
  "CASH_MOVEMENT",
  "ACCOUNT_CLOSURE",
  "ADDRESS_CHANGE",
  "RETIREMENT_DISTRIBUTION",
] as const satisfies readonly TicketCategory[];

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------

/** Placeholder values for {{ticket.number}}, {{requester.name}}, {{requester.firstName}}, {{agent.name}}, {{today}}. */
export type MacroVars = {
  ticket: { number: string };
  requester: { name: string; firstName: string };
  agent: { name: string };
  today: string;
};

// ---------------------------------------------------------------------------
// Audit (shared shapes; DB-row helpers stay in src/lib/audit.ts)
// ---------------------------------------------------------------------------

/** Who performed an audited action. `id` is null for system and client-API actors. */
export type AuditActor = { id: string | null; email: string; groups: OktaGroup[] };

/**
 * One audit row to write. `metadata` is supplementary (outside the hash chain) and is
 * `Prisma.InputJsonValue | undefined` — never `null` (Prisma rejects bare null for Json?).
 */
export type AuditEntry = {
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  ticketId?: string | null;
  fieldChanged?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  metadata?: Prisma.InputJsonValue;
};

// ---------------------------------------------------------------------------
// Action inputs (zod schemas in src/server/validation.ts must infer to exactly these types)
// ---------------------------------------------------------------------------

export type CreateTicketInput = {
  subject: string;
  description: string;
  category: TicketCategory;
  /** Defaults to ROUTING_TABLE[category].priority. */
  priority?: TicketPriority;
  /** Defaults to ROUTING_TABLE[category].queueKey; an override must pass canCreateTicket. */
  queueKey?: QueueKey;
  requesterName: string;
  requesterEmail: string;
  clientReference?: string;
  assigneeId?: string;
};

export type UpdateTicketFieldsInput = {
  ticketId: string;
  version: number;
  subject?: string;
  description?: string;
  clientReference?: string | null;
  category?: TicketCategory;
  // --- Wave A. Every one diffs into TICKET_FIELD_CHANGED exactly as today. `undefined` means
  // "not submitted"; an explicit `null` clears a nullable column. `complaintFiledAt` is NOT an input —
  // the server stamps it the first time `isComplaint` flips true. ---
  requesterName?: string;
  /** Normalized (trim + lower-case) before the diff, so the client API's equality check keeps working. */
  requesterEmail?: string | null;
  /** E.164: `+` then 8..15 digits. */
  requesterPhone?: string | null;
  brand?: TicketBrand;
  isComplaint?: boolean;
  escalationTarget?: EscalationTarget;
  /** ISO-8601. */
  followUpAt?: string | null;
  externalRef?: string | null;
};

/** S6 `recordClientContact`: credits a non-reply contact as the first response. */
export type RecordClientContactInput = {
  ticketId: string;
  version: number;
  channel: ClientContactChannel;
  /** 1..20000 chars; sanitized and written as an INTERNAL note prefixed with CLIENT_CONTACT_NOTE_PREFIX. */
  note: string;
};

/** S6 `assignToMe`: one-click self-assignment for a viewer with WRITE on the ticket's queue. */
export type AssignToMeInput = { ticketId: string; version: number };

/**
 * Input for `changeRequesterEmail` (src/server/tickets.actions.ts), capability `ticket:requester-email`.
 *
 * Redirecting an EXISTING requester address is an access-control decision, not a field edit:
 * `/api/client/tickets/[id]` and `.../messages` authorize purely on
 * `ticket.requesterEmail === X-Requester-Email`, so the new address gains read access to every PUBLIC
 * comment already on the thread, and `addPublicReply` delivers every future reply there. It therefore
 * leaves `updateTicketFields` (which keeps adopting a FIRST address and clearing one) and gets its own
 * action with an explicit confirmation and a recorded reason — the `deactivateUser` shape.
 */
export type ChangeRequesterEmailInput = {
  ticketId: string;
  version: number;
  /** The new address. Never null: clearing an address stays on `updateTicketFields`. */
  requesterEmail: string;
  /** Why the correspondence is being redirected. Recorded on the audit row; sanitized first. */
  reason: string;
  /** The second step of a two-step confirmation. Anything but a literal `true` is refused. */
  confirm: true;
};

/** S8 user administration. Both actions are ops_team-only and fully audited. */
export type SetUserActiveInput = { userId: string; isActive: boolean; reason?: string };

/** S9 macro administration (ops_team or compliance_officers). */
export type MacroAdminInput = {
  key: string;
  title: string;
  queueKey: QueueKey | null;
  body: string;
  channel: CommentVisibility;
  disclaimerKey: DisclaimerKey;
  sortOrder: number;
};
export type UpdateMacroInput = Partial<Omit<MacroAdminInput, "key">> & { macroId: string };
export type SetMacroActiveInput = { macroId: string; isActive: boolean };

export type ChangeStatusInput = {
  ticketId: string;
  version: number;
  status: TicketStatus;
  /**
   * How the ticket ENDED, recorded in the same transaction as the status change
   * (the build record: "Set alongside RESOLVED / CLOSED / VOIDED").
   *
   * Optional, because a resolve with the outcome not yet known must still be possible — the column
   * then stays `NONE`, which is what `resolution-mix` reports as "Not recorded". The action accepts
   * only the four OPERATOR outcomes here and only on a move into RESOLVED or CLOSED: `DUPLICATE`
   * belongs to `mergeTickets` and `ENTERED_IN_ERROR` to `voidTicket`, which write it themselves.
   */
  resolution?: TicketResolution;
};
export type ChangePriorityInput = { ticketId: string; version: number; priority: TicketPriority };
export type AssignTicketInput = { ticketId: string; version: number; assigneeId: string | null };
export type MoveQueueInput = { ticketId: string; version: number; queueKey: QueueKey };

/**
 * Body of an INTERNAL note. Visibility is fixed by the action (addInternalNote), never a field.
 * Deliberately carries no `version`: appending a comment never conflicts with a field edit; the
 * Ticket side effects are conditional updateMany writes instead.
 */
export type CommentBodyInput = { ticketId: string; body: string; macroId?: string };

/** Body of a PUBLIC reply. Visibility is fixed by the action (addPublicReply), never a field. */
export type PublicReplyInput = CommentBodyInput & {
  /** Must not be NONE. */
  disclaimerKey: DisclaimerKey;
  /** Must be true — the agent confirmed the appended disclaimer text. */
  disclaimerAcknowledged: boolean;
};

export type CommentActionResult = {
  id: string;
  piiRedacted: boolean;
  piiRedactionCount: number;
  /** True when this PUBLIC reply set Ticket.firstRespondedAt. Always false for internal notes. */
  firstResponseStamped: boolean;
};

// ---------------------------------------------------------------------------
// Query inputs (URL-driven; parsed by zod in src/server/validation.ts)
// ---------------------------------------------------------------------------

export const TICKET_SORTS = ["resolutionDueAt", "createdAt", "updatedAt", "priority"] as const;
export type TicketSort = (typeof TICKET_SORTS)[number];

export const FOLLOW_UP_FILTERS = ["due", "overdue", "any"] as const;
export type FollowUpFilter = (typeof FOLLOW_UP_FILTERS)[number];

/** Scope of the staff ticket CSV export. `full` adds the original description and comment bodies. */
export const TICKET_EXPORT_SCOPES = ["standard", "full"] as const;
export type TicketExportScope = (typeof TICKET_EXPORT_SCOPES)[number];

/**
 * URL-driven list query. Multi-value fields (`status`, `priority`, `slaStatus`) travel as REPEATED
 * BARE KEYS (`?status=NEW&status=OPEN`), never `status[]`; parsers also split single values on ","
 * (docs/ARCHITECTURE.md §g shared convention 12).
 */
export type TicketListQuery = {
  queueKey?: QueueKey;
  /** Default: OPEN_STATUSES ∪ RESOLVED (everything except CLOSED). */
  status?: TicketStatus[];
  priority?: TicketPriority[];
  /** A user id, or the literals "me" / "unassigned". */
  assigneeId?: string;
  /** Evaluated in SQL (src/server/sla-where.ts), never post-pagination. */
  slaStatus?: SlaStatus[];
  search?: string;
  // --- Wave A filters (S6 parses, S7 renders). Multi-valued keys repeat bare (convention 12). ---
  category?: TicketCategory[];
  brand?: TicketBrand[];
  source?: TicketSource[];
  /** true → only complaints; false → only non-complaints; undefined → no constraint. */
  isComplaint?: boolean;
  /** "due" = followUpAt <= now; "overdue" = followUpAt < start of today; "any" = followUpAt not null. */
  followUp?: FollowUpFilter;
  /** ISO-8601 bounds on `createdAt` (inclusive from, exclusive to). */
  createdFrom?: string;
  createdTo?: string;
  /**
   * Exact requester email, lower-cased.
   *
   * It has to stay a predicate — a ticket with no linked advisor platform person has nothing else to filter on, and
   * `/api/tickets/export` supports it — but prefer `requesterExternalId` wherever the ticket carries
   * one. A named client's address in a URL lands verbatim in Cloud Run's `httpRequest.requestUrl` and
   * in browser history, neither of which the desk's PII rules reach.
   */
  requesterEmail?: string;
  /**
   * The advisor platform person pointer (`Ticket.requesterExternalId`). Preferred over `requesterEmail`: it is an opaque
   * id, so it is safe in a URL, in a Cloud Run access log and in browser history. The chip that renders
   * it must show the requester's NAME, never the id.
   */
  requesterExternalId?: string;
  sort: TicketSort;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

export type AuditQuery = {
  /** ISO-8601 bounds on occurredAt. */
  from?: string;
  to?: string;
  actorEmail?: string;
  /** Repeated bare `action=` keys in the URL (convention 12). */
  action?: AuditAction[];
  entityType?: AuditEntityType;
  ticketNumber?: number;
  /** Decimal-string seq of the last row seen; pages are ordered by seq desc. */
  cursor?: string;
  limit: number;
};

// ---------------------------------------------------------------------------
// DTOs (staff surfaces). All dates ISO strings; seq as decimal string.
// ---------------------------------------------------------------------------

export type UserRef = { id: string; name: string | null; email: string; image: string | null };
export type AssigneeOption = UserRef & { groups: OktaGroup[] };

export type TicketPermissions = {
  canWrite: boolean;
  canInternalNote: boolean;
  canPublicReply: boolean;
  canMove: boolean;
  movableTo: QueueKey[];
  allowedStatuses: TicketStatus[];
};

export type TicketListRow = {
  id: string;
  number: number;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  queueKey: QueueKey;
  assignee: UserRef | null;
  requesterName: string;
  // --- Wave A. Carried on LIST rows (not only the detail DTO) so the dashboard can render flag badges
  // and filter chips without a second fetch, and so the CSV export builds from one shape. ---
  brand: TicketBrand;
  source: TicketSource;
  isComplaint: boolean;
  complaintFiledAt: string | null;
  escalationTarget: EscalationTarget;
  followUpAt: string | null;
  externalRef: string | null;
  // --- Wave B. On LIST rows for the same reason as the Wave A flags: the board renders the merge and
  // void chips, the bulk bar decides what it may apply, and the CSV export builds from one shape. ---
  resolution: TicketResolution;
  /** Set when this ticket was merged into another. The board shows it read-only and links across. */
  mergedIntoId: string | null;
  mergedIntoNumber: number | null;
  createdAt: string;
  updatedAt: string;
  firstResponseDueAt: string;
  resolutionDueAt: string;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  piiRedacted: boolean;
  /**
   * Total redactions on the ticket and its comments. Carried on list rows (not only the detail DTO)
   * so `PiiIndicator` always renders a real count — never a fabricated 1 (contract amendment #27).
   */
  piiRedactionCount: number;
  /**
   * Optimistic-concurrency token. Carried on list rows — not only on the detail DTO — so the
   * dashboard's inline `AssigneeSelect` can call `assignTicket` with the real version instead of
   * guaranteeing a CONFLICT. Declared once here and inherited by `TicketDetailDTO` (contract amendment #46).
   */
  version: number;
  /** Computed server-side at render; the SlaBadge recomputes client-side from the timer fields. */
  sla: SlaEvaluation;
};

export type TicketDetailDTO = TicketListRow & {
  description: string;
  clientReference: string | null;
  /** NULL when the ticket was opened from a phone call or voicemail. */
  requesterEmail: string | null;
  /** E.164, or null. */
  requesterPhone: string | null;
  /** Opaque advisor platform pointers — ids only, never account numbers. */
  householdId: string | null;
  requesterExternalId: string | null;
  /** The ticket this one was opened from when a requester replied to a CLOSED ticket. */
  linkedFromTicketId: string | null;
  externalId: string | null;
  queueId: string;
  queueName: string;
  createdBy: UserRef;
  slaFirstResponseMinutes: number;
  slaResolutionMinutes: number;
  closedAt: string | null;
  // --- Wave B ---
  /** Set together, by `voidTicket` only. Null on every live ticket (DB CHECK, both directions). */
  voidedAt: string | null;
  voidReason: string | null;
  mergedAt: string | null;
  /** Status-aware (docs/ARCHITECTURE.md §b.9: CLOSED → read-plus-annotate for everyone). */
  permissions: TicketPermissions;
};

export type TicketListPage = { rows: TicketListRow[]; total: number; page: number; pageSize: number };

/** Staff-facing comment. Carries visibility so the UI can style INTERNAL rows; never sent to clients. */
export type CommentDTO = {
  id: string;
  ticketId: string;
  visibility: CommentVisibility;
  body: string;
  disclaimerKey: DisclaimerKey;
  /** STAFF | REQUESTER | SYSTEM. `author` is non-null exactly when this is "STAFF". */
  authorKind: CommentAuthorKind;
  /** NULL for REQUESTER and SYSTEM rows — a requester is not a User and a job is not a person. */
  author: UserRef | null;
  /**
   * What a staff surface prints as the author of a non-STAFF row: the requester's name for REQUESTER,
   * the system label for SYSTEM. Never used for STAFF rows (they render `author`).
   */
  authorLabel: string;
  macroId: string | null;
  macroTitle: string | null;
  /**
   * Outbound state of this comment, when it has one. PUBLIC staff replies get a MessageDelivery row in
   * the same transaction; INTERNAL notes and requester messages never do, so this is null for them.
   */
  delivery: CommentDeliveryDTO | null;
  /** READY attachments on this comment. INTERNAL-only in v1 — never sent to a client surface. */
  attachments: AttachmentDTO[];
  /**
   * Wave B. Non-null when this comment has been withdrawn. The BODY above is still the stored record —
   * a staff surface shows it struck through behind a disclosure, because the desk has to be able to
   * read what it sent — and the client surface never receives it at all (the view blanks it).
   */
  retraction: CommentRetractionDTO | null;
  /** Wave B. Supervisory review stamps on this comment, oldest first. Empty for INTERNAL notes. */
  reviews: ReviewStampDTO[];
  piiRedacted: boolean;
  piiRedactionCount: number;
  createdAt: string;
};

/** Delivery state as a comment renders it. Carries no body — the comment IS the body. */
export type CommentDeliveryDTO = {
  id: string;
  status: MessageDeliveryStatus;
  attempts: number;
  toAddress: string;
  sentAt: string | null;
  /** Sanitized, truncated failure reason. Shown only for FAILED. */
  lastError: string | null;
};

/** One attachment as a staff surface renders it. There is no client-facing attachment DTO by design. */
export type AttachmentDTO = {
  id: string;
  ticketId: string;
  commentId: string | null;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  size: number;
  state: AttachmentState;
  uploader: UserRef | null;
  createdAt: string;
};

/** Payload of GET /api/tickets/[id]/preview (slide-over). One fetch = one TICKET_PREVIEWED row. */
export type TicketPreviewDTO = { ticket: TicketDetailDTO; comments: CommentDTO[] };

export type QueueSummary = {
  key: QueueKey;
  slug: QueueSlug;
  name: string;
  description: string;
  /** Count of tickets not CLOSED. */
  total: number;
  /** Count of tickets in OPEN_STATUSES. */
  open: number;
  byStatus: Record<TicketStatus, number>;
  byPriority: Record<TicketPriority, number>;
  breached: number;
  warning: number;
  unassigned: number;
  canRead: boolean;
  canWrite: boolean;
};

/** Payload of GET /api/queues/summary. */
export type QueueSummaryResponse = { queues: QueueSummary[]; generatedAt: string };

export type MacroDTO = {
  id: string;
  key: string;
  title: string;
  queueKey: QueueKey | null;
  body: string;
  channel: CommentVisibility;
  disclaimerKey: DisclaimerKey;
  /**
   * Fix round 1. The structured side effects this macro applies atomically when its body is submitted
   *, or null for "insert the body only".
   *
   * It is on the RUNTIME DTO, not only on `MacroAdminRow`, because the composer and its confirmation
   * dialog could not see it: a macro carrying `{"status": "PENDING_CLIENT"}` moved the ticket
   * OPEN → PENDING_CLIENT on confirm while the dialog enumerated every other consequence and omitted
   * that one. A dialog that lists consequences and leaves out the ticket mutation it is about to
   * perform understates the action being confirmed.
   */
  actions: MacroActions | null;
};

/** Ticket-page activity feed item (AuditLog rows in TIMELINE_AUDIT_ACTIONS). */
export type ActivityItem = {
  id: string;
  seq: string;
  occurredAt: string;
  action: AuditAction;
  actorEmail: string;
  actorName: string | null;
  fieldChanged: string | null;
  oldValue: string | null;
  newValue: string | null;
};

export type AuditRow = {
  id: string;
  seq: string;
  occurredAt: string;
  actorId: string | null;
  actorEmail: string;
  actorGroups: OktaGroup[];
  /** compliance_officers together with an operational group (separation-of-duties flag). */
  dualRole: boolean;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string | null;
  ticketId: string | null;
  ticketNumber: number | null;
  fieldChanged: string | null;
  oldValue: string | null;
  newValue: string | null;
  ipAddress: string;
  userAgent: string | null;
  requestId: string;
  metadata: unknown;
  prevHash: string;
  hash: string;
};

export type AuditPage = { rows: AuditRow[]; nextCursor: string | null; total: number };

export type ChainVerification = {
  ok: boolean;
  checkedRows: number;
  fromSeq: string;
  toSeq: string;
  firstBadSeq: string | null;
  reason: "OK" | "HASH_MISMATCH" | "PREV_HASH_MISMATCH" | "EMPTY";
  verifiedAt: string;
};

// ---------------------------------------------------------------------------
// Client-facing DTOs — the ONLY shapes that may cross to a client surface.
// Structurally incapable of carrying an internal note or a staff identity.
// ---------------------------------------------------------------------------

/**
 * the client surface now shows the requester their OWN messages, so the author
 * line is a two-value union, not a constant. It is derived from `ClientVisibleComment.authorKind`
 * (a three-value enum) — never from an authorId, a name or an email, neither of which the view exposes.
 */
export const CLIENT_AUTHOR_DISPLAYS = ["You", "Your Service Team"] as const;
export type ClientAuthorDisplay = (typeof CLIENT_AUTHOR_DISPLAYS)[number];

/**
 * what a client is shown in place of a withdrawn message. The desk sent
 * something and then took it back; saying so is the honest minimum, and the fact carries no content.
 */
export const CLIENT_RETRACTED_BODY = "This message was withdrawn by your service team." as const;

export type ClientSafeComment = {
  id: string;
  /**
   * PUBLIC comment body with the disclaimer already appended (exactly what was stored) — or, when
   * `retracted` is true, exactly `CLIENT_RETRACTED_BODY`. The withdrawn text never reaches this field:
   * the "ClientVisibleComment" view returns an empty string for a retracted row, and the client role
   * holds no privilege on "Comment" or "CommentRetraction", so it is unreachable at the privilege
   * layer and not merely unrendered.
   */
  body: string;
  createdAt: string;
  disclaimerKey: DisclaimerKey;
  authorDisplay: ClientAuthorDisplay;
  /** Wave B. True when the message was withdrawn. A fact about the thread, never its content. */
  retracted: boolean;
};

export type ClientTicketView = {
  /** "HD-<number>" */
  reference: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  messages: ClientSafeComment[];
  /**
   * the client vocabulary. Both are derived from an enum this payload already carries,
   * so neither widens what the DTO discloses; they exist so a client never reads the desk's internal
   * word for something (`PENDING_INTERNAL`, `ACAT`). The maps themselves live in
   * `src/server/client-view.ts`, where the spec put them.
   */
  statusLabel: string;
  categoryLabel: string;
};

/** Keys that must never appear anywhere in a client-facing payload (checked by assertNoInternalLeak). */
export const CLIENT_FORBIDDEN_KEYS = [
  "visibility",
  "author",
  "authorId",
  "assignee",
  "assigneeId",
  "internal",
  "macroId",
  "piiRedacted",
  "piiRedactionCount",
  "description",
  "requesterEmail",
  "clientReference",
  // --- Wave A. None of these may ever appear in a client-facing payload. ---
  "requesterPhone",
  "householdId",
  "requesterExternalId",
  "externalId",
  "externalRef",
  "isComplaint",
  "complaintFiledAt",
  "escalationTarget",
  // Another ticket's internal cuid: a client must never learn that two of their
  // tickets are linked, let alone the id of the other one.
  "linkedFromTicketId",
  // Internal routing facts: which brand the desk answers under, and which channel the row arrived on.
  "brand",
  "source",
  "followUpAt",
  "attachments",
  "delivery",
  "authorKind",
  "authorLabel",
  "uploader",
  "uploaderId",
  "objectKey",
  "headers",
  "rawRef",
  // --- Wave A leaf keys. `attachments`, `delivery`, `headers` and `rawRef` above are CONTAINER keys;
  // a flattened or partially-spread shape would carry the leaves without them, so the walker names the
  // leaves too. MessageDelivery (the outbound-mail row) and SuspendedIntake (quarantined inbound mail)
  // are both REVOKEd from the client role and have no client-facing DTO by design. ---
  "fromAddress",
  "replyTo",
  "toAddress",
  "textBody",
  "htmlBody",
  "providerMessageId",
  "lastError",
  "mailbox",
  "snippet",
  // --- Wave B leaf and container keys. Every Wave B table is REVOKEd from the client role and none of
  // them has a client-facing DTO by design. `retracted` is deliberately ABSENT from
  // this list: it is the one Wave B fact a client is owed, and it carries no content. ---
  "resolution",
  "mergedIntoId",
  "mergedIntoNumber",
  "mergedAt",
  "voidedAt",
  "voidedById",
  "voidReason",
  "retraction",
  "retractedById",
  "reviews",
  "reviewerId",
  "verdict",
  "notificationPrefs",
  "outOfOfficeUntil",
  "backupUserId",
  "dedupeKey",
  "secretHash",
  "secretPrefix",
  "tokenHash",
  "payloadHash",
  "scopes",
  "endpoint",
  "p256dh",
  "identityVerifications",
  "verifiedById",
  "followers",
  "links",
  "draft",
] as const;

// ---------------------------------------------------------------------------
// machine write path (S1/S2). Viewer-agnostic: these shapes are what the ingest cores take,
// whatever the caller. `actor` is resolved by the route from its bearer, never supplied in the body.
// ---------------------------------------------------------------------------

/**
 * The shared shape behind POST /api/ingest/tickets, POST /api/client/tickets and the email intake.
 * Unlike `CreateTicketInput` (the staff form), the requester's EMAIL is optional — a voicemail has a
 * phone and nothing else — but the DB CHECK still demands at least one of email / phone.
 */
export type IngestTicketInput = {
  source: TicketSource;
  /** The upstream id. Unique per source; a retry with the same pair returns the SAME ticket id, 200. */
  externalId: string;
  subject: string;
  description: string;
  category?: TicketCategory;
  priority?: TicketPriority;
  queueKey?: QueueKey;
  brand?: TicketBrand;
  requesterName: string;
  requesterEmail?: string | null;
  requesterPhone?: string | null;
  clientReference?: string | null;
  householdId?: string | null;
  requesterExternalId?: string | null;
  externalRef?: string | null;
  /** Set when this ticket continues a CLOSED one. */
  linkedFromTicketId?: string | null;
};

/** The shared shape behind every machine-authored message on an existing ticket. */
export type IngestMessageInput = {
  ticketId: string;
  source: TicketSource;
  externalId: string;
  /** REQUESTER for a client message; STAFF requires `authorEmail` to resolve to an active User. */
  authorKind: Exclude<CommentAuthorKind, "SYSTEM">;
  /** Required when authorKind is STAFF; ignored otherwise. */
  authorEmail?: string | null;
  body: string;
  /** PUBLIC for a requester message; a STAFF-authored ingest may be INTERNAL. */
  visibility?: CommentVisibility;
  disclaimerKey?: DisclaimerKey;
  /**
   * The address that produced this message, recorded on the audit row. A REQUESTER comment's actor is
   * the machine identity (`svc_integration`), so without this the ledger names who WROTE the row but
   * not who sent the mail it came from. Email intake sets it; the identity gate in
   * `src/server/email-intake.ts` means it always equals the ticket's `requesterEmail` at write time,
   * which is exactly what makes it worth having on the record.
   */
  senderAddress?: string | null;
  /**
   * Wave B. The RFC 5322 `Message-ID` of the inbound mail this comment was written
   * from, persisted on `Comment.inboundMessageId` so the next outbound reply threads under it in the
   * client's mail client rather than starting a new conversation.
   *
   * It has to arrive HERE, at creation. A comment is immutable and guardrail G5 forbids
   * `comment.update` anywhere outside `src/lib/db.ts`, so there is no later moment to write it —
   * which is the right constraint, not an obstacle: the id is a fact about the message the comment
   * IS, not an annotation somebody adds afterwards.
   *
   * Only `authorKind: "REQUESTER"` uses it; a staff-authored ingest has no inbound message.
   */
  inboundMessageId?: string | null;
};

/** What every ingest core returns. `created: false` means the receipt already existed (idempotent replay). */
export type IngestResult = {
  ticketId: string;
  ticketNumber: number;
  commentId: string | null;
  created: boolean;
  /** True when a requester reply moved PENDING_CLIENT → OPEN or reopened a RESOLVED ticket. */
  reopened: boolean;
  piiRedacted: boolean;
  piiRedactionCount: number;
};

/** One page of the OPS-PORTAL-mirror export (GET /api/export/tickets). PUBLIC channel only, sanitized. */
export type TicketExportPage = {
  rows: TicketExportRow[];
  /** Opaque `<updatedAt ISO>|<id>` cursor; null when the caller has reached the end. */
  nextCursor: string | null;
};

export type TicketExportRow = {
  id: string;
  reference: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  queueKey: QueueKey;
  brand: TicketBrand;
  source: TicketSource;
  requesterName: string;
  requesterEmail: string | null;
  householdId: string | null;
  requesterExternalId: string | null;
  externalRef: string | null;
  isComplaint: boolean;
  createdAt: string;
  updatedAt: string;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** PUBLIC comments only, sanitized bodies. Internal notes are structurally absent. */
  messages: TicketExportMessage[];
};

export type TicketExportMessage = {
  id: string;
  authorKind: CommentAuthorKind;
  body: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// shared shapes. Every slice imports these; nobody redeclares them.
// the build record is the binding description; this file is the compiled copy of it.
// ---------------------------------------------------------------------------

/** Per-kind, per-channel notification switches. A missing key means the default, never "off". */
export type NotificationPrefs = {
  /** Which kinds reach which channels. IN_APP is always true and is not configurable. */
  channels: Partial<Record<NotificationKind, Partial<Record<NotificationChannel, boolean>>>>;
  /** Daily digest of everything unread, at DIGEST_HOUR_LOCAL firm time. */
  digest: boolean;
  /** Suppress SLACK_DM and WEB_PUSH while out of office; the inbox still fills. */
  muteWhileOutOfOffice: boolean;
};

/**
 * What `null` in `User.notificationPrefs` means. Stated as a value rather than as prose so the inbox,
 * the dispatcher and the preferences form cannot disagree about an unset column.
 *
 * IN_APP is deliberately absent from `channels`: it is unconditional. A staff member may silence the
 * Slack DM and the push notification, and the inbox row is written either way — a notification that
 * could be switched off entirely would make "you were told" unprovable.
 */
export const NOTIFICATION_PREFS_DEFAULT: NotificationPrefs = {
  channels: {
    MENTION: { SLACK_DM: true, WEB_PUSH: true },
    ASSIGNED: { SLACK_DM: true, WEB_PUSH: true },
    REQUESTER_REPLY: { SLACK_DM: true, WEB_PUSH: false },
    FOLLOWED_UPDATE: { SLACK_DM: false, WEB_PUSH: false },
    SLA_WARNING: { SLACK_DM: false, WEB_PUSH: false },
    SLA_BREACH: { SLACK_DM: true, WEB_PUSH: true },
    REVIEW_REQUESTED: { SLACK_DM: false, WEB_PUSH: false },
    FOLLOW_UP_DUE: { SLACK_DM: false, WEB_PUSH: false },
  },
  digest: true,
  muteWhileOutOfOffice: true,
};

/** Caps shared by the Wave B write paths. One source, like `INGEST_LIMITS`. */
export const WAVE_B_LIMITS = {
  /** Inbox preview line (DB CHECK: <= 200). */
  notificationPreviewChars: 200,
  /** A retraction, void or override reason. The floor is a DB CHECK; this is the ceiling. */
  reasonMinChars: 12,
  reasonMaxChars: 2000,
  /** Composer draft body — the same ceiling as a comment body. */
  draftMaxChars: 20_000,
  /** How many tickets one bulk action may touch. Above this the UI asks for a narrower filter. */
  bulkMaxTickets: 100,
  /** Ticket-to-ticket links per ticket (live, not removed). */
  maxLinksPerTicket: 25,
  /** @mentions resolved per comment. Beyond this the rest are rendered as plain text. */
  maxMentionsPerComment: 20,
  /** Rows one report page or CSV export may return. */
  reportMaxRows: 50_000,
  /** Webhook delivery attempts before DEAD. */
  webhookMaxAttempts: 8,
  /** Per-token requests per minute, in-memory per instance. */
  tokenRateLimitPerMinute: 120,
  /** How long a TICKET_VIEWED row counts as "someone is looking at this" for the presence chip. */
  presenceWindowMs: 5 * 60_000,
} as const;

/** Structured side effects a macro applies atomically when its body is submitted. */
export type MacroActions = {
  status?: TicketStatus;
  /**
   * How the ticket ENDED, applied only when `status` also ends it. Restricted at the
   * schema to the four `OPERATOR_RESOLUTIONS`; the type is the wider enum for the same reason
   * `status` is — `macroActionsSchema` is the narrowing, and it is asserted assignable to this type.
   */
  resolution?: TicketResolution;
  priority?: TicketPriority;
  queueKey?: QueueKey;
  /** `"me"` resolves to the submitting viewer; `null` clears; a user id assigns that user. */
  assignee?: "me" | string | null;
  /** Days from submission, in firm time, for `followUpAt`. 0 clears it. */
  followUpInDays?: number;
  escalationTarget?: EscalationTarget;
};

// --- DTOs ---------------------------------------------------------------

export type NotificationDTO = {
  id: string;
  kind: NotificationKind;
  preview: string;
  createdAt: string;
  readAt: string | null;
  dismissedAt: string | null;
  actor: UserRef | null;
  ticketId: string | null;
  ticketNumber: number | null;
  ticketSubject: string | null;
  commentId: string | null;
  channels: NotificationChannel[];
};

export type InboxPage = { rows: NotificationDTO[]; unread: number; nextCursor: string | null };

export type TicketFollowerDTO = { user: UserRef; source: FollowerSource; since: string };

export type TicketLinkDTO = {
  id: string;
  kind: TicketLinkKind;
  /** The ticket at the OTHER end, from the point of view of the ticket that was asked. */
  otherTicketId: string;
  otherTicketNumber: number;
  otherTicketSubject: string;
  otherTicketStatus: TicketStatus;
  /** True when this ticket is the `to` side, so the UI prints `TICKET_LINK_INVERSE_LABELS`. */
  inbound: boolean;
  note: string | null;
  createdBy: UserRef;
  createdAt: string;
};

export type CommentRetractionDTO = {
  id: string;
  reason: string;
  retractedBy: UserRef;
  createdAt: string;
};

export type ReviewStampDTO = {
  id: string;
  commentId: string;
  verdict: ReviewVerdict;
  note: string | null;
  reviewer: UserRef;
  createdAt: string;
};

export type IdentityVerificationDTO = {
  id: string;
  ticketId: string;
  method: IdentityVerificationMethod;
  result: IdentityVerificationResult;
  note: string;
  verifiedBy: UserRef;
  createdAt: string;
};

/** What the identity gate answers for one ticket. `required` is category-driven, never per-ticket. */
export type IdentityGateState = {
  required: boolean;
  satisfied: boolean;
  latest: IdentityVerificationDTO | null;
};

export type ComposerDraftDTO = {
  ticketId: string;
  channel: CommentVisibility;
  body: string;
  macroId: string | null;
  disclaimerKey: DisclaimerKey;
  updatedAt: string;
};

export type ApiTokenDTO = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiTokenScope[];
  requesterEmail: string | null;
  createdBy: UserRef;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  note: string | null;
};

/** The ONE shape that ever carries a token's plaintext, returned once from `createApiToken`. */
export type ApiTokenSecret = { token: ApiTokenDTO; plaintext: string };

export type WebhookEndpointDTO = {
  id: string;
  name: string;
  url: string;
  secretPrefix: string;
  events: AuditAction[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  /** Rolling health, cheap to compute from the delivery table's last page. */
  recentFailures: number;
};

export type WebhookEndpointSecret = { endpoint: WebhookEndpointDTO; plaintext: string };

export type WebhookDeliveryDTO = {
  id: string;
  endpointId: string;
  auditSeq: string;
  eventAction: AuditAction;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
};

export type SuppressionDTO = {
  id: string;
  email: string;
  reason: SuppressionReason;
  note: string | null;
  createdBy: UserRef | null;
  createdAt: string;
  removedAt: string | null;
};

/** Who has looked at this ticket inside `WAVE_B_LIMITS.presenceWindowMs`, most recent first. */
export type PresenceDTO = { viewers: Array<{ user: UserRef; at: string }>; generatedAt: string };

/** A candidate duplicate, ranked. Never auto-merged: the banner offers, a person decides. */
export type DuplicateCandidateDTO = {
  ticketId: string;
  ticketNumber: number;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  /** 0..1. How it was found is `reason`; the number only orders the list. */
  score: number;
  reason: "same-requester-subject" | "same-external-ref" | "same-requester-recent";
};

/** A saved SLA policy row as /admin/sla renders it. */
export type SlaPolicyDTO = {
  id: string;
  priority: TicketPriority;
  name: string;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  warningMinutes: number;
  updatedAt: string;
};

/** One capability the deployment either has or has not, as /admin/flags renders it. READ ONLY. */
export type EnvCapabilityDTO = {
  key: string;
  label: string;
  enabled: boolean;
  /** What is switched off while this is false. Never the value of the variable. */
  effect: string;
};

// --- Reporting ----------------------------------------------------------

export const REPORT_KEYS = [
  "volume",
  "backlog",
  "first-response",
  "resolution",
  "sla-attainment",
  "agent-load",
  "category-mix",
  "reopen-rate",
  // --- Wave B. Two dimensions that fit none of the eight above; folding either into
  // `category-mix` would have put two different dimensions in one table. ---
  /** How resolved tickets ENDED — the `TicketResolution` mix, independent of how they closed. */
  "resolution-mix",
  /** Operational health: complaints, held intake, outbox failures, dead webhooks, voids. */
  "desk-health",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export const REPORT_GRANULARITIES = ["day", "week", "month"] as const;
export type ReportGranularity = (typeof REPORT_GRANULARITIES)[number];

export type ReportQuery = {
  key: ReportKey;
  from: string;
  to: string;
  granularity: ReportGranularity;
  queueKey?: QueueKey[];
  priority?: TicketPriority[];
  category?: TicketCategory[];
};

/** One row of any report. `bucket` is a firm-local period label; the series are named by the report. */
export type ReportRow = { bucket: string; label: string; values: Record<string, number> };

export type ReportResult = {
  key: ReportKey;
  from: string;
  to: string;
  granularity: ReportGranularity;
  /** Column keys inside every row's `values`, in display order. */
  series: string[];
  rows: ReportRow[];
  /** Whole-range summary, e.g. `{ p50: 42, p90: 310 }` in minutes. */
  totals: Record<string, number>;
  generatedAt: string;
};

// --- Action inputs ------------------------------------------------------

/**
 * Wave B. Availability rides with the preferences because they are the same form: a person
 * setting "I am out until Friday, send it to Dana" is making one decision, and splitting it across
 * two actions would let half of it land. Both fields are OPTIONAL — omitted means "leave as is",
 * `null` means "clear it" — and the pair is audited as part of `NOTIFICATION_PREFS_CHANGED`.
 */
export type SetNotificationPrefsInput = {
  prefs: NotificationPrefs;
  /** ISO instant; the user is out UNTIL this moment. Null clears it. */
  outOfOfficeUntil?: string | null;
  /** The colleague who receives what would have gone to this user while they are out. Null clears it. */
  backupUserId?: string | null;
};
export type MarkNotificationsInput = { ids?: string[]; all?: boolean };
export type FollowTicketInput = { ticketId: string; follow: boolean };

export type AddTicketLinkInput = { ticketId: string; otherTicketNumber: number; kind: TicketLinkKind; note?: string };
export type RemoveTicketLinkInput = { linkId: string };
export type MergeTicketsInput = { ticketId: string; version: number; intoTicketNumber: number; reason: string };
export type VoidTicketInput = { ticketId: string; version: number; reason: string; confirm: true };

/** One bulk action over a checked selection. Per ticket: RBAC, version, audit — never a blanket write. */
export type BulkActionInput = {
  ticketIds: string[];
  action:
    | { kind: "assign"; assigneeId: string | null }
    /**
     * `resolution` is optional and applies to the whole batch: the bar asks once, the
     * server writes it per ticket and skips any ticket that already carries an outcome. Only the four
     * operator outcomes — `DUPLICATE` belongs to a merge and `ENTERED_IN_ERROR` to a void.
     */
    | { kind: "status"; status: TicketStatus; resolution?: OperatorResolution }
    | { kind: "priority"; priority: TicketPriority }
    | { kind: "queue"; queueKey: QueueKey }
    | { kind: "follow"; follow: boolean };
};
export type BulkActionResult = {
  applied: number;
  skipped: Array<{ ticketId: string; code: ActionErrorCode; message: string }>;
};

export type SaveDraftInput = {
  ticketId: string;
  channel: CommentVisibility;
  body: string;
  macroId?: string | null;
  disclaimerKey?: DisclaimerKey;
};
export type DeleteDraftInput = { ticketId: string; channel: CommentVisibility };
export type RetractCommentInput = { commentId: string; reason: string; confirm: true };

export type AiDraftInput = { ticketId: string; instruction?: string };
export type AiDraftResult = { draft: string; provider: string; model: string; hash: string };

export type SaveSlaPolicyInput = {
  priority: TicketPriority;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  warningMinutes: number;
};

export type CreateWebhookEndpointInput = { name: string; url: string; events: AuditAction[] };
export type UpdateWebhookEndpointInput = {
  endpointId: string;
  name?: string;
  url?: string;
  events?: AuditAction[];
  isActive?: boolean;
};
export type RevokeWebhookEndpointInput = { endpointId: string; reason: string };

export type CreateApiTokenInput = {
  name: string;
  scopes: ApiTokenScope[];
  requesterEmail?: string | null;
  expiresAt?: string | null;
  note?: string;
};
export type RevokeApiTokenInput = { tokenId: string; reason: string };
export type RotateApiTokenInput = { tokenId: string; reason: string };

export type StampReviewInput = { commentId: string; verdict: ReviewVerdict; note?: string };
export type RecordIdentityVerificationInput = {
  ticketId: string;
  method: IdentityVerificationMethod;
  result: IdentityVerificationResult;
  note: string;
};
export type OverrideIdentityGateInput = { ticketId: string; reason: string; confirm: true };

export type AddSuppressionInput = { email: string; reason: SuppressionReason; note?: string };
export type RemoveSuppressionInput = { suppressionId: string; reason: string };

export type PushSubscribeInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/** What the legacy help desk importer hands `importTicketCore`. Timestamps are the ORIGINAL ones, preserved. */
export type ImportTicketInput = {
  externalId: string;
  subject: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  queueKey: QueueKey;
  requesterName: string;
  requesterEmail?: string | null;
  requesterPhone?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  firstRespondedAt?: string | null;
  resolvedAt?: string | null;
  closedAt?: string | null;
  externalRef?: string | null;
  clientReference?: string | null;
  comments: ImportCommentInput[];
  attachments?: ImportAttachmentInput[];
  // --- Wave B. Mapped from the source system; all optional, all defaulted, so an archive that
  // carries none of them still imports. CONTRACT §10 B11's "resolution and compliance flags". ---
  resolution?: TicketResolution;
  isComplaint?: boolean;
  complaintFiledAt?: string | null;
  escalationTarget?: EscalationTarget;
  brand?: TicketBrand;
  householdId?: string | null;
  requesterExternalId?: string | null;
  followUpAt?: string | null;
};

export type ImportCommentInput = {
  externalId: string;
  authorKind: CommentAuthorKind;
  /** Resolved to a User for STAFF rows; ignored otherwise. Unknown addresses import as SYSTEM. */
  authorEmail?: string | null;
  visibility: CommentVisibility;
  body: string;
  createdAt: string;
  /**
   * Wave B. The original author's display name, for a STAFF row whose address resolves to no
   * User. It is prefixed onto the imported BODY rather than kept in metadata, because `AuditLog`'s
   * metadata sits outside the hash chain and `Comment` has no metadata column — so the body is the
   * only place the attribution is as immutable as the comment it belongs to.
   */
  authorName?: string | null;
};

export type ImportAttachmentInput = {
  externalId: string;
  filename: string;
  mime: string;
  size: number;
  /** Where the archive tool put the bytes; the importer streams it through the storage interface. */
  sourcePath: string;
  /** Wave B. The comment this hung off, by its SOURCE id. Null/absent → the ticket itself. */
  commentExternalId?: string | null;
};

export type ImportResult = {
  ticketId: string;
  ticketNumber: number;
  created: boolean;
  comments: number;
  attachments: number;
};

// ---------------------------------------------------------------------------
// Compile-time parity with the Prisma enums. If the schema and this file drift, tsc fails here.
// ---------------------------------------------------------------------------

export type EnumParityChecks = [
  Expect<Equal<OktaGroup, PrismaOktaGroup>>,
  Expect<Equal<QueueKey, PrismaQueueKey>>,
  Expect<Equal<TicketCategory, PrismaTicketCategory>>,
  Expect<Equal<TicketPriority, PrismaTicketPriority>>,
  Expect<Equal<TicketStatus, PrismaTicketStatus>>,
  Expect<Equal<CommentVisibility, PrismaCommentVisibility>>,
  Expect<Equal<DisclaimerKey, PrismaDisclaimerKey>>,
  Expect<Equal<AuditAction, PrismaAuditAction>>,
  Expect<Equal<AuditEntityType, PrismaAuditEntityType>>,
  // --- Wave A ---
  Expect<Equal<CommentAuthorKind, PrismaCommentAuthorKind>>,
  Expect<Equal<TicketBrand, PrismaTicketBrand>>,
  Expect<Equal<TicketSource, PrismaTicketSource>>,
  Expect<Equal<EscalationTarget, PrismaEscalationTarget>>,
  Expect<Equal<SuspendedIntakeReason, PrismaSuspendedIntakeReason>>,
  Expect<Equal<SuspendedIntakeStatus, PrismaSuspendedIntakeStatus>>,
  Expect<Equal<MessageDeliveryStatus, PrismaMessageDeliveryStatus>>,
  Expect<Equal<AttachmentKind, PrismaAttachmentKind>>,
  Expect<Equal<AttachmentState, PrismaAttachmentState>>,
  Expect<Equal<AttachmentVisibility, PrismaAttachmentVisibility>>,
  Expect<Equal<SlaAlertPhase, PrismaSlaAlertPhase>>,
  Expect<Equal<SlaAlertKind, PrismaSlaAlertKind>>,
  Expect<Equal<ClientContactChannel, PrismaClientContactChannel>>,
  // --- Wave B ---
  Expect<Equal<TicketResolution, PrismaTicketResolution>>,
  Expect<Equal<NotificationKind, PrismaNotificationKind>>,
  Expect<Equal<NotificationChannel, PrismaNotificationChannel>>,
  Expect<Equal<FollowerSource, PrismaFollowerSource>>,
  Expect<Equal<TicketLinkKind, PrismaTicketLinkKind>>,
  Expect<Equal<WebhookDeliveryStatus, PrismaWebhookDeliveryStatus>>,
  Expect<Equal<ApiTokenScope, PrismaApiTokenScope>>,
  Expect<Equal<IdentityVerificationMethod, PrismaIdentityVerificationMethod>>,
  Expect<Equal<IdentityVerificationResult, PrismaIdentityVerificationResult>>,
  Expect<Equal<ReviewVerdict, PrismaReviewVerdict>>,
  Expect<Equal<SuppressionReason, PrismaSuppressionReason>>,
];
