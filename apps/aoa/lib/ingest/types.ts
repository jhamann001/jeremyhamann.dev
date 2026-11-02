import type { EmailEnvelope } from "@/lib/email-search/envelope";
/**
 * Phase D ingest contract types (D-1, ticket) — the complete compile-time
 * contract for the D-2 ingest route handlers (`POST /api/ingest/clients`,
 * `POST /api/ingest/accounts`).
 *
 * Pure TS contract module: zero imports, no Prisma (TDD ADR-9 — no Prisma
 * models for `mirror`; the `deal-types` idiom). Source of truth:
 * docs/planning/phase-d/tdd.md §4 (envelope/items/responses), §7 (reason
 * codes), §8 (error taxonomy).
 */

// ---------------------------------------------------------------------------
// Const tuples + literal unions mirroring the mirror.account CHECK constraints.
// ---------------------------------------------------------------------------

export const CUSTODIANS = ['APEX', 'DRIVEWEALTH'] as const;
export type Custodian = (typeof CUSTODIANS)[number];

export const ACCOUNT_STATUSES = ['OPEN', 'CLOSED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** CRM parent records supplied by the authoritative CRM/Salesforce feed.
 * These are deliberately key-only: the existing clients feed remains the
 * owner of display names, stages, and advisor assignments. */
export const CRM_PARENT_TYPES = ['HOUSEHOLD', 'CONTACT'] as const;
export type CrmParentType = (typeof CRM_PARENT_TYPES)[number];

/** Historical parent evidence is diagnostic-only. These states never become
 * identity source rows and are not consumed by reconciliation. */
export const CRM_PARENT_ORPHAN_STATES = ['DELETED', 'MERGED'] as const;
export type CrmParentOrphanState = (typeof CRM_PARENT_ORPHAN_STATES)[number];

// ---------------------------------------------------------------------------
// Request envelope (TDD §4) — both endpoints share it.
// ---------------------------------------------------------------------------

/** `{ source, run_id, items }` — `source` is a free-text label for the audit
 * trail (e.g. "crm", "investment"); `run_id` is the n8n run identifier
 * echoed back in the response. */
export interface IngestEnvelope<TItem> {
  source: string;
  run_id: string;
  items: TItem[];
}

// ---------------------------------------------------------------------------
// Payload items (TDD §4, verbatim).
// ---------------------------------------------------------------------------

/** One clients-endpoint item. Upsert key: `sf_contact_id` → mirror.client.sf_id.
 * Contact email, phone and birthdate are outside this feed's write scope. */
export interface ClientsItem {
  /** `user-<uuid>` when present. */
  cedar_ridge_user_id: string | null;
  sf_contact_id: string;
  name: string;
  household_name: string | null;
  household_sf_id: string | null;
  stage: string;
  /** Book-scoping RLS key; null = row visible to Ops/Admin/HoA only (ADR-5). */
  lead_advisor_email: string | null;
}

/** One accounts-endpoint item. Upsert key: `custodian_account_id`. */
export interface AccountsItem {
  custodian_account_id: string;
  cedar_ridge_user_id: string;
  custodian: Custodian;
  account_type: string | null;
  status: AccountStatus;
  /** ISO date `YYYY-MM-DD`, or null. */
  opened_at: string | null;
  /** ISO date `YYYY-MM-DD`, or null. */
  closed_at: string | null;
}

/** One key-only CRM parent. Account IDs (`001...`) become HOUSEHOLD parents;
 * Contact IDs (`003...`) become CONTACT parents. Both 15- and 18-character
 * Salesforce widths are accepted and normalized by the database. */
export interface CrmParentItem {
  parent_type: CrmParentType;
  source_key: string;
}

/** Key-only Salesforce tombstone/merge evidence. `replacement_key` is required
 * only for MERGED rows and must have the same Salesforce object type. */
export interface CrmParentOrphanItem {
  parent_type: CrmParentType;
  source_key: string;
  parent_state: CrmParentOrphanState;
  replacement_key?: string | null;
}

/** One source-confirmed assignment observation. Omission of the enclosing
 * object means a legacy payload; it must never clear an existing assignment.
 * observed_at is the UTC source-read time, retained unchanged on retries.
 * Renamed owners can therefore refresh without changing Task.LastModifiedDate.
 * UNASSIGNED requires authoritative absence; failed/missing reads are UNAVAILABLE. */
export interface TaskAssignment {
  state: "ASSIGNED" | "UNASSIGNED" | "UNAVAILABLE";
  assignee_id: string | null;
  assignee_type: "USER" | "QUEUE" | null;
  assignee_name: string | null;
  observed_at: string;
}

/** One tasks-endpoint item. Upsert key: `sf_id` → mirror.task.sf_id.
 * `household_sf_id` is Task.AccountId → mirror.household.sf_id (household-level
 * linkage; the per-person WhoId is FLS-blocked). Existing descriptive fields
 * accept null/omission; assignment, when supplied, is a complete observation. */
export interface TasksItem {
  sf_id: string;
  household_sf_id: string;
  subject: string | null;
  status: string | null;
  priority: string | null;
  description: string | null;
  /** Salesforce LastModifiedDate; free-form date string, or null. */
  last_modified_at: string | null;
  assignment?: TaskAssignment;
}

/** One emails-endpoint item. Upsert key: `sf_id` → mirror.email.sf_id.
 * `household_sf_id` is Task.AccountId → mirror.household.sf_id (household-level
 * linkage; the per-person WhoId is FLS-blocked). `body` is cleaned,
 * disclaimer-stripped and capped upstream in the feed. Everything else is
 * optional. `sent_at` is Salesforce CreatedDate; `last_modified_at` is
 * LastModifiedDate — both free-form date strings, or null. */
export interface EmailsItem {
  email_envelope?: EmailEnvelope;
  sf_id: string;
  household_sf_id: string;
  subject: string | null;
  body: string | null;
  sent_at: string | null;
  last_modified_at: string | null;
}

/** One Zendesk ticket content item. Requester linkage fields are used only
 * inside the ingest transaction to resolve an AOA contact/household and are
 * never persisted. The initial description and public comments are retained;
 * private notes, attachments, and requester names stay outside this contract. */
export interface ZendeskTicketsItem {
  zendesk_ticket_id: string;
  requester_id: string;
  requester_cedar_ridge_user_id: string | null;
  requester_email: string | null;
  subject: string | null;
  description: string | null;
  status: string;
  priority: string | null;
  ticket_type: string | null;
  ticket_url: string;
  created_at: string;
  updated_at: string;
  comments_truncated: boolean;
  comments: ZendeskTicketCommentItem[];
}

export interface ZendeskTicketCommentItem {
  zendesk_comment_id: string;
  author_id: string;
  public: true;
  body: string;
  created_at: string;
}

/** One activity-endpoint item. Upsert key: `sf_id` → mirror.activity.sf_id.
 * `household_sf_id` is Task.AccountId → mirror.household.sf_id (household-level
 * linkage; the per-person WhoId is FLS-blocked). These are CRM Tasks with
 * `TaskSubtype='Call'` — call-log entries. `note` is the Salesforce Description.
 * Everything else is optional. `activity_at` is Salesforce CreatedDate;
 * `last_modified_at` is LastModifiedDate — both free-form date strings, or null.
 * `owner_name` is Owner.Name, nullable. */
export interface ActivityItem {
  sf_id: string;
  household_sf_id: string;
  subject: string | null;
  note: string | null;
  activity_at: string | null;
  owner_name: string | null;
  last_modified_at: string | null;
}

// ---------------------------------------------------------------------------
// Rejection reason codes (TDD §7 — exact strings).
//
// PII rule (absolute): reason codes are field + rule names only — NEVER the
// offending value. Nothing a client sent ever appears in a response or log.
// ---------------------------------------------------------------------------

export type ClientsRejectReason =
  | 'sf_contact_id_missing'
  | 'name_missing'
  | 'stage_missing'
  | 'cedar_ridge_user_id_invalid'
  | 'household_name_missing'
  | 'lead_advisor_email_invalid'
  | 'item_malformed';

export type AccountsRejectReason =
  | 'custodian_account_id_missing'
  | 'cedar_ridge_user_id_invalid'
  | 'custodian_invalid'
  | 'status_invalid'
  | 'opened_at_invalid'
  | 'closed_at_invalid'
  | 'status_closed_at_mismatch'
  | 'item_malformed';

export type CrmParentsRejectReason =
  | 'parent_type_invalid'
  | 'source_key_invalid'
  | 'item_malformed';

export type CrmParentOrphansRejectReason =
  | 'parent_type_invalid'
  | 'source_key_invalid'
  | 'parent_state_invalid'
  | 'replacement_key_invalid'
  | 'state_replacement_mismatch'
  | 'item_malformed';

export type TasksRejectReason =
  | 'sf_id_missing'
  | 'household_sf_id_missing'
  | 'assignment_invalid'
  | 'item_malformed';

export type EmailsRejectReason =
  | 'sf_id_missing'
  | 'household_sf_id_missing'
  | 'item_malformed'
  | 'email_bcc_forbidden'
  | 'email_envelope_invalid';

export type ActivityRejectReason =
  | 'sf_id_missing'
  | 'household_sf_id_missing'
  | 'item_malformed';

export type ZendeskTicketsRejectReason =
  | 'item_malformed'
  | 'ticket_id_invalid'
  | 'requester_id_invalid'
  | 'cedar_ridge_user_id_invalid'
  | 'requester_email_invalid'
  | 'subject_invalid'
  | 'description_invalid'
  | 'status_invalid'
  | 'priority_invalid'
  | 'ticket_type_invalid'
  | 'ticket_url_invalid'
  | 'created_at_invalid'
  | 'updated_at_invalid'
  | 'comments_invalid';

// Deals endpoint: each item is a `DealInput` (lib/data/deal-types) validated by
// the FROZEN `validateDealInput` — the ONE contract shared with the D3 form and
// the D4 import. `item_malformed` = not a plain object (or a field is the wrong
// primitive type); `deal_invalid` = failed `validateDealInput`. PII-free: never
// the offending value, and the field-level messages stay in the response's
// rejected list only via the code (the audit row carries counts only).
export type DealsRejectReason =
  | 'item_malformed'
  | 'deal_invalid';

export type IngestRejectReason =
  | ClientsRejectReason
  | AccountsRejectReason
  | TasksRejectReason
  | EmailsRejectReason
  | ActivityRejectReason
  | ZendeskTicketsRejectReason
  | CrmParentsRejectReason
  | CrmParentOrphansRejectReason
  | DealsRejectReason;

/** One rejected item: its zero-based position in `items` + the reason code. */
export interface RejectedItem {
  index: number;
  reason: IngestRejectReason;
}

// ---------------------------------------------------------------------------
// Response shapes (TDD §4).
//
// Arithmetic invariant: `upserted = items.length − rejected.length` (and
// `would_upsert` likewise) — every item not in `rejected` counts as processed,
// always, so the two fields can never be misread against each other.
// ---------------------------------------------------------------------------

/** 200 body for a live run. */
export interface IngestLiveResponse {
  upserted: number;
  rejected: RejectedItem[];
  run_id: string;
}

/** 200 body for `?dryRun=1` — validate + report, zero mirror writes (TDD §10). */
export interface IngestDryRunResponse {
  would_upsert: number;
  rejected: RejectedItem[];
  run_id: string;
}

export type IngestResponse = IngestLiveResponse | IngestDryRunResponse;

/** Non-200 error body (TDD §8 error taxonomy). */
export interface IngestErrorBody {
  error: 'unauthorized' | 'method_not_allowed' | 'bad_request' | 'too_large' | 'internal';
}
