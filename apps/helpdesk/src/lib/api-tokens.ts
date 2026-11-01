/**
 * Per-consumer machine credentials — node only, layer L2
 *.
 *
 * Wave A gave every machine surface ONE shared bearer in an environment variable. That credential is
 * readable by anyone who can open an n8n workflow, it cannot be revoked without a deploy, it says
 * nothing about who is calling, and rotating it breaks every consumer at once. `ClientApiToken` is
 * the replacement: one row per consumer, with its own scopes, its own expiry, its own revocation and
 * its own `lastUsedAt`, so "who is still using this?" is a query rather than an argument.
 *
 * Four properties, each load-bearing:
 *
 *  1. **The plaintext exists once.** `mintApiToken` returns it; `createApiToken` hands it to the
 *     operator's screen once; nothing else ever holds it. The row stores `sha256` hex (DB CHECK
 *     `^[0-9a-f]{64}$`) and a display prefix. No DTO, no audit row, no log line carries it — §3 rule 2.
 *  2. **The lookup is by PREFIX and the comparison is CONSTANT-TIME over digests.** The prefix is
 *     public by design, so the indexed lookup is on a non-secret, and the secret half is then compared
 *     with `safeEqualStrings` from `@/lib/safe-equal` — the SAME function `isClientApiAuthorized` and
 *     `isIntegrationApiAuthorized` call, deliberately, so the three bearers cannot drift apart. A
 *     missing, malformed, unknown, expired, revoked or wrongly-scoped token is the SAME answer,
 *     `null`: the caller learns nothing about which it was.
 *  3. **Revocation is a column, never a delete.** `ClientApiToken` carries a no-hard-delete trigger
 *     because `API_TOKEN_CREATED` / `_REVOKED` / `_ROTATED` rows point at an id, and a
 *     row that vanished would leave the ledger unreadable.
 *  4. **`lastUsedAt` is written at most once a minute.** It is operational metadata, not evidence —
 *     the ledger is what records a call — so it must not turn every read into a write. The
 *     throttle is expressed as a conditional `updateMany` against the stored value rather than an
 *     in-memory timer, so it holds across instances and its failure can never deny a valid caller.
 *
 * Legacy env bearers keep working: `authorizeMachineRequest` in `src/lib/integration-auth.ts` tries
 * the database token first and falls back to `INTEGRATION_API_TOKEN` (and its per-scope narrowings),
 * and `/api/client/**` does the same with `CLIENT_API_TOKEN`. Nothing that works today stops working.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { ApiTokenDTO, ApiTokenScope, UserRef } from "@/types/domain";
import { prisma } from "@/lib/db";
import { logError } from "@/lib/logger";
import { safeEqualStrings } from "@/lib/safe-equal";

/** Every minted prefix starts with this, so a leaked string is identifiable at a glance. */
export const API_TOKEN_PREFIX_NAMESPACE = "wmhd_" as const;

/** The DB CHECK `api_token_prefix_shape`, mirrored here so `mintApiToken` cannot mint an invalid row. */
export const API_TOKEN_PREFIX_PATTERN = /^wmhd_[0-9a-z]{8}$/;

/** `<prefix>.<secret>`; the separator a bearer is split on. Not in the prefix or the base64url alphabet. */
const PLAINTEXT_SEPARATOR = ".";

/** Alphabet for the eight random prefix characters. Matches the DB CHECK's `[0-9a-z]`. */
const PREFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const PREFIX_RANDOM_CHARS = 8;

/** 32 bytes of CSPRNG output, base64url — 256 bits, which is not guessable and not worth padding. */
const SECRET_BYTES = 32;

/** A well-formed bearer: `wmhd_xxxxxxxx.<43 base64url chars>`. Bounded so a huge header is cheap to refuse. */
const PLAINTEXT_PATTERN = /^wmhd_[0-9a-z]{8}\.[A-Za-z0-9_-]{16,128}$/;

/** `lastUsedAt` is refreshed no more often than this. Operational metadata, not evidence. */
export const LAST_USED_REFRESH_MS = 60_000;

/** What a verified bearer tells the caller. Deliberately NOT the row: no hash, no name, no note. */
export type VerifiedToken = {
  id: string;
  scopes: ApiTokenScope[];
  /**
   * When set, a `CLIENT_READ` / `CLIENT_WRITE` token may act only for this requester address — a
   * per-client credential rather than a per-consumer one. Null is the ordinary case: the consumer
   * names the requester in `X-Requester-Email` and the ticket's own requester is still the check.
   */
  requesterEmail: string | null;
};

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * `Authorization: Bearer <token>`, trimmed. Null when the header is absent or not a bearer.
 * Deliberately the same regular expression the two Wave A bearer checks use.
 */
export function bearerFromHeaders(h: Headers): string | null {
  const header = h.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match === null ? null : match[1];
}

/**
 * A fresh credential. The plaintext is returned to exactly one caller, once; the row keeps the prefix
 * and the digest.
 *
 * `randomInt` rather than `randomBytes(n) % 36`: the modulo is biased (256 is not a multiple of 36),
 * and while eight biased characters of a public prefix would harm nothing, a biased generator in a
 * credential module is the kind of thing that gets copied into one that matters.
 */
export function mintApiToken(): { plaintext: string; prefix: string; tokenHash: string } {
  let suffix = "";
  for (let i = 0; i < PREFIX_RANDOM_CHARS; i++) suffix += PREFIX_ALPHABET[randomInt(0, PREFIX_ALPHABET.length)];
  const prefix = `${API_TOKEN_PREFIX_NAMESPACE}${suffix}`;
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const plaintext = `${prefix}${PLAINTEXT_SEPARATOR}${secret}`;
  return { plaintext, prefix, tokenHash: sha256Hex(plaintext) };
}

/** Splits a bearer into its public prefix and the whole string that was hashed. Null when malformed. */
function parsePlaintext(raw: string): { prefix: string } | null {
  if (!PLAINTEXT_PATTERN.test(raw)) return null;
  const prefix = raw.slice(0, raw.indexOf(PLAINTEXT_SEPARATOR));
  return API_TOKEN_PREFIX_PATTERN.test(prefix) ? { prefix } : null;
}

/**
 * Refreshes `lastUsedAt`, at most once per `LAST_USED_REFRESH_MS`, and never at the cost of the
 * request.
 *
 * The condition is evaluated by Postgres, not by this process: two instances serving the same token
 * both issue the statement and at most one matches, and an instance that has just started does not
 * write a row simply because its own memory is empty. A failure here is swallowed — this column is
 * "is anyone still using this credential?", and the answer to a failed metadata write is not to
 * refuse a correctly authenticated call.
 */
async function touchLastUsed(tokenId: string, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - LAST_USED_REFRESH_MS);
  try {
    await prisma.clientApiToken.updateMany({
      where: { id: tokenId, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }] },
      data: { lastUsedAt: now },
    });
  } catch (e) {
    logError("api-tokens", e, { op: "last_used_refresh", tokenId });
  }
}

/**
 * Verifies the `Authorization` header against `ClientApiToken` and checks the required scope.
 *
 * `null` for every failure — no header, a malformed one, an unknown prefix, a digest that does not
 * match, an expired row, a revoked row, or a row without `required`. One answer for all of them is
 * the point: a caller probing the surface cannot tell a real-but-unscoped credential from a typo,
 * and the route above writes exactly one denial shape.
 *
 * `now` is injectable so expiry is testable without touching the clock.
 */
export async function verifyApiToken(
  header: Headers,
  required: ApiTokenScope,
  now: Date = new Date(),
): Promise<VerifiedToken | null> {
  const raw = bearerFromHeaders(header);
  if (raw === null) return null;
  const parsed = parsePlaintext(raw);
  if (parsed === null) return null;

  const row = await prisma.clientApiToken.findUnique({
    where: { prefix: parsed.prefix },
    select: { id: true, tokenHash: true, scopes: true, requesterEmail: true, expiresAt: true, revokedAt: true },
  });
  if (row === null) return null;

  // Constant-time, through the ONE construction the repository has — `@/lib/safe-equal`, which
  // SHA-256s both sides and then `timingSafeEqual`s the two fixed-width digests. This module used to
  // carry its own `Buffer.from(hash,"hex")` + length-guard + `timingSafeEqual`, which is a THIRD copy
  // of a construction the build record exists to keep singular; the length guard it needed
  // is what `safeEqualStrings` does by hashing first. The compared values are already digests, so the
  // extra hash costs one block and reveals nothing.
  if (!safeEqualStrings(row.tokenHash, sha256Hex(raw))) return null;

  if (row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return null;
  if (!row.scopes.includes(required)) return null;

  await touchLastUsed(row.id, now);
  return { id: row.id, scopes: [...row.scopes], requesterEmail: row.requesterEmail };
}

/**
 * The rate-limit key for a database credential. The TOKEN ID, never the bearer: a key lives in
 * memory and reaches log lines, and a secret belongs in neither.
 */
export function apiTokenRateLimitKey(tokenId: string): string {
  return `token:${tokenId}`;
}

/**
 * The rate-limit key for a caller still on a legacy env bearer. Keyed by SURFACE rather than by
 * credential, because the env bearer is shared: every consumer of it is one bucket, which is a
 * blunter limit than a per-consumer one and is exactly the argument for moving off it.
 */
export function legacyRateLimitKey(surface: string): string {
  return `token:legacy:${surface}`;
}

type ApiTokenRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiTokenScope[];
  requesterEmail: string | null;
  createdBy: { id: string; name: string | null; email: string; image: string | null };
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  note: string | null;
};

/** The columns every token read selects. `tokenHash` is deliberately absent — nothing may echo it. */
export const API_TOKEN_SELECT = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  requesterEmail: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
  note: true,
  createdBy: { select: { id: true, name: true, email: true, image: true } },
} as const;

/** Pure mapper. Field by field, so a widened select can never carry a new column into the DTO. */
export function toApiTokenDTO(row: ApiTokenRow): ApiTokenDTO {
  const createdBy: UserRef = {
    id: row.createdBy.id,
    name: row.createdBy.name,
    email: row.createdBy.email,
    image: row.createdBy.image,
  };
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: [...row.scopes],
    requesterEmail: row.requesterEmail,
    createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.toISOString(),
    note: row.note,
  };
}

/** Live = not revoked and not past its expiry. The one definition, shared by the UI and the verifier. */
export function isTokenLive(token: Pick<ApiTokenDTO, "revokedAt" | "expiresAt">, now: Date = new Date()): boolean {
  if (token.revokedAt !== null) return false;
  if (token.expiresAt === null) return true;
  return new Date(token.expiresAt).getTime() > now.getTime();
}

/**
 * The audit actor for a database credential that has not yet been resolved to a person — a rate-limit
 * refusal, a scope denial. `actorId` is null (no FK to invent) and the email is a literal marker in
 * the same `<realm>:<who>` shape `clientApiActor` and `ANONYMOUS_INTEGRATION_ACTOR` use. It carries
 * the token ID, never the prefix's secret half and never the bearer.
 */
export function apiTokenActor(tokenId: string | null): { id: null; email: string; groups: never[] } {
  return { id: null, email: tokenId === null ? "token:legacy" : `token:${tokenId}`, groups: [] };
}
