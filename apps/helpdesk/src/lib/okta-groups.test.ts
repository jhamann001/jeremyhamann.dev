/**
 * Okta scope/claim configuration and the advisor platform group-name mapping (#59).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPS_PORTAL_GROUP_MAP,
  DEFAULT_OKTA_GROUPS_CLAIM,
  DEFAULT_OKTA_SCOPE,
  OKTA_APP_CODES,
  SCALAR_OIDC_CLAIMS,
  opsPortalRoleName,
  extractRawGroups,
  isReadOnlyRoleName,
  isValidOktaGroupsClaim,
  isValidOktaScope,
  mapOktaGroupNames,
  normalizeOktaGroupName,
  oktaGroupsClaim,
  oktaScope,
  splitOktaGroupName,
} from "@/lib/okta-groups";
import { isDualRole } from "@/lib/rbac";
import { OKTA_GROUPS } from "@/types/domain";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("defaults", () => {
  it("scope and claim default to the pre-#58 literals", () => {
    expect(DEFAULT_OKTA_SCOPE).toBe("openid profile email groups");
    expect(DEFAULT_OKTA_GROUPS_CLAIM).toBe("groups");
  });
});

describe("oktaScope()", () => {
  it("returns the default when AUTH_OKTA_SCOPE is unset or blank", () => {
    vi.stubEnv("AUTH_OKTA_SCOPE", "");
    expect(oktaScope()).toBe(DEFAULT_OKTA_SCOPE);
    vi.stubEnv("AUTH_OKTA_SCOPE", "   ");
    expect(oktaScope()).toBe(DEFAULT_OKTA_SCOPE);
  });

  it("returns the trimmed override when it contains openid (the OPS-PORTAL-reuse value)", () => {
    vi.stubEnv("AUTH_OKTA_SCOPE", "  openid email profile ops_portal_groups ");
    expect(oktaScope()).toBe("openid email profile ops_portal_groups");
  });

  it("falls back to the default when the override lacks the openid token (a substring is not a token)", () => {
    vi.stubEnv("AUTH_OKTA_SCOPE", "email profile ops_portal_groups");
    expect(oktaScope()).toBe(DEFAULT_OKTA_SCOPE);
    vi.stubEnv("AUTH_OKTA_SCOPE", "openidx email");
    expect(oktaScope()).toBe(DEFAULT_OKTA_SCOPE);
  });

  it("isValidOktaScope mirrors the same rule", () => {
    expect(isValidOktaScope("openid")).toBe(true);
    expect(isValidOktaScope("openid email profile ops_portal_groups")).toBe(true);
    expect(isValidOktaScope("email profile")).toBe(false);
    expect(isValidOktaScope("")).toBe(false);
    expect(isValidOktaScope("  ")).toBe(false);
  });
});

describe("oktaGroupsClaim()", () => {
  it("returns the default when AUTH_OKTA_GROUPS_CLAIM is unset or blank", () => {
    vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", "");
    expect(oktaGroupsClaim()).toBe("groups");
  });

  it("returns the trimmed override when it is an identifier (OpsPortalGroups)", () => {
    vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", " OpsPortalGroups ");
    expect(oktaGroupsClaim()).toBe("OpsPortalGroups");
    vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", "_g1");
    expect(oktaGroupsClaim()).toBe("_g1");
  });

  it("falls back to the default for anything that is not an identifier", () => {
    for (const bad of ["1groups", "opsportal-groups", "a.b", "a b", "x".repeat(65), "groups!"]) {
      vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", bad);
      expect(oktaGroupsClaim(), bad).toBe("groups");
      expect(isValidOktaGroupsClaim(bad), bad).toBe(false);
    }
    expect(isValidOktaGroupsClaim("x".repeat(64))).toBe(true);
  });

  it("refuses well-known scalar OIDC claim names case-insensitively, so a mis-pointed claim fails at boot (Decision #59)", () => {
    for (const scalar of ["email", "name", "sub", "preferred_username", "given_name", "Email", "NAME", " sub "]) {
      expect(isValidOktaGroupsClaim(scalar), scalar).toBe(false);
      vi.stubEnv("AUTH_OKTA_GROUPS_CLAIM", scalar);
      expect(oktaGroupsClaim(), scalar).toBe("groups"); // defensive fallback behind parseEnv's refusal
    }
    for (const ok of ["groups", "OpsPortalGroups", "ops_portal_groups", "memberOf", "roles"]) {
      expect(isValidOktaGroupsClaim(ok), ok).toBe(true);
    }
    expect(SCALAR_OIDC_CLAIMS).toContain("email");
    expect(SCALAR_OIDC_CLAIMS).not.toContain("groups");
    expect(SCALAR_OIDC_CLAIMS.every((c) => c === c.toLowerCase())).toBe(true); // compared lower-cased
  });
});

describe("extractRawGroups()", () => {
  it("reads the configured claim first, then falls back to `groups` (OPS_PORTAL's order, claim configurable)", () => {
    expect(extractRawGroups({ OpsPortalGroups: ["OPSPORTAL-Operations"], groups: ["ops_team"] }, "OpsPortalGroups")).toEqual([
      "OPSPORTAL-Operations",
    ]);
    expect(extractRawGroups({ groups: ["ops_team"] }, "OpsPortalGroups")).toEqual(["ops_team"]);
    expect(extractRawGroups({ OpsPortalGroups: null, groups: ["ops_team"] }, "OpsPortalGroups")).toEqual(["ops_team"]);
    expect(extractRawGroups({ OpsPortalGroups: [], groups: ["ops_team"] }, "OpsPortalGroups")).toEqual([]); // [] is a value, not absence
  });

  it("yields undefined for a missing claim and for non-object profiles; inherited properties are not read", () => {
    expect(extractRawGroups({ sub: "00u1" }, "groups")).toBeUndefined();
    expect(extractRawGroups(undefined, "groups")).toBeUndefined();
    expect(extractRawGroups(null, "groups")).toBeUndefined();
    expect(extractRawGroups("groups", "groups")).toBeUndefined();
    expect(extractRawGroups({ sub: "00u1" }, "constructor")).toBeUndefined();
    expect(extractRawGroups({ sub: "00u1" }, "toString")).toBeUndefined();
  });
});

describe("normalizeOktaGroupName()", () => {
  it("lower-cases, strips one leading <code>- prefix, collapses punctuation to single spaces, trims", () => {
    expect(normalizeOktaGroupName("OPSPORTAL-Ops Read/Write")).toBe("ops read write");
    expect(normalizeOktaGroupName("OPSPORTAL-Advisory Ops Lead")).toBe("advisory ops lead");
    expect(normalizeOktaGroupName("OPSPORTAL- Client  Service")).toBe("client service");
    expect(normalizeOktaGroupName("opsportal-opsportal-admin")).toBe("opsportal admin"); // only ONE prefix is stripped
  });

  it("leaves names without a `<code>-` prefix alone apart from case and punctuation", () => {
    expect(normalizeOktaGroupName("compliance_officers")).toBe("compliance officers");
    expect(normalizeOktaGroupName("Client Service")).toBe("client service");
    expect(normalizeOktaGroupName("-Ops")).toBe("ops"); // no code before the dash → nothing stripped; dash → space → trimmed
  });

  it("is text-only: a foreign app code is stripped like any other; eligibility is opsPortalRoleName's job", () => {
    expect(normalizeOktaGroupName("IT-Admin")).toBe("admin");
    expect(opsPortalRoleName("IT-Admin")).toBeNull();
  });
});

describe("splitOktaGroupName() / opsPortalRoleName() — app-code allowlist (Decision #59)", () => {
  it("splits one `<code>-` prefix into a lower-cased code and a normalised role part", () => {
    expect(splitOktaGroupName("OPSPORTAL-Ops Read/Write")).toEqual({ code: "opsportal", role: "ops read write" });
    expect(splitOktaGroupName("OPSPORTAL- Client  Service")).toEqual({ code: "opsportal", role: "client service" });
    expect(splitOktaGroupName("opsportal-opsportal-admin")).toEqual({ code: "opsportal", role: "opsportal admin" });
    expect(splitOktaGroupName("OPSPORTAL-")).toEqual({ code: "opsportal", role: "" });
    expect(splitOktaGroupName("compliance_officers")).toBeNull();
    expect(splitOktaGroupName("-Ops")).toBeNull();
    expect(splitOktaGroupName("")).toBeNull();
  });

  it("only `opsPortal` is an eligible code today", () => {
    expect(OKTA_APP_CODES).toEqual(["opsportal"]);
    expect(opsPortalRoleName("OPSPORTAL-Operations")).toBe("operations");
    expect(opsPortalRoleName("opsportal-operations")).toBe("operations");
    for (const foreign of ["IT-Admin", "Slack-Admin", "CRM-Admin", "WMHD-Ops", "Finance-Read Only", "OTHERAPP- Ops Read/Write"]) {
      expect(opsPortalRoleName(foreign), foreign).toBeNull();
    }
    for (const unprefixed of ["Client Service", "Compliance_Officers", "Everyone", "admin", ""]) {
      expect(opsPortalRoleName(unprefixed), unprefixed).toBeNull();
    }
  });
});

describe("mapOktaGroupNames() — the advisor platform names (Decision #58)", () => {
  it.each([
    ["OPSPORTAL-Operations", ["ops_team"]],
    ["OPSPORTAL-Ops Read/Write", ["ops_team"]],
    ["OPSPORTAL-Advisory Ops Lead", ["ops_team"]],
    ["OPSPORTAL-Client Service", ["client_services"]],
    ["OPSPORTAL-Client Services", ["client_services"]],
    ["OPSPORTAL-Advisor", ["advisors"]],
    ["OPSPORTAL-Advisors", ["advisors"]],
    ["OPSPORTAL-Compliance", ["compliance_officers"]],
    ["OPSPORTAL-Admin", ["ops_team", "advisors", "client_services", "compliance_officers"]],
  ])("%s → %j", (name, expected) => {
    expect(mapOktaGroupNames([name])).toEqual(expected);
  });

  it("OPSPORTAL-Admin becomes a full operator plus compliance and is flagged dual-role by the existing rbac helper", () => {
    const groups = mapOktaGroupNames(["OPSPORTAL-Admin"]);
    expect(groups).toEqual([...OKTA_GROUPS]);
    expect(isDualRole(groups)).toBe(true);
  });

  it("an advisory ops lead is operations, not advisors; `advisory` never matches the advisor rule", () => {
    expect(mapOktaGroupNames(["OPSPORTAL-Advisory Ops Lead"])).toEqual(["ops_team"]);
    expect(mapOktaGroupNames(["OPSPORTAL-Advisory"])).toEqual([]);
  });

  it("several names → the union, deduplicated, in OKTA_GROUPS order", () => {
    expect(mapOktaGroupNames(["OPSPORTAL-Advisor", "OPSPORTAL-Operations"])).toEqual(["ops_team", "advisors"]);
    expect(mapOktaGroupNames(["OPSPORTAL-Operations", "OPSPORTAL-Ops Read/Write", "ops_team"])).toEqual(["ops_team"]);
    expect(mapOktaGroupNames(["OPSPORTAL-Compliance", "OPSPORTAL-Client Service", "OPSPORTAL-Advisor", "OPSPORTAL-Operations"])).toEqual([
      "ops_team",
      "advisors",
      "client_services",
      "compliance_officers",
    ]);
  });

  it("exact internal values pass through untouched (parseGroups semantics), mixed with the advisor platform names", () => {
    expect(mapOktaGroupNames(["ops_team", "advisors", "client_services", "compliance_officers"])).toEqual([
      ...OKTA_GROUPS,
    ]);
    expect(mapOktaGroupNames(["compliance_officers", "OPSPORTAL-Advisor"])).toEqual(["advisors", "compliance_officers"]);
  });

  it("a bare string is kept only when it is itself an exact internal value; it is never run through the advisor platform map (Decision #59)", () => {
    expect(mapOktaGroupNames("ops_team")).toEqual(["ops_team"]);
    expect(mapOktaGroupNames("compliance_officers")).toEqual(["compliance_officers"]);
    expect(mapOktaGroupNames("OPSPORTAL-Operations")).toEqual([]);
    expect(mapOktaGroupNames("OPSPORTAL-Admin")).toEqual([]);
    expect(mapOktaGroupNames("Ops Desk")).toEqual([]);
  });

  it("a scalar claim value that looks like a mailbox or a display name grants nothing (fail closed, I12)", () => {
    // What a claim mis-pointed at `email`, `name` or `preferred_username` would hand the mapper.
    expect(mapOktaGroupNames("admin@example.com")).toEqual([]);
    expect(mapOktaGroupNames("cs.team@example.com")).toEqual([]);
    expect(mapOktaGroupNames("compliance@example.com")).toEqual([]);
    expect(mapOktaGroupNames("Ops Desk")).toEqual([]);
    expect(mapOktaGroupNames("OPSPORTAL-Admin")).toEqual([]);
    // Even inside an array these are not eligible names (no `ops-portal-` prefix; `@` is punctuation, not a code separator).
    expect(mapOktaGroupNames(["admin@example.com", "Ops Desk"])).toEqual([]);
  });

  it("only `ops-portal-` prefixed names are eligible; internal names with underscores pass only as exact values (Decision #59)", () => {
    expect(mapOktaGroupNames(["compliance_officers"])).toEqual(["compliance_officers"]);
    expect(mapOktaGroupNames(["Compliance_Officers"])).toEqual([]); // not exact, no `ops-portal-` prefix → dropped
    expect(mapOktaGroupNames(["Client Service"])).toEqual([]);
    expect(mapOktaGroupNames(["WMHD-Ops"])).toEqual([]); // foreign app code: the map no longer relies on the claim filter as the only perimeter
    for (const foreign of ["IT-Admin", "Slack-Admin", "CRM-Admin", "Okta-Admin", "GCP-Admin"]) {
      expect(mapOktaGroupNames([foreign]), foreign).toEqual([]);
    }
  });

  it("`admin` grants all four ONLY as the whole role name; an admin qualifier inside another role grants that role alone (Decision #59)", () => {
    expect(mapOktaGroupNames(["OPSPORTAL-Admin"])).toEqual([...OKTA_GROUPS]);
    expect(mapOktaGroupNames(["opsportal-admin"])).toEqual([...OKTA_GROUPS]);
    expect(mapOktaGroupNames(["OPSPORTAL- Admin "])).toEqual([...OKTA_GROUPS]);
    expect(mapOktaGroupNames(["OPSPORTAL-Client Service Admin"])).toEqual(["client_services"]);
    expect(mapOktaGroupNames(["OPSPORTAL-Advisor Admin Assistant"])).toEqual(["advisors"]);
    expect(mapOktaGroupNames(["OPSPORTAL-Ops Admin"])).toEqual(["ops_team"]);
    expect(mapOktaGroupNames(["OPSPORTAL-Admin Assistant"])).toEqual([]);
    expect(mapOktaGroupNames(["OPSPORTAL-Super Admin"])).toEqual([]);
    expect(mapOktaGroupNames(["opsportal-opsportal-admin"])).toEqual([]); // only one prefix strips; "opsportal admin" is not the whole-name token
    expect(isDualRole(mapOktaGroupNames(["OPSPORTAL-Client Service Admin"]))).toBe(false);
  });

  it("an access-level marker `Read Only` / `Viewer` grants nothing — §b scopes by access level, ops_team is WRITE (Decision #59)", () => {
    for (const ro of [
      "OPSPORTAL-Ops Read Only",
      "OPSPORTAL-Operations Read Only",
      "OPSPORTAL-Ops Read-Only",
      "OPSPORTAL-Ops ReadOnly",
      "OPSPORTAL-Read Only Ops",
      "OPSPORTAL-Client Service Read Only",
      "OPSPORTAL-Advisor Read Only",
      "OPSPORTAL-Compliance Read Only",
      "OPSPORTAL-Admin Read Only",
      "OPSPORTAL-Ops Viewer",
      "OPSPORTAL-Read Only",
      "OPSPORTAL-Viewer",
    ]) {
      expect(mapOktaGroupNames([ro]), ro).toEqual([]);
    }
    expect(mapOktaGroupNames(["OPSPORTAL-Ops Read/Write"])).toEqual(["ops_team"]); // read/write is not read-only
    expect(mapOktaGroupNames(["OPSPORTAL-Ops Read Only", "OPSPORTAL-Advisor"])).toEqual(["advisors"]); // per-name, not per-claim
    expect(isReadOnlyRoleName("ops read only")).toBe(true);
    expect(isReadOnlyRoleName("ops readonly")).toBe(true);
    expect(isReadOnlyRoleName("viewer")).toBe(true);
    expect(isReadOnlyRoleName("ops read write")).toBe(false);
    expect(isReadOnlyRoleName("operations")).toBe(false);
  });

  it("the `cs` shorthand is gone: only the phrase `client service(s)` maps (Decision #59)", () => {
    expect(mapOktaGroupNames(["OPSPORTAL-CS"])).toEqual([]);
    expect(mapOktaGroupNames(["OPSPORTAL-Client Service"])).toEqual(["client_services"]);
  });

  it("unknown, empty and non-string entries are dropped (fail closed, I12)", () => {
    expect(mapOktaGroupNames(["Finance-Read Only"])).toEqual([]);
    expect(mapOktaGroupNames(["OPSPORTAL-Viewer"])).toEqual([]);
    expect(mapOktaGroupNames(["OPSPORTAL-"])).toEqual([]);
    expect(mapOktaGroupNames([""])).toEqual([]);
    expect(mapOktaGroupNames([42, null, {}, undefined, true, ["OPSPORTAL-Admin"]])).toEqual([]);
    expect(mapOktaGroupNames(["Everyone", "OPSPORTAL-Read Only", "OPSPORTAL-Advisor"])).toEqual(["advisors"]);
  });

  it("never throws on garbage input", () => {
    for (const garbage of [undefined, null, 42, {}, { length: 1 }, Symbol("x"), () => "OPSPORTAL-Admin", new Date(), NaN]) {
      expect(() => mapOktaGroupNames(garbage)).not.toThrow();
      expect(mapOktaGroupNames(garbage)).toEqual([]);
    }
    const throwingToString = { toString: () => { throw new Error("boom"); } };
    expect(mapOktaGroupNames([throwingToString])).toEqual([]);
  });

  it("only listens to tokens: substrings inside other words do not match", () => {
    expect(mapOktaGroupNames(["OPSPORTAL-Administrators"])).toEqual([]); // "administrators" is not the whole-name "admin"
    expect(mapOktaGroupNames(["OPSPORTAL-Topsy"])).toEqual([]); // contains "ops" but not as a token
    expect(mapOktaGroupNames(["OPSPORTAL-Complianceish"])).toEqual([]);
  });
});

describe("OPS_PORTAL_GROUP_MAP as data", () => {
  it("is a readonly list of {name, test, groups} whose groups are all known and whose patterns carry no global flag", () => {
    expect(OPS_PORTAL_GROUP_MAP.length).toBe(5);
    for (const rule of OPS_PORTAL_GROUP_MAP) {
      expect(typeof rule.name).toBe("string");
      expect(rule.test).toBeInstanceOf(RegExp);
      expect(rule.test.global).toBe(false); // a /g regex would keep lastIndex state between calls
      expect(rule.groups.length).toBeGreaterThan(0);
      for (const g of rule.groups) expect(OKTA_GROUPS).toContain(g);
    }
  });

  it("the admin rule grants all four groups and is anchored to the whole role name; every other rule grants exactly one", () => {
    const admin = OPS_PORTAL_GROUP_MAP.find((r) => r.name === "admin");
    expect(admin?.groups).toEqual(["ops_team", "advisors", "client_services", "compliance_officers"]);
    expect(admin?.test.source).toBe("^admin$");
    expect(OPS_PORTAL_GROUP_MAP.some((r) => r.test.test("cs"))).toBe(false);
    for (const rule of OPS_PORTAL_GROUP_MAP.filter((r) => r.name !== "admin")) {
      expect(rule.groups.length, rule.name).toBe(1);
    }
  });
});
