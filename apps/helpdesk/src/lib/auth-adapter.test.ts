/**
 * The adapter wrapper that never persists Okta's tokens.
 *
 * The claim is narrow and worth pinning exactly: `linkAccount` must not write `access_token`,
 * `refresh_token` or `id_token`, and must change NOTHING else — not the other columns, not the other
 * adapter methods, not an adapter that has no `linkAccount` at all.
 */
import { describe, expect, it, vi } from "vitest";
import type { Adapter, AdapterAccount } from "next-auth/adapters";
import { NEVER_PERSISTED_ACCOUNT_FIELDS, stripOidcTokens, withoutOidcTokens } from "@/lib/auth-adapter";

const ACCOUNT = {
  userId: "user_1",
  type: "oidc",
  provider: "okta",
  providerAccountId: "00u123",
  access_token: "ACCESS-SECRET",
  refresh_token: "REFRESH-SECRET",
  id_token: "ID-SECRET",
  expires_at: 1_790_000_000,
  token_type: "Bearer",
  scope: "openid email profile groups",
  session_state: "abc",
} as unknown as AdapterAccount;

describe("NEVER_PERSISTED_ACCOUNT_FIELDS", () => {
  it("names the three credential columns and nothing else", () => {
    expect([...NEVER_PERSISTED_ACCOUNT_FIELDS]).toEqual(["access_token", "refresh_token", "id_token"]);
  });
});

describe("stripOidcTokens", () => {
  it("nulls the three credentials and keeps every other field byte for byte", () => {
    const out = stripOidcTokens(ACCOUNT) as Record<string, unknown>;
    expect(out.access_token).toBeNull();
    expect(out.refresh_token).toBeNull();
    expect(out.id_token).toBeNull();
    expect(out.userId).toBe("user_1");
    expect(out.provider).toBe("okta");
    expect(out.providerAccountId).toBe("00u123");
    // Link METADATA is kept: it carries no credential and is what an operator reads when an Okta
    // assignment looks wrong.
    expect(out.expires_at).toBe(1_790_000_000);
    expect(out.token_type).toBe("Bearer");
    expect(out.scope).toBe("openid email profile groups");
    expect(out.session_state).toBe("abc");
  });

  it("does not mutate its input, and no secret survives serialization", () => {
    const copy = { ...(ACCOUNT as unknown as Record<string, unknown>) };
    const out = stripOidcTokens(ACCOUNT);
    expect(ACCOUNT).toEqual(copy);
    const json = JSON.stringify(out);
    for (const secret of ["ACCESS-SECRET", "REFRESH-SECRET", "ID-SECRET"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("adds nothing when a field is simply absent", () => {
    const minimal = { userId: "u", type: "oidc", provider: "okta", providerAccountId: "1" } as unknown as AdapterAccount;
    expect(Object.keys(stripOidcTokens(minimal)).sort()).toEqual(
      ["provider", "providerAccountId", "type", "userId"].sort(),
    );
  });
});

describe("withoutOidcTokens", () => {
  it("filters linkAccount and passes every other method through untouched", async () => {
    const linkAccount = vi.fn(async () => undefined);
    const createUser = vi.fn(async () => ({ id: "u" }) as never);
    const base = { linkAccount, createUser, getUser: vi.fn() } as unknown as Adapter;

    const wrapped = withoutOidcTokens(base);
    await wrapped.linkAccount?.(ACCOUNT);

    const passed = (linkAccount.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(passed.access_token).toBeNull();
    expect(passed.refresh_token).toBeNull();
    expect(passed.id_token).toBeNull();
    expect(passed.providerAccountId).toBe("00u123");

    expect(wrapped.createUser).toBe(base.createUser);
    expect(wrapped.getUser).toBe(base.getUser);
  });

  it("returns the adapter unchanged when it has no linkAccount", () => {
    const base = { createUser: vi.fn() } as unknown as Adapter;
    expect(withoutOidcTokens(base)).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Slice B6 review against CONTRACT §6. The module was handed over LIVE by the
// foundation; this block extends the cover and weakens nothing above.
// ---------------------------------------------------------------------------

describe("withoutOidcTokens — B6 review against CONTRACT §6", () => {
  it("wrapping twice is harmless — the second wrap strips an already-stripped payload", async () => {
    // An adapter composed by two call sites (or re-wrapped after a refactor) must not double-null or
    // throw. Idempotence is what makes the wrapper safe to apply defensively.
    const linkAccount = vi.fn(async () => undefined);
    const base = { linkAccount } as unknown as Adapter;
    const twice = withoutOidcTokens(withoutOidcTokens(base));
    await twice.linkAccount?.(ACCOUNT);
    const passed = (linkAccount.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(passed.access_token).toBeNull();
    expect(passed.refresh_token).toBeNull();
    expect(passed.id_token).toBeNull();
    expect(passed.providerAccountId).toBe("00u123");
  });

  it("the three credential columns are NULLED, not deleted — the adapter's column contract is unchanged", () => {
    // Deleting the keys would make Prisma leave whatever was there before on an upsert path, and
    // would change the shape `@auth/prisma-adapter` declares. Present-and-null is the honest state:
    // "we have a link, we hold no credential."
    const out = stripOidcTokens(ACCOUNT) as Record<string, unknown>;
    for (const field of NEVER_PERSISTED_ACCOUNT_FIELDS) {
      expect(field in out, field).toBe(true);
      expect(out[field], field).toBeNull();
    }
  });

  it("strips a payload whose credentials are already null or undefined without inventing values", () => {
    const partial = {
      userId: "u",
      type: "oidc",
      provider: "okta",
      providerAccountId: "1",
      access_token: undefined,
      refresh_token: null,
    } as unknown as AdapterAccount;
    const out = stripOidcTokens(partial) as Record<string, unknown>;
    expect(out.access_token).toBeNull();
    expect(out.refresh_token).toBeNull();
    // `id_token` was absent and stays absent: the wrapper removes credentials, it does not add columns.
    expect("id_token" in out).toBe(false);
  });

  it("is not fooled by a look-alike field name", () => {
    // Only the three columns the adapter writes are stripped. An `accessToken` (camelCase) or a
    // `provider_access_token` is not one of them, and silently nulling an unrelated column would be a
    // different bug wearing this one's clothes.
    const odd = {
      userId: "u",
      type: "oidc",
      provider: "okta",
      providerAccountId: "1",
      accessToken: "CAMEL-CASE",
      provider_access_token: "PREFIXED",
    } as unknown as AdapterAccount;
    const out = stripOidcTokens(odd) as Record<string, unknown>;
    expect(out.accessToken).toBe("CAMEL-CASE");
    expect(out.provider_access_token).toBe("PREFIXED");
  });

  it("every other adapter method keeps its identity, so the wrapper cannot change the contract", () => {
    const base = {
      linkAccount: vi.fn(async () => undefined),
      createUser: vi.fn(),
      getUser: vi.fn(),
      getUserByEmail: vi.fn(),
      getUserByAccount: vi.fn(),
      updateUser: vi.fn(),
      unlinkAccount: vi.fn(),
      createSession: vi.fn(),
      getSessionAndUser: vi.fn(),
      updateSession: vi.fn(),
      deleteSession: vi.fn(),
    } as unknown as Adapter;
    const wrapped = withoutOidcTokens(base) as unknown as Record<string, unknown>;
    const source = base as unknown as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (key === "linkAccount") {
        expect(wrapped[key], key).not.toBe(source[key]);
        continue;
      }
      expect(wrapped[key], key).toBe(source[key]);
    }
  });

  it("propagates the adapter's own failure rather than swallowing it", async () => {
    // A link that fails must fail the sign-in. A wrapper that caught here would create an account
    // row with no Okta link behind it.
    const boom = new Error("adapter exploded");
    const base = { linkAccount: vi.fn(async () => { throw boom; }) } as unknown as Adapter;
    await expect(withoutOidcTokens(base).linkAccount?.(ACCOUNT)).rejects.toBe(boom);
  });
});
