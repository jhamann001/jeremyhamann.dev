/**
 * `src/lib/api-tokens.ts` — the pure half.
 *
 * `verifyApiToken` needs a database and is proved in `api-tokens.integration.test.ts` against the
 * real schema and its CHECK constraints. What is proved here is everything a credential's SHAPE
 * promises, because those promises are what the database constraints and the verifier both rely on:
 * the minted prefix satisfies the DB CHECK, the digest is of the WHOLE plaintext, the secret half is
 * long enough to be unguessable, and no mapper ever carries the hash into a DTO.
 *
 * `@/lib/db` is mocked to an empty object: importing the module must not open a Prisma client, and a
 * unit test that silently connected to a database would be a unit test only until CI ran it.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import type { ApiTokenDTO } from "@/types/domain";
import {
  API_TOKEN_PREFIX_NAMESPACE,
  API_TOKEN_PREFIX_PATTERN,
  API_TOKEN_SELECT,
  LAST_USED_REFRESH_MS,
  apiTokenActor,
  apiTokenRateLimitKey,
  bearerFromHeaders,
  isTokenLive,
  legacyRateLimitKey,
  mintApiToken,
  sha256Hex,
  toApiTokenDTO,
} from "@/lib/api-tokens";

/** The DB CHECK from `20260920000200_wave_b_constraints`, restated so a drift fails here first. */
const DB_PREFIX_CHECK = /^wmhd_[0-9a-z]{8}$/;
const DB_HASH_CHECK = /^[0-9a-f]{64}$/;

describe("mintApiToken", () => {
  it("mints a prefix the database's CHECK constraint accepts", () => {
    for (let i = 0; i < 200; i++) {
      const { prefix } = mintApiToken();
      expect(prefix, prefix).toMatch(DB_PREFIX_CHECK);
      expect(prefix).toMatch(API_TOKEN_PREFIX_PATTERN);
      expect(prefix.startsWith(API_TOKEN_PREFIX_NAMESPACE)).toBe(true);
    }
  });

  it("stores the sha256 of the WHOLE plaintext, in the hex shape the CHECK constraint accepts", () => {
    const { plaintext, tokenHash } = mintApiToken();
    expect(tokenHash).toMatch(DB_HASH_CHECK);
    expect(tokenHash).toBe(createHash("sha256").update(plaintext, "utf8").digest("hex"));
    expect(sha256Hex(plaintext)).toBe(tokenHash);
  });

  it("the plaintext is the prefix, a dot, and a 256-bit secret", () => {
    const { plaintext, prefix } = mintApiToken();
    expect(plaintext.startsWith(`${prefix}.`)).toBe(true);
    const secret = plaintext.slice(prefix.length + 1);
    // 32 bytes as base64url is 43 characters with no padding.
    expect(secret).toHaveLength(43);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never repeats a plaintext or a prefix across a large sample", () => {
    const prefixes = new Set<string>();
    const plaintexts = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const m = mintApiToken();
      prefixes.add(m.prefix);
      plaintexts.add(m.plaintext);
    }
    expect(plaintexts.size).toBe(500);
    // Eight base-36 characters: a collision in 500 draws would mean the generator is not random.
    expect(prefixes.size).toBe(500);
  });

  it("the plaintext never contains the hash, and the hash never contains the plaintext", () => {
    const { plaintext, tokenHash } = mintApiToken();
    expect(plaintext).not.toContain(tokenHash);
    expect(tokenHash).not.toContain(plaintext);
  });
});

describe("bearerFromHeaders", () => {
  const h = (value: string | null): Headers =>
    value === null ? new Headers() : new Headers({ authorization: value });

  it("reads a well-formed bearer, case-insensitively on the scheme", () => {
    expect(bearerFromHeaders(h("Bearer abc123"))).toBe("abc123");
    expect(bearerFromHeaders(h("bearer abc123"))).toBe("abc123");
    expect(bearerFromHeaders(h("  Bearer   abc123  "))).toBe("abc123");
  });

  it("is null for a missing, empty or non-bearer header", () => {
    expect(bearerFromHeaders(h(null))).toBeNull();
    expect(bearerFromHeaders(h(""))).toBeNull();
    expect(bearerFromHeaders(h("Basic abc123"))).toBeNull();
    expect(bearerFromHeaders(h("Bearer"))).toBeNull();
    expect(bearerFromHeaders(h("Bearer a b"))).toBeNull();
  });
});

describe("API_TOKEN_SELECT", () => {
  it("does not select tokenHash — the column no DTO, route or log may carry", () => {
    expect(Object.keys(API_TOKEN_SELECT)).not.toContain("tokenHash");
    expect(JSON.stringify(API_TOKEN_SELECT)).not.toContain("tokenHash");
  });
});

describe("toApiTokenDTO", () => {
  const row = {
    id: "tok_1",
    name: "n8n — email intake",
    prefix: "wmhd_ab12cd34",
    scopes: ["INTEGRATION_INGEST"] as const,
    requesterEmail: null,
    createdBy: { id: "u_1", name: "Mia Ops", email: "mia@wm.local", image: null },
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    revokedAt: null,
    lastUsedAt: null,
    note: "Workspace variable WMHD_INGEST_TOKEN.",
  };

  it("maps field by field, with ISO dates and no extra keys", () => {
    const dto = toApiTokenDTO({ ...row, scopes: [...row.scopes] });
    expect(dto).toEqual({
      id: "tok_1",
      name: "n8n — email intake",
      prefix: "wmhd_ab12cd34",
      scopes: ["INTEGRATION_INGEST"],
      requesterEmail: null,
      createdBy: { id: "u_1", name: "Mia Ops", email: "mia@wm.local", image: null },
      createdAt: "2026-09-01T10:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
      revokedAt: null,
      lastUsedAt: null,
      note: "Workspace variable WMHD_INGEST_TOKEN.",
    });
  });

  it("an extra column on the row does not ride along into the DTO", () => {
    const dto = toApiTokenDTO({ ...row, scopes: [...row.scopes], tokenHash: "f".repeat(64) } as never);
    expect(JSON.stringify(dto)).not.toContain("f".repeat(64));
    expect("tokenHash" in dto).toBe(false);
  });

  it("copies the scopes array rather than aliasing the row's", () => {
    const scopes = [...row.scopes];
    const dto = toApiTokenDTO({ ...row, scopes });
    dto.scopes.push("MCP");
    expect(scopes).toEqual(["INTEGRATION_INGEST"]);
  });
});

describe("isTokenLive", () => {
  const now = new Date("2026-09-20T12:00:00.000Z");
  const base: Pick<ApiTokenDTO, "revokedAt" | "expiresAt"> = { revokedAt: null, expiresAt: null };

  it("a revoked token is never live, whatever its expiry says", () => {
    expect(isTokenLive({ revokedAt: "2026-09-19T00:00:00.000Z", expiresAt: null }, now)).toBe(false);
    expect(isTokenLive({ revokedAt: "2026-09-19T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" }, now)).toBe(false);
  });

  it("no expiry means live; a future expiry is live; a past one is not", () => {
    expect(isTokenLive(base, now)).toBe(true);
    expect(isTokenLive({ ...base, expiresAt: "2026-09-21T00:00:00.000Z" }, now)).toBe(true);
    expect(isTokenLive({ ...base, expiresAt: "2026-09-19T00:00:00.000Z" }, now)).toBe(false);
  });
});

describe("keys and actors carry ids, never secrets", () => {
  it("namespaces the two realms apart", () => {
    expect(apiTokenRateLimitKey("tok_1")).toBe("token:tok_1");
    expect(legacyRateLimitKey("ingest")).toBe("token:legacy:ingest");
    expect(apiTokenRateLimitKey("tok_1")).not.toBe(legacyRateLimitKey("tok_1"));
  });

  it("the audit actor has no user id and names the token, not the bearer", () => {
    expect(apiTokenActor("tok_1")).toEqual({ id: null, email: "token:tok_1", groups: [] });
    expect(apiTokenActor(null)).toEqual({ id: null, email: "token:legacy", groups: [] });
  });

  it("lastUsedAt is refreshed at most once a minute", () => {
    expect(LAST_USED_REFRESH_MS).toBe(60_000);
  });
});
