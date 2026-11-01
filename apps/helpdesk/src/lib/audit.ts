/**
 * Audit writer and hash-chain helpers — node only, layer L2.
 *
 * Every row is written through one mapper: PII-sanitized and truncated values, sanitized/truncated
 * user agent, actor snapshots (groups sorted in OKTA_GROUPS order — the stored order the hash depends on),
 * `ipAddress` never null. `seq`/`prevHash`/`hash` are assigned by the DB trigger; `canonicalAuditPayload`
 * mirrors that trigger byte-for-byte so the chain can be re-verified in the app.
 */
import { createHash, randomUUID } from "node:crypto";
import { OKTA_GROUPS } from "@/types/domain";
import type {
  AuditAction,
  AuditActor,
  AuditEntityType,
  AuditEntry,
  ChainVerification,
  OktaGroup,
  RequestContext,
  Viewer,
} from "@/types/domain";
import type { Prisma } from "@prisma/client";
import { prisma, withTx } from "@/lib/db";
import type { DbTx } from "@/lib/db";
import { PrefetchNotAllowedError } from "@/lib/errors";
import { sanitizePII } from "@/lib/pii";
import { enforceDemoLimits, lockDemoLimits, shouldRecordDemoDenial, shouldRecordDemoView } from "@/lib/demo/limits";
import { demoMode } from "@/lib/demo/mode";

export const AUDIT_VALUE_MAX_CHARS = 4000 as const;
const USER_AGENT_MAX_CHARS = 512;
const TRUNCATION_SUFFIX = "…[truncated]";
const PAYLOAD_SEPARATOR = "\x1f";

export const SYSTEM_ACTOR: AuditActor = Object.freeze({
  id: null,
  email: "system@wm-helpdesk.local",
  groups: [] as OktaGroup[],
}) as AuditActor;

// ---------------------------------------------------------------------------
// Wave A actors.
//
// A machine caller is a REAL User row, seeded by prisma/seed.ts, so `AuditLog.actorId` is a foreign
// key and "who did this" survives even though no human was present. The two emails below are the
// seeded rows' unique keys; nothing else may use them.
// ---------------------------------------------------------------------------

/** The integration bearer's identity: every ingest / export / outbox call is attributed to this row. */
export const INTEGRATION_ACTOR_EMAIL = "integration@wm-helpdesk.local" as const;
/** The scheduled-jobs identity (SLA sweep, event alerts, nightly duplicate copy). */
export const JOB_ACTOR_EMAIL = "jobs@wm-helpdesk.local" as const;

/**
 * `JOB_ACTOR_EMAIL` (env) resolved against the seeded default: blank or whitespace counts as unset,
 * the convention `src/lib/env.ts` applies to every optional string.
 *
 * This is the ONE definition of "which address is the jobs identity" (integration round 3). It used to
 * exist twice — `resolveJobActorEmail` in `src/jobs/run.ts`, which decides who the jobs run AS, and a
 * re-derivation in `src/server/users.ts`, which decides which rows `/admin/users` hides and
 * `deactivateUser` refuses. If those two ever disagreed, a configured jobs actor would show up as an
 * ordinary staff account an administrator could disable while the jobs kept running as it.
 *
 * It lives here, beside the two constants it chooses between, and it is PURE — the caller passes the
 * configured value. That is deliberate: `src/lib/audit.ts` is pulled in transitively almost everywhere,
 * and several suites mock `@/lib/env` wholesale, so a named `env` import inside this module would break
 * them on a missing export (INTEGRATION_LOG round 2 §10.1). It also keeps the jobs runtime — Slack, the
 * object store — out of a page's server bundle, which is why `users.ts` could not simply import
 * `@/jobs/run`.
 */
export function resolveJobActorEmail(configured: string | undefined): string {
  const trimmed = configured?.trim() ?? "";
  return trimmed === "" ? JOB_ACTOR_EMAIL : trimmed;
}

/**
 * Every address that designates a machine identity rather than a person: the two seeded rows, plus a
 * jobs actor pointed elsewhere by `JOB_ACTOR_EMAIL`. Deduped, so the default (or an override spelled
 * the same as the default) leaves the list exactly two entries long.
 *
 * `src/server/users.ts` hides these from the staff list and refuses them in `deactivateUser` /
 * `reactivateUser`; disabling the integration row would break every machine write path with no signal
 * beyond a 500.
 */
export function machineActorEmails(configuredJobActor: string | undefined): readonly string[] {
  return [...new Set([INTEGRATION_ACTOR_EMAIL, JOB_ACTOR_EMAIL, resolveJobActorEmail(configuredJobActor)])];
}

/**
 * `metadata.via` on a row written by a machine caller. Human actions carry no `via`, so
 * `metadata->>'via'` partitions the ledger into "a person did this" and "a system did this".
 *
 * Wave B adds two. `mcp` is an agent acting through POST /api/mcp: it authenticates with a
 * `ClientApiToken` like any other machine caller, but WHICH machine caller matters here more than
 * usual — an agent reads and writes on a person's behalf with no human in the loop for each call, and
 * "this note was written by a Claude session" is a different fact from "n8n posted it". `import` is
 * the legacy help desk importer, so a row backfilled with a historical timestamp can never be mistaken for one
 * the desk produced live.
 */
export const AUDIT_VIA = {
  api: "api",
  email: "email",
  clientApp: "client-app",
  job: "job",
  mcp: "mcp",
  import: "import",
} as const;
export type AuditVia = (typeof AUDIT_VIA)[keyof typeof AUDIT_VIA];

export function actorFromViewer(v: Viewer): AuditActor {
  return { id: v.id, email: v.email, groups: [...v.groups] };
}

/**
 * Actor for a seeded machine User row. Groups are deliberately EMPTY: a machine caller holds no RBAC
 * grant of its own — its route decides what it may do — and an empty `actorGroups` makes that visible
 * on every row it writes.
 */
export function actorFromMachineUser(user: { id: string; email: string }): AuditActor {
  return { id: user.id, email: user.email, groups: [] };
}

/** Client-API actor: no user row, email `client:<requesterEmail>` lowercased, no groups. */
export function clientApiActor(requesterEmail: string): AuditActor {
  return { id: null, email: `client:${requesterEmail.toLowerCase()}`, groups: [] };
}

/** Context for writes that happen outside an HTTP request (seed, auth events without a header store). */
export function systemRequestContext(label: string): RequestContext {
  return { ipAddress: "unknown", userAgent: label, requestId: `${label}-${randomUUID()}`, isPrefetch: false };
}

function truncateWithSuffix(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

/** null/undefined → null; else sanitizePII(v).text truncated to AUDIT_VALUE_MAX_CHARS (suffix "…[truncated]"). */
export function prepareAuditValue(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return truncateWithSuffix(sanitizePII(String(v)).text, AUDIT_VALUE_MAX_CHARS);
}

/**
 * undefined → undefined; else the metadata re-parsed from its PII-sanitized JSON text. Redaction tokens
 * contain no JSON structural characters, so string values survive the round trip unchanged.
 * CONTRACT-GAP: the contract does not say what to do if the sanitized text no longer parses (only possible
 * when a bare JSON number is itself redacted); the supplementary value is then stored as text rather than
 * failing the business write or persisting raw digits.
 */
export function prepareAuditMetadata(m: AuditEntry["metadata"]): AuditEntry["metadata"] {
  if (m === undefined) return undefined;
  const json = JSON.stringify(m);
  if (json === undefined) return undefined;
  const sanitized = sanitizePII(json).text;
  try {
    return JSON.parse(sanitized) as Prisma.InputJsonValue;
  } catch {
    return { unparseable: sanitized };
  }
}

/** null/undefined/"" → null; else sanitizePII(ua).text truncated to 512 chars (the header is attacker-controlled). */
export function prepareUserAgent(ua: string | null | undefined): string | null {
  if (ua === null || ua === undefined || ua === "") return null;
  // Every visitor can read the demo's ledger, so a browser is recorded by its family alone, not its full string.
  if (demoMode() && String(ua).includes("Mozilla/")) return browserFamily(String(ua));
  return sanitizePII(String(ua)).text.slice(0, USER_AGENT_MAX_CHARS);
}

/** "Chrome", "Safari (mobile)" and so on, from a browser's User-Agent. */
export function browserFamily(ua: string): string {
  const family = /Edg(A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Other browser";
  return /Mobile|Android|iPhone|iPad/.test(ua) ? `${family} (mobile)` : family;
}

/** Deduped, ordered by OKTA_GROUPS index — the stored actorGroups order the hash depends on. Unknowns dropped. */
export function sortGroups(groups: readonly OktaGroup[]): OktaGroup[] {
  const present = new Set<OktaGroup>(groups);
  return OKTA_GROUPS.filter((g) => present.has(g));
}

function buildRow(
  actor: AuditActor,
  ctx: RequestContext,
  entry: AuditEntry,
  occurredAt: Date,
): Prisma.AuditLogCreateManyInput {
  return {
    occurredAt,
    actorId: actor.id,
    actorEmail: actor.email,
    actorGroups: sortGroups(actor.groups),
    action: entry.action,
    entityType: entry.entityType,
    // Defense in depth: entityId can be caller-controlled on the unauthenticated client API,
    // so it is sanitized + truncated exactly like oldValue/newValue rather than stored verbatim.
    entityId: prepareAuditValue(entry.entityId),
    ticketId: entry.ticketId ?? null,
    fieldChanged: entry.fieldChanged ?? null,
    oldValue: prepareAuditValue(entry.oldValue),
    newValue: prepareAuditValue(entry.newValue),
    ipAddress: ctx.ipAddress || "unknown",
    userAgent: prepareUserAgent(ctx.userAgent),
    requestId: ctx.requestId,
    metadata: prepareAuditMetadata(entry.metadata),
  };
}

/** One row. Inside a mutation this must be the last statement of the transaction (the chain trigger locks). */
export async function writeAudit(tx: DbTx, actor: AuditActor, ctx: RequestContext, entry: AuditEntry): Promise<void> {
  // The demo's caps (src/lib/demo/limits.ts), which skip a look's row or refuse a change past a limit;
  // SYSTEM_ACTOR is exempt by identity.
  if (actor !== SYSTEM_ACTOR && !(await enforceDemoLimits(tx, [entry.action], ctx.ipAddress))) return;
  await tx.auditLog.create({ data: buildRow(actor, ctx, entry, new Date()) });
}

/** Several rows in one round trip, built by the same mapper as writeAudit. */
export async function writeAuditMany(
  tx: DbTx,
  actor: AuditActor,
  ctx: RequestContext,
  entries: AuditEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  if (actor !== SYSTEM_ACTOR && !(await enforceDemoLimits(tx, entries.map((e) => e.action), ctx.ipAddress))) return;
  const now = new Date();
  await tx.auditLog.createMany({ data: entries.map((entry) => buildRow(actor, ctx, entry, now)) });
}

/**
 * Records a human view of ticket content. Throws PrefetchNotAllowedError for prefetch requests;
 * otherwise a single awaited insert — errors propagate so no content is served when the row fails.
 */
export async function recordView(
  actor: AuditActor,
  ctx: RequestContext,
  ticketId: string,
  mode: "DETAIL" | "PREVIEW",
): Promise<void> {
  if (ctx.isPrefetch) throw new PrefetchNotAllowedError();
  const entry: AuditEntry = {
    action: mode === "DETAIL" ? "TICKET_VIEWED" : "TICKET_PREVIEWED",
    entityType: "TICKET",
    entityId: ticketId,
    ticketId,
    newValue: mode === "PREVIEW" ? "slide-over" : undefined,
  };
  if (demoMode()) {
    // The demo's view rule (src/lib/demo/limits.ts): one view per persona, ticket and hour. The check and the
    // insert share one transaction under the limits lock, so two tabs cannot both record the same view.
    await withTx(async (tx) => {
      await lockDemoLimits(tx);
      if (await shouldRecordDemoView(tx, actor, ticketId)) await writeAudit(tx, actor, ctx, entry);
    });
    return;
  }
  await writeAudit(prisma, actor, ctx, entry);
}

/**
 * Records a read of CLIENT MATERIAL that is not a ticket-content view: an attachment
 * download, a page of the OPS-PORTAL-mirror export. Same rule as `recordView` — awaited, outside a
 * transaction, errors propagate so nothing is served when the row fails — but deliberately NOT
 * prefetch-guarded, because neither surface is reachable from a Next prefetch.
 */
export async function recordMaterialRead(
  actor: AuditActor,
  ctx: RequestContext,
  entry: Pick<AuditEntry, "action" | "entityType" | "entityId" | "ticketId" | "newValue" | "metadata">,
): Promise<void> {
  await writeAudit(prisma, actor, ctx, entry);
}

/**
 * ONE summarised row standing for N unauthenticated denials from one client IP in one window
 *. `count` is the number of denials the window collapsed, including this one.
 * Authenticated denials are never coalesced — those stay one row each.
 */
export async function recordCoalescedDenial(
  ctx: RequestContext,
  route: string,
  count: number,
  windowStartedAt: Date,
): Promise<void> {
  await writeAudit(prisma, { id: null, email: "client:anonymous", groups: [] }, ctx, {
    action: "AUTHZ_DENIED_COALESCED",
    entityType: "ENDPOINT",
    entityId: route,
    fieldChanged: "capability",
    newValue: `client:unauthenticated x${count}`,
    metadata: { count, route, windowStartedAt: windowStartedAt.toISOString() },
  });
}

/**
 * AUTHZ_DENIED for a REFUSED SIGN-IN — `callbacks.signIn` returning `false`, which is the one refusal in
 * the system that writes NOTHING on its own.
 *
 * Why it needs its own function rather than falling out of the sign-in path: Auth.js runs `handleAuthorized`
 * BEFORE `handleLoginOrRegister`, so a refused identity never reaches `events.signIn` and never produces the
 * `USER_SIGNED_IN` row that records every accepted sign-in. Without this, the only trace of somebody
 * hammering the domain gate on a publicly invokable service is the Cloud Run request log, which is not the
 * compliance ledger and is not retained on the ledger's terms.
 *
 * THE LOCAL PART IS NEVER RECORDED. The refused party is unauthenticated, chooses the address, and the
 * ledger is append-only with no hard delete: `someone@example.com` written there on an attacker's
 * request could never be corrected. The DOMAIN is what the refusal is actually about, so the domain is what
 * is kept — bounded by the caller to a plausible bare domain or the literal `domain:invalid`, exactly as
 * `recordClientApiDenied` bounds a requested ticket id.
 *
 * Coalesced, like every other unauthenticated denial: see `recordRefusedSignIn` in
 * `src/lib/denial-throttle.ts` for the two bounds. `count` is the number of refusals this row stands for,
 * including itself.
 */
export async function recordSignInDenied(
  ctx: RequestContext,
  provider: string,
  reason: string,
  domain: string,
  count: number,
  windowStartedAt: Date,
): Promise<void> {
  await writeAudit(prisma, { id: null, email: `${provider}:${domain}`, groups: [] }, ctx, {
    action: "AUTHZ_DENIED",
    entityType: "SESSION",
    entityId: null,
    fieldChanged: "capability",
    newValue: `${reason} x${count}`,
    metadata: { count, provider, domain, reason, windowStartedAt: windowStartedAt.toISOString() },
  });
}

/** VERBATIM per §e: ticketId ? "TICKET" : /\baudit:/.test(what) ? "AUDIT_LOG" : "QUEUE". */
export function deniedEntityType(what: string, ticketId?: string | null): AuditEntityType {
  return ticketId ? "TICKET" : /\baudit:/.test(what) ? "AUDIT_LOG" : "QUEUE";
}

/** AUTHZ_DENIED for a staff denial (server-side ForbiddenError or a /no-access render). */
export async function recordDenied(
  actor: AuditActor,
  ctx: RequestContext,
  what: string,
  ticketId?: string | null,
): Promise<void> {
  // The demo's denial rule: one recorded refusal per persona and visitor a minute (src/lib/demo/limits.ts).
  if (!shouldRecordDemoDenial(actor.id, ctx.ipAddress)) return;
  await writeAudit(prisma, actor, ctx, {
    action: "AUTHZ_DENIED",
    entityType: deniedEntityType(what, ticketId),
    entityId: ticketId ?? null,
    ticketId: ticketId ?? null,
    fieldChanged: "capability",
    newValue: what,
  });
}

/** CLIENT_API_READ — one of the two audit functions src/server/client-view.ts may import. */
export async function recordClientApiRead(ctx: RequestContext, ticketId: string, requesterEmail: string): Promise<void> {
  await writeAudit(prisma, clientApiActor(requesterEmail), ctx, {
    action: "CLIENT_API_READ",
    entityType: "TICKET",
    entityId: ticketId,
    ticketId,
  });
}

/**
 * A requested id the ledger will store verbatim on a client-API denial: a plausible cuid / seed-style
 * ticket id — alphanumerics and underscore, bounded length. Real ticket ids (cuid `@default`) and the
 * seeded ids all match; a hostile id (an SSN or email with separators, or kilobytes of text) does not.
 */
const PLAUSIBLE_TICKET_ID = /^[A-Za-z0-9_]{1,64}$/;

/** AUTHZ_DENIED for the client API — the other audit function client-view.ts may import. */
export async function recordClientApiDenied(
  ctx: RequestContext,
  requestedTicketId: string,
  requesterEmail: string | null,
  reason: "client:unauthenticated" | "client:requester-mismatch",
  ticketExists: boolean,
): Promise<void> {
  // The route is unauthenticated and the id is the raw URL path segment, so bound it before it reaches the
  // append-only ledger: a hostile id is recorded as the literal "id:invalid", mirroring /no-access's
  // "path:invalid". When the ticket exists the id IS a real, plausible ticket id.
  const entityId = PLAUSIBLE_TICKET_ID.test(requestedTicketId) ? requestedTicketId : "id:invalid";
  await writeAudit(prisma, clientApiActor(requesterEmail ?? "anonymous"), ctx, {
    action: "AUTHZ_DENIED",
    entityType: "TICKET",
    entityId,
    // FK: only reference the ticket when it exists (a real, plausible id).
    ticketId: ticketExists ? requestedTicketId : null,
    fieldChanged: "capability",
    newValue: reason,
  });
}

export type FieldDiff = { fieldChanged: string; oldValue: string | null; newValue: string | null };

/** null/undefined → null; Date → ISO; bigint → decimal string; object → JSON.stringify; else String(v). */
export function serializeAuditValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** One diff per listed field that is present in `after` (not undefined) and differs after serialization. */
export function diffFields<T extends object>(
  before: T,
  after: Partial<T>,
  fields: readonly (keyof T & string)[],
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of fields) {
    if (!(field in after)) continue;
    const next = after[field];
    if (next === undefined) continue;
    const oldValue = serializeAuditValue(before[field]);
    const newValue = serializeAuditValue(next);
    if (oldValue === newValue) continue;
    diffs.push({ fieldChanged: field, oldValue, newValue });
  }
  return diffs;
}

/** The hashed columns of an AuditLog row (everything except `id` and `metadata`). */
export type AuditChainRow = {
  seq: bigint;
  occurredAt: Date;
  actorId: string | null;
  actorEmail: string;
  actorGroups: OktaGroup[];
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string | null;
  ticketId: string | null;
  fieldChanged: string | null;
  oldValue: string | null;
  newValue: string | null;
  ipAddress: string;
  userAgent: string | null;
  requestId: string;
  prevHash: string;
  hash: string;
};

/**
 * MUST equal the SQL trigger payload byte-for-byte: 16 fields joined with \x1f —
 * prevHash, seq, occurredAt (ISO ms, "Z"), actorId, actorEmail, action, entityType, entityId, ticketId,
 * fieldChanged, oldValue, newValue, ipAddress, requestId, actorGroups joined by ",", userAgent.
 */
export function canonicalAuditPayload(row: AuditChainRow): string {
  return [
    row.prevHash,
    row.seq.toString(),
    row.occurredAt.toISOString(),
    row.actorId ?? "",
    row.actorEmail,
    row.action,
    row.entityType,
    row.entityId ?? "",
    row.ticketId ?? "",
    row.fieldChanged ?? "",
    row.oldValue ?? "",
    row.newValue ?? "",
    row.ipAddress,
    row.requestId,
    row.actorGroups.join(","),
    row.userAgent ?? "",
  ].join(PAYLOAD_SEPARATOR);
}

/** sha256 hex over the UTF-8 payload — the same digest the trigger computes. */
export function hashAuditRow(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Pure chain walker over rows ordered by seq ascending. `previousHash` is the hash of the row just before
 * `rows[0]` (null ⇒ rows[0] must carry prevHash "GENESIS"). An empty input reports reason "EMPTY" with
 * `ok: true` (nothing was contradicted), so callers paging through the ledger can compose results.
 * On failure `checked` counts the rows examined, including the failing one.
 */
export function verifyChainRows(
  rows: AuditChainRow[],
  previousHash: string | null,
): { ok: boolean; checked: number; firstBadSeq: bigint | null; reason: ChainVerification["reason"] } {
  if (rows.length === 0) return { ok: true, checked: 0, firstBadSeq: null, reason: "EMPTY" };
  let expectedPrev = previousHash ?? "GENESIS";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.prevHash !== expectedPrev) {
      return { ok: false, checked: i + 1, firstBadSeq: row.seq, reason: "PREV_HASH_MISMATCH" };
    }
    if (hashAuditRow(canonicalAuditPayload(row)) !== row.hash) {
      return { ok: false, checked: i + 1, firstBadSeq: row.seq, reason: "HASH_MISMATCH" };
    }
    expectedPrev = row.hash;
  }
  return { ok: true, checked: rows.length, firstBadSeq: null, reason: "OK" };
}
