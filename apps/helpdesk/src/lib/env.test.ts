import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertServingInvariants,
  env,
  isNextBuildPhase,
  isNextServerProcess,
  parseEnv,
  previousReplySecrets,
  trustedAuthservIds,
} from "@/lib/env";
import { composeDatabaseUrl } from "@/test-support/db-url";

type RawEnv = Record<string, string | undefined>;

/** Next.js augments NodeJS.ProcessEnv with a required literal NODE_ENV; tests feed arbitrary raw strings. */
function raw(o: RawEnv): NodeJS.ProcessEnv {
  return o as unknown as NodeJS.ProcessEnv;
}

/**
 * The redaction tests need a DATABASE_URL that carries a password, and a literal
 * `postgresql://USER:PASSWORD@HOST/DB` is a security scanner secret finding in any tracked file. The URL is
 * assembled from its parts at run time and the password itself is random per run, so there is no
 * credential pair in this file for a scanner — or a person reading the diff — to mistake for a real one.
 */
const DB_PASSWORD = `S3cret-${randomBytes(9).toString("base64url")}`;
const DB_SECRET = composeDatabaseUrl({ user: "app", password: DB_PASSWORD, host: "db.internal", database: "wm" });
const OKTA_SECRET = "okta-client-secret-VALUE-9f8e7d";
const AUTH_SECRET = "auth-secret-VALUE-".padEnd(44, "x");
const TOKEN = "client-api-token-VALUE-".padEnd(48, "y");

const PROD_OK: RawEnv = {
  NODE_ENV: "production",
  DATABASE_URL: DB_SECRET,
  PUBLIC_DATABASE_URL: "",
  AUTH_SECRET,
  AUTH_OKTA_ID: "0oa1234567890abcdef",
  AUTH_OKTA_SECRET: OKTA_SECRET,
  AUTH_OKTA_ISSUER: "https://tenant.okta.com/oauth2/default",
  AUTH_DEV_LOGIN: "false",
  TRUSTED_PROXY_HOPS: "1",
  CLIENT_API_TOKEN: TOKEN,
  APP_ENV: "production",
};

/** The Cloud Run dev service before an Okta application exists: production build, dev label, personas only. */
const DEPLOYED_DEV_OK: RawEnv = {
  NODE_ENV: "production",
  APP_ENV: "dev",
  DATABASE_URL: DB_SECRET,
  PUBLIC_DATABASE_URL: "",
  AUTH_SECRET,
  AUTH_OKTA_ID: "",
  AUTH_OKTA_SECRET: "",
  AUTH_OKTA_ISSUER: "",
  AUTH_DEV_LOGIN: "true",
  TRUSTED_PROXY_HOPS: "1",
  CLIENT_API_TOKEN: TOKEN,
};

const OKTA_TRIO: RawEnv = {
  AUTH_OKTA_ID: "0oa1234567890abcdef",
  AUTH_OKTA_SECRET: OKTA_SECRET,
  AUTH_OKTA_ISSUER: "https://tenant.okta.com/oauth2/default",
};

/**
 * Every key that WOULD satisfy the deployed-dev "at least one sign-in method" rule. The temporary Google
 * pair joined the list when that one check widened: the message is the operator's instruction sheet, and a
 * Google-only dev service is now a legitimate shape, so naming only Okta and the personas would send them to
 * configure the wrong thing. The PRODUCTION block is untouched — Okta is still mandatory there.
 */
const SIGN_IN_KEYS = [
  "AUTH_DEV_LOGIN",
  "AUTH_OKTA_ID",
  "AUTH_OKTA_SECRET",
  "AUTH_OKTA_ISSUER",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
] as const;

/**
 * The temporary Google sign-in's credential pair (src/lib/google-domain.ts).
 *
 * The secret deliberately does NOT carry Google's real `GOCSPX-` client-secret prefix. It did, and security scanner's
 * secret scanner flagged it on PR #16 — correctly, in the sense that the string was indistinguishable from
 * a live credential to a scanner AND to a human skimming this file. `parseEnv` holds this key to
 * `optionalString` only (no format rule, no MIN_SECRET_LENGTH entry), so the prefix bought the test nothing
 * and cost a finding on every future scan of this file. The realistic-looking CLIENT ID is kept: a client id
 * is public by design, it is not matched by any secret pattern, and its shape documents what the operator
 * pastes into Secret Manager.
 */
const GOOGLE_PAIR: RawEnv = {
  AUTH_GOOGLE_ID: "1234567890-abcdefghijklmnop.apps.googleusercontent.com",
  AUTH_GOOGLE_SECRET: "test-google-client-secret-not-a-real-value",
};

const SECRET_VALUES = [DB_SECRET, DB_PASSWORD, OKTA_SECRET, AUTH_SECRET, TOKEN];

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected parseEnv to throw");
}

/**
 * What `toThrow(new RegExp(`<prefix>.*<key>`))` used to assert, without building a pattern at run
 * time — a non-literal `RegExp` is a security scanner CWE-185 finding wherever it appears, tests included. Same
 * strength: the prefix must be present, and the key must appear after it ON THE SAME LINE, because
 * the `.*` it replaces does not cross a newline either.
 */
function expectMessageNaming(message: string, prefix: string, key: string, label: string): void {
  const at = message.indexOf(prefix);
  expect(at, `${label}: message does not carry "${prefix}" — ${message}`).toBeGreaterThanOrEqual(0);
  const line = message.slice(at + prefix.length).split("\n", 1)[0];
  expect(line.includes(key), `${label}: the "${prefix}" line does not name ${key} — ${message}`).toBe(true);
}

/** Every key of `base` that is not in `named` must be absent from the message (only offenders are named). */
function expectOnlyNamed(message: string, base: RawEnv, named: readonly string[]): void {
  for (const key of named) expect(message).toContain(key);
  for (const other of Object.keys(base)) {
    if (!named.includes(other)) expect(message).not.toContain(other);
  }
}

describe("parseEnv — production invariants (I6, I9): APP_ENV === \"production\"", () => {
  it("accepts a complete production configuration", () => {
    const e = parseEnv(raw(PROD_OK));
    expect(e.NODE_ENV).toBe("production");
    expect(e.AUTH_DEV_LOGIN).toBe(false);
    expect(e.TRUSTED_PROXY_HOPS).toBe(1);
    expect(e.APP_ENV).toBe("production");
    expect(e.PUBLIC_DATABASE_URL).toBeUndefined();
    expect(e.CLIENT_API_TOKEN).toBe(TOKEN);
    expect(e.DATABASE_URL).toBe(DB_SECRET);
  });

  const cases: Array<{ key: string; patch: RawEnv }> = [
    { key: "AUTH_DEV_LOGIN", patch: { AUTH_DEV_LOGIN: "true" } },
    { key: "AUTH_SECRET", patch: { AUTH_SECRET: undefined } },
    { key: "AUTH_SECRET", patch: { AUTH_SECRET: "" } },
    { key: "AUTH_OKTA_ID", patch: { AUTH_OKTA_ID: undefined } },
    { key: "AUTH_OKTA_SECRET", patch: { AUTH_OKTA_SECRET: "   " } },
    { key: "AUTH_OKTA_ISSUER", patch: { AUTH_OKTA_ISSUER: undefined } },
    { key: "DATABASE_URL", patch: { DATABASE_URL: undefined } },
    { key: "TRUSTED_PROXY_HOPS", patch: { TRUSTED_PROXY_HOPS: "0" } },
    { key: "TRUSTED_PROXY_HOPS", patch: { TRUSTED_PROXY_HOPS: undefined } },
    { key: "CLIENT_API_TOKEN", patch: { CLIENT_API_TOKEN: "too-short-token" } },
  ];

  for (const c of cases) {
    it(`fails individually when ${c.key} = ${JSON.stringify(c.patch[c.key])}`, () => {
      const message = messageOf(() => parseEnv(raw({ ...PROD_OK, ...c.patch })));
      expectOnlyNamed(message, PROD_OK, [c.key]);
    });
  }

  it("names every offending key at once", () => {
    const message = messageOf(() =>
      parseEnv(raw({ ...PROD_OK, AUTH_DEV_LOGIN: "true", TRUSTED_PROXY_HOPS: "0", AUTH_SECRET: undefined })),
    );
    expect(message).toContain("AUTH_DEV_LOGIN");
    expect(message).toContain("TRUSTED_PROXY_HOPS");
    expect(message).toContain("AUTH_SECRET");
  });

  it("CLIENT_API_TOKEN is optional in production (unset = API disabled)", () => {
    expect(parseEnv(raw({ ...PROD_OK, CLIENT_API_TOKEN: undefined })).CLIENT_API_TOKEN).toBeUndefined();
    expect(parseEnv(raw({ ...PROD_OK, CLIENT_API_TOKEN: "" })).CLIENT_API_TOKEN).toBeUndefined();
  });

  it("the production block keys on APP_ENV, not NODE_ENV: a development or test build labelled production is held to it (Decision #57)", () => {
    for (const nodeEnv of ["development", "test"]) {
      expect(() => parseEnv(raw({ ...PROD_OK, NODE_ENV: nodeEnv }))).not.toThrow();
      const devLogin = messageOf(() => parseEnv(raw({ ...PROD_OK, NODE_ENV: nodeEnv, AUTH_DEV_LOGIN: "true" })));
      expectOnlyNamed(devLogin, PROD_OK, ["AUTH_DEV_LOGIN"]);
      const noOkta = messageOf(() => parseEnv(raw({ ...PROD_OK, NODE_ENV: nodeEnv, AUTH_OKTA_ISSUER: "" })));
      expectOnlyNamed(noOkta, PROD_OK, ["AUTH_OKTA_ISSUER"]);
      const hops = messageOf(() => parseEnv(raw({ ...PROD_OK, NODE_ENV: nodeEnv, TRUSTED_PROXY_HOPS: "0" })));
      expectOnlyNamed(hops, PROD_OK, ["TRUSTED_PROXY_HOPS"]);
    }
  });

  it("Google may be ADDED in production but can never REPLACE Okta there (the production block is untouched)", () => {
    // Added: a complete production configuration plus the Google pair is still valid.
    expect(() => parseEnv(raw({ ...PROD_OK, ...GOOGLE_PAIR }))).not.toThrow();
    expect(parseEnv(raw({ ...PROD_OK, ...GOOGLE_PAIR })).AUTH_GOOGLE_ID).toBe(GOOGLE_PAIR.AUTH_GOOGLE_ID);
    // Substituted: the Okta trio is still mandatory, and the Google pair does not stand in for any of it.
    for (const key of ["AUTH_OKTA_ID", "AUTH_OKTA_SECRET", "AUTH_OKTA_ISSUER"]) {
      const message = messageOf(() => parseEnv(raw({ ...PROD_OK, ...GOOGLE_PAIR, [key]: undefined })));
      expectOnlyNamed(message, PROD_OK, [key]);
    }
    const noOkta = messageOf(() =>
      parseEnv(raw({ ...PROD_OK, ...GOOGLE_PAIR, AUTH_OKTA_ID: "", AUTH_OKTA_SECRET: "", AUTH_OKTA_ISSUER: "" })),
    );
    for (const key of ["AUTH_OKTA_ID", "AUTH_OKTA_SECRET", "AUTH_OKTA_ISSUER"]) expect(noOkta).toContain(key);
  });

  it("never echoes values — only key names", () => {
    const failing: RawEnv[] = [
      { ...PROD_OK, AUTH_DEV_LOGIN: "true" },
      { ...PROD_OK, TRUSTED_PROXY_HOPS: "0" },
      { ...PROD_OK, CLIENT_API_TOKEN: "short-VALUE-zz" },
      { ...PROD_OK, TRUSTED_PROXY_HOPS: "not-a-number" },
      { ...PROD_OK, NODE_ENV: "prod" },
      { ...DEPLOYED_DEV_OK, AUTH_SECRET: undefined },
      { ...DEPLOYED_DEV_OK, AUTH_DEV_LOGIN: "false" },
      { ...DEPLOYED_DEV_OK, CLIENT_API_TOKEN: "short-VALUE-zz" },
      { ...DEPLOYED_DEV_OK, APP_ENV: "staging-VALUE" },
    ];
    for (const r of failing) {
      const message = messageOf(() => parseEnv(raw(r)));
      for (const secret of SECRET_VALUES) expect(message).not.toContain(secret);
      expect(message).not.toContain("short-VALUE-zz");
      expect(message).not.toContain("not-a-number");
      expect(message).not.toContain("VALUE");
    }
  });
});

describe("parseEnv — deployed-dev invariants (Decision #57): NODE_ENV === \"production\" && APP_ENV !== \"production\"", () => {
  it("accepts the Cloud Run dev shape: production build, APP_ENV=dev, personas as the only sign-in method, no Okta", () => {
    const e = parseEnv(raw(DEPLOYED_DEV_OK));
    expect(e.NODE_ENV).toBe("production");
    expect(e.APP_ENV).toBe("dev");
    expect(e.AUTH_DEV_LOGIN).toBe(true);
    expect(e.AUTH_OKTA_ID).toBeUndefined();
    expect(e.TRUSTED_PROXY_HOPS).toBe(1);
  });

  it("accepts Okta as the sign-in method with dev login off, and both together", () => {
    expect(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, ...OKTA_TRIO, AUTH_DEV_LOGIN: "false" }))).not.toThrow();
    expect(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, ...OKTA_TRIO, AUTH_DEV_LOGIN: undefined }))).not.toThrow();
    expect(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, ...OKTA_TRIO }))).not.toThrow();
  });

  it("CLIENT_API_TOKEN stays optional (unset = API disabled)", () => {
    expect(parseEnv(raw({ ...DEPLOYED_DEV_OK, CLIENT_API_TOKEN: undefined })).CLIENT_API_TOKEN).toBeUndefined();
    expect(parseEnv(raw({ ...DEPLOYED_DEV_OK, CLIENT_API_TOKEN: "" })).CLIENT_API_TOKEN).toBeUndefined();
  });

  const cases: Array<{ key: string; patch: RawEnv }> = [
    { key: "AUTH_SECRET", patch: { AUTH_SECRET: undefined } },
    { key: "AUTH_SECRET", patch: { AUTH_SECRET: "  " } },
    { key: "DATABASE_URL", patch: { DATABASE_URL: undefined } },
    { key: "TRUSTED_PROXY_HOPS", patch: { TRUSTED_PROXY_HOPS: "0" } },
    { key: "TRUSTED_PROXY_HOPS", patch: { TRUSTED_PROXY_HOPS: undefined } },
    { key: "CLIENT_API_TOKEN", patch: { CLIENT_API_TOKEN: "too-short-token" } },
  ];

  for (const c of cases) {
    it(`fails individually when ${c.key} = ${JSON.stringify(c.patch[c.key])}`, () => {
      const message = messageOf(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, ...c.patch })));
      expectOnlyNamed(message, DEPLOYED_DEV_OK, [c.key]);
    });
  }

  it("accepts the temporary Google pair as the sign-in method, with dev login off and no Okta", () => {
    // This is the whole point of the widening: a deployed dev service whose only real sign-in is the
    // domain-restricted Google provider must boot. Before it, such a service failed closed at startup.
    expect(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, ...GOOGLE_PAIR, AUTH_DEV_LOGIN: "false" }))).not.toThrow();
    expect(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, ...GOOGLE_PAIR, AUTH_DEV_LOGIN: undefined }))).not.toThrow();
    // …and half a pair is not a sign-in method.
    for (const half of [{ AUTH_GOOGLE_SECRET: undefined }, { AUTH_GOOGLE_ID: undefined }] as RawEnv[]) {
      const message = messageOf(() =>
        parseEnv(raw({ ...DEPLOYED_DEV_OK, ...GOOGLE_PAIR, ...half, AUTH_DEV_LOGIN: "false" })),
      );
      expectOnlyNamed(message, DEPLOYED_DEV_OK, SIGN_IN_KEYS);
    }
  });

  it("no sign-in method at all (dev login off, Okta incomplete, no Google pair) → names every key that would satisfy it, nothing else", () => {
    for (const patch of [
      { AUTH_DEV_LOGIN: "false" },
      { AUTH_DEV_LOGIN: undefined },
      { AUTH_DEV_LOGIN: "TRUE" }, // literal "true" only
      { AUTH_DEV_LOGIN: "1" }, // OPS_PORTAL's "1" is NOT this repo's switch
      { AUTH_DEV_LOGIN: "false", AUTH_OKTA_ID: OKTA_TRIO.AUTH_OKTA_ID, AUTH_OKTA_SECRET: OKTA_TRIO.AUTH_OKTA_SECRET }, // issuer missing
    ] as RawEnv[]) {
      const message = messageOf(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, ...patch })));
      expectOnlyNamed(message, DEPLOYED_DEV_OK, SIGN_IN_KEYS);
    }
  });

  it("names every offending key at once", () => {
    const message = messageOf(() =>
      parseEnv(raw({ ...DEPLOYED_DEV_OK, AUTH_DEV_LOGIN: "false", TRUSTED_PROXY_HOPS: "0", AUTH_SECRET: undefined })),
    );
    for (const key of [...SIGN_IN_KEYS, "TRUSTED_PROXY_HOPS", "AUTH_SECRET"]) expect(message).toContain(key);
    expect(message).not.toContain("DATABASE_URL");
  });

  it("a production build labelled local (a local `next start`, or APP_ENV unset) is held to the same block", () => {
    for (const appEnv of ["local", "", undefined]) {
      expect(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, APP_ENV: appEnv }))).not.toThrow();
      const hops = messageOf(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, APP_ENV: appEnv, TRUSTED_PROXY_HOPS: "0" })));
      expectOnlyNamed(hops, DEPLOYED_DEV_OK, ["TRUSTED_PROXY_HOPS"]);
      const noSecret = messageOf(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, APP_ENV: appEnv, AUTH_SECRET: "" })));
      expectOnlyNamed(noSecret, DEPLOYED_DEV_OK, ["AUTH_SECRET"]);
    }
  });

  it("does not demand Google either: the pair stays optional when another sign-in method is present", () => {
    expect(parseEnv(raw(DEPLOYED_DEV_OK)).AUTH_GOOGLE_ID).toBeUndefined();
    const message = messageOf(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, TRUSTED_PROXY_HOPS: "0" })));
    expect(message).not.toContain("AUTH_GOOGLE_ID");
    expect(message).not.toContain("AUTH_GOOGLE_SECRET");
  });

  it("does not demand Okta and does not refuse dev login — that is the production block's job", () => {
    const message = messageOf(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, TRUSTED_PROXY_HOPS: "0" })));
    expect(message).not.toContain("AUTH_OKTA_ID");
    expect(message).not.toContain("AUTH_DEV_LOGIN");
  });
});

describe("parseEnv — development / test defaults", () => {
  it("empty environment → safe defaults", () => {
    const e = parseEnv(raw({}));
    expect(e).toEqual({
      NODE_ENV: "development",
      DATABASE_URL: undefined,
      PUBLIC_DATABASE_URL: undefined,
      AUTH_SECRET: undefined,
      AUTH_OKTA_ID: undefined,
      AUTH_OKTA_SECRET: undefined,
      AUTH_OKTA_ISSUER: undefined,
      AUTH_OKTA_SCOPE: undefined,
      AUTH_OKTA_GROUPS_CLAIM: undefined,
      AUTH_GOOGLE_ID: undefined,
      AUTH_GOOGLE_SECRET: undefined,
      AUTH_GOOGLE_ALLOWED_DOMAINS: undefined,
      AUTH_GOOGLE_GROUPS: undefined,
      AUTH_DEV_LOGIN: false,
      TRUSTED_PROXY_HOPS: 0,
      CLIENT_API_TOKEN: undefined,
      APP_ENV: "local",
      // Wave B's four boolean keys. `toEqual` ignores properties that are `undefined`, which is why
      // every other optional key can stay out of this literal — a boolean that defaults to `false`
      // cannot, and naming them here is what makes "unset means OFF" an assertion rather than a claim.
      AUTO_ACK_ENABLED: false,
      RESOLVED_NOTICE_ENABLED: false,
      WEBHOOKS_ENABLED: false,
      MCP_ENABLED: false,
    });
  });

  it("AUTH_OKTA_SCOPE / AUTH_OKTA_GROUPS_CLAIM are optional, trimmed, and never required by either invariant block (Decision #58)", () => {
    const e = parseEnv(raw({ AUTH_OKTA_SCOPE: "  openid email profile ops_portal_groups ", AUTH_OKTA_GROUPS_CLAIM: " OpsPortalGroups " }));
    expect(e.AUTH_OKTA_SCOPE).toBe("openid email profile ops_portal_groups");
    expect(e.AUTH_OKTA_GROUPS_CLAIM).toBe("OpsPortalGroups");
    expect(parseEnv(raw({ AUTH_OKTA_SCOPE: "", AUTH_OKTA_GROUPS_CLAIM: "   " })).AUTH_OKTA_SCOPE).toBeUndefined();
    expect(parseEnv(raw({ AUTH_OKTA_SCOPE: "", AUTH_OKTA_GROUPS_CLAIM: "   " })).AUTH_OKTA_GROUPS_CLAIM).toBeUndefined();
    // Production and deployed-dev shapes stay valid with or without them.
    expect(parseEnv(raw(PROD_OK)).AUTH_OKTA_SCOPE).toBeUndefined();
    expect(parseEnv(raw({ ...PROD_OK, AUTH_OKTA_SCOPE: "openid email profile ops_portal_groups", AUTH_OKTA_GROUPS_CLAIM: "OpsPortalGroups" })).AUTH_OKTA_GROUPS_CLAIM).toBe("OpsPortalGroups");
    expect(parseEnv(raw({ ...DEPLOYED_DEV_OK, AUTH_OKTA_SCOPE: "openid groups", AUTH_OKTA_GROUPS_CLAIM: "groups" })).AUTH_OKTA_SCOPE).toBe("openid groups");
  });

  it("a set-but-malformed AUTH_OKTA_SCOPE (no openid token) or AUTH_OKTA_GROUPS_CLAIM (not an identifier) is refused by key name, never echoed", () => {
    const scopeMsg = messageOf(() => parseEnv(raw({ AUTH_OKTA_SCOPE: "email profile ops_portal_groups" })));
    expect(scopeMsg).toContain("AUTH_OKTA_SCOPE");
    expect(scopeMsg).not.toContain("ops_portal_groups");
    expect(messageOf(() => parseEnv(raw({ AUTH_OKTA_SCOPE: "openidx" })))).toContain("AUTH_OKTA_SCOPE");
    for (const bad of ["opsportal-groups", "1groups", "a.b", "a b", "x".repeat(65)]) {
      const msg = messageOf(() => parseEnv(raw({ AUTH_OKTA_GROUPS_CLAIM: bad })));
      expect(msg, bad).toContain("AUTH_OKTA_GROUPS_CLAIM");
      expect(msg, bad).not.toContain(bad);
    }
    // The refusal is shape validation: it applies in every NODE_ENV / APP_ENV, including the relaxed non-serving parse.
    expect(messageOf(() => parseEnv(raw({ ...PROD_OK, AUTH_OKTA_GROUPS_CLAIM: "opsportal-groups" })))).toContain("AUTH_OKTA_GROUPS_CLAIM");
    expect(
      messageOf(() => parseEnv(raw({ AUTH_OKTA_SCOPE: "profile" }), { enforceProductionInvariants: false })),
    ).toContain("AUTH_OKTA_SCOPE");
  });

  it("AUTH_OKTA_GROUPS_CLAIM naming a well-known scalar claim (email, name, sub, preferred_username, …) is refused by key name (Decision #59)", () => {
    for (const scalar of ["email", "name", "sub", "preferred_username", "given_name", "Email"]) {
      const msg = messageOf(() => parseEnv(raw({ AUTH_OKTA_GROUPS_CLAIM: scalar })));
      expect(msg, scalar).toContain("AUTH_OKTA_GROUPS_CLAIM");
    }
    expect(messageOf(() => parseEnv(raw({ ...PROD_OK, AUTH_OKTA_GROUPS_CLAIM: "email" })))).toContain("AUTH_OKTA_GROUPS_CLAIM");
    expect(parseEnv(raw({ AUTH_OKTA_GROUPS_CLAIM: "OpsPortalGroups" })).AUTH_OKTA_GROUPS_CLAIM).toBe("OpsPortalGroups");
    expect(parseEnv(raw({ AUTH_OKTA_GROUPS_CLAIM: "groups" })).AUTH_OKTA_GROUPS_CLAIM).toBe("groups");
  });

  it("empty strings count as unset", () => {
    const e = parseEnv(
      raw({ NODE_ENV: "development", DATABASE_URL: "", AUTH_SECRET: "  ", TRUSTED_PROXY_HOPS: "", APP_ENV: "" }),
    );
    expect(e.DATABASE_URL).toBeUndefined();
    expect(e.AUTH_SECRET).toBeUndefined();
    expect(e.TRUSTED_PROXY_HOPS).toBe(0);
    expect(e.APP_ENV).toBe("local");
  });

  it('AUTH_DEV_LOGIN is a literal read of the string "true"', () => {
    expect(parseEnv(raw({ NODE_ENV: "development", AUTH_DEV_LOGIN: "true" })).AUTH_DEV_LOGIN).toBe(true);
    expect(parseEnv(raw({ NODE_ENV: "development", AUTH_DEV_LOGIN: "TRUE" })).AUTH_DEV_LOGIN).toBe(false);
    expect(parseEnv(raw({ NODE_ENV: "development", AUTH_DEV_LOGIN: "1" })).AUTH_DEV_LOGIN).toBe(false);
    expect(parseEnv(raw({ NODE_ENV: "development", AUTH_DEV_LOGIN: "yes" })).AUTH_DEV_LOGIN).toBe(false);
    expect(parseEnv(raw({ NODE_ENV: "test", AUTH_DEV_LOGIN: "true" })).AUTH_DEV_LOGIN).toBe(true);
  });

  it("dev login, a short client token and zero hops are allowed in a development or test build with a non-production label", () => {
    for (const nodeEnv of ["development", "test"]) {
      for (const appEnv of ["local", "dev", undefined]) {
        const e = parseEnv(
          raw({ NODE_ENV: nodeEnv, APP_ENV: appEnv, AUTH_DEV_LOGIN: "true", CLIENT_API_TOKEN: "short", TRUSTED_PROXY_HOPS: "0" }),
        );
        expect(e.AUTH_DEV_LOGIN).toBe(true);
        expect(e.CLIENT_API_TOKEN).toBe("short");
        expect(e.TRUSTED_PROXY_HOPS).toBe(0);
        expect(e.AUTH_SECRET).toBeUndefined();
      }
    }
  });

  it("TRUSTED_PROXY_HOPS must be a non-negative integer", () => {
    expect(parseEnv(raw({ TRUSTED_PROXY_HOPS: "2" })).TRUSTED_PROXY_HOPS).toBe(2);
    expect(parseEnv(raw({ TRUSTED_PROXY_HOPS: " 3 " })).TRUSTED_PROXY_HOPS).toBe(3);
    expect(messageOf(() => parseEnv(raw({ TRUSTED_PROXY_HOPS: "-1" })))).toContain("TRUSTED_PROXY_HOPS");
    expect(messageOf(() => parseEnv(raw({ TRUSTED_PROXY_HOPS: "1.5" })))).toContain("TRUSTED_PROXY_HOPS");
    expect(messageOf(() => parseEnv(raw({ TRUSTED_PROXY_HOPS: "abc" })))).toContain("TRUSTED_PROXY_HOPS");
  });

  it("unknown NODE_ENV / APP_ENV values are refused by key name; APP_ENV accepts exactly local | dev | production", () => {
    expect(messageOf(() => parseEnv(raw({ NODE_ENV: "staging" })))).toContain("NODE_ENV");
    expect(messageOf(() => parseEnv(raw({ APP_ENV: "qa" })))).toContain("APP_ENV");
    expect(messageOf(() => parseEnv(raw({ APP_ENV: "Production" })))).toContain("APP_ENV");
    expect(messageOf(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, APP_ENV: "staging" })))).toContain("APP_ENV");
    expect(parseEnv(raw({ APP_ENV: "dev" })).APP_ENV).toBe("dev");
    expect(parseEnv(raw({ APP_ENV: "local" })).APP_ENV).toBe("local");
    expect(parseEnv(raw({ NODE_ENV: "test" })).NODE_ENV).toBe("test");
  });
});

/**
 * The temporary Google sign-in's two list variables. Both are refused at boot BY KEY NAME when they are set
 * but unusable, which is the AUTH_OKTA_SCOPE rule applied to a higher-stakes pair: a domain
 * allowlist that silently falls back is how a staff-only desk quietly becomes a public one, and a group name
 * that silently grants nothing presents as an RBAC bug rather than as the typo it is.
 */
describe("parseEnv — temporary Google sign-in keys", () => {
  it("all four are optional, and the credentials are never required by either invariant block", () => {
    const e = parseEnv(raw({}));
    expect(e.AUTH_GOOGLE_ID).toBeUndefined();
    expect(e.AUTH_GOOGLE_SECRET).toBeUndefined();
    expect(e.AUTH_GOOGLE_ALLOWED_DOMAINS).toBeUndefined();
    expect(e.AUTH_GOOGLE_GROUPS).toBeUndefined();
    expect(() => parseEnv(raw(PROD_OK))).not.toThrow();
    expect(() => parseEnv(raw(DEPLOYED_DEV_OK))).not.toThrow();
  });

  it("a blank allowlist or group list counts as UNSET (blank means the hardcoded default, not 'all domains')", () => {
    for (const blank of ["", "   "]) {
      const e = parseEnv(raw({ AUTH_GOOGLE_ALLOWED_DOMAINS: blank, AUTH_GOOGLE_GROUPS: blank }));
      expect(e.AUTH_GOOGLE_ALLOWED_DOMAINS, blank).toBeUndefined();
      expect(e.AUTH_GOOGLE_GROUPS, blank).toBeUndefined();
    }
  });

  it("a written allowlist is kept trimmed", () => {
    const e = parseEnv(raw({ AUTH_GOOGLE_ALLOWED_DOMAINS: "  example.com,example.net  " }));
    expect(e.AUTH_GOOGLE_ALLOWED_DOMAINS).toBe("example.com,example.net");
  });

  it("a set-but-malformed AUTH_GOOGLE_ALLOWED_DOMAINS is refused by key name, never echoed", () => {
    for (const bad of [
      "https://example.com",
      "user@example.com",
      "cedarridgewealth",
      "cedarRidge wealth.com",
      ".example.com",
      "example.com.",
      "-example.com",
      "example.com,not a domain",
      ",,,",
    ]) {
      const message = messageOf(() => parseEnv(raw({ AUTH_GOOGLE_ALLOWED_DOMAINS: bad })));
      expect(message, bad).toContain("AUTH_GOOGLE_ALLOWED_DOMAINS");
      expect(message, bad).not.toContain(bad);
    }
    // Refused in every mode, including a complete production shape and with the invariants switched off.
    expect(messageOf(() => parseEnv(raw({ ...PROD_OK, AUTH_GOOGLE_ALLOWED_DOMAINS: "cedarridgewealth" })))).toContain(
      "AUTH_GOOGLE_ALLOWED_DOMAINS",
    );
    expect(
      messageOf(() =>
        parseEnv(raw({ AUTH_GOOGLE_ALLOWED_DOMAINS: "cedarridgewealth" }), { enforceProductionInvariants: false }),
      ),
    ).toContain("AUTH_GOOGLE_ALLOWED_DOMAINS");
  });

  it("a valid allowlist is accepted in every mode", () => {
    for (const ok of ["example.com", "example.com,example.net", " example.net , example.co.uk "]) {
      expect(() => parseEnv(raw({ AUTH_GOOGLE_ALLOWED_DOMAINS: ok })), ok).not.toThrow();
      expect(() => parseEnv(raw({ ...PROD_OK, AUTH_GOOGLE_ALLOWED_DOMAINS: ok })), ok).not.toThrow();
      expect(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, AUTH_GOOGLE_ALLOWED_DOMAINS: ok })), ok).not.toThrow();
    }
  });

  it("AUTH_GOOGLE_GROUPS naming anything but a known group is refused by key name — a typo that grants nothing is worse than a loud refusal", () => {
    for (const bad of ["ops-team", "OPS_TEAM", "ops_team,not_a_group", "OPSPORTAL-Operations", "admin", ",,,"]) {
      const message = messageOf(() => parseEnv(raw({ AUTH_GOOGLE_GROUPS: bad })));
      expect(message, bad).toContain("AUTH_GOOGLE_GROUPS");
      expect(message, bad).not.toContain(bad);
    }
    expect(messageOf(() => parseEnv(raw({ ...PROD_OK, AUTH_GOOGLE_GROUPS: "ops-team" })))).toContain(
      "AUTH_GOOGLE_GROUPS",
    );
  });

  it("AUTH_GOOGLE_GROUPS naming known groups is accepted", () => {
    expect(parseEnv(raw({ AUTH_GOOGLE_GROUPS: "ops_team" })).AUTH_GOOGLE_GROUPS).toBe("ops_team");
    expect(
      parseEnv(raw({ AUTH_GOOGLE_GROUPS: " ops_team , client_services , advisors , compliance_officers " }))
        .AUTH_GOOGLE_GROUPS,
    ).toBe("ops_team , client_services , advisors , compliance_officers");
  });

  it("never echoes a Google credential value in any refusal", () => {
    const failing: RawEnv[] = [
      { ...PROD_OK, ...GOOGLE_PAIR, AUTH_GOOGLE_ALLOWED_DOMAINS: "cedarridgewealth" },
      { ...PROD_OK, ...GOOGLE_PAIR, AUTH_GOOGLE_GROUPS: "ops-team" },
      { ...DEPLOYED_DEV_OK, ...GOOGLE_PAIR, TRUSTED_PROXY_HOPS: "0" },
    ];
    for (const r of failing) {
      const message = messageOf(() => parseEnv(raw(r)));
      expect(message).not.toContain(GOOGLE_PAIR.AUTH_GOOGLE_SECRET);
      expect(message).not.toContain(GOOGLE_PAIR.AUTH_GOOGLE_ID);
      expect(message).not.toContain("VALUE");
    }
  });
});

describe("parseEnv — non-serving-process option (decisions #43, #57)", () => {
  it("enforces both invariant blocks by default and when asked explicitly (serving-process contract unchanged)", () => {
    expect(messageOf(() => parseEnv(raw({ ...PROD_OK, AUTH_DEV_LOGIN: "true" })))).toContain("AUTH_DEV_LOGIN");
    expect(messageOf(() => parseEnv(raw({ ...PROD_OK, AUTH_OKTA_ISSUER: undefined }), {}))).toContain("AUTH_OKTA_ISSUER");
    expect(
      messageOf(() => parseEnv(raw({ ...PROD_OK, TRUSTED_PROXY_HOPS: "0" }), { enforceProductionInvariants: true })),
    ).toContain("TRUSTED_PROXY_HOPS");
    expect(
      messageOf(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, AUTH_SECRET: undefined }), { enforceProductionInvariants: true })),
    ).toContain("AUTH_SECRET");
  });

  it("enforceProductionInvariants=false still validates the shape by key name but demands no serving-process invariant of either block", () => {
    const e = parseEnv(raw({ NODE_ENV: "production", APP_ENV: "production", AUTH_DEV_LOGIN: "true", TRUSTED_PROXY_HOPS: "0" }), {
      enforceProductionInvariants: false,
    });
    expect(e.NODE_ENV).toBe("production");
    expect(e.APP_ENV).toBe("production");
    expect(e.AUTH_DEV_LOGIN).toBe(true);
    expect(e.AUTH_OKTA_ISSUER).toBeUndefined();
    expect(e.TRUSTED_PROXY_HOPS).toBe(0);
    // The migrate job's seed process: production build, dev label, only the owner DATABASE_URL.
    const seed = parseEnv(raw({ NODE_ENV: "production", APP_ENV: "dev", DATABASE_URL: DB_SECRET }), {
      enforceProductionInvariants: false,
    });
    expect(seed.AUTH_SECRET).toBeUndefined();
    expect(seed.TRUSTED_PROXY_HOPS).toBe(0);
    expect(seed.AUTH_DEV_LOGIN).toBe(false);
    expect(
      messageOf(() => parseEnv(raw({ NODE_ENV: "production", TRUSTED_PROXY_HOPS: "abc" }), { enforceProductionInvariants: false })),
    ).toContain("TRUSTED_PROXY_HOPS");
    expect(messageOf(() => parseEnv(raw({ NODE_ENV: "prod" }), { enforceProductionInvariants: false }))).toContain("NODE_ENV");
    expect(messageOf(() => parseEnv(raw({ APP_ENV: "qa" }), { enforceProductionInvariants: false }))).toContain("APP_ENV");
    const message = messageOf(() =>
      parseEnv(raw({ NODE_ENV: "production", AUTH_SECRET, TRUSTED_PROXY_HOPS: "not-a-number" }), { enforceProductionInvariants: false }),
    );
    for (const secret of SECRET_VALUES) expect(message).not.toContain(secret);
  });

  it("isNextBuildPhase is false outside the `next build` worker (vitest leaves NEXT_PHASE unset)", () => {
    expect(process.env.NEXT_PHASE).toBeUndefined();
    expect(isNextBuildPhase).toBe(false);
  });

  it("isNextServerProcess is false outside a Next server process — vitest, like `prisma db seed`, leaves NEXT_RUNTIME unset (decision #57)", () => {
    // Next compiles process.env.NEXT_RUNTIME into its server bundles as the literal "nodejs"; a plain node/tsx
    // process never has it, so the module-level `env` is shape-validated only there and the seed can run with
    // just the owner DATABASE_URL. Serving processes are unaffected: their gates are the strict calls below.
    expect(process.env.NEXT_RUNTIME).toBeUndefined();
    expect(isNextServerProcess).toBe(false);
  });

  it("parseEnv's strict mode is independent of NEXT_PHASE and NEXT_RUNTIME — a serving process cannot inherit a relaxation (decision #52)", () => {
    // parseEnv itself reads neither variable; the default enforces the invariants regardless, so a process that
    // inherited NEXT_PHASE=phase-production-build (or lacks NEXT_RUNTIME) still fails closed on the strict parse.
    const message = messageOf(() =>
      parseEnv(raw({ ...PROD_OK, AUTH_DEV_LOGIN: "true", TRUSTED_PROXY_HOPS: "0", NEXT_PHASE: "phase-production-build" })),
    );
    expect(message).toContain("AUTH_DEV_LOGIN");
    expect(message).toContain("TRUSTED_PROXY_HOPS");
    const deployed = messageOf(() =>
      parseEnv(raw({ ...DEPLOYED_DEV_OK, AUTH_SECRET: undefined, NEXT_PHASE: "phase-production-build", NEXT_RUNTIME: undefined })),
    );
    expect(deployed).toContain("AUTH_SECRET");
    // And fully-valid configurations still pass with the phase set.
    expect(() => parseEnv(raw({ ...PROD_OK, NEXT_PHASE: "phase-production-build" }))).not.toThrow();
    expect(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, NEXT_PHASE: "phase-production-build" }))).not.toThrow();
  });

  it("assertServingInvariants runs the strict parse and is idempotent (decision #52)", () => {
    // In the vitest process (NODE_ENV=test, APP_ENV local) neither invariant block applies, so it passes and memoises.
    expect(() => assertServingInvariants()).not.toThrow();
    expect(() => assertServingInvariants()).not.toThrow();
  });
});

describe("env singleton", () => {
  it("is the parse of process.env at import (vitest runs with NODE_ENV=test)", () => {
    expect(env.NODE_ENV).toBe("test");
    expect(typeof env.TRUSTED_PROXY_HOPS).toBe("number");
    expect(typeof env.AUTH_DEV_LOGIN).toBe("boolean");
  });
});

describe("seed production refusal keys on APP_ENV (Decision #57) — source scan of prisma/seed.ts + prisma/seed-dev.ts", () => {
  const ROOT = fileURLToPath(new URL("../..", import.meta.url));
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(?<!:)\s\/\/.*$/gm, "");
  const seed = stripComments(readFileSync(path.join(ROOT, "prisma/seed.ts"), "utf8"));
  const seedDev = stripComments(readFileSync(path.join(ROOT, "prisma/seed-dev.ts"), "utf8"));

  it("seed.ts refuses SEED_DEV_FIXTURES under APP_ENV=production with exit 2, before importing ../src/lib/db, and never consults NODE_ENV", () => {
    const refusal = seed.indexOf('process.env.APP_ENV === "production"');
    expect(refusal).toBeGreaterThan(-1);
    expect(seed.slice(refusal, refusal + 400)).toContain("SEED_DEV_FIXTURES is not allowed in production");
    expect(seed.slice(refusal, refusal + 400)).toContain("return 2;");
    expect(seed.indexOf('import("../src/lib/db")')).toBeGreaterThan(refusal);
    expect(seed).toContain('process.env.SEED_DEV_FIXTURES === "true"');
    expect(seed).not.toContain("NODE_ENV");
  });

  it("seed-dev.ts guards itself again on APP_ENV=production and never consults NODE_ENV", () => {
    expect(seedDev).toContain('if (process.env.APP_ENV === "production")');
    expect(seedDev).toContain("seedFromUniverse refused: APP_ENV=production");
    expect(seedDev).not.toContain("NODE_ENV");
  });
});

// ---------------------------------------------------------------------------
// Wave A keys. The property under test is uniform: every one is optional
// and fail-closed, a malformed value is refused BY KEY NAME in every mode, and a short shared secret
// is refused wherever the process is network-reachable.
// ---------------------------------------------------------------------------

/** Repo root, for the .env.example documentation check below. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LONG_SECRET = "wave-a-secret-VALUE-".padEnd(48, "z");
const SHORT_SECRET = "too-short";

describe("parseEnv — Wave A keys", () => {
  it("every Wave A key is optional: a local process with none of them parses and reports them undefined", () => {
    const parsed = parseEnv(raw({ NODE_ENV: "development" }));
    expect(parsed.INTEGRATION_API_TOKEN).toBeUndefined();
    expect(parsed.INGEST_API_TOKEN).toBeUndefined();
    expect(parsed.EXPORT_API_TOKEN).toBeUndefined();
    expect(parsed.OUTBOX_API_TOKEN).toBeUndefined();
    expect(parsed.REPLY_TOKEN_SECRET).toBeUndefined();
    expect(parsed.REPLY_TOKEN_PREVIOUS_SECRETS).toBeUndefined();
    expect(parsed.APP_BASE_URL).toBeUndefined();
    expect(parsed.MAILBOX_MAP).toBeUndefined();
    expect(parsed.EMAIL_TRUSTED_AUTHSERV_IDS).toBeUndefined();
    expect(parsed.ATTACHMENTS_BUCKET).toBeUndefined();
    expect(parsed.ATTACHMENTS_SIGNER_EMAIL).toBeUndefined();
    expect(parsed.DUPLICATE_COPY_BUCKET).toBeUndefined();
    expect(parsed.SLA_ALERT_SLACK_WEBHOOK_URL).toBeUndefined();
    expect(parsed.SLACK_QUEUE_WEBHOOKS).toBeUndefined();
    expect(parsed.JOB_ACTOR_EMAIL).toBeUndefined();
    expect(parsed.LEGACY_DESK_SUBDOMAIN).toBeUndefined();
    expect(parsed.LEGACY_DESK_EMAIL).toBeUndefined();
    expect(parsed.LEGACY_DESK_API_TOKEN).toBeUndefined();
  });

  it("an empty or whitespace-only value counts as unset, exactly like the pre-existing keys", () => {
    const parsed = parseEnv(
      raw({ NODE_ENV: "development", INTEGRATION_API_TOKEN: "", MAILBOX_MAP: "   ", SLACK_QUEUE_WEBHOOKS: "" }),
    );
    expect(parsed.INTEGRATION_API_TOKEN).toBeUndefined();
    expect(parsed.MAILBOX_MAP).toBeUndefined();
    expect(parsed.SLACK_QUEUE_WEBHOOKS).toBeUndefined();
  });

  it("a JSON-valued key must be a JSON OBJECT: an array, a scalar or unparseable text is refused by key name", () => {
    for (const key of ["MAILBOX_MAP", "SLACK_QUEUE_WEBHOOKS"]) {
      for (const bad of ["{", "[]", '["a"]', '"a string"', "42", "null"]) {
        expectMessageNaming(
          messageOf(() => parseEnv(raw({ NODE_ENV: "development", [key]: bad }))),
          "Invalid environment configuration for:",
          key,
          `${key}=${bad}`,
        );
      }
    }
    // A real object parses in every mode.
    const ok = parseEnv(
      raw({
        NODE_ENV: "development",
        MAILBOX_MAP: '{"service@example.com":{"queueKey":"CLIENT_SERVICE","brand":"CEDAR_RIDGE_WEALTH"}}',
        SLACK_QUEUE_WEBHOOKS: '{"OPERATIONS":"https://hooks.slack.com/services/T/B/x"}',
      }),
    );
    expect(ok.MAILBOX_MAP).toContain("CLIENT_SERVICE");
    expect(ok.SLACK_QUEUE_WEBHOOKS).toContain("OPERATIONS");
  });

  it("a Slack webhook must be https: http, a bare host and nonsense are all refused by key name", () => {
    for (const bad of ["http://hooks.slack.com/services/T/B/x", "hooks.slack.com/services/T/B/x", "not a url", "ftp://x/y"]) {
      expect(() => parseEnv(raw({ NODE_ENV: "development", SLA_ALERT_SLACK_WEBHOOK_URL: bad })), bad).toThrow(
        /Invalid environment configuration for: .*SLA_ALERT_SLACK_WEBHOOK_URL/,
      );
    }
    expect(
      parseEnv(raw({ NODE_ENV: "development", SLA_ALERT_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x" }))
        .SLA_ALERT_SLACK_WEBHOOK_URL,
    ).toBe("https://hooks.slack.com/services/T/B/x");
  });

  it("a short shared secret is refused in production and on a deployed dev instance, by key name", () => {
    for (const key of [
      "INTEGRATION_API_TOKEN",
      "INGEST_API_TOKEN",
      "EXPORT_API_TOKEN",
      "OUTBOX_API_TOKEN",
      "REPLY_TOKEN_SECRET",
    ]) {
      expectMessageNaming(
        messageOf(() => parseEnv(raw({ ...PROD_OK, [key]: SHORT_SECRET }))),
        "Production environment invariants violated for:",
        key,
        `production ${key}`,
      );
      expectMessageNaming(
        messageOf(() => parseEnv(raw({ ...DEPLOYED_DEV_OK, [key]: SHORT_SECRET }))),
        "Deployed environment invariants violated for:",
        key,
        `deployed dev ${key}`,
      );
    }
    // The pre-existing rule for CLIENT_API_TOKEN is the same rule, unchanged.
    expect(() => parseEnv(raw({ ...PROD_OK, CLIENT_API_TOKEN: SHORT_SECRET }))).toThrow(/CLIENT_API_TOKEN/);
  });

  it("a short shared secret is NOT refused in local development — a developer is not network-reachable", () => {
    const parsed = parseEnv(raw({ NODE_ENV: "development", INTEGRATION_API_TOKEN: SHORT_SECRET }));
    expect(parsed.INTEGRATION_API_TOKEN).toBe(SHORT_SECRET);
  });

  it("a full Wave A production configuration parses", () => {
    const parsed = parseEnv(
      raw({
        ...PROD_OK,
        INTEGRATION_API_TOKEN: LONG_SECRET,
        REPLY_TOKEN_SECRET: LONG_SECRET,
        MAILBOX_MAP: '{"ops@example.com":{"queueKey":"OPERATIONS","brand":"CEDAR_RIDGE_WEALTH"}}',
        ATTACHMENTS_BUCKET: "wm-helpdesk-prod-attachments",
        ATTACHMENTS_SIGNER_EMAIL: "service-account@example-project.iam.gserviceaccount.com",
        DUPLICATE_COPY_BUCKET: "wm-helpdesk-prod-duplicate-copy",
        SLA_ALERT_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
        SLACK_QUEUE_WEBHOOKS: '{"OPERATIONS":"https://hooks.slack.com/services/T/B/y"}',
        JOB_ACTOR_EMAIL: "jobs@wm-helpdesk.local",
      }),
    );
    expect(parsed.INTEGRATION_API_TOKEN).toBe(LONG_SECRET);
    expect(parsed.ATTACHMENTS_BUCKET).toBe("wm-helpdesk-prod-attachments");
    expect(parsed.JOB_ACTOR_EMAIL).toBe("jobs@wm-helpdesk.local");
  });

  // The per-surface bearers are declared here so the whole credential surface is visible in one place
  // and a short value is refused at boot; `src/lib/integration-scope.ts` is what RESOLVES them per
  // route, and it reads process.env directly (see that module's header for why).
  it("the per-surface machine bearers round-trip and narrow independently of the shared one", () => {
    const parsed = parseEnv(
      raw({
        ...PROD_OK,
        INTEGRATION_API_TOKEN: LONG_SECRET,
        INGEST_API_TOKEN: `${LONG_SECRET}i`,
        EXPORT_API_TOKEN: `${LONG_SECRET}e`,
        OUTBOX_API_TOKEN: `${LONG_SECRET}o`,
      }),
    );
    expect(parsed.INGEST_API_TOKEN).toBe(`${LONG_SECRET}i`);
    expect(parsed.EXPORT_API_TOKEN).toBe(`${LONG_SECRET}e`);
    expect(parsed.OUTBOX_API_TOKEN).toBe(`${LONG_SECRET}o`);
    // Each is independent: setting one does not require the others or the shared key.
    expect(parseEnv(raw({ NODE_ENV: "development", OUTBOX_API_TOKEN: LONG_SECRET })).INTEGRATION_API_TOKEN).toBeUndefined();
  });

  it("APP_BASE_URL must be an absolute https origin, refused by key name otherwise", () => {
    for (const bad of ["http://helpdesk.internal", "helpdesk.internal", "not a url", "/tickets"]) {
      expect(() => parseEnv(raw({ NODE_ENV: "development", APP_BASE_URL: bad })), bad).toThrow(
        /Invalid environment configuration for: .*APP_BASE_URL/,
      );
    }
    expect(parseEnv(raw({ NODE_ENV: "development", APP_BASE_URL: " https://helpdesk.example.com " })).APP_BASE_URL).toBe(
      "https://helpdesk.example.com",
    );
  });

  // Unset must mean "use the module default", NEVER "trust nobody": an empty trusted set authenticates
  // nothing and would hold every inbound message.
  it("trustedAuthservIds: unset and empty-ish values both fall through to the module default", () => {
    expect(trustedAuthservIds(undefined)).toBeUndefined();
    expect(trustedAuthservIds("")).toBeUndefined();
    expect(trustedAuthservIds("   ")).toBeUndefined();
    expect(trustedAuthservIds(",, ,")).toBeUndefined();
  });

  it("trustedAuthservIds: comma-separated, trimmed, lower-cased, duplicates removed", () => {
    expect(trustedAuthservIds("mx.google.com")).toEqual(["mx.google.com"]);
    expect(trustedAuthservIds(" MX.Google.com , mx2.example.net ,mx.google.com")).toEqual([
      "mx.google.com",
      "mx2.example.net",
    ]);
  });

  it("previousReplySecrets: comma-separated, trimmed, empties dropped, duplicates removed", () => {
    expect(previousReplySecrets(undefined)).toEqual([]);
    expect(previousReplySecrets("  ")).toEqual([]);
    expect(previousReplySecrets("a-secret")).toEqual(["a-secret"]);
    expect(previousReplySecrets(" one , two ,, one ,")).toEqual(["one", "two"]);
  });

  it("a RETIRED reply-token secret is held to the same minimum length as the current one", () => {
    // It still verifies tokens, so a short one is the same weakness as a short current secret.
    expect(() =>
      parseEnv(raw({ ...PROD_OK, REPLY_TOKEN_SECRET: LONG_SECRET, REPLY_TOKEN_PREVIOUS_SECRETS: SHORT_SECRET })),
    ).toThrow(/Production environment invariants violated for: .*REPLY_TOKEN_PREVIOUS_SECRETS/);
    expect(() =>
      parseEnv(
        raw({
          ...DEPLOYED_DEV_OK,
          REPLY_TOKEN_SECRET: LONG_SECRET,
          REPLY_TOKEN_PREVIOUS_SECRETS: `${LONG_SECRET},${SHORT_SECRET}`,
        }),
      ),
    ).toThrow(/Deployed environment invariants violated for: .*REPLY_TOKEN_PREVIOUS_SECRETS/);
    // Two long retired values, and a trailing comma, are fine.
    const ok = parseEnv(
      raw({
        ...PROD_OK,
        REPLY_TOKEN_SECRET: LONG_SECRET,
        REPLY_TOKEN_PREVIOUS_SECRETS: `${LONG_SECRET}a,${LONG_SECRET}b,`,
      }),
    );
    expect(previousReplySecrets(ok.REPLY_TOKEN_PREVIOUS_SECRETS)).toHaveLength(2);
  });

  it(".env.example documents every Wave A key", () => {
    const example = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
    for (const key of [
      "INTEGRATION_API_TOKEN",
      "INGEST_API_TOKEN",
      "EXPORT_API_TOKEN",
      "OUTBOX_API_TOKEN",
      "REPLY_TOKEN_SECRET",
      "REPLY_TOKEN_PREVIOUS_SECRETS",
      "APP_BASE_URL",
      "MAILBOX_MAP",
      "EMAIL_TRUSTED_AUTHSERV_IDS",
      "ATTACHMENTS_BUCKET",
      "ATTACHMENTS_SIGNER_EMAIL",
      "DUPLICATE_COPY_BUCKET",
      "SLA_ALERT_SLACK_WEBHOOK_URL",
      "SLACK_QUEUE_WEBHOOKS",
      "JOB_ACTOR_EMAIL",
      "LEGACY_DESK_SUBDOMAIN",
      "LEGACY_DESK_EMAIL",
      "LEGACY_DESK_API_TOKEN",
    ]) {
      expect(example, `${key} is not documented in .env.example`).toContain(`${key}=`);
    }
  });
});
