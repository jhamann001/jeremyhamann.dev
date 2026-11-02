import { hasForbiddenBccKey, isEmailEnvelope } from "@/lib/email-search/envelope";
import {
  ACCOUNT_STATUSES,
  CRM_PARENT_ORPHAN_STATES,
  CRM_PARENT_TYPES,
  CUSTODIANS,
  type AccountStatus,
  type CrmParentType,
  type Custodian,
  type IngestEnvelope,
  type RejectedItem,
} from "@/lib/ingest/types";
import type { DealInput } from "@/lib/data/deal-types";
import { validateDealInput } from "@/lib/data/deal-validate";
import { mapReportRow, reportRecordFromObject } from "@/lib/deals/import-csv";

// Hand-rolled envelope + per-item validators (the `deal-validate` idiom — no
// zod, the standing no-new-runtime-deps rule). The reason codes and item shapes
// are the FROZEN unions from `@/lib/ingest/types` (D-1); this module imports
// them and NEVER redefines a reason string or item shape.
//
// PII rule (absolute, TDD §7/§11): a validator NEVER puts the offending value
// into the `RejectedItem` — reason strings are field + rule names only. Nothing
// a caller sent ever appears in a response or a log.

/** `user-<uuid>`; the account-holder linkage key. */
export const CEDAR_RIDGE_USER_ID_RE = /^user-[0-9a-f-]{36}$/;

/** Intentionally permissive `x@y.z` shape check (TDD §7 "simple format check") —
 * NOT RFC-5322. We only guard against obviously-malformed advisor emails; the
 * source system is authoritative for real deliverability. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SALESFORCE_ACCOUNT_ID_RE = /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const SALESFORCE_CONTACT_ID_RE = /^003[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** True for a real calendar date in YYYY-MM-DD form that round-trips through
 * `Date.UTC` (mirrors `deal-validate.isValidIsoDate`). Rejects e.g. 2026-02-30. */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Envelope shape check: a non-null object with STRING `source`, STRING `run_id`,
 * and ARRAY `items`. The >5,000-item cap is NOT enforced here — that is the 413
 * the handler checks before per-item work.
 */
export function validateEnvelope(
  body: unknown,
): { ok: true; envelope: IngestEnvelope<unknown> } | { ok: false } {
  if (!isPlainObject(body)) return { ok: false };
  if (typeof body.source !== "string") return { ok: false };
  if (typeof body.run_id !== "string") return { ok: false };
  if (!Array.isArray(body.items)) return { ok: false };
  return {
    ok: true,
    envelope: {
      source: body.source,
      run_id: body.run_id,
      items: body.items,
    },
  };
}

/**
 * Clients per-item validator. Applies the TDD §7 clients rules IN TABLE ORDER,
 * first-failure-wins; returns the `RejectedItem` or `null` (valid).
 *
 * NOTE (D-1 QC LOW-3): `cedar_ridge_user_id` is NOT unique in `mirror.client`
 * (only an index). This validator does per-item SHAPE checks ONLY — it MUST NOT
 * reject or dedupe a batch because two items carry the same `cedar_ridge_user_id`.
 * Two clients sharing the id land as two distinct `mirror.client` rows (upsert
 * key is `sf_id`). The account book-scoping RLS (`account_own_book`) rides on
 * this linkage id, so such an account becomes visible to every advisor leading
 * either client — an inherent property of the non-unique key, acceptable in
 * slice 1 (accepted at the endpoint, see the clients handler holder-join note).
 * D-2 does NOT add a unique constraint (that would be a TDD amendment + a new
 * migration, out of scope).
 */
export function validateClientsItem(
  item: unknown,
  index: number,
): RejectedItem | null {
  if (!isPlainObject(item)) return { index, reason: "item_malformed" };

  if (!isNonEmptyString(item.sf_contact_id))
    return { index, reason: "sf_contact_id_missing" };

  if (!isNonEmptyString(item.name)) return { index, reason: "name_missing" };

  if (!isNonEmptyString(item.stage)) return { index, reason: "stage_missing" };

  // cedar_ridge_user_id: null (or OMITTED — an absent nullable key is `undefined`,
  // treated the same as null, matching the `?? null` bind on the write side and
  // the household_name check below) OR matches the regex (nullable here — TDD §4).
  if (
    item.cedar_ridge_user_id != null &&
    !(
      typeof item.cedar_ridge_user_id === "string" &&
      CEDAR_RIDGE_USER_ID_RE.test(item.cedar_ridge_user_id)
    )
  )
    return { index, reason: "cedar_ridge_user_id_invalid" };

  // household_sf_id non-null ⇒ household_name must be non-null.
  if (
    item.household_sf_id !== null &&
    item.household_sf_id !== undefined &&
    (item.household_name === null || item.household_name === undefined)
  )
    return { index, reason: "household_name_missing" };

  // lead_advisor_email: null (or OMITTED → undefined, treated as null) OR
  // matches EMAIL_RE.
  if (
    item.lead_advisor_email != null &&
    !(
      typeof item.lead_advisor_email === "string" &&
      EMAIL_RE.test(item.lead_advisor_email)
    )
  )
    return { index, reason: "lead_advisor_email_invalid" };

  // Preserve the legacy contract's tolerance for extra properties. Contact
  // email, phone and birthdate are not supported by this feed; the route's
  // explicit SQL column list ignores them rather than writing or clearing PII.
  return null;
}

/**
 * Accounts per-item validator. TDD §7 accounts rules in table order,
 * first-failure-wins. `cedar_ridge_user_id` is REQUIRED here (non-null). The
 * `status === "OPEN" ⇒ closed_at === null` rule mirrors the source's
 * open = `close_date IS NULL`.
 */
export function validateAccountsItem(
  item: unknown,
  index: number,
): RejectedItem | null {
  if (!isPlainObject(item)) return { index, reason: "item_malformed" };

  if (!isNonEmptyString(item.custodian_account_id))
    return { index, reason: "custodian_account_id_missing" };

  // Required and regex-matching here (unlike the clients endpoint).
  if (
    !(
      typeof item.cedar_ridge_user_id === "string" &&
      CEDAR_RIDGE_USER_ID_RE.test(item.cedar_ridge_user_id)
    )
  )
    return { index, reason: "cedar_ridge_user_id_invalid" };

  if (!CUSTODIANS.includes(item.custodian as Custodian))
    return { index, reason: "custodian_invalid" };

  if (!ACCOUNT_STATUSES.includes(item.status as AccountStatus))
    return { index, reason: "status_invalid" };

  // opened_at / closed_at: null-or-valid-ISO.
  if (
    item.opened_at !== null &&
    item.opened_at !== undefined &&
    !(typeof item.opened_at === "string" && isValidIsoDate(item.opened_at))
  )
    return { index, reason: "opened_at_invalid" };

  if (
    item.closed_at !== null &&
    item.closed_at !== undefined &&
    !(typeof item.closed_at === "string" && isValidIsoDate(item.closed_at))
  )
    return { index, reason: "closed_at_invalid" };

  // Cross-field: an OPEN account must have a null closed_at.
  if (item.status === "OPEN" && item.closed_at !== null && item.closed_at !== undefined)
    return { index, reason: "status_closed_at_mismatch" };

  return null;
}

/** Key-only CRM parent validation. The type/prefix pairing is enforced at
 * both the HTTP seam and the mirror table CHECK constraint, so an Account can
 * never be registered as a Contact (or vice versa). */
export function validateCrmParentItem(
  item: unknown,
  index: number,
): RejectedItem | null {
  if (!isPlainObject(item)) return { index, reason: "item_malformed" };

  if (!CRM_PARENT_TYPES.includes(item.parent_type as CrmParentType)) {
    return { index, reason: "parent_type_invalid" };
  }

  if (typeof item.source_key !== "string") {
    return { index, reason: "source_key_invalid" };
  }

  const valid = item.parent_type === "HOUSEHOLD"
    ? SALESFORCE_ACCOUNT_ID_RE.test(item.source_key)
    : SALESFORCE_CONTACT_ID_RE.test(item.source_key);
  return valid ? null : { index, reason: "source_key_invalid" };
}

/** Diagnostic-only Salesforce tombstone/merge validation. Unknown fields are
 * rejected so names or other business content cannot cross this key-only seam. */
export function validateCrmParentOrphanItem(
  item: unknown,
  index: number,
): RejectedItem | null {
  if (!isPlainObject(item)) return { index, reason: "item_malformed" };

  const allowed = new Set([
    "parent_type",
    "source_key",
    "parent_state",
    "replacement_key",
  ]);
  if (Object.keys(item).some((key) => !allowed.has(key))) {
    return { index, reason: "item_malformed" };
  }

  if (!CRM_PARENT_TYPES.includes(item.parent_type as CrmParentType)) {
    return { index, reason: "parent_type_invalid" };
  }
  if (typeof item.source_key !== "string") {
    return { index, reason: "source_key_invalid" };
  }

  const keyPattern = item.parent_type === "HOUSEHOLD"
    ? SALESFORCE_ACCOUNT_ID_RE
    : SALESFORCE_CONTACT_ID_RE;
  if (!keyPattern.test(item.source_key)) {
    return { index, reason: "source_key_invalid" };
  }

  if (!CRM_PARENT_ORPHAN_STATES.includes(
    item.parent_state as (typeof CRM_PARENT_ORPHAN_STATES)[number],
  )) {
    return { index, reason: "parent_state_invalid" };
  }

  const replacement = item.replacement_key;
  if (replacement !== undefined && replacement !== null
    && (typeof replacement !== "string" || !keyPattern.test(replacement))) {
    return { index, reason: "replacement_key_invalid" };
  }

  if (item.parent_state === "DELETED" && replacement != null) {
    return { index, reason: "state_replacement_mismatch" };
  }
  if (item.parent_state === "MERGED"
    && (typeof replacement !== "string"
      || replacement.slice(0, 15) === item.source_key.slice(0, 15))) {
    return { index, reason: "state_replacement_mismatch" };
  }

  return null;
}

const TASK_ASSIGNMENT_KEYS = new Set([
  "state", "assignee_id", "assignee_type", "assignee_name", "observed_at",
]);

/** Match the feed's UTC observation clock with millisecond-or-less precision.
 * Round-trip rejects normalized impossible dates (e.g. February 30), avoiding
 * timestamp-cast failures that would roll back an otherwise valid batch. */
function isAssignmentTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match || value.startsWith("0000-") || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
}

function isTaskAssignment(value: unknown): boolean {
  if (!isPlainObject(value)
    || Object.keys(value).length !== TASK_ASSIGNMENT_KEYS.size
    || Object.keys(value).some(key => !TASK_ASSIGNMENT_KEYS.has(key))
    || !isAssignmentTimestamp(value.observed_at)) return false;

  if (value.state === "UNASSIGNED" || value.state === "UNAVAILABLE") {
    return value.assignee_id === null && value.assignee_type === null && value.assignee_name === null;
  }
  if (value.state !== "ASSIGNED" || typeof value.assignee_id !== "string") return false;
  // The prefix validates a supplied authoritative classification; it does not
  // create one. In particular a Group ID alone must never imply a Queue.
  const idPattern = value.assignee_type === "USER"
    ? /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/
    : value.assignee_type === "QUEUE" ? /^00G[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/ : null;
  if (!idPattern?.test(value.assignee_id)) return false;
  return value.assignee_name === null || (typeof value.assignee_name === "string"
    && value.assignee_name.trim().length > 0 && value.assignee_name.length <= 255
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value.assignee_name));
}

/**
 * Tasks per-item validator. First-failure-wins: the item
 * must be a plain object with non-empty `sf_id` (upsert key) and non-empty
 * `household_sf_id` (the household linkage). Legacy fields — subject, status,
 * priority, description, last_modified_at — is optional (null/absent OK) and
 * carried verbatim; there is NO format check on `last_modified_at` (the source
 * is authoritative, the column is a tolerant timestamptz cast at the seam).
 * The additive assignment object is optional but strictly validated when sent.
 */
export function validateTasksItem(
  item: unknown,
  index: number,
): RejectedItem | null {
  if (!isPlainObject(item)) return { index, reason: "item_malformed" };

  if (!isNonEmptyString(item.sf_id))
    return { index, reason: "sf_id_missing" };

  if (!isNonEmptyString(item.household_sf_id))
    return { index, reason: "household_sf_id_missing" };

  if (Object.hasOwn(item, "assignment") && !isTaskAssignment(item.assignment))
    return { index, reason: "assignment_invalid" };

  return null;
}

/**
 * Emails per-item validator. SHAPE checks only, first-failure-wins: the item
 * must be a plain object with non-empty `sf_id` (upsert key) and non-empty
 * `household_sf_id` (the household linkage). Everything else — subject, body,
 * sent_at, last_modified_at — is optional (null/absent OK) and carried verbatim;
 * there is NO format check on the dates (the source is authoritative, the
 * columns are tolerant timestamptz casts at the seam). `body` is cleaned,
 * disclaimer-stripped and capped upstream in the feed, so no content check here.
 */
export function validateEmailsItem(
  item: unknown,
  index: number,
): RejectedItem | null {
  if (!isPlainObject(item)) return { index, reason: "item_malformed" };

  if (!isNonEmptyString(item.sf_id))
    return { index, reason: "sf_id_missing" };

  if (!isNonEmptyString(item.household_sf_id))
    return { index, reason: "household_sf_id_missing" };

  if (hasForbiddenBccKey(item)) return { index, reason: "email_bcc_forbidden" };
  if (Object.hasOwn(item, "email_envelope") && !isEmailEnvelope(item.email_envelope, item.sf_id))
    return { index, reason: "email_envelope_invalid" };
  return null;
}

const ZENDESK_TICKET_KEYS = new Set([
  "zendesk_ticket_id",
  "requester_id",
  "requester_cedar_ridge_user_id",
  "requester_email",
  "subject",
  "description",
  "status",
  "priority",
  "ticket_type",
  "ticket_url",
  "created_at",
  "updated_at",
  "comments_truncated",
  "comments",
]);

function isNullableBoundedString(value: unknown, max: number): boolean {
  return value === null || (typeof value === "string" && value.length <= max);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

/** Strict Zendesk content seam. Unknown keys are rejected so private notes,
 * requester names, attachments, or other accidental data cannot cross the
 * ingest boundary. Public comment bodies are accepted only through the narrow
 * nested contract below. */
export function validateZendeskTicketsItem(
  item: unknown,
  index: number,
): RejectedItem | null {
  if (!isPlainObject(item)) return { index, reason: "item_malformed" };
  if (Object.keys(item).some((key) => !ZENDESK_TICKET_KEYS.has(key)))
    return { index, reason: "item_malformed" };
  if (!isNonEmptyString(item.zendesk_ticket_id)
    || !/^\d{1,20}$/.test(item.zendesk_ticket_id))
    return { index, reason: "ticket_id_invalid" };
  if (!isNonEmptyString(item.requester_id)
    || !/^\d{1,20}$/.test(item.requester_id))
    return { index, reason: "requester_id_invalid" };
  if (item.requester_cedar_ridge_user_id !== null
    && (typeof item.requester_cedar_ridge_user_id !== "string"
      || !CEDAR_RIDGE_USER_ID_RE.test(item.requester_cedar_ridge_user_id)))
    return { index, reason: "cedar_ridge_user_id_invalid" };
  if (item.requester_email !== null
    && (typeof item.requester_email !== "string"
      || item.requester_email.length > 320
      || !EMAIL_RE.test(item.requester_email)))
    return { index, reason: "requester_email_invalid" };
  if (!isNullableBoundedString(item.subject, 500))
    return { index, reason: "subject_invalid" };
  if (!isNullableBoundedString(item.description, 50_000))
    return { index, reason: "description_invalid" };
  if (!isNonEmptyString(item.status) || item.status.length > 64)
    return { index, reason: "status_invalid" };
  if (!isNullableBoundedString(item.priority, 64))
    return { index, reason: "priority_invalid" };
  if (!isNullableBoundedString(item.ticket_type, 64))
    return { index, reason: "ticket_type_invalid" };
  if (!isNonEmptyString(item.ticket_url) || item.ticket_url.length > 1000)
    return { index, reason: "ticket_url_invalid" };
  try {
    const url = new URL(item.ticket_url);
    const normalizedPath = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    if (url.protocol !== "https:"
      || !url.hostname.toLowerCase().endsWith(".zendesk.com")
      || normalizedPath !== `/agent/tickets/${item.zendesk_ticket_id}`)
      return { index, reason: "ticket_url_invalid" };
  } catch {
    return { index, reason: "ticket_url_invalid" };
  }
  if (!isIsoTimestamp(item.created_at))
    return { index, reason: "created_at_invalid" };
  if (!isIsoTimestamp(item.updated_at))
    return { index, reason: "updated_at_invalid" };
  if (typeof item.comments_truncated !== "boolean")
    return { index, reason: "comments_invalid" };
  if (!Array.isArray(item.comments) || item.comments.length > 250)
    return { index, reason: "comments_invalid" };
  for (const comment of item.comments) {
    if (!isPlainObject(comment)
      || Object.keys(comment).some((key) => ![
        "zendesk_comment_id", "author_id", "public", "body", "created_at",
      ].includes(key))
      || !isNonEmptyString(comment.zendesk_comment_id)
      || !/^\d{1,20}$/.test(comment.zendesk_comment_id)
      || !isNonEmptyString(comment.author_id)
      || !/^-?\d{1,20}$/.test(comment.author_id)
      || comment.public !== true
      || !isNonEmptyString(comment.body)
      || comment.body.length > 50_000
      || !isIsoTimestamp(comment.created_at)) {
      return { index, reason: "comments_invalid" };
    }
  }
  return null;
}

/**
 * Activity per-item validator. SHAPE checks only, first-failure-wins: the item
 * must be a plain object with non-empty `sf_id` (upsert key) and non-empty
 * `household_sf_id` (the household linkage). Everything else — subject, note,
 * activity_at, owner_name, last_modified_at — is optional (null/absent OK) and
 * carried verbatim; there is NO format check on the dates (the source is
 * authoritative, the columns are tolerant timestamptz casts at the seam). These
 * are CRM Tasks with `TaskSubtype='Call'`; the subtype filter lives
 * upstream in the feed, so no subtype check here.
 */
export function validateActivityItem(
  item: unknown,
  index: number,
): RejectedItem | null {
  if (!isPlainObject(item)) return { index, reason: "item_malformed" };

  if (!isNonEmptyString(item.sf_id))
    return { index, reason: "sf_id_missing" };

  if (!isNonEmptyString(item.household_sf_id))
    return { index, reason: "household_sf_id_missing" };

  return null;
}

/** Result of mapping + validating one deals item: the mapped `DealInput` (push
 * to okItems) OR the `RejectedItem` (push to rejected). A discriminated union so
 * the route never re-maps a row to recover the DealInput after validation. */
export type DealsItemResult =
  | { ok: true; deal: DealInput }
  | { ok: false; rejected: RejectedItem };

/**
 * Deals per-item validator. Items are now RAW CRM report-row objects
 * (keyed by the report's CSV column headers — exactly what n8n's
 * `extractFromFile` produces), NOT clean DealInputs. This MAPS each row →
 * DealInput via the app's EXISTING importer (`reportRecordFromObject` +
 * `mapReportRow`, the same alias resolution + crosswalk the D4 import script
 * uses — no review CSV at this seam, so `mapReportRow` is called without one),
 * then validates the mapped row with the FROZEN `validateDealInput` (the ONE
 * contract shared with the D3 form + D4 import) so the endpoint can never accept
 * a row the form would reject. First-failure-wins, PII-free reasons only:
 *   - not a plain object                         → `item_malformed`;
 *   - maps to a blank `sf_deal_id` (e.g. the row is missing the deal-id column)
 *     → `item_malformed` — the MANDATORY upsert key, guarded independently of
 *     validateDealInput's source-conditional rule so it can never reach
 *     tx.deal.upsert({ where: { sf_deal_id: undefined } }) and 500 the batch;
 *   - fails `validateDealInput`                  → `deal_invalid`.
 */
export function validateDealsItem(
  item: unknown,
  index: number,
): DealsItemResult {
  if (!isPlainObject(item))
    return { ok: false, rejected: { index, reason: "item_malformed" } };

  const deal = mapReportRow(reportRecordFromObject(item)).input;

  if (!isNonEmptyString(deal.sf_deal_id))
    return { ok: false, rejected: { index, reason: "item_malformed" } };

  if (!validateDealInput(deal).ok)
    return { ok: false, rejected: { index, reason: "deal_invalid" } };

  return { ok: true, deal };
}
