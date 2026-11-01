/**
 * `src/auth.ts` — the dev-persona provider and the Decision #72 sign-in refusal.
 *
 * `@/auth` cannot be imported in this runtime as it stands (`next-auth` reaches for `next/server`), and the
 * two functions under test are closures inside the `NextAuth(...)` argument. So `next-auth` is mocked with a
 * recorder: the REAL module is loaded, and the real `authorize` / `callbacks.signIn` / `events.signIn` are
 * pulled out of the configuration object it passes. `@auth/prisma-adapter` is stubbed (it is never called
 * here) and `@/lib/db` is an in-memory `User` table that applies exactly the fields a write names — so a
 * field a write omits keeps its stored value, which is the whole point of the regression below.
 *
 * Proves:
 *  - a deactivated persona is NOT reactivated by clicking its button on /sign-in, and cannot sign in;
 *  - the upsert's `update` branch never carries `isActive` (only `create` may set it);
 *  - the kill switch is re-checked per call, and the refusal reads stored state for every identity kind;
 *  - the temporary Google domain gate REFUSES an out-of-domain or unverified identity outright, and the
 *    Decision #72 deactivation check still runs for a Google sign-in like any other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEV_PERSONAS, DEV_PROVIDER_ID } from "@/lib/dev-login";

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  groups: string[];
  isActive: boolean;
  emailVerified?: Date | null;
};

type WriteRecord = { op: "upsert.create" | "upsert.update" | "update"; id: string; data: Record<string, unknown> };

const store = vi.hoisted(() => ({
  rows: new Map<string, UserRow>(),
  writes: [] as WriteRecord[],
}));

const captured = vi.hoisted(() => ({ config: null as Record<string, unknown> | null }));

vi.mock("next-auth", () => ({
  default: (config: Record<string, unknown>) => {
    captured.config = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));

vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));

// `recordSignInDenied` and `recordCoalescedDenial` are stubbed because `src/lib/denial-throttle.ts` —
// which `src/auth.ts` now uses to record a REFUSED sign-in — imports them from here; its own pure core
// (the two coalescing bounds) runs for real. `ipAddress` is the literal "unknown" because that is what the
// real `systemRequestContext` returns (RequestContext.ipAddress is a string, never null); the previous
// `null` here was a fixture that could not occur.
vi.mock("@/lib/audit", () => ({
  writeAudit: vi.fn(async () => undefined),
  recordCoalescedDenial: vi.fn(async () => undefined),
  recordSignInDenied: vi.fn(async () => undefined),
  systemRequestContext: (label: string) => ({
    ipAddress: "unknown",
    userAgent: `system/${label}`,
    requestId: "test",
    isPrefetch: false,
  }),
}));

// The real module, with only `logWarn` stubbed: `src/lib/denial-throttle.ts` logs every refusal the
// coalescing window suppresses, and this suite deliberately drives dozens of refusals. Everything else in
// the logger is left real so nothing else in the graph changes shape.
vi.mock("@/lib/logger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/logger")>("@/lib/logger");
  return { ...actual, logWarn: vi.fn() };
});

vi.mock("@/lib/request-context", () => ({
  getRequestContext: vi.fn(async () => ({
    ipAddress: "203.0.113.9",
    userAgent: "auth-test",
    requestId: "auth-test",
    isPrefetch: false,
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      // BY ID or BY EMAIL. The Google gate looks a person up by their verified address, because on a
      // first-ever OAuth sign-in Auth.js hands `callbacks.signIn` a `user` whose id is a fresh random
      // UUID — an id lookup there can only ever miss.
      findUnique: async (args: { where: { id?: string; email?: string } }) => {
        const { id, email } = args.where;
        const row =
          id !== undefined
            ? store.rows.get(id)
            : [...store.rows.values()].find((candidate) => candidate.email === email);
        return row ? { isActive: row.isActive } : null;
      },
      upsert: async (args: { where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const id = args.where.id;
        const existing = store.rows.get(id);
        if (existing) {
          store.writes.push({ op: "upsert.update", id, data: args.update });
          // Apply ONLY the named fields: a column the write omits keeps its stored value, as Postgres does.
          Object.assign(existing, args.update);
          return { ...existing };
        }
        store.writes.push({ op: "upsert.create", id, data: args.create });
        const created: UserRow = {
          id,
          email: String(args.create.email ?? ""),
          name: typeof args.create.name === "string" ? args.create.name : null,
          groups: Array.isArray(args.create.groups) ? [...(args.create.groups as string[])] : [],
          isActive: args.create.isActive === true,
        };
        store.rows.set(id, created);
        return { ...created };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const id = args.where.id;
        const existing = store.rows.get(id);
        if (!existing) throw new Error(`no such user ${id}`);
        store.writes.push({ op: "update", id, data: args.data });
        for (const [k, v] of Object.entries(args.data)) {
          if (v !== undefined) Object.assign(existing, { [k]: v });
        }
        return { ...existing };
      },
    },
  },
}));

type AuthorizeFn = (
  credentials: Record<string, unknown> | undefined,
) => Promise<{ id: string; email: string; name: string | null; groups: string[] } | null>;

type ProviderLike = { id?: string; authorize?: AuthorizeFn; options?: { id?: string; authorize?: AuthorizeFn } };

/** `callbacks.signIn` now reads `account` and `profile` too (the Google domain gate); both stay optional. */
type SignInParams = {
  user: { id?: string };
  account?: { provider: string; providerAccountId?: string } | null;
  profile?: Record<string, unknown>;
};

type CapturedConfig = {
  providers: ProviderLike[];
  callbacks: { signIn: (params: SignInParams) => Promise<boolean> };
  events: {
    signIn: (params: {
      user: { id?: string; email?: string | null; name?: string | null; groups?: unknown };
      account?: { provider: string; providerAccountId: string } | null;
      profile?: unknown;
    }) => Promise<void>;
  };
};

const OPS = DEV_PERSONAS.find((p) => p.key === "ops");
const ADVISOR = DEV_PERSONAS.find((p) => p.key === "advisor");
if (!OPS || !ADVISOR) throw new Error("dev personas 'ops' and 'advisor' are expected by this test");

/** Re-imports the REAL `src/auth.ts` under the current env and returns the configuration it built. */
async function loadAuth(): Promise<CapturedConfig> {
  captured.config = null;
  vi.resetModules();
  await import("@/auth");
  if (!captured.config) throw new Error("NextAuth() was not called by @/auth");
  return captured.config as unknown as CapturedConfig;
}

function devProvider(cfg: CapturedConfig): ProviderLike | undefined {
  return cfg.providers.find((p) => (p.options?.id ?? p.id) === DEV_PROVIDER_ID);
}

/** The persona provider's own `authorize` (Auth.js keeps the caller's config under `options`). */
function devAuthorize(cfg: CapturedConfig): AuthorizeFn {
  const provider = devProvider(cfg);
  const fn = provider?.options?.authorize ?? provider?.authorize;
  if (!fn) throw new Error("the dev-persona provider has no authorize()");
  return fn;
}

function seed(row: UserRow): void {
  store.rows.set(row.id, { ...row });
}

beforeEach(() => {
  store.rows.clear();
  store.writes.length = 0;
  vi.stubEnv("AUTH_DEV_LOGIN", "true");
  vi.stubEnv("APP_ENV", "local");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dev-persona authorize() × Decision #72 — a deactivated account stays deactivated", () => {
  it("does not reactivate a deactivated persona, writes nothing, and the sign-in is refused", async () => {
    // Exactly the reported sequence: Operations deactivates Aaron Advisor (audited USER_DEACTIVATED,
    // assignments cleared), then someone clicks that persona on /sign-in.
    seed({ id: ADVISOR.id, email: ADVISOR.email, name: ADVISOR.name, groups: [...ADVISOR.groups], isActive: false });
    const cfg = await loadAuth();

    const user = await devAuthorize(cfg)({ persona: ADVISOR.key });

    // The row is untouched — no write at all, so nothing contradicts the audited deactivation.
    expect(store.rows.get(ADVISOR.id)?.isActive).toBe(false);
    expect(store.writes).toEqual([]);
    // …and the sign-in itself is refused, which is what /sign-in?error=AccessDenied reports.
    expect(user).not.toBeNull();
    await expect(cfg.callbacks.signIn({ user: { id: ADVISOR.id } })).resolves.toBe(false);
  });

  it("refuses every deactivated persona, not just one", async () => {
    for (const p of DEV_PERSONAS) {
      seed({ id: p.id, email: p.email, name: p.name, groups: [...p.groups], isActive: false });
    }
    const cfg = await loadAuth();
    const authorize = devAuthorize(cfg);

    for (const p of DEV_PERSONAS) {
      await authorize({ persona: p.key });
      expect(store.rows.get(p.id)?.isActive, p.key).toBe(false);
      await expect(cfg.callbacks.signIn({ user: { id: p.id } }), p.key).resolves.toBe(false);
    }
    expect(store.writes).toEqual([]);
  });

  it("the upsert's update branch never names isActive (only create may set it)", async () => {
    seed({ id: OPS.id, email: OPS.email, name: "Stale Name", groups: [], isActive: true });
    const cfg = await loadAuth();

    await devAuthorize(cfg)({ persona: OPS.key });

    const update = store.writes.find((w) => w.op === "upsert.update");
    expect(update).toBeDefined();
    expect(Object.keys(update?.data ?? {}).sort()).toEqual(["groups", "name"]);
    expect(update?.data).not.toHaveProperty("isActive");
    // The fields it DOES refresh still land, so a renamed persona constant reaches the row.
    expect(store.rows.get(OPS.id)?.name).toBe(OPS.name);
    expect(store.rows.get(OPS.id)?.groups).toEqual([...OPS.groups]);
  });

  it("an active persona signs in, and a first-ever persona row is created active", async () => {
    seed({ id: OPS.id, email: OPS.email, name: OPS.name, groups: [...OPS.groups], isActive: true });
    const cfg = await loadAuth();
    const authorize = devAuthorize(cfg);

    const existing = await authorize({ persona: OPS.key });
    expect(existing).toMatchObject({ id: OPS.id, email: OPS.email, groups: [...OPS.groups] });
    await expect(cfg.callbacks.signIn({ user: { id: OPS.id } })).resolves.toBe(true);

    // Nothing seeded for the advisor: the create branch runs and the row is active.
    const created = await authorize({ persona: ADVISOR.key });
    expect(created?.id).toBe(ADVISOR.id);
    expect(store.rows.get(ADVISOR.id)?.isActive).toBe(true);
    expect(store.writes.some((w) => w.op === "upsert.create" && w.id === ADVISOR.id)).toBe(true);
    await expect(cfg.callbacks.signIn({ user: { id: ADVISOR.id } })).resolves.toBe(true);
  });

  it("re-checks the kill switch per call and rejects an unknown persona key, before any read or write", async () => {
    seed({ id: OPS.id, email: OPS.email, name: OPS.name, groups: [...OPS.groups], isActive: true });
    const cfg = await loadAuth();
    const authorize = devAuthorize(cfg);

    await expect(authorize({ persona: "not-a-persona" })).resolves.toBeNull();
    await expect(authorize(undefined)).resolves.toBeNull();

    vi.stubEnv("AUTH_DEV_LOGIN", "false");
    await expect(authorize({ persona: OPS.key })).resolves.toBeNull();
    vi.stubEnv("AUTH_DEV_LOGIN", "true");
    vi.stubEnv("APP_ENV", "production");
    await expect(authorize({ persona: OPS.key })).resolves.toBeNull();

    expect(store.writes).toEqual([]);
  });

  it("is not registered at all when the kill switch is off", async () => {
    vi.stubEnv("AUTH_DEV_LOGIN", "false");
    const cfg = await loadAuth();
    expect(devProvider(cfg)).toBeUndefined();
  });
});

describe("callbacks.signIn — the refusal reads stored state for every identity kind", () => {
  it("allows a sign-in with no id and an id with no row yet (getViewer() is the backstop)", async () => {
    const cfg = await loadAuth();
    await expect(cfg.callbacks.signIn({ user: {} })).resolves.toBe(true);
    await expect(cfg.callbacks.signIn({ user: { id: "" } })).resolves.toBe(true);
    await expect(cfg.callbacks.signIn({ user: { id: "okta_user_never_seen" } })).resolves.toBe(true);
  });

  it("refuses a deactivated Okta user and allows an active one", async () => {
    seed({ id: "okta_left", email: "left@wm-helpdesk.local", name: "Left", groups: ["advisors"], isActive: false });
    seed({ id: "okta_here", email: "here@wm-helpdesk.local", name: "Here", groups: ["advisors"], isActive: true });
    const cfg = await loadAuth();

    await expect(cfg.callbacks.signIn({ user: { id: "okta_left" } })).resolves.toBe(false);
    await expect(cfg.callbacks.signIn({ user: { id: "okta_here" } })).resolves.toBe(true);
  });

  it("the signed-in event refreshes groups and name but never isActive", async () => {
    seed({ id: OPS.id, email: OPS.email, name: OPS.name, groups: [], isActive: true });
    const cfg = await loadAuth();

    await cfg.events.signIn({
      user: { id: OPS.id, email: OPS.email, name: OPS.name, groups: [...OPS.groups] },
      account: { provider: DEV_PROVIDER_ID, providerAccountId: OPS.id },
      profile: undefined,
    });

    const write = store.writes.find((w) => w.op === "update" && w.id === OPS.id);
    expect(write).toBeDefined();
    expect(write?.data).not.toHaveProperty("isActive");
    expect(store.rows.get(OPS.id)?.groups).toEqual([...OPS.groups]);
  });
});

/**
 * The temporary Google domain gate (src/lib/google-domain.ts), as `callbacks.signIn` enforces it.
 *
 * The shape under test is REFUSAL, not "a session with no groups". A session with zero groups is still a
 * session: an adapter row for an outsider, a USER_SIGNED_IN row that reads as legitimate access, and an
 * eight-hour token. `false` means none of that exists.
 *
 * Every profile here carries `hd`, because a Google profile from a Workspace account does: the gate is a
 * WORKSPACE check, not a mailbox check, and a fixture without `hd` is a consumer account (its own case
 * below). `hd` was added to these fixtures rather than dropped from the gate — see
 * `src/lib/google-domain.test.ts` for the consumer-account class it closes.
 */
describe("callbacks.signIn — the temporary Google domain gate", () => {
  const VERIFIED = { email: "jeremy@example.com", email_verified: true, hd: "example.com" };
  const google = { provider: "google", providerAccountId: "1234567890" };

  /** The profile a Workspace account on `email`'s own domain would present. */
  function profileFor(email: string, email_verified: unknown = true): Record<string, unknown> {
    return { email, email_verified, hd: email.split("@").at(-1) };
  }

  it("allows a verified address on each allowed domain (and the Decision #72 check still decides)", async () => {
    seed({ id: "g_ok", email: "jeremy@example.com", name: "J", groups: [], isActive: true });
    const cfg = await loadAuth();
    await expect(cfg.callbacks.signIn({ user: { id: "g_ok" }, account: google, profile: VERIFIED })).resolves.toBe(
      true,
    );
    await expect(
      cfg.callbacks.signIn({
        user: { id: "g_ok" },
        account: google,
        profile: { email: "jeremy@example.net", email_verified: true, hd: "example.net" },
      }),
    ).resolves.toBe(true);
    // A Workspace with a secondary domain can present the primary domain as `hd`; both are listed.
    await expect(
      cfg.callbacks.signIn({
        user: { id: "g_ok" },
        account: google,
        profile: { email: "jeremy@example.net", email_verified: true, hd: "example.com" },
      }),
    ).resolves.toBe(true);
  });

  it("refuses an out-of-domain address, including the look-alike prefix, suffix and subdomain forms", async () => {
    const cfg = await loadAuth();
    for (const email of [
      "attacker@gmail.com",
      "attacker@evil-example.com",
      "attacker@example.com.attacker.tld",
      "attacker@sub.example.com",
      "attacker@example.net.attacker.tld",
    ]) {
      await expect(
        cfg.callbacks.signIn({ user: { id: "never_seen" }, account: google, profile: profileFor(email) }),
        email,
      ).resolves.toBe(false);
    }
  });

  it("refuses a CONSUMER Google account holding a company address — no hd, however verified it is", async () => {
    const cfg = await loadAuth();
    // email_verified: true and an in-domain address, with no `hd`: a personal Google account created
    // against a company mailbox. It outlives the Workspace account it shadows, so this is the offboarded
    // -employee and contractor class, and it is the reason `hd` is required rather than advisory.
    await expect(
      cfg.callbacks.signIn({
        user: { id: "never_seen" },
        account: google,
        profile: { email: "left@example.com", email_verified: true },
      }),
    ).resolves.toBe(false);
    // An hd Google DOES send, on a domain nobody listed, is refused for the same reason.
    await expect(
      cfg.callbacks.signIn({
        user: { id: "never_seen" },
        account: google,
        profile: { email: "left@example.com", email_verified: true, hd: "gmail.com" },
      }),
    ).resolves.toBe(false);
  });

  it("refuses an unverified address on an allowed domain — including the STRING \"true\"", async () => {
    const cfg = await loadAuth();
    for (const email_verified of [false, "true", undefined, null]) {
      await expect(
        cfg.callbacks.signIn({
          user: { id: "never_seen" },
          account: google,
          profile: { email: "jeremy@example.com", email_verified, hd: "example.com" },
        }),
        JSON.stringify(email_verified) ?? "undefined",
      ).resolves.toBe(false);
    }
    // No profile at all is refused too: there is nothing to check the domain against.
    await expect(cfg.callbacks.signIn({ user: { id: "never_seen" }, account: google })).resolves.toBe(false);
  });

  it("still refuses a DEACTIVATED user whose Google address is in-domain and verified (Decision #72 holds)", async () => {
    seed({ id: "g_left", email: "left@example.com", name: "Left", groups: ["advisors"], isActive: false });
    const cfg = await loadAuth();
    await expect(
      cfg.callbacks.signIn({
        user: { id: "g_left" },
        account: google,
        profile: profileFor("left@example.com"),
      }),
    ).resolves.toBe(false);
    // …and writes nothing while refusing, so the audited deactivation is not contradicted.
    expect(store.writes).toEqual([]);
  });

  it("refuses a DEACTIVATED person on their FIRST Google sign-in, where the id lookup cannot see them", async () => {
    // The gap this closes: on a first OAuth sign-in there is no Account link, so Auth.js builds `user` with
    // `crypto.randomUUID()` rather than an adapter row id. `isSignInAllowed(user.id)` therefore looks up a
    // random UUID, finds nothing, and allows — the Decision #72 check was structurally a no-op on this path
    // and the refusal came only incidentally, from the adapter's OAuthAccountNotLinked. The gate now looks
    // the person up by the VERIFIED email, which is the same row the adapter would have found.
    seed({ id: "row_left", email: "left@example.com", name: "Left", groups: ["advisors"], isActive: false });
    const cfg = await loadAuth();
    await expect(
      cfg.callbacks.signIn({
        user: { id: "3f8c1e6a-0000-4000-8000-000000000000" },
        account: google,
        profile: profileFor("left@example.com"),
      }),
    ).resolves.toBe(false);
    expect(store.writes).toEqual([]);

    // An ACTIVE row on the same path is still allowed, so this only ever subtracts.
    seed({ id: "row_here", email: "here@example.com", name: "Here", groups: [], isActive: true });
    await expect(
      cfg.callbacks.signIn({
        user: { id: "9a2b7c4d-0000-4000-8000-000000000000" },
        account: google,
        profile: profileFor("here@example.com"),
      }),
    ).resolves.toBe(true);
  });

  /**
   * A refusal that writes nothing is a refusal nobody can review. Auth.js runs `handleAuthorized` before
   * `handleLoginOrRegister`, so `events.signIn` — the only other place a sign-in is recorded — never runs
   * for a refused identity, and the sign-in page is public on both services.
   */
  it("records the refusal in the ledger, with the DOMAIN only and never the local part", async () => {
    const cfg = await loadAuth();
    const { recordSignInDenied } = await import("@/lib/audit");

    await expect(
      cfg.callbacks.signIn({
        user: { id: "never_seen" },
        account: google,
        profile: profileFor("first.last+tag@gmail.com"),
      }),
    ).resolves.toBe(false);

    const call = vi.mocked(recordSignInDenied).mock.calls.at(-1);
    expect(call, "a refused Google sign-in must write an AUTHZ_DENIED row").toBeDefined();
    const [ctx, provider, reason, domain, count] = call ?? [];
    expect(provider).toBe("google");
    expect(reason).toBe("google:profile-refused");
    expect(domain).toBe("gmail.com");
    expect(count).toBe(1);
    expect(ctx?.requestId).toBe("auth-test");
    // Nothing anywhere in the recorded arguments may carry the address or its local part.
    expect(JSON.stringify(call)).not.toContain("first.last");
    expect(JSON.stringify(call)).not.toContain("@");
  });

  it("names a deactivation as a deactivation, not as a domain refusal", async () => {
    seed({ id: "row_left", email: "left@example.com", name: "Left", groups: [], isActive: false });
    const cfg = await loadAuth();
    const { recordSignInDenied } = await import("@/lib/audit");

    await cfg.callbacks.signIn({
      user: { id: "3f8c1e6a-0000-4000-8000-000000000000" },
      account: google,
      profile: profileFor("left@example.com"),
    });
    expect(vi.mocked(recordSignInDenied).mock.calls.at(-1)?.[2]).toBe("google:deactivated");
    expect(vi.mocked(recordSignInDenied).mock.calls.at(-1)?.[3]).toBe("example.com");
  });

  it("bounds an implausible domain to the literal domain:invalid", async () => {
    // A refused "address" that is not one address on a plausible bare domain is never written verbatim:
    // the refused party is unauthenticated, they choose this string, and the ledger is append-only with no
    // hard delete. Its own `loadAuth` because the coalescing window is per module instance — a second
    // refusal inside one test would be counted rather than recorded, which is the point of the window.
    const cfg = await loadAuth();
    const { recordSignInDenied } = await import("@/lib/audit");

    await cfg.callbacks.signIn({
      user: { id: "never_seen" },
      account: google,
      profile: { email: "a@b@example.com", email_verified: true, hd: "example.com" },
    });
    expect(vi.mocked(recordSignInDenied).mock.calls.at(-1)?.[3]).toBe("domain:invalid");
  });

  it("coalesces a scripted probe into one row per window rather than one row per attempt", async () => {
    const cfg = await loadAuth();
    const { recordSignInDenied } = await import("@/lib/audit");

    for (let i = 0; i < 5; i += 1) {
      await cfg.callbacks.signIn({
        user: { id: "never_seen" },
        account: google,
        profile: profileFor(`probe${i}@gmail.com`),
      });
    }

    // One row, and it states how many refusals it stands for — the evidence is compressed, not dropped.
    expect(vi.mocked(recordSignInDenied)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordSignInDenied).mock.calls[0]?.[4]).toBe(1);
  });

  it("gates ONLY the google provider: okta and dev-persona sign-ins are unaffected by the allowlist", async () => {
    seed({ id: "okta_here", email: "here@example.test", name: "Here", groups: ["advisors"], isActive: true });
    const cfg = await loadAuth();
    // An address nowhere near the allowlist, through Okta: allowed, exactly as before this change.
    await expect(
      cfg.callbacks.signIn({
        user: { id: "okta_here" },
        account: { provider: "okta", providerAccountId: "00u1" },
        profile: { email: "here@example.test", email_verified: false, hd: "example.test" },
      }),
    ).resolves.toBe(true);
    await expect(
      cfg.callbacks.signIn({ user: { id: OPS.id }, account: { provider: DEV_PROVIDER_ID }, profile: undefined }),
    ).resolves.toBe(true);
    // And a call with no account at all (the shape the earlier tests use) is unchanged.
    await expect(cfg.callbacks.signIn({ user: { id: "okta_here" } })).resolves.toBe(true);
  });

  it("honours a configured AUTH_GOOGLE_ALLOWED_DOMAINS, and a blank one means the DEFAULT, never 'any domain'", async () => {
    vi.stubEnv("AUTH_GOOGLE_ALLOWED_DOMAINS", "example.test");
    const cfg = await loadAuth();
    await expect(
      cfg.callbacks.signIn({
        user: { id: "never_seen" },
        account: google,
        profile: profileFor("someone@example.test"),
      }),
    ).resolves.toBe(true);
    await expect(cfg.callbacks.signIn({ user: { id: "never_seen" }, account: google, profile: VERIFIED })).resolves.toBe(
      false,
    );

    for (const blank of ["", "   ", ",,,"]) {
      vi.stubEnv("AUTH_GOOGLE_ALLOWED_DOMAINS", blank);
      await expect(
        cfg.callbacks.signIn({ user: { id: "never_seen" }, account: google, profile: VERIFIED }),
        blank,
      ).resolves.toBe(true);
      await expect(
        cfg.callbacks.signIn({
          user: { id: "never_seen" },
          account: google,
          profile: profileFor("attacker@gmail.com"),
        }),
        blank,
      ).resolves.toBe(false);
    }
  });

  it("the signed-in event records provider \"google\" in the audit metadata (P6)", async () => {
    seed({ id: "g_ok", email: "jeremy@example.com", name: "J", groups: [], isActive: true });
    vi.stubEnv("AUTH_GOOGLE_GROUPS", "client_services");
    const cfg = await loadAuth();
    const { writeAudit } = await import("@/lib/audit");

    await cfg.events.signIn({
      user: { id: "g_ok", email: "jeremy@example.com", name: "Test Owner" },
      account: { provider: "google", providerAccountId: "1234567890" },
      profile: VERIFIED,
    });

    expect(vi.mocked(writeAudit)).toHaveBeenCalled();
    const entry = vi.mocked(writeAudit).mock.calls.at(-1)?.[3] as unknown as {
      action: string;
      newValue: string;
      metadata: { provider: string };
    };
    expect(entry.action).toBe("USER_SIGNED_IN");
    expect(entry.metadata.provider).toBe("google");
    // Groups come from AUTH_GOOGLE_GROUPS through groupsFromSignIn — never from the stored snapshot (#51).
    expect(entry.newValue).toBe("client_services");
    expect(store.rows.get("g_ok")?.groups).toEqual(["client_services"]);
    // The oktaId column is not written for a Google sign-in.
    const write = store.writes.find((w) => w.op === "update" && w.id === "g_ok");
    expect(write?.data.oktaId).toBeUndefined();
  });
});
