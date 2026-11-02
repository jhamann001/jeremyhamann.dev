import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAuthConfig } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { SESSION_ABSOLUTE_MAX_MS, authConfig, groupsFromSignIn, isGoogleConfigured, isOktaConfigured } from "@/auth.config";
import { DEFAULT_GOOGLE_DOMAINS } from "@/lib/google-domain";
import { DEFAULT_OKTA_SCOPE } from "@/lib/okta-groups";
import { safeRelativePath } from "@/lib/rbac";

type Callbacks = NonNullable<NextAuthConfig["callbacks"]>;
type JwtCallback = NonNullable<Callbacks["jwt"]>;
type JwtParams = Parameters<JwtCallback>[0];
type SessionCallback = NonNullable<Callbacks["session"]>;
type AuthorizedCallback = NonNullable<Callbacks["authorized"]>;

const T0 = new Date("2026-09-16T12:00:00.000Z").getTime();
const HOUR = 3600 * 1000;

function jwtCb(): JwtCallback {
  const cb = authConfig.callbacks?.jwt;
  if (!cb) throw new Error("jwt callback missing");
  return cb;
}
function sessionCb(): SessionCallback {
  const cb = authConfig.callbacks?.session;
  if (!cb) throw new Error("session callback missing");
  return cb;
}
function authorizedCb(): AuthorizedCallback {
  const cb = authConfig.callbacks?.authorized;
  if (!cb) throw new Error("authorized callback missing");
  return cb;
}

/** Auth.js passes a subset token at sign-in; the augmented JWT fields are not present yet. */
function freshToken(): JWT {
  return { name: "Olivia Ops", email: "ops@example.com", sub: "user_1" } as unknown as JWT;
}

function signInParams(overrides: Partial<JwtParams> = {}): JwtParams {
  return {
    token: freshToken(),
    user: { id: "user_1", email: "ops@example.com", name: "Olivia Ops" },
    account: { provider: "okta", providerAccountId: "00u123", type: "oidc" },
    profile: { sub: "00u123", groups: ["ops_team", "not_a_group", "compliance_officers"] },
    trigger: "signIn",
    ...overrides,
  };
}

/** Re-issue params: Auth.js supplies no user/account/profile. The type marks `user` required; runtime does not. */
function reissueParams(token: JWT): JwtParams {
  return { token } as unknown as JwtParams;
}

function fakeRequest(path: string): NextRequest {
  return { nextUrl: new URL(path, "http://localhost:3000") } as unknown as NextRequest;
}

function sessionFor(groups: Session["user"]["groups"]): Session {
  return {
    expires: new Date(T0 + HOUR).toISOString(),
    user: { id: "user_1", email: "x@example.com", groups, oktaId: null, isDev: false },
  };
}

describe("authConfig static shape", () => {
  it("uses a jwt session bounded at 8 h with the sign-in/error pages on /sign-in", () => {
    expect(authConfig.session).toEqual({ strategy: "jwt", maxAge: 8 * 3600, updateAge: 3600 });
    expect(authConfig.pages).toEqual({ signIn: "/sign-in", error: "/sign-in" });
    expect(authConfig.trustHost).toBe(true);
    expect(SESSION_ABSOLUTE_MAX_MS).toBe(8 * 3600 * 1000);
    expect(DEFAULT_OKTA_SCOPE).toBe("openid profile email groups");
  });

  it("registers the Okta provider iff AUTH_OKTA_ISSUER/ID/SECRET are all set; never the dev-persona provider (Decision #44)", () => {
    const ids = authConfig.providers.map((p) => (typeof p === "function" ? p().id : p.id));
    // authConfig is built at import time from the real process.env of this test run.
    const expected = [...(isOktaConfigured() ? ["okta"] : []), ...(isGoogleConfigured() ? ["google"] : [])];
    expect(ids).toEqual(expected);
    expect(ids).not.toContain("dev-persona");
  });

  it("isOktaConfigured requires all three Okta settings", () => {
    vi.stubEnv("AUTH_OKTA_ISSUER", "https://example.okta.com/oauth2/default");
    vi.stubEnv("AUTH_OKTA_ID", "client-id");
    vi.stubEnv("AUTH_OKTA_SECRET", "client-secret");
    expect(isOktaConfigured()).toBe(true);
    vi.stubEnv("AUTH_OKTA_SECRET", "");
    expect(isOktaConfigured()).toBe(false);
    vi.stubEnv("AUTH_OKTA_SECRET", "client-secret");
    vi.stubEnv("AUTH_OKTA_ISSUER", "");
    expect(isOktaConfigured()).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("Decision #44 — provider registration follows AUTH_OKTA_* at module load (both branches, fresh module instances)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function providerIds(env: Record<string, string>): Promise<string[]> {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const mod = await import("@/auth.config");
    return mod.authConfig.providers.map((p) => (typeof p === "function" ? p().id : p.id));
  }

  const complete = {
    AUTH_OKTA_ISSUER: "https://example.okta.com/oauth2/default",
    AUTH_OKTA_ID: "client-id",
    AUTH_OKTA_SECRET: "client-secret",
  };

  it("all three set → exactly the okta provider", async () => {
    expect(await providerIds(complete)).toEqual(["okta"]);
  });

  it("any one missing → no provider at all (Auth.js would otherwise assert the empty Okta endpoints on every call and break the dev-persona flow too)", async () => {
    for (const missing of Object.keys(complete)) {
      expect(await providerIds({ ...complete, [missing]: "" }), `${missing} empty`).toEqual([]);
    }
    expect(await providerIds({ AUTH_OKTA_ISSUER: "", AUTH_OKTA_ID: "", AUTH_OKTA_SECRET: "" })).toEqual([]);
  });
});

describe("Decision #58 — configurable Okta scope and groups claim (fresh module instances)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const complete = {
    AUTH_OKTA_ISSUER: "https://example.okta.com/oauth2/default",
    AUTH_OKTA_ID: "client-id",
    AUTH_OKTA_SECRET: "client-secret",
  };

  /** The Okta provider factory returns `{ id, options }`; `options.authorization.params.scope` is what Auth.js sends. */
  async function requestedScope(env: Record<string, string>): Promise<string | undefined> {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const mod = await import("@/auth.config");
    const p = mod.authConfig.providers[0];
    const provider = (typeof p === "function" ? p() : p) as { options?: { authorization?: { params?: { scope?: string } } } };
    return provider.options?.authorization?.params?.scope;
  }

  it("requests the default scope when AUTH_OKTA_SCOPE is unset", async () => {
    expect(await requestedScope({ ...complete, AUTH_OKTA_SCOPE: "" })).toBe("openid profile email groups");
  });

  it("requests AUTH_OKTA_SCOPE when set (OPS_PORTAL's shared app: openid email profile ops_portal_groups)", async () => {
    expect(await requestedScope({ ...complete, AUTH_OKTA_SCOPE: "openid email profile ops_portal_groups" })).toBe(
      "openid email profile ops_portal_groups",
    );
  });

  it("a scope override without openid is ignored in favour of the default (parseEnv refuses it at boot anyway)", async () => {
    expect(await requestedScope({ ...complete, AUTH_OKTA_SCOPE: "email profile ops_portal_groups" })).toBe(
      "openid profile email groups",
    );
  });

  it("jwt: profile.OpsPortalGroups=[\"OPSPORTAL-Operations\"] under AUTH_OKTA_GROUPS_CLAIM=OpsPortalGroups → groups [ops_team]", async () => {
    vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", "OpsPortalGroups");
    const out = await jwtCb()(signInParams({ profile: { sub: "00u123", OpsPortalGroups: ["OPSPORTAL-Operations"] } }));
    expect((out as JWT).groups).toEqual(["ops_team"]);
  });

  it("jwt: The advisor platform names on the shared app map onto the internal groups and unknown names drop", async () => {
    vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", "OpsPortalGroups");
    const out = await jwtCb()(
      signInParams({
        profile: { sub: "00u123", OpsPortalGroups: ["OPSPORTAL-Advisor", "OPSPORTAL-Advisory Ops Lead", "OPSPORTAL-Viewer", "Everyone"] },
      }),
    );
    expect((out as JWT).groups).toEqual(["ops_team", "advisors"]);
  });

  it("jwt: with the claim configured but absent from the token, the `groups` fallback is read (OPS_PORTAL's order)", async () => {
    vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", "OpsPortalGroups");
    const out = await jwtCb()(signInParams({ profile: { sub: "00u123", groups: ["client_services"] } }));
    expect((out as JWT).groups).toEqual(["client_services"]);
  });

  it("jwt: without the env, the profile.groups path is unchanged and a non-default claim is ignored", async () => {
    vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", "");
    const out = await jwtCb()(
      signInParams({ profile: { sub: "00u123", groups: ["ops_team"], OpsPortalGroups: ["OPSPORTAL-Admin"] } }),
    );
    expect((out as JWT).groups).toEqual(["ops_team"]);
  });

  it("jwt: a configured claim that is absent AND no groups claim → [] (never the adapter snapshot, Decision #51)", async () => {
    vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", "OpsPortalGroups");
    const out = await jwtCb()(
      signInParams({
        user: { id: "user_1", email: "ops@example.com", name: "Olivia Ops", groups: ["ops_team"] },
        profile: { sub: "00u123" },
      }),
    );
    expect((out as JWT).groups).toEqual([]);
  });

  it("groupsFromSignIn: a claim pointed at a scalar (email / name / preferred_username) yields [] — never roles minted from a mailbox (Decision #59)", () => {
    // parseEnv refuses these claim names at boot; this pins the defensive path should the env module ever be bypassed.
    for (const [claim, profile] of [
      ["email", { sub: "00u1", email: "admin@example.com" }],
      ["email", { sub: "00u1", email: "cs.team@example.com" }],
      ["name", { sub: "00u1", name: "Ops Desk" }],
      ["preferred_username", { sub: "00u1", preferred_username: "compliance@example.com" }],
    ] as const) {
      vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", claim);
      expect(groupsFromSignIn("okta", undefined, profile), claim).toEqual([]);
    }
    // A legitimately configured claim whose VALUE is a bare the advisor platform name (not an array) is likewise not mapped.
    vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", "OpsPortalGroups");
    expect(groupsFromSignIn("okta", undefined, { sub: "00u1", OpsPortalGroups: "OPSPORTAL-Admin" })).toEqual([]);
    expect(groupsFromSignIn("okta", undefined, { sub: "00u1", OpsPortalGroups: "ops_team" })).toEqual(["ops_team"]);
  });

  it("groupsFromSignIn: qualified admin, read-only and foreign-app names on the shared app grant only what §b allows (Decision #59)", () => {
    vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", "OpsPortalGroups");
    expect(groupsFromSignIn("okta", undefined, { OpsPortalGroups: ["OPSPORTAL-Client Service Admin"] })).toEqual(["client_services"]);
    expect(groupsFromSignIn("okta", undefined, { OpsPortalGroups: ["OPSPORTAL-Ops Read Only"] })).toEqual([]);
    expect(groupsFromSignIn("okta", undefined, { OpsPortalGroups: ["IT-Admin", "Slack-Admin", "WMHD-Ops"] })).toEqual([]);
    expect(groupsFromSignIn("okta", undefined, { OpsPortalGroups: ["IT-Admin", "OPSPORTAL-Advisor"] })).toEqual(["advisors"]);
  });

  it("groupsFromSignIn is the single source for jwt and events.signIn: okta → mapped claim, dev-persona → user.groups only", () => {
    vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", "OpsPortalGroups");
    expect(groupsFromSignIn("okta", { groups: ["ops_team"] }, { OpsPortalGroups: ["OPSPORTAL-Client Service"] })).toEqual([
      "client_services",
    ]);
    expect(groupsFromSignIn("okta", { groups: ["ops_team"] }, { sub: "x" })).toEqual([]);
    expect(groupsFromSignIn("okta", undefined, undefined)).toEqual([]);
    // Dev personas never go through the advisor platform map: an OPS-PORTAL-style name in user.groups is not an internal value → dropped.
    expect(groupsFromSignIn("dev-persona", { groups: ["client_services", "OPSPORTAL-Admin"] }, { OpsPortalGroups: ["OPSPORTAL-Admin"] })).toEqual([
      "client_services",
    ]);
    expect(groupsFromSignIn(undefined, { groups: ["ops_team"] }, { groups: ["advisors"] })).toEqual(["advisors"]);
  });
});

describe("callbacks.jwt — absolute 8 h lifetime (§b.8)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("on sign-in stamps uid, oktaId, parsed groups, dev=false and groupsSyncedAt = now", async () => {
    const out = await jwtCb()(signInParams());
    expect(out).not.toBeNull();
    const token = out as JWT;
    expect(token.uid).toBe("user_1");
    expect(token.oktaId).toBe("00u123");
    expect(token.groups).toEqual(["ops_team", "compliance_officers"]); // unknown dropped, OKTA_GROUPS order
    expect(token.dev).toBe(false);
    expect(token.groupsSyncedAt).toBe(T0);
  });

  it("on dev-persona sign-in reads groups from user.groups, sets dev=true and oktaId=null", async () => {
    const out = await jwtCb()(
      signInParams({
        user: { id: "dev_cs", email: "cs.dev@wm-helpdesk.local", name: "Casey Service", groups: ["client_services"] },
        account: { provider: "dev-persona", providerAccountId: "dev_cs", type: "credentials" },
        profile: undefined,
      }),
    );
    const token = out as JWT;
    expect(token.uid).toBe("dev_cs");
    expect(token.dev).toBe(true);
    expect(token.oktaId).toBeNull();
    expect(token.groups).toEqual(["client_services"]);
  });

  it("a profile with zero recognized groups yields an empty groups array (no access, §b.3)", async () => {
    const out = await jwtCb()(signInParams({ profile: { sub: "00u123", groups: ["everyone"] } }));
    expect((out as JWT).groups).toEqual([]);
  });

  it("an okta sign-in whose id_token carries no groups claim yields [] — never the adapter's User.groups snapshot (Decision #51)", async () => {
    // The adapter passes the full Prisma User row (with its last-known groups) as `user`. A missing `groups`
    // claim must NOT fall back to that snapshot, or a user Okta removed from every group keeps stale access.
    const out = await jwtCb()(
      signInParams({
        user: { id: "user_1", email: "ops@example.com", name: "Olivia Ops", groups: ["ops_team", "compliance_officers"] },
        profile: { sub: "00u123" }, // OIDC profile without a groups claim
      }),
    );
    expect((out as JWT).groups).toEqual([]);
  });

  it("an okta sign-in that emits an empty groups claim also yields [] (normal demotion path)", async () => {
    const out = await jwtCb()(
      signInParams({
        user: { id: "user_1", email: "ops@example.com", name: "Olivia Ops", groups: ["ops_team"] },
        profile: { sub: "00u123", groups: [] },
      }),
    );
    expect((out as JWT).groups).toEqual([]);
  });

  /**
   * Wave B put a 30-minute IDLE bound under the absolute one, so a token can no longer
   * be jumped forward seven hours in one step and still be valid — that IS the idle case now. These
   * two tests therefore keep the session ALIVE the way a working day does, with activity inside the
   * idle window, and assert that the absolute bound still fires anyway. That is a stronger statement
   * than the one they replaced: it proves `updateAge` re-issues cannot extend the 8 hours, which
   * is the property the bound exists for.
   */
  const tick = async (token: JWT, at: number): Promise<JWT | null> => {
    vi.setSystemTime(at);
    return (await jwtCb()(reissueParams(token))) as JWT | null;
  };

  /** Walks a token forward to `until` in 20-minute steps — never idle, so only the absolute bound bites. */
  const active = async (from: JWT, until: number): Promise<JWT | null> => {
    let token: JWT | null = from;
    for (let at = T0 + 20 * 60 * 1000; at < until && token !== null; at += 20 * 60 * 1000) {
      token = await tick(token, at);
    }
    return token === null ? null : await tick(token, until);
  };

  it("re-issue at +7 h 59 m keeps the session, with groupsSyncedAt unmoved", async () => {
    const signed = (await jwtCb()(signInParams())) as JWT;
    const out = await active(signed, T0 + 7 * HOUR + 59 * 60 * 1000);
    expect(out).not.toBeNull();
    // The sign-in instant never moves: that is what makes the 8 hours absolute rather than sliding.
    expect((out as JWT).groupsSyncedAt).toBe(T0);
    expect((out as JWT).groups).toEqual(signed.groups);
    expect((out as JWT).uid).toBe(signed.uid);
  });

  it("re-issue at exactly +8 h still keeps the session (the bound is strict >)", async () => {
    const signed = (await jwtCb()(signInParams())) as JWT;
    const out = await active(signed, T0 + SESSION_ABSOLUTE_MAX_MS);
    expect(out).not.toBeNull();
    expect((out as JWT).groupsSyncedAt).toBe(T0);
  });

  it("re-issue at +8 h 1 ms returns null even with continuous activity (Decision #105 does not weaken §b.8)", async () => {
    const signed = (await jwtCb()(signInParams())) as JWT;
    expect(await active(signed, T0 + SESSION_ABSOLUTE_MAX_MS + 1)).toBeNull();
  });

  it("idle beyond 30 minutes returns null, even well inside the 8 hours (Decision #105)", async () => {
    const signed = (await jwtCb()(signInParams())) as JWT;
    // One jump, no activity in between: an unattended machine, not a working session.
    expect(await tick(signed, T0 + 31 * 60 * 1000)).toBeNull();
  });

  it("activity inside the idle window keeps the session alive indefinitely, up to the absolute bound", async () => {
    const signed = (await jwtCb()(signInParams())) as JWT;
    const out = await active(signed, T0 + 3 * HOUR);
    expect(out).not.toBeNull();
    expect(await tick(out as JWT, T0 + 3 * HOUR + 29 * 60 * 1000)).not.toBeNull();
  });

  it("re-issue at +8 h 1 ms returns null (forces re-authentication)", async () => {
    const signed = (await jwtCb()(signInParams())) as JWT;
    vi.setSystemTime(T0 + SESSION_ABSOLUTE_MAX_MS + 1);
    expect(await jwtCb()(reissueParams(signed))).toBeNull();
  });

  it("a token with no groupsSyncedAt returns null", async () => {
    const legacy = { uid: "user_1", groups: ["ops_team"], sub: "user_1" } as unknown as JWT;
    expect(await jwtCb()(reissueParams(legacy))).toBeNull();
    const bad = { uid: "user_1", groups: [], groupsSyncedAt: "yesterday" } as unknown as JWT;
    expect(await jwtCb()(reissueParams(bad))).toBeNull();
  });
});

describe("callbacks.session", () => {
  it("copies uid/groups/oktaId/isDev from the token into session.user", async () => {
    const token = {
      uid: "user_1",
      groups: ["advisors"],
      oktaId: "00u9",
      dev: false,
      groupsSyncedAt: T0,
    } as unknown as JWT;
    const session = sessionFor([]);
    const out = (await sessionCb()({ session, token } as unknown as Parameters<SessionCallback>[0])) as Session;
    expect(out.user.id).toBe("user_1");
    expect(out.user.groups).toEqual(["advisors"]);
    expect(out.user.oktaId).toBe("00u9");
    expect(out.user.isDev).toBe(false);
  });

  it("defaults groups to [] and oktaId to null when the token lacks them", async () => {
    const token = { uid: "u", dev: true } as unknown as JWT;
    const out = (await sessionCb()({
      session: sessionFor(["ops_team"]),
      token,
    } as unknown as Parameters<SessionCallback>[0])) as Session;
    expect(out.user.groups).toEqual([]);
    expect(out.user.oktaId).toBeNull();
    expect(out.user.isDev).toBe(true);
  });
});

describe("callbacks.authorized — coarse gate (§b.7)", () => {
  it("unauthenticated page → 307 to /sign-in with the path as callbackUrl", async () => {
    const res = (await authorizedCb()({ auth: null, request: fakeRequest("/dashboard") })) as Response;
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("Location")!);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("callbackUrl")).toBe("/dashboard");
  });

  it("behind a proxy, callbackUrl is the path and query, never the app's own address", async () => {
    const request = { nextUrl: new URL("https://0.0.0.0:3000/tickets/hd-2465?tab=activity") } as unknown as NextRequest;
    const res = (await authorizedCb()({ auth: null, request })) as Response;
    const callbackUrl = new URL(res.headers.get("Location")!).searchParams.get("callbackUrl");
    expect(callbackUrl).toBe("/tickets/hd-2465?tab=activity");
    expect(safeRelativePath(callbackUrl, "/dashboard")).toBe("/tickets/hd-2465?tab=activity");
  });

  it("unauthenticated API → 401 JSON", async () => {
    const res = (await authorizedCb()({ auth: null, request: fakeRequest("/api/queues/summary") })) as Response;
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("allowed path → true", async () => {
    expect(await authorizedCb()({ auth: sessionFor(["ops_team"]), request: fakeRequest("/dashboard") })).toBe(true);
    expect(
      await authorizedCb()({ auth: sessionFor(["compliance_officers"]), request: fakeRequest("/compliance/audit") }),
    ).toBe(true);
  });

  it("forbidden page → redirect to /no-access?from=<path>, with the QUERY STRING dropped", async () => {
    // Integration round 1: `from` used to carry `pathname + search`.
    // `/no-access` writes it into `AuditLog.newValue`, which is append-only and no-hard-delete, and a
    // forbidden URL can carry `?requesterEmail=<a client's address>` — which `sanitizePII` does not
    // redact, because an address is a first-class ticket field. The attempted PATH is the evidence;
    // its query string is not, and it can never be taken back out of that row.
    const res = (await authorizedCb()({
      auth: sessionFor(["client_services"]),
      request: fakeRequest("/queues/advice?status=NEW"),
    })) as Response;
    expect(res).toBeInstanceOf(Response);
    expect([302, 307, 308]).toContain(res.status);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.pathname).toBe("/no-access");
    expect(loc.searchParams.get("from")).toBe("/queues/advice");
  });

  it("drops a query string carrying a client's address, so it cannot reach the ledger", async () => {
    const res = (await authorizedCb()({
      auth: sessionFor(["client_services"]),
      request: fakeRequest("/queues/advice?requesterEmail=someone%40example.com&page=2"),
    })) as Response;
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("example.com");
    expect(location).not.toContain("requesterEmail");
    expect(new URL(location).searchParams.get("from")).toBe("/queues/advice");
  });

  it("forbidden API → 403 JSON", async () => {
    const res = (await authorizedCb()({
      auth: sessionFor(["ops_team"]),
      request: fakeRequest("/api/compliance/audit/export"),
    })) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("zero groups → redirected to /no-access even for /dashboard (§b.3)", async () => {
    const res = (await authorizedCb()({ auth: sessionFor([]), request: fakeRequest("/dashboard") })) as Response;
    expect(res).toBeInstanceOf(Response);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe("/no-access");
  });
});

/**
 * The temporary Google provider. Registration follows the SAME rule as Okta (#44) — an unconfigured provider
 * is not in the list at all, because Auth.js asserts every registered provider's endpoints on every call —
 * with one addition: the resolved domain allowlist must be non-empty. That second condition is unreachable
 * as `allowedGoogleDomains()` stands, and the matrix below states it anyway, because the failure it prevents
 * is a public sign-in page on a books-and-records system.
 */
describe("temporary Google provider — registration matrix (fresh module instances)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const OKTA = {
    AUTH_OKTA_ISSUER: "https://example.okta.com/oauth2/default",
    AUTH_OKTA_ID: "client-id",
    AUTH_OKTA_SECRET: "client-secret",
  };
  const NO_OKTA = { AUTH_OKTA_ISSUER: "", AUTH_OKTA_ID: "", AUTH_OKTA_SECRET: "" };
  const GOOGLE = { AUTH_GOOGLE_ID: "google-client-id", AUTH_GOOGLE_SECRET: "google-client-secret" };
  const NO_GOOGLE = { AUTH_GOOGLE_ID: "", AUTH_GOOGLE_SECRET: "" };

  async function providerIds(env: Record<string, string>): Promise<string[]> {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const mod = await import("@/auth.config");
    return mod.authConfig.providers.map((p) => (typeof p === "function" ? p().id : p.id));
  }

  it("neither configured → no provider at all", async () => {
    expect(await providerIds({ ...NO_OKTA, ...NO_GOOGLE })).toEqual([]);
  });

  it("Google only → exactly the google provider (the deployed dev service before Okta exists)", async () => {
    expect(await providerIds({ ...NO_OKTA, ...GOOGLE })).toEqual(["google"]);
  });

  it("Okta only → exactly the okta provider, unchanged", async () => {
    expect(await providerIds({ ...OKTA, ...NO_GOOGLE })).toEqual(["okta"]);
  });

  it("both → okta first, google second (the sign-in page's primary/secondary order)", async () => {
    expect(await providerIds({ ...OKTA, ...GOOGLE })).toEqual(["okta", "google"]);
  });

  it("half a Google pair registers nothing — the id and the secret are needed together", async () => {
    expect(await providerIds({ ...NO_OKTA, AUTH_GOOGLE_ID: "google-client-id", AUTH_GOOGLE_SECRET: "" })).toEqual([]);
    expect(await providerIds({ ...NO_OKTA, AUTH_GOOGLE_ID: "", AUTH_GOOGLE_SECRET: "google-client-secret" })).toEqual(
      [],
    );
  });

  it("isGoogleConfigured needs both credentials, and reports the allowlist it will enforce", async () => {
    vi.stubEnv("AUTH_GOOGLE_ID", "google-client-id");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "google-client-secret");
    expect(isGoogleConfigured()).toBe(true);
    // An unset / blank allowlist is the DEFAULT, not "no restriction", so the provider stays registered.
    vi.stubEnv("AUTH_GOOGLE_ALLOWED_DOMAINS", "");
    expect(isGoogleConfigured()).toBe(true);
    expect([...DEFAULT_GOOGLE_DOMAINS]).toEqual(["example.com", "example.net"]);
    vi.stubEnv("AUTH_GOOGLE_SECRET", "");
    expect(isGoogleConfigured()).toBe(false);
  });

  it("the google provider's profile() returns STANDARD FIELDS ONLY — the adapter spreads it into user.create", async () => {
    vi.resetModules();
    for (const [k, v] of Object.entries({ ...NO_OKTA, ...GOOGLE })) vi.stubEnv(k, v);
    const mod = await import("@/auth.config");
    const p = mod.authConfig.providers[0];
    const provider = (typeof p === "function" ? p() : p) as {
      options?: { profile?: (p: Record<string, unknown>) => Record<string, unknown> };
      profile?: (p: Record<string, unknown>) => Record<string, unknown>;
    };
    const profile = provider.options?.profile ?? provider.profile;
    if (!profile) throw new Error("the google provider has no profile()");
    const mapped = profile({
      sub: "1234567890",
      name: "Test Owner",
      email: "jeremy@example.com",
      email_verified: true,
      picture: "https://lh3.googleusercontent.com/a/photo",
      hd: "example.com",
    });
    expect(Object.keys(mapped).sort()).toEqual(["email", "id", "image", "name"]);
    expect(mapped).toEqual({
      id: "1234567890",
      name: "Test Owner",
      email: "jeremy@example.com",
      image: null,
    });
  });
});

describe("groupsFromSignIn — provider \"google\" reads AUTH_GOOGLE_GROUPS and nothing else", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("unset AUTH_GOOGLE_GROUPS → [] → the user authenticates and lands on /no-access (I12)", () => {
    vi.stubEnv("AUTH_GOOGLE_GROUPS", "");
    expect(groupsFromSignIn("google", undefined, { email: "jeremy@example.com" })).toEqual([]);
  });

  it("returns the configured groups, dropping unknown names", () => {
    vi.stubEnv("AUTH_GOOGLE_GROUPS", "client_services,not_a_group,ops_team");
    expect(groupsFromSignIn("google", undefined, undefined)).toEqual(["ops_team", "client_services"]);
  });

  it("ignores the adapter's User.groups snapshot and any claim on the profile (Decision #51)", () => {
    vi.stubEnv("AUTH_GOOGLE_GROUPS", "advisors");
    expect(
      groupsFromSignIn(
        "google",
        { groups: ["ops_team", "compliance_officers"] },
        { groups: ["ops_team"], OpsPortalGroups: ["OPSPORTAL-Admin"], email: "jeremy@example.com" },
      ),
    ).toEqual(["advisors"]);
  });

  it("leaves the dev-persona and Okta paths exactly as they were", () => {
    vi.stubEnv("AUTH_GOOGLE_GROUPS", "ops_team,advisors,client_services,compliance_officers");
    // Dev persona: still the persona's own list.
    expect(groupsFromSignIn("dev-persona", { groups: ["client_services"] }, { groups: ["ops_team"] })).toEqual([
      "client_services",
    ]);
    // Okta: still the mapped claim.
    expect(groupsFromSignIn("okta", { groups: ["ops_team"] }, { groups: ["advisors"] })).toEqual(["advisors"]);
    expect(groupsFromSignIn("okta", { groups: ["ops_team"] }, { sub: "00u1" })).toEqual([]);
    // An unknown provider is still treated as the OIDC path, not as Google.
    expect(groupsFromSignIn(undefined, { groups: ["ops_team"] }, { groups: ["advisors"] })).toEqual(["advisors"]);
  });
});
