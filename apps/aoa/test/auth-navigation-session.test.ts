import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAuthConfig, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";

const captured = vi.hoisted(() => ({
  config: null as NextAuthConfig | null,
  devLogin: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("next-auth", () => ({
  default: (config: NextAuthConfig) => {
    captured.config = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("@/lib/auth/mode", () => ({ get DEV_LOGIN() { return captured.devLogin; } }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));

const identity = {
  id: "synthetic-user-1", email: "advisor@example.test", name: "Synthetic Advisor",
  image: null, role: "ADVISOR",
};
const expires = "2026-09-14T12:00:00.000Z";

type SessionInput = {
  session: {
    user?: Partial<typeof identity>;
    expires: string;
    sessionToken?: unknown;
    userId?: string;
    [key: string]: unknown;
  };
  user?: Partial<typeof identity>;
  token?: JWT;
  trigger?: "update";
  newSession?: unknown;
};

async function callbacks(devLogin: boolean) {
  captured.devLogin = devLogin;
  await import("@/auth");
  const configured = captured.config!.callbacks!;
  return {
    // Auth.js declares the two runtime strategies as an intersection. Exercise
    // their actual separate payloads plus malformed credential inputs here.
    session: configured.session as unknown as (input: SessionInput) => Promise<Session>,
    jwt: configured.jwt as (input: {
      token: JWT;
      user?: Partial<typeof identity>;
      trigger?: "signIn" | "signUp" | "update";
      session?: unknown;
    }) => Promise<JWT>,
  };
}

beforeEach(() => {
  vi.resetModules();
  captured.config = null;
});

describe("database-session navigation partition", () => {
  it("is stable across fresh requests and renewal, but changes for a new same-user login", async () => {
    const { session } = await callbacks(false);
    const input = {
      user: identity,
      session: { user: { ...identity }, expires, sessionToken: "synthetic-session-token-one" },
    };
    const initial = await session(input);
    const refreshed = await session({ ...input, session: { ...input.session } });
    const renewed = await session({
      ...input, session: { ...input.session, expires: "2026-09-14T16:00:00.000Z" },
      trigger: "update",
      newSession: { navigationScope: "untrusted-client-scope" },
    });
    const newLogin = await session({
      ...input, session: { ...input.session, sessionToken: "synthetic-session-token-two" },
    });
    expect(initial.navigationScope).toMatch(/^[a-f0-9]{64}$/);
    expect(refreshed.navigationScope).toBe(initial.navigationScope);
    expect(renewed.navigationScope).toBe(initial.navigationScope);
    expect(newLogin.navigationScope).not.toBe(initial.navigationScope);
    expect(renewed.expires).toBe("2026-09-14T16:00:00.000Z");
  });

  it("returns only public session fields, never an adapter token or private extra field", async () => {
    const { session } = await callbacks(false);
    const output = await session({
      user: identity,
      session: {
        user: { ...identity }, expires, userId: identity.id,
        sessionToken: "synthetic-adapter-bearer-token", privateAdapterField: "not-public",
      },
    });
    expect(Object.keys(output).sort()).toEqual(["expires", "navigationScope", "user"]);
    expect(output.user).toEqual(identity);
    expect(JSON.stringify(output)).not.toContain("synthetic-adapter-bearer-token");
    expect(JSON.stringify(output)).not.toContain("not-public");
  });

  it("uses current authenticated ID, exact email and normalized role", async () => {
    const { session } = await callbacks(false);
    const make = (user: typeof identity) => session({
      user, session: { user: { ...user }, expires, sessionToken: "synthetic-session-token" },
    });
    const initial = await make(identity);
    for (const changed of [
      { ...identity, id: "synthetic-user-2" },
      { ...identity, email: "Advisor@example.test" },
      { ...identity, role: "VIEWER" },
    ]) expect((await make(changed)).navigationScope).not.toBe(initial.navigationScope);
    expect((await make({ ...identity, role: "HEAD_OF_ADVISORY" })).navigationScope)
      .toBe((await make({ ...identity, role: "OPERATIONS" })).navigationScope);
  });

  it.each([undefined, null, "", " ", 1, {}])("fails closed for a missing or malformed adapter credential: %s", async (key) => {
    const { session } = await callbacks(false);
    const output = await session({
      user: identity, session: { user: { ...identity }, expires, sessionToken: key },
    });
    expect(output.navigationScope).toBeNull();
    expect(output.user).toEqual(identity);
  });
});

describe("dev JWT-session navigation partition", () => {
  it("mints a nonce at sign-in and retains it through reads and renewal", async () => {
    const { jwt, session } = await callbacks(true);
    const initial = await jwt({ token: { sub: identity.id }, user: identity, trigger: "signIn" });
    expect(initial.navigationSessionNonce).toMatch(/^[a-f0-9]{64}$/);
    const refreshed = await jwt({ token: { ...initial, iat: 1, exp: 2, jti: "renewed-jwt-id" } });
    const renewed = await jwt({
      token: { ...refreshed }, trigger: "update",
      session: { navigationSessionNonce: "0".repeat(64), navigationScope: "forged-client-scope" },
    });
    expect(refreshed.navigationSessionNonce).toBe(initial.navigationSessionNonce);
    expect(renewed.navigationSessionNonce).toBe(initial.navigationSessionNonce);
    const first = await session({ session: { user: { ...identity }, expires }, token: initial });
    const afterRenew = await session({
      session: { user: { ...identity }, expires: "2026-09-14T16:00:00.000Z" }, token: renewed,
    });
    expect(first.navigationScope).toMatch(/^[a-f0-9]{64}$/);
    expect(afterRenew.navigationScope).toBe(first.navigationScope);
    expect(Object.keys(afterRenew).sort()).toEqual(["expires", "navigationScope", "user"]);
    expect(JSON.stringify(afterRenew)).not.toContain(String(initial.navigationSessionNonce));
  });

  it("rotates on each same-user sign-in, even when handed a previous token", async () => {
    const { jwt, session } = await callbacks(true);
    const first = await jwt({ token: { sub: identity.id }, user: identity, trigger: "signIn" });
    const second = await jwt({ token: { ...first }, user: identity, trigger: "signIn" });
    expect(second.navigationSessionNonce).not.toBe(first.navigationSessionNonce);
    const input = { session: { user: { ...identity }, expires } };
    expect((await session({ ...input, token: second })).navigationScope)
      .not.toBe((await session({ ...input, token: first })).navigationScope);
  });

  it("uses the authenticated token subject even though the default session user omits ID", async () => {
    const { jwt, session } = await callbacks(true);
    const token = await jwt({ token: { sub: identity.id }, user: identity, trigger: "signIn" });
    const input = { session: { user: { email: identity.email }, expires } };
    const first = await session({ ...input, token });
    const changed = await session({ ...input, token: { ...token, sub: "synthetic-user-2" } });
    expect(first.navigationScope).not.toBe(changed.navigationScope);
  });

  it("exposes the authenticated user id from the token subject in JWT sessions", async () => {
    const { jwt, session } = await callbacks(true);
    const token = await jwt({ token: { sub: identity.id }, user: identity, trigger: "signIn" });
    const output = await session({ session: { user: { email: identity.email, name: identity.name }, expires }, token });
    expect(output.user?.id).toBe(identity.id);
    const anonymous = await session({ session: { user: { email: identity.email }, expires }, token: {} });
    expect(anonymous.user?.id).toBeUndefined();
  });

  it.each([undefined, null, "", "too-short", "0".repeat(65), 5, {}])(
    "does not invent a persistent identity for a legacy or malformed JWT nonce: %s", async (nonce) => {
      const { jwt, session } = await callbacks(true);
      const token = { sub: identity.id, role: identity.role, navigationSessionNonce: nonce };
      const refreshed = await jwt({ token: { ...token } });
      expect(refreshed.navigationSessionNonce).toBe(nonce);
      const output = await session({ session: { user: { ...identity }, expires }, token: refreshed });
      expect(output.navigationScope).toBeNull();
    },
  );

  it("does not mint a nonce without an authenticated sign-in user", async () => {
    const { jwt } = await callbacks(true);
    expect((await jwt({ token: {}, trigger: "signIn" })).navigationSessionNonce).toBeUndefined();
  });
});
