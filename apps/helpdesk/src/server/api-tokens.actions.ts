"use server";

/**
 * Machine-credential administration — `"use server"`, node, layer L4
 * (the build record `tokens:admin`, §3.2 `API_TOKEN_*`).
 *
 * What this replaces: one `INTEGRATION_API_TOKEN` and one `CLIENT_API_TOKEN` in the environment,
 * shared by every consumer, revocable only by a deploy, and attributable to nobody. A `ClientApiToken`
 * row is per consumer, carries its own scopes and expiry, is revoked with one click, and records who
 * issued it and when it was last used.
 *
 * Three rules this module exists to enforce, none of them optional:
 *
 *  1. **The plaintext leaves once, from `createApiToken` / `rotateApiToken`, and never again.** It is
 *     returned inside `ApiTokenSecret` and is held nowhere else — not in a DTO, not in an audit row,
 *     not in a log line. §3 rule 2: "a secret never reaches the ledger", and `writeAudit`'s PII
 *     sanitizer is no help here because a bearer token is not a PII shape. This module is the control.
 *  2. **Nothing is ever deleted.** `ClientApiToken` carries a no-hard-delete trigger
 *     because every `API_TOKEN_*` row points at an id. Revocation is a column and a timestamp.
 *  3. **`tokens:admin` is `ops_team`, checked here as well as in middleware and on the page.** Three
 *     checks, because middleware is a coarse UX gate and the server is authoritative.
 *
 * Every action is ONE transaction whose last statement is a single `writeAuditMany` (§3 rule 2).
 *
 * The zod schemas are module-private: a `"use server"` file may export only `runAction`-wrapped async
 * functions (guardrail G4), and no other module needs them.
 */
import { z } from "zod";
import type {
  ActionResult,
  ApiTokenDTO,
  ApiTokenScope,
  ApiTokenSecret,
  AuditEntry,
  CreateApiTokenInput,
  RevokeApiTokenInput,
  RotateApiTokenInput,
} from "@/types/domain";
import { API_TOKEN_SCOPES, WAVE_B_LIMITS } from "@/types/domain";
import { API_TOKEN_SELECT, mintApiToken, toApiTokenDTO } from "@/lib/api-tokens";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
import type { DbTx } from "@/lib/db";
import { prisma, withTx } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { DEMO_TOKENS_OFF, demoMode } from "@/lib/demo/mode";
import { sanitizePII } from "@/lib/pii";
import { assertCan, canAdminTokens } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";

// ---------------------------------------------------------------------------
// Module-private validation (G4: a "use server" file exports async functions only)
// ---------------------------------------------------------------------------

const NAME_MAX = 120;
const NOTE_MAX = 500;
const EMAIL_MAX = 254;

/**
 * The scopes that make `requesterEmail` meaningful. Binding a token to one address is how a
 * per-CLIENT credential is expressed; binding an ingest or export credential to an address would be a
 * field nothing reads, which is worse than a missing feature because someone will later believe it.
 */
const REQUESTER_BOUND_SCOPES: readonly ApiTokenScope[] = ["CLIENT_READ", "CLIENT_WRITE"];

const scopeSchema = z.enum(API_TOKEN_SCOPES);

const createSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
  scopes: z.array(scopeSchema).min(1).max(API_TOKEN_SCOPES.length),
  requesterEmail: z
    .string()
    .trim()
    .toLowerCase()
    .max(EMAIL_MAX)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "that does not look like an email address")
    .nullish(),
  /** ISO 8601. Absent or null means the credential does not expire on its own. */
  expiresAt: z.string().trim().min(1).max(64).nullish(),
  note: z.string().trim().max(NOTE_MAX).optional(),
});

/**
 * Revoking and rotating both take a recorded reason, at the same floor every other Wave B reason uses
 * (`WAVE_B_LIMITS.reasonMinChars`). "why is this credential gone" is the question an operator asks six
 * months later when an integration stops working, and "rotate" as a whole reason answers nothing.
 */
const reasonSchema = z
  .string()
  .trim()
  .min(WAVE_B_LIMITS.reasonMinChars, `give a reason of at least ${WAVE_B_LIMITS.reasonMinChars} characters`)
  .max(WAVE_B_LIMITS.reasonMaxChars);

const revokeSchema = z.object({ tokenId: z.string().trim().min(1).max(64), reason: reasonSchema });

/** Refuses free text the PII sanitizer touched, rather than storing the redaction (the macro rule). */
function sanitizedField(raw: string, field: string, label: string): string {
  const result = sanitizePII(raw);
  if (result.redacted) {
    throw new ValidationError(`${label} looks like it contains client data`, {
      [field]: [
        // Three kinds since Decision #116, not four — see the note on `sanitizedField` in
        // `macros.actions.ts`. This gate no longer fires on a routing number.
        `That ${label.toLowerCase()} contains ${result.count} value${result.count === 1 ? "" : "s"} that look ` +
          "like an account, card or Social Security number. A token's name is read by every " +
          "administrator — describe the consumer, not the client.",
      ],
    });
  }
  return result.text;
}

/** ISO string → Date, in the future. Null passes through: a credential may legitimately not expire. */
function parseExpiry(raw: string | null | undefined, now: Date): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError("that expiry is not a date", { expiresAt: ["Use an ISO date, for example 2027-01-31."] });
  }
  if (d.getTime() <= now.getTime()) {
    throw new ValidationError("that expiry is in the past", {
      expiresAt: ["An expiry in the past would create a credential that is dead on arrival."],
    });
  }
  return d;
}

/** Deduplicated, in declaration order, so two tokens with the same grant produce the same audit value. */
function normalizeScopes(scopes: readonly ApiTokenScope[]): ApiTokenScope[] {
  const seen = new Set<ApiTokenScope>(scopes);
  return API_TOKEN_SCOPES.filter((s) => seen.has(s));
}

function assertRequesterBinding(scopes: readonly ApiTokenScope[], requesterEmail: string | null): void {
  if (requesterEmail === null) return;
  if (scopes.some((s) => REQUESTER_BOUND_SCOPES.includes(s))) return;
  throw new ValidationError("only a client-scoped token can be bound to one requester", {
    requesterEmail: [
      "Binding an address to an ingest, outbox, export or MCP credential would be a field nothing " +
        "reads. Add Client API — read / write, or leave the address blank.",
    ],
  });
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "P2002";
}

type InsertInput = {
  name: string;
  scopes: ApiTokenScope[];
  requesterEmail: string | null;
  expiresAt: Date | null;
  note: string | null;
  createdById: string;
};

/** What `mintApiToken` produced: one prefix, one hash, and the plaintext that leaves exactly once. */
type MintedToken = ReturnType<typeof mintApiToken>;

/**
 * Mints a credential and runs `body` in ONE transaction with it, re-running the WHOLE transaction once
 * — with a fresh mint — if the insert loses the `prefix` or `tokenHash` unique index.
 *
 * The retry has to live out here, and the mint with it. `withTx` is a single interactive BEGIN/COMMIT
 * with no per-statement SAVEPOINT (`src/lib/db.ts`), so a P2002 leaves PostgreSQL's transaction in the
 * ABORTED state: a second `create` on that same `tx` could only fail with 25P02 — not a unique
 * violation, so it would be rethrown and reach the operator as an opaque 500, and in `rotateApiToken`
 * the old credential's revocation would roll back with it, leaving them unsure whether the token they
 * were rotating is still live. Rolling back and re-running is the shape `createTicketCore`
 * (`src/server/ingest.ts`) and `suspendIntake` (`src/server/email-intake.ts`) already use for their own
 * unique-index races.
 *
 * Re-running is safe for both callers: the losing attempt committed nothing, and `rotateApiToken`'s
 * revocation is a conditional `updateMany` against `revokedAt: null`, so the replay reads the same
 * un-revoked row it read the first time and the audit pair is written once. A collision is
 * astronomically unlikely (36^8 ≈ 2.8e12 prefixes, 2^256 secrets) and the operator did nothing wrong,
 * which is why it is retried rather than surfaced; a SECOND one surfaces as a `ConflictError` rather
 * than looping.
 */
async function withMintedToken<T>(body: (tx: DbTx, minted: MintedToken) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const minted = mintApiToken();
    try {
      return await withTx((tx) => body(tx, minted));
    } catch (e) {
      if (attempt === 0 && isUniqueViolation(e)) continue;
      throw e;
    }
  }
  throw new ConflictError("could not mint a unique token prefix");
}

/**
 * Inserts one credential from an already-minted secret and returns the row plus its plaintext.
 *
 * One statement and no retry of its own: the collision retry belongs to `withMintedToken`, which owns
 * the transaction this runs inside and is the only place a retry can actually work.
 */
async function insertToken(
  tx: DbTx,
  input: InsertInput,
  minted: MintedToken,
): Promise<{ row: ApiTokenDTO; plaintext: string }> {
  const row = await tx.clientApiToken.create({
    data: {
      name: input.name,
      prefix: minted.prefix,
      tokenHash: minted.tokenHash,
      scopes: input.scopes,
      requesterEmail: input.requesterEmail,
      expiresAt: input.expiresAt,
      note: input.note,
      createdById: input.createdById,
    },
    select: API_TOKEN_SELECT,
  });
  return { row: toApiTokenDTO(row), plaintext: minted.plaintext };
}

/** The `API_TOKEN_CREATED` row. `metadata.prefix` is the whole of what the ledger learns. */
function createdEntry(token: ApiTokenDTO, extra: Record<string, unknown> = {}): AuditEntry {
  return {
    action: "API_TOKEN_CREATED",
    entityType: "API_TOKEN",
    entityId: token.id,
    ticketId: null,
    fieldChanged: "scopes",
    oldValue: null,
    newValue: token.scopes.join(","),
    metadata: {
      prefix: token.prefix,
      name: token.name,
      // The ADDRESS is not recorded; whether the credential is bound to one is. A token's audit trail
      // is read by administrators, and a client's mailbox is not their business.
      requesterBound: token.requesterEmail !== null,
      expiresAt: token.expiresAt,
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Every credential ever issued, newest first, including revoked and expired ones.
 *
 * Revoked rows stay on the screen deliberately: "we revoked that on the 3rd" is the answer to a
 * question somebody will ask, and a list that hid them would make the ledger the only place to look.
 * The UI groups them; this returns them all.
 */
/**
 * The public demo issues no credentials: every route a token opens (the client API, MCP, the machine
 * intake and outbox) is closed at the demo's edge, so a minted token could only mislead.
 */
function assertNotDemo(): void {
  if (demoMode()) throw new ValidationError(DEMO_TOKENS_OFF);
}

export async function listApiTokens(): Promise<ActionResult<ApiTokenDTO[]>> {
  return runAction("listApiTokens", async (viewer) => {
    assertCan(canAdminTokens(viewer.groups), "tokens:admin list");
    const rows = await prisma.clientApiToken.findMany({
      select: API_TOKEN_SELECT,
      orderBy: [{ createdAt: "desc" }],
      take: 200,
    });
    return rows.map(toApiTokenDTO);
  });
}

/**
 * Issues a credential. The plaintext is in the RESULT and nowhere else — the screen shows it once and
 * the operator copies it into whatever consumes it. There is no "show me again".
 */
export async function createApiToken(input: CreateApiTokenInput): Promise<ActionResult<ApiTokenSecret>> {
  return runAction("createApiToken", async (viewer, ctx) => {
    const data = createSchema.parse(input);
    assertCan(canAdminTokens(viewer.groups), "tokens:admin create");
    assertNotDemo();

    const now = new Date();
    const name = sanitizedField(data.name, "name", "Name");
    const note = data.note === undefined || data.note === "" ? null : sanitizedField(data.note, "note", "Note");
    const scopes = normalizeScopes(data.scopes);
    const requesterEmail = data.requesterEmail ?? null;
    assertRequesterBinding(scopes, requesterEmail);
    const expiresAt = parseExpiry(data.expiresAt, now);
    const actor = actorFromViewer(viewer);

    return withMintedToken(async (tx, minted) => {
      const { row, plaintext } = await insertToken(
        tx,
        {
          name,
          scopes,
          requesterEmail,
          expiresAt,
          note,
          createdById: viewer.id,
        },
        minted,
      );
      await writeAuditMany(tx, actor, ctx, [createdEntry(row)]);
      const secret: ApiTokenSecret = { token: row, plaintext };
      return secret;
    });
  });
}

/**
 * Revokes a credential. Immediate: `verifyApiToken` refuses any row with a `revokedAt`, so the next
 * request on that bearer is a 401 with no deploy and no cache to wait out.
 *
 * Revoking an already-revoked token is not an error and writes no second row — the caller asked for a
 * state and the state holds. The conditional `updateMany` is what makes that race-free.
 */
export async function revokeApiToken(input: RevokeApiTokenInput): Promise<ActionResult<{ id: string }>> {
  return runAction("revokeApiToken", async (viewer, ctx) => {
    const data = revokeSchema.parse(input);
    assertCan(canAdminTokens(viewer.groups), "tokens:admin revoke");
    const reason = sanitizedField(data.reason, "reason", "Reason");
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      // `existing`, not `token`: the value is a ClientApiToken ROW — an id, a prefix and a timestamp,
      // selected without the hash — and the checks below are a presence test and a state test, not a
      // comparison of anything secret. security scanner reads `token === null` as CWE-208 on the name alone
      // (the build record), and `rotateApiToken` right below already names its row `old` for
      // the same reason. Presence is asked by truthiness, which is the shape the Wave A rescan settled
      // on for exactly this (`token === null` → `!token`, commit 900ac2e).
      const existing = await tx.clientApiToken.findUnique({
        where: { id: data.tokenId },
        select: { id: true, prefix: true, revokedAt: true },
      });
      if (!existing) throw new NotFoundError("that token no longer exists");
      if (existing.revokedAt !== null) return { id: existing.id };

      const revokedAt = new Date();
      const flipped = await tx.clientApiToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt, revokedById: viewer.id },
      });
      if (flipped.count !== 1) return { id: existing.id };

      await writeAuditMany(tx, actor, ctx, [
        {
          action: "API_TOKEN_REVOKED",
          entityType: "API_TOKEN",
          entityId: existing.id,
          ticketId: null,
          fieldChanged: "revokedAt",
          oldValue: null,
          newValue: revokedAt.toISOString(),
          metadata: { prefix: existing.prefix, reason },
        },
      ]);
      return { id: existing.id };
    });
  });
}

/**
 * Replaces a credential: the old row is revoked and a NEW row is issued carrying the same name,
 * scopes, requester binding and expiry, in ONE transaction.
 *
 * It is two rows rather than a new secret on the same row, and that is the point. A rotated
 * credential must be able to answer "which of the two was used on the 14th", and `lastUsedAt` on a
 * row whose hash had been replaced underneath it could not. It also means the old prefix keeps
 * pointing at the old audit trail forever.
 *
 * There is no overlap window: the old bearer stops working the instant this commits. A consumer that
 * needs one issues a second credential, cuts over, then revokes the first — which is what the two
 * separate actions are for.
 */
export async function rotateApiToken(input: RotateApiTokenInput): Promise<ActionResult<ApiTokenSecret>> {
  return runAction("rotateApiToken", async (viewer, ctx) => {
    const data = revokeSchema.parse(input);
    assertCan(canAdminTokens(viewer.groups), "tokens:admin rotate");
    assertNotDemo();
    const reason = sanitizedField(data.reason, "reason", "Reason");
    const actor = actorFromViewer(viewer);

    return withMintedToken(async (tx, minted) => {
      const old = await tx.clientApiToken.findUnique({
        where: { id: data.tokenId },
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          requesterEmail: true,
          expiresAt: true,
          note: true,
          revokedAt: true,
        },
      });
      if (old === null) throw new NotFoundError("that token no longer exists");
      if (old.revokedAt !== null) {
        throw new ConflictError("that token is already revoked — issue a new one instead of rotating it");
      }

      const revokedAt = new Date();
      const flipped = await tx.clientApiToken.updateMany({
        where: { id: old.id, revokedAt: null },
        data: { revokedAt, revokedById: viewer.id },
      });
      if (flipped.count !== 1) throw new ConflictError("that token was revoked while you were rotating it");

      const { row, plaintext } = await insertToken(
        tx,
        {
          name: old.name,
          scopes: [...old.scopes],
          requesterEmail: old.requesterEmail,
          // An expiry is a property of the GRANT, not of the secret, so it is carried across. A
          // rotation that silently extended it would be how a 90-day credential quietly becomes
          // permanent.
          expiresAt: old.expiresAt,
          note: old.note,
          createdById: viewer.id,
        },
        minted,
      );

      await writeAuditMany(tx, actor, ctx, [
        {
          action: "API_TOKEN_ROTATED",
          entityType: "API_TOKEN",
          entityId: old.id,
          ticketId: null,
          fieldChanged: "revokedAt",
          oldValue: null,
          newValue: revokedAt.toISOString(),
          metadata: { prefix: old.prefix, reason, replacedByPrefix: row.prefix, replacedById: row.id },
        },
        createdEntry(row, { rotatedFromPrefix: old.prefix, rotatedFromId: old.id }),
      ]);

      const secret: ApiTokenSecret = { token: row, plaintext };
      return secret;
    });
  });
}
