/**
 * zod 4 schemas and tolerant URL-query parsers — node, layer L4.
 *
 * Every schema's `z.output` is the matching input type in src/types/domain.ts (asserted in
 * validation.test.ts). Multi-value URL keys travel as REPEATED BARE KEYS (`?status=NEW&status=OPEN`);
 * readers also split single values on "," (shared convention 12). Unknown values are dropped, an
 * empty result means "unset" (the default applies).
 */
import { z } from "zod";
import type {
  ActionError,
  AssignTicketInput,
  AssignToMeInput,
  AuditAction,
  ChangeRequesterEmailInput,
  AuditEntityType,
  AuditQuery,
  ChangePriorityInput,
  ChangeStatusInput,
  CommentBodyInput,
  CreateTicketInput,
  FollowUpFilter,
  MacroAdminInput,
  MoveQueueInput,
  PublicReplyInput,
  QueueKey,
  RecordClientContactInput,
  SetMacroActiveInput,
  SetUserActiveInput,
  SlaStatus,
  TicketBrand,
  TicketCategory,
  TicketExportScope,
  TicketListQuery,
  TicketPriority,
  TicketSort,
  TicketSource,
  TicketStatus,
  UpdateMacroInput,
  UpdateTicketFieldsInput,
} from "@/types/domain";
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  CLIENT_CONTACT_CHANNELS,
  COMMENT_VISIBILITIES,
  DISCLAIMER_KEYS,
  ESCALATION_TARGETS,
  FOLLOW_UP_FILTERS,
  OPEN_STATUSES,
  QUEUE_KEYS,
  SLA_STATUSES,
  TICKET_BRANDS,
  TICKET_CATEGORIES,
  TICKET_EXPORT_SCOPES,
  TICKET_PRIORITIES,
  TICKET_RESOLUTIONS,
  TICKET_SORTS,
  TICKET_SOURCES,
  TICKET_STATUSES,
} from "@/types/domain";
import { demoTextMax } from "@/lib/demo/mode";

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const SUBJECT_MAX = 200;
// Shorter in the public demo, whose shared database keeps every visitor's text until the reset.
const DESCRIPTION_MAX = demoTextMax(20_000);
const BODY_MAX = demoTextMax(20_000);
const REQUESTER_NAME_MAX = 120;
const CLIENT_REFERENCE_MAX = 200;
const EXTERNAL_REF_MAX = 200;

/** cuid / cuid2 / seed-style ids: URL-safe token, 1..64 chars. */
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");
const versionSchema = z.number().int().min(1);

/** Trims before the email format check (the format check runs before `.trim()` in zod 4), then lowercases. */
const emailSchema = z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.email().toLowerCase());

/**
 * E.164 as `prisma/schema.prisma` documents `Ticket.requesterPhone`: `+` then 8..15 digits, the first
 * of them non-zero. This is the ONLY accepted stored shape — a national-format number is rejected
 * rather than guessed at, because a wrong country code on a callback number is a client-facing error.
 */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * Wave A nullable field schemas. Each one accepts `null` explicitly (the caller clearing the
 * column) and treats an empty / whitespace-only string as `null`, so an emptied form input clears
 * rather than failing validation. `undefined` never reaches these — `.optional()` short-circuits it.
 */
const nullableEmailSchema = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;
  },
  // Normalized trim + lower-case: `Ticket.requesterEmail` is compared for EQUALITY by the client API
  // (src/server/client-view.ts matches the X-Requester-Email header), so a stored mixed-case address
  // would silently deny that client. The normalization here is what keeps that check working.
  z.union([z.email().toLowerCase(), z.null()]),
);

const nullablePhoneSchema = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    // Formatting humans type is stripped; the country code is never inferred.
    const compact = v.replace(/[\s().-]/g, "");
    return compact.length === 0 ? null : compact;
  },
  z.union([z.string().regex(E164_PATTERN, "Enter the number in E.164 format, e.g. +15551234567"), z.null()]),
);

const nullableIsoDateTimeSchema = z.preprocess(
  (v) => (typeof v === "string" && v.trim().length === 0 ? null : v),
  z.union([
    z
      .string()
      .refine((s) => !Number.isNaN(Date.parse(s)), { message: "Enter a valid date" })
      .transform((s) => new Date(s).toISOString()),
    z.null(),
  ]),
);

// ---------------------------------------------------------------------------
// Mutation inputs
// ---------------------------------------------------------------------------

export const createTicketSchema: z.ZodType<CreateTicketInput, unknown> = z.object({
  subject: z.string().trim().min(3).max(SUBJECT_MAX),
  description: z.string().min(1).max(DESCRIPTION_MAX),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  queueKey: z.enum(QUEUE_KEYS).optional(),
  // Sanitized later by createTicket (sanitizeFields), like subject/description/clientReference.
  requesterName: z.string().trim().min(1).max(REQUESTER_NAME_MAX),
  requesterEmail: emailSchema,
  clientReference: z.string().trim().max(CLIENT_REFERENCE_MAX).optional(),
  assigneeId: idSchema.optional(),
});

/**
 * Every editable field `updateTicketFields` accepts, in the order the properties panel shows them.
 * The refine below and `tickets.actions.ts`'s diff list are both driven from this, so adding a field
 * in one place and forgetting the other is not possible.
 */
export const UPDATE_TICKET_FIELD_KEYS = [
  "subject",
  "description",
  "clientReference",
  "category",
  // --- Wave A. `complaintFiledAt` is deliberately absent: the server stamps it. ---
  "requesterName",
  "requesterEmail",
  "requesterPhone",
  "brand",
  "isComplaint",
  "escalationTarget",
  "followUpAt",
  "externalRef",
] as const;

export const updateTicketFieldsSchema: z.ZodType<UpdateTicketFieldsInput, unknown> = z
  .object({
    ticketId: idSchema,
    version: versionSchema,
    subject: z.string().trim().min(3).max(SUBJECT_MAX).optional(),
    description: z.string().min(1).max(DESCRIPTION_MAX).optional(),
    clientReference: z.string().trim().max(CLIENT_REFERENCE_MAX).nullable().optional(),
    category: z.enum(TICKET_CATEGORIES).optional(),
    // Sanitized by the action (sanitizeFields), exactly like subject / description / clientReference.
    requesterName: z.string().trim().min(1).max(REQUESTER_NAME_MAX).optional(),
    requesterEmail: nullableEmailSchema.optional(),
    requesterPhone: nullablePhoneSchema.optional(),
    brand: z.enum(TICKET_BRANDS).optional(),
    isComplaint: z.boolean().optional(),
    escalationTarget: z.enum(ESCALATION_TARGETS).optional(),
    followUpAt: nullableIsoDateTimeSchema.optional(),
    externalRef: z.string().trim().max(EXTERNAL_REF_MAX).nullable().optional(),
  })
  .refine((v) => UPDATE_TICKET_FIELD_KEYS.some((k) => (v as Record<string, unknown>)[k] !== undefined), {
    message: `At least one of ${UPDATE_TICKET_FIELD_KEYS.join(", ")} is required`,
  });

/**
 * S6 `recordClientContact`. The note is stored as an INTERNAL comment, so it takes the
 * comment body cap; the channel is a closed enum, never free text.
 */
export const recordClientContactSchema: z.ZodType<RecordClientContactInput, unknown> = z.object({
  ticketId: idSchema,
  version: versionSchema,
  channel: z.enum(CLIENT_CONTACT_CHANNELS),
  note: z.string().trim().min(1).max(BODY_MAX),
});

/** S6 `assignToMe`: the assignee is the viewer, so the input carries only the ticket and its token. */
export const assignToMeSchema: z.ZodType<AssignToMeInput, unknown> = z.object({
  ticketId: idSchema,
  version: versionSchema,
});

export const changeStatusSchema: z.ZodType<ChangeStatusInput, unknown> = z.object({
  ticketId: idSchema,
  version: versionSchema,
  status: z.enum(TICKET_STATUSES),
  // The outcome recorded alongside the status. The enum is accepted in full here and
  // narrowed in `changeTicketStatus`, which is the only place that knows the CURRENT status: which
  // values are legal depends on the transition (RESOLVED/CLOSED only) and on who owns the value
  // (`DUPLICATE` is `mergeTickets`', `ENTERED_IN_ERROR` is `voidTicket`'s), not on the shape.
  resolution: z.enum(TICKET_RESOLUTIONS).optional(),
});

export const changePrioritySchema: z.ZodType<ChangePriorityInput, unknown> = z.object({
  ticketId: idSchema,
  version: versionSchema,
  priority: z.enum(TICKET_PRIORITIES),
});

export const assignTicketSchema: z.ZodType<AssignTicketInput, unknown> = z.object({
  ticketId: idSchema,
  version: versionSchema,
  assigneeId: idSchema.nullable(),
});

export const moveQueueSchema: z.ZodType<MoveQueueInput, unknown> = z.object({
  ticketId: idSchema,
  version: versionSchema,
  queueKey: z.enum(QUEUE_KEYS),
});

const commentBodyObject = z.object({
  ticketId: idSchema,
  body: z.string().min(1).max(BODY_MAX),
  macroId: idSchema.optional(),
});

export const commentBodySchema: z.ZodType<CommentBodyInput, unknown> = commentBodyObject;

/**
 * I7: a public reply must carry a non-NONE disclaimer and an explicit acknowledgement.
 * `disclaimerAcknowledged` is a boolean refined to `true` (rejects `false` exactly like `z.literal(true)`)
 * so `z.output` stays `boolean` and matches `PublicReplyInput` field-for-field.
 */
export const publicReplySchema: z.ZodType<PublicReplyInput, unknown> = commentBodyObject.extend({
  disclaimerKey: z
    .enum(DISCLAIMER_KEYS)
    .refine((k) => k !== "NONE", { message: "A public reply must carry a firm-approved disclaimer" }),
  disclaimerAcknowledged: z
    .boolean()
    .refine((v) => v === true, { message: "You must confirm the disclaimer will be appended" }),
});

// ---------------------------------------------------------------------------
// Admin — macros and staff users
//
// These live here rather than beside their actions so every schema in the app is one file and
// validation.test.ts can assert each one's `z.output` against its domain input type in one place.
// `@/server/macros` and `@/server/users` re-export them, because CONTRACT §10 pins them to those
// module surfaces.
// ---------------------------------------------------------------------------

/** One key segment. A single quantifier over one class, anchored — linear, with nothing to nest. */
const MACRO_KEY_SEGMENT = /^[a-z0-9]+$/;

/**
 * Lower-case kebab, like every seeded key. The key is a stable machine handle that appears in the
 * picker's subtitle and in audit metadata; leaving it free-form would let two macros differ only by
 * capitalisation, and `Macro.key` is unique so that pair would be a confusing near-collision.
 *
 * Replaces `MACRO_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`, whose `(?:…+)*` is the
 * quantifier-inside-a-quantified-group shape security scanner reports under CWE-1333 — the same shape, and the
 * same fix, as `isDeliverableAddress` in `src/server/outbox.ts`, which is the line the Wave B PR
 * raised that finding against. The accepted set is unchanged: `split("-")` yields an empty segment
 * for a leading, trailing or doubled hyphen and for the empty string, and an empty segment fails
 * `MACRO_KEY_SEGMENT` exactly as it failed the group there.
 */
export function isMacroKey(value: string): boolean {
  return value.split("-").every((segment) => MACRO_KEY_SEGMENT.test(segment));
}

export const MACRO_KEY_MAX = 64;
export const MACRO_TITLE_MAX = 120;
/** Same ceiling as a comment body (INGEST_LIMITS.bodyMax): a macro becomes one. */
export const MACRO_BODY_MAX = 20_000;
export const MACRO_SORT_ORDER_MAX = 100_000;

const macroKeySchema = z
  .string()
  .trim()
  .min(1, "A key is required")
  .max(MACRO_KEY_MAX)
  .refine(isMacroKey, "Use lower-case words separated by hyphens, e.g. wire-verification-notice");
const macroTitleSchema = z.string().trim().min(1, "A title is required").max(MACRO_TITLE_MAX);
const macroBodySchema = z.string().trim().min(1, "A body is required").max(MACRO_BODY_MAX);
const macroQueueKeySchema = z.union([z.enum(QUEUE_KEYS), z.null()]);
const macroChannelSchema = z.enum(COMMENT_VISIBILITIES);
const macroDisclaimerSchema = z.enum(DISCLAIMER_KEYS);
const macroSortOrderSchema = z.number().int().min(0).max(MACRO_SORT_ORDER_MAX);

export const macroAdminSchema: z.ZodType<MacroAdminInput, unknown> = z.object({
  key: macroKeySchema,
  title: macroTitleSchema,
  queueKey: macroQueueKeySchema,
  body: macroBodySchema,
  channel: macroChannelSchema,
  disclaimerKey: macroDisclaimerSchema,
  sortOrder: macroSortOrderSchema,
});

/**
 * Every field optional except the id — `undefined` means "not submitted" and is left alone, exactly
 * like `updateTicketFieldsSchema`. `key` is absent by construction (`Omit<MacroAdminInput, "key">`):
 * a macro's key is its identity in the audit ledger and in `MACRO_SEED`, so renaming one would orphan
 * both. Retire it and create its replacement instead.
 */
export const updateMacroSchema: z.ZodType<UpdateMacroInput, unknown> = z.object({
  macroId: idSchema,
  title: macroTitleSchema.optional(),
  queueKey: macroQueueKeySchema.optional(),
  body: macroBodySchema.optional(),
  channel: macroChannelSchema.optional(),
  disclaimerKey: macroDisclaimerSchema.optional(),
  sortOrder: macroSortOrderSchema.optional(),
});

export const setMacroActiveSchema: z.ZodType<SetMacroActiveInput, unknown> = z.object({
  macroId: idSchema,
  isActive: z.boolean(),
});

/** Free text an operator types into the deactivate/reactivate dialog; sanitized again before persistence. */
const REASON_MAX = 500;

export const setUserActiveSchema: z.ZodType<SetUserActiveInput, unknown> = z.object({
  userId: idSchema,
  isActive: z.boolean(),
  reason: z.string().trim().max(REASON_MAX).optional(),
});

// ---------------------------------------------------------------------------
// Privileged requester-address change (security)
// ---------------------------------------------------------------------------

/**
 * `ChangeRequesterEmailInput` now lives with every other action input in `@/types/domain`
 * (round-2 integration pass); it is re-exported here so existing importers of `@/server/validation`
 * are unchanged and the schema sits beside the type it parses into.
 */
export type { ChangeRequesterEmailInput };

/** Long enough that "typo" alone does not pass; short enough that a real reason fits comfortably. */
const REQUESTER_EMAIL_REASON_MIN = 12;

export const changeRequesterEmailSchema: z.ZodType<ChangeRequesterEmailInput, unknown> = z.object({
  ticketId: idSchema,
  version: versionSchema,
  // Same trim + lower-case normalization as `nullableEmailSchema`: the client API compares this
  // column for EQUALITY, so a stored mixed-case address would silently deny the requester.
  requesterEmail: emailSchema,
  reason: z.string().trim().min(REQUESTER_EMAIL_REASON_MIN).max(REASON_MAX),
  confirm: z.literal(true),
});

// ---------------------------------------------------------------------------
// URL query parsing (tolerant)
// ---------------------------------------------------------------------------

type SearchParamsLike = Record<string, string | string[] | undefined> | URLSearchParams;

/**
 * Convention 12: `URLSearchParams.getAll(key)` or the record value normalized to `string[]`; every value
 * additionally split on ","; trimmed; empties dropped. Shared by both parsers.
 */
export function multiValue(sp: SearchParamsLike, key: string): string[] {
  const raw: string[] = sp instanceof URLSearchParams ? sp.getAll(key) : toArray(sp[key]);
  return raw
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** First value of a single-valued key, trimmed; undefined when absent or empty. */
function singleValue(sp: SearchParamsLike, key: string): string | undefined {
  const raw = sp instanceof URLSearchParams ? sp.get(key) : sp[key];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === null || first === undefined) return undefined;
  const trimmed = first.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pickAllowed<T extends string>(values: readonly string[], allowed: readonly T[]): T[] {
  const set = new Set<T>();
  for (const v of values) {
    if ((allowed as readonly string[]).includes(v)) set.add(v as T);
  }
  return [...set];
}

function pickOne<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,9}$/.test(value)) return undefined;
  return Number.parseInt(value, 10);
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

const SEARCH_MAX = 200;
const ASSIGNEE_PARAM_MAX = 64;
const ACTOR_EMAIL_MAX = 200;
const REQUESTER_EMAIL_PARAM_MAX = 320;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_PAGE = 100_000;
const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;

/** Every status except CLOSED — the default dashboard filter. */
const DEFAULT_STATUS_FILTER: readonly TicketStatus[] = [...OPEN_STATUSES, "RESOLVED"];

/**
 * Tolerant list-query parser: invalid values are dropped, defaults are `sort "resolutionDueAt"`,
 * `dir "asc"`, `page 1`, `pageSize 50` (max 200); `status` defaults to every status except CLOSED when
 * the parsed list is empty. `HD-123` in `search` is allowed (listTickets treats it as a number lookup).
 */
export function parseTicketListQuery(sp: SearchParamsLike): TicketListQuery {
  const queueKey = pickOne<QueueKey>(singleValue(sp, "queueKey"), QUEUE_KEYS);
  const statuses = pickAllowed<TicketStatus>(multiValue(sp, "status"), TICKET_STATUSES);
  const priorities = pickAllowed<TicketPriority>(multiValue(sp, "priority"), TICKET_PRIORITIES);
  const slaStatuses = pickAllowed<SlaStatus>(multiValue(sp, "slaStatus"), SLA_STATUSES);

  const assigneeRaw = singleValue(sp, "assigneeId");
  const assigneeId =
    assigneeRaw !== undefined && assigneeRaw.length <= ASSIGNEE_PARAM_MAX && /^[A-Za-z0-9_-]+$/.test(assigneeRaw)
      ? assigneeRaw
      : undefined;

  const searchRaw = singleValue(sp, "search");
  const search = searchRaw !== undefined ? searchRaw.slice(0, SEARCH_MAX) : undefined;

  const sort = pickOne<TicketSort>(singleValue(sp, "sort"), TICKET_SORTS) ?? "resolutionDueAt";
  const dir = pickOne<"asc" | "desc">(singleValue(sp, "dir"), ["asc", "desc"]) ?? "asc";
  const page = clampInt(parseInteger(singleValue(sp, "page")), 1, MAX_PAGE, 1);
  const pageSize = clampInt(parseInteger(singleValue(sp, "pageSize")), 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);

  const query: TicketListQuery = {
    status: statuses.length > 0 ? statuses : [...DEFAULT_STATUS_FILTER],
    sort,
    dir,
    page,
    pageSize,
  };
  if (queueKey !== undefined) query.queueKey = queueKey;
  if (priorities.length > 0) query.priority = priorities;
  if (slaStatuses.length > 0) query.slaStatus = slaStatuses;
  if (assigneeId !== undefined) query.assigneeId = assigneeId;
  if (search !== undefined) query.search = search;

  // --- Wave A filters (S6 parses, S7 renders). Same tolerance as everything above: an unknown value
  // is dropped and the key behaves as if it were absent, so a hand-edited URL never 500s a dashboard.
  const categories = pickAllowed<TicketCategory>(multiValue(sp, "category"), TICKET_CATEGORIES);
  if (categories.length > 0) query.category = categories;
  const brands = pickAllowed<TicketBrand>(multiValue(sp, "brand"), TICKET_BRANDS);
  if (brands.length > 0) query.brand = brands;
  const sources = pickAllowed<TicketSource>(multiValue(sp, "source"), TICKET_SOURCES);
  if (sources.length > 0) query.source = sources;

  const isComplaint = parseBoolean(singleValue(sp, "isComplaint"));
  if (isComplaint !== undefined) query.isComplaint = isComplaint;

  const followUp = pickOne<FollowUpFilter>(singleValue(sp, "followUp"), FOLLOW_UP_FILTERS);
  if (followUp !== undefined) query.followUp = followUp;

  const createdFrom = parseIsoDate(singleValue(sp, "createdFrom"));
  if (createdFrom !== undefined) query.createdFrom = createdFrom;
  const createdTo = parseIsoDate(singleValue(sp, "createdTo"));
  if (createdTo !== undefined) query.createdTo = createdTo;

  // The ticket header's requester link filters the dashboard by EXACT address, so it is lower-cased
  // here to match the normalization updateTicketFields applies on the way in.
  const requesterEmailRaw = singleValue(sp, "requesterEmail");
  if (
    requesterEmailRaw !== undefined &&
    requesterEmailRaw.length <= REQUESTER_EMAIL_PARAM_MAX &&
    /^[^\s@]+@[^\s@]+$/.test(requesterEmailRaw)
  ) {
    query.requesterEmail = requesterEmailRaw.toLowerCase();
  }

  // The opaque form of the same question. Same tolerant treatment as `assigneeId`: an id that is not
  // id-shaped is DROPPED rather than refused, because these come off a URL a person may have edited.
  const requesterExternalIdRaw = singleValue(sp, "requesterExternalId");
  if (
    requesterExternalIdRaw !== undefined &&
    requesterExternalIdRaw.length <= ASSIGNEE_PARAM_MAX &&
    /^[A-Za-z0-9_-]+$/.test(requesterExternalIdRaw)
  ) {
    query.requesterExternalId = requesterExternalIdRaw;
  }

  return query;
}

/** `"true"`/`"1"`/`"yes"` → true, `"false"`/`"0"`/`"no"` → false, anything else → undefined. */
function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
}

/**
 * Scope of `/api/tickets/export`. Defaults to `"standard"`; `"full"` (the original description and the
 * comment bodies) is additionally gated on the compliance capability in the route, never here — a
 * tolerant parser must not be the thing that decides who may read record content.
 */
export function parseTicketExportScope(sp: SearchParamsLike): TicketExportScope {
  return pickOne<TicketExportScope>(singleValue(sp, "scope"), TICKET_EXPORT_SCOPES) ?? "standard";
}

function parseIsoDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** Tolerant audit-query parser: `action` via multiValue (convention 12); `limit` default 100, max 500. */
export function parseAuditQuery(sp: SearchParamsLike): AuditQuery {
  const query: AuditQuery = {
    limit: clampInt(parseInteger(singleValue(sp, "limit")), 1, MAX_AUDIT_LIMIT, DEFAULT_AUDIT_LIMIT),
  };

  const from = parseIsoDate(singleValue(sp, "from"));
  if (from !== undefined) query.from = from;
  const to = parseIsoDate(singleValue(sp, "to"));
  if (to !== undefined) query.to = to;

  const actorEmail = singleValue(sp, "actorEmail");
  if (actorEmail !== undefined) query.actorEmail = actorEmail.slice(0, ACTOR_EMAIL_MAX).toLowerCase();

  const actions = pickAllowed<AuditAction>(multiValue(sp, "action"), AUDIT_ACTIONS);
  if (actions.length > 0) query.action = actions;

  const entityType = pickOne<AuditEntityType>(singleValue(sp, "entityType"), AUDIT_ENTITY_TYPES);
  if (entityType !== undefined) query.entityType = entityType;

  const ticketNumberRaw = singleValue(sp, "ticketNumber");
  if (ticketNumberRaw !== undefined) {
    const m = /^(?:HD-?)?(\d{1,9})$/i.exec(ticketNumberRaw);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (n >= 1) query.ticketNumber = n;
    }
  }

  const cursor = singleValue(sp, "cursor");
  if (cursor !== undefined && /^\d{1,19}$/.test(cursor)) query.cursor = cursor;

  return query;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `{ ok:false, code:"VALIDATION", message:"Invalid input", fieldErrors }` built from `z.flattenError`.
 * CONTRACT-GAP: the contract maps only `fieldErrors`; root-level (refine) messages would otherwise be lost,
 * so they are surfaced under the reserved key "_form" when present.
 *
 * At most `MAX_REPORTED_ISSUES` messages in all: a list of 20,000 bad ids is one mistake, not 20,000
 * messages in the response.
 */
export const MAX_REPORTED_ISSUES = 5;

export function zodToActionError(err: z.ZodError): ActionError {
  const flat = z.flattenError(err);
  const fieldErrors: Record<string, string[]> = {};
  let room = MAX_REPORTED_ISSUES;
  for (const [field, messages] of Object.entries(flat.fieldErrors as Record<string, string[] | undefined>)) {
    if (room === 0) break;
    if (messages && messages.length > 0) {
      fieldErrors[field] = messages.slice(0, room);
      room -= fieldErrors[field].length;
    }
  }
  if (flat.formErrors.length > 0 && room > 0) fieldErrors._form = flat.formErrors.slice(0, room);
  return { ok: false, code: "VALIDATION", message: "Invalid input", fieldErrors };
}
