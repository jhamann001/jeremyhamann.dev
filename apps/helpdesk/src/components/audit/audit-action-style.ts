/**
 * The visual family of an audit action badge — which shadcn Badge variant it wears and which extra
 * classes it carries. Pure on purpose, in the `delivery-chip-label.ts` / `sla-badge-label.ts` shape:
 * the badge itself is JSX and the colour contract is not, so the contract is unit-testable without a
 * DOM (see `audit-action-style.test.ts`).
 *
 * One visual family per kind of evidence. Exhaustive over `AuditAction` so a new catalog entry fails
 * typecheck here instead of rendering unstyled.
 *
 *  - denials and delivery failures: alarming (destructive, bold) — AUTHZ_DENIED,
 *    AUTHZ_DENIED_COALESCED, MESSAGE_FAILED, and nothing else. A compliance reviewer scanning a
 *    filtered page must be able to read "red" as "something was refused or never reached a client".
 *  - PII redaction / suspension / SLA breach: amber, attention without alarm
 *  - reads (ticket views, client API): quiet outline
 *  - ledger self-events (viewed / exported / verified): violet, so compliance's own footprint is visible
 *  - session and machine events: dashed outline
 *  - everything else (ticket mutations, comments, macros, administrative on/off flips): neutral secondary
 *
 * Routine administration is deliberately neutral. Deactivating a user is the CORRECT act on every
 * departure (the build record P19 holds it up as a Wave A improvement), so it reads like
 * `MACRO_DEACTIVATED` — the structurally identical "turn something off" event — and stays symmetric
 * with its own reversal, `USER_REACTIVATED`.
 */
import type { AuditAction } from "@/types/domain";

/** Which shadcn Badge variant an action wears. Kept narrow so the badge cannot invent a new one. */
export type AuditActionVariant = "destructive" | "outline" | "secondary";

const ALARM = "font-semibold";
const AMBER =
  "border-amber-400 bg-amber-100 font-medium text-amber-950 dark:border-amber-500 dark:bg-amber-900/40 dark:text-amber-100";
const AMBER_SOFT =
  "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100";
const SKY =
  "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200";
const VIOLET =
  "border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200";
const QUIET = "text-muted-foreground";
const DASHED = "border-dashed";

/** Extra classes per action, on top of the variant. Empty string = the variant alone. */
export const AUDIT_ACTION_CLASSES: Readonly<Record<AuditAction, string>> = {
  TICKET_CREATED: "",
  TICKET_VIEWED: QUIET,
  TICKET_PREVIEWED: QUIET,
  TICKET_FIELD_CHANGED: "",
  TICKET_STATUS_CHANGED: "",
  TICKET_PRIORITY_CHANGED: "",
  TICKET_ASSIGNED: "",
  TICKET_QUEUE_CHANGED: "",
  COMMENT_ADDED_INTERNAL: AMBER_SOFT,
  COMMENT_ADDED_PUBLIC: SKY,
  MACRO_APPLIED: "",
  PII_REDACTED: AMBER,
  AUDIT_LOG_VIEWED: VIOLET,
  AUDIT_LOG_EXPORTED: VIOLET,
  AUDIT_CHAIN_VERIFIED: VIOLET,
  CLIENT_API_READ: QUIET,
  USER_SIGNED_IN: DASHED,
  USER_SIGNED_OUT: DASHED,
  AUTHZ_DENIED: ALARM,
  // --- Wave A. Same families: client-facing traffic is sky, ledger/self-events violet,
  // reads quiet, denials and delivery failures alarming, machine/system events dashed,
  // everything else — including routine administrative on/off flips — neutral. ---
  COMMENT_ADDED_REQUESTER: SKY,
  TICKET_REOPENED_BY_REQUESTER: SKY,
  TICKET_INGESTED: DASHED,
  TICKET_LINKED: "",
  INTAKE_SUSPENDED: AMBER,
  INTAKE_RELEASED: "",
  MESSAGE_QUEUED: SKY,
  MESSAGE_LEASED: QUIET,
  MESSAGE_SENT: SKY,
  MESSAGE_FAILED: ALARM,
  ATTACHMENT_ADDED: "",
  ATTACHMENT_VIEWED: QUIET,
  ATTACHMENT_REMOVED: "",
  SLA_ALERT: AMBER,
  TICKET_LIST_EXPORTED: VIOLET,
  TICKET_EXPORT_READ: QUIET,
  CLIENT_CONTACT_RECORDED: "",
  // Offboarding a leaver is routine administration, not an incident: same weight as its reversal
  // below and as MACRO_DEACTIVATED.
  USER_DEACTIVATED: "",
  USER_REACTIVATED: "",
  MACRO_CREATED: "",
  MACRO_UPDATED: "",
  MACRO_DEACTIVATED: "",
  MACRO_REACTIVATED: "",
  AUTHZ_DENIED_COALESCED: ALARM,
  JOB_RUN: DASHED,
  // --- Carried from Wave A CONTRACT §14. Each inherits the family of the action it replaces. ---
  TICKET_REQUESTER_EMAIL_CHANGED: AMBER,
  INTAKE_DISCARDED: "",
  ATTACHMENT_INTENT_CREATED: QUIET,
  // --- Wave B. Families, not one colour per action: a reviewer reads the family, not the name.
  // Amber (attention without alarm) is reserved for the things a supervisor has to look at — a
  // withdrawn reply, an overridden identity gate, a flagged review, an address that stopped receiving
  // mail. Destructive stays the three Wave A alarms plus the two genuine failures of delivery. ---
  NOTIFICATION_PREFS_CHANGED: DASHED,
  TICKET_FOLLOWED: QUIET,
  TICKET_UNFOLLOWED: QUIET,
  TICKET_LINK_ADDED: "",
  TICKET_LINK_REMOVED: "",
  TICKET_MERGED: "",
  TICKET_VOIDED: AMBER,
  BULK_ACTION_APPLIED: "",
  COMMENT_RETRACTED: AMBER,
  MESSAGE_CANCELLED: QUIET,
  MESSAGE_BOUNCED: ALARM,
  MACRO_ACTIONS_APPLIED: "",
  AI_DRAFT_REQUESTED: QUIET,
  SLA_POLICY_CHANGED: AMBER_SOFT,
  WEBHOOK_ENDPOINT_CREATED: "",
  WEBHOOK_ENDPOINT_UPDATED: "",
  WEBHOOK_ENDPOINT_REVOKED: "",
  WEBHOOK_DELIVERY_SENT: QUIET,
  WEBHOOK_DELIVERY_FAILED: AMBER_SOFT,
  WEBHOOK_DELIVERY_DEAD: ALARM,
  REVIEW_STAMPED: VIOLET,
  IDENTITY_VERIFIED: SKY,
  IDENTITY_GATE_OVERRIDDEN: AMBER,
  REPORT_EXPORTED: VIOLET,
  API_TOKEN_CREATED: AMBER_SOFT,
  API_TOKEN_REVOKED: "",
  API_TOKEN_ROTATED: AMBER_SOFT,
  PUSH_SUBSCRIBED: DASHED,
  PUSH_UNSUBSCRIBED: DASHED,
  SUPPRESSION_ADDED: AMBER,
  SUPPRESSION_REMOVED: "",
  TICKET_IMPORTED: DASHED,
};

/**
 * The actions that wear `destructive`: two forms of "access was refused", and three of "something the
 * desk sent never arrived, and will not". Anything else — including administrative deactivation, a
 * withdrawn reply and a retrying webhook — is not an alarm.
 */
export const ALARM_ACTIONS: readonly AuditAction[] = [
  "AUTHZ_DENIED",
  "AUTHZ_DENIED_COALESCED",
  "MESSAGE_FAILED",
  // Wave B adds two, and only two. `MESSAGE_BOUNCED` is the same fact as MESSAGE_FAILED one step
  // later — a provider took the message and the client still did not get it. `WEBHOOK_DELIVERY_DEAD`
  // is an integration that has stopped receiving events and will not retry, which is silent data loss
  // for whoever is downstream. A retrying webhook (WEBHOOK_DELIVERY_FAILED) is not an alarm.
  "MESSAGE_BOUNCED",
  "WEBHOOK_DELIVERY_DEAD",
];

export function auditActionVariant(action: AuditAction): AuditActionVariant {
  switch (action) {
    case "AUTHZ_DENIED":
    case "AUTHZ_DENIED_COALESCED":
    case "MESSAGE_FAILED":
    case "MESSAGE_BOUNCED":
    case "WEBHOOK_DELIVERY_DEAD":
      return "destructive";
    case "TICKET_VIEWED":
    case "TICKET_PREVIEWED":
    case "CLIENT_API_READ":
    case "USER_SIGNED_IN":
    case "USER_SIGNED_OUT":
    case "COMMENT_ADDED_INTERNAL":
    case "COMMENT_ADDED_PUBLIC":
    case "PII_REDACTED":
    case "AUDIT_LOG_VIEWED":
    case "AUDIT_LOG_EXPORTED":
    case "AUDIT_CHAIN_VERIFIED":
    case "COMMENT_ADDED_REQUESTER":
    case "TICKET_REOPENED_BY_REQUESTER":
    case "INTAKE_SUSPENDED":
    case "MESSAGE_QUEUED":
    case "MESSAGE_LEASED":
    case "MESSAGE_SENT":
    case "ATTACHMENT_VIEWED":
    case "SLA_ALERT":
    case "TICKET_LIST_EXPORTED":
    case "TICKET_EXPORT_READ":
    case "TICKET_INGESTED":
    case "JOB_RUN":
    // --- Wave B: reads, machine events and the desk's own footprint stay quiet. ---
    case "TICKET_FOLLOWED":
    case "TICKET_UNFOLLOWED":
    case "NOTIFICATION_PREFS_CHANGED":
    case "MESSAGE_CANCELLED":
    case "AI_DRAFT_REQUESTED":
    case "WEBHOOK_DELIVERY_SENT":
    case "WEBHOOK_DELIVERY_FAILED":
    case "REVIEW_STAMPED":
    case "REPORT_EXPORTED":
    case "PUSH_SUBSCRIBED":
    case "PUSH_UNSUBSCRIBED":
    case "TICKET_IMPORTED":
    case "ATTACHMENT_INTENT_CREATED":
    case "SLA_POLICY_CHANGED":
    case "TICKET_VOIDED":
    case "COMMENT_RETRACTED":
    case "IDENTITY_GATE_OVERRIDDEN":
    case "SUPPRESSION_ADDED":
    case "TICKET_REQUESTER_EMAIL_CHANGED":
    case "API_TOKEN_CREATED":
    case "API_TOKEN_ROTATED":
      return "outline";
    case "TICKET_CREATED":
    case "TICKET_FIELD_CHANGED":
    case "TICKET_STATUS_CHANGED":
    case "TICKET_PRIORITY_CHANGED":
    case "TICKET_ASSIGNED":
    case "TICKET_QUEUE_CHANGED":
    case "MACRO_APPLIED":
    case "TICKET_LINKED":
    case "INTAKE_RELEASED":
    case "ATTACHMENT_ADDED":
    case "ATTACHMENT_REMOVED":
    case "CLIENT_CONTACT_RECORDED":
    case "USER_DEACTIVATED":
    case "USER_REACTIVATED":
    case "MACRO_CREATED":
    case "MACRO_UPDATED":
    case "MACRO_DEACTIVATED":
    case "MACRO_REACTIVATED":
    // --- Wave B: ordinary mutations and administrative on/off flips. ---
    case "INTAKE_DISCARDED":
    case "TICKET_LINK_ADDED":
    case "TICKET_LINK_REMOVED":
    case "TICKET_MERGED":
    case "BULK_ACTION_APPLIED":
    case "MACRO_ACTIONS_APPLIED":
    case "WEBHOOK_ENDPOINT_CREATED":
    case "WEBHOOK_ENDPOINT_UPDATED":
    case "WEBHOOK_ENDPOINT_REVOKED":
    case "IDENTITY_VERIFIED":
    case "API_TOKEN_REVOKED":
    case "SUPPRESSION_REMOVED":
      return "secondary";
  }
}
