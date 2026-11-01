/**
 * `src/lib/google-domain.ts` — the temporary Google sign-in's domain gate.
 *
 * The property under test is not "the happy path works". It is that there is NO input for which this module
 * admits an identity it should not, and in particular no input for which the allowlist becomes empty and is
 * then read as permissive. The refusal cases below are therefore the point of the file, and each names the
 * mistake it guards: a suffix test (`evil-example.com`), an unescaped dot in a constructed regexp
 * (`example.com.attacker.tld`), a subdomain treated as the company (`sub.example.com`), a
 * truthiness check on `email_verified` (the STRING `"true"`), and a mailbox check standing in for a
 * Workspace check (a verified company address on a CONSUMER Google account, which carries no `hd`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GOOGLE_DOMAINS,
  allowedGoogleDomains,
  googleGroups,
  isAllowedGoogleProfile,
  isValidGoogleDomain,
  isValidGoogleDomainList,
  isValidGoogleGroupList,
  refusedGoogleDomain,
} from "@/lib/google-domain";

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * `isAllowedGoogleProfile` over a profile assembled from one address.
 *
 * `hd` defaults to the address's own domain, which is the ordinary Workspace shape, so every case below
 * still reads as a statement about the ADDRESS and the `hd` rule gets its own block instead of being
 * smeared across all of them. Where a case would otherwise be refused by BOTH rules at once, the block
 * passes `hd` explicitly so it is clear which rule is doing the work.
 */
function allows(email: unknown, emailVerified: unknown = true, hd: unknown = defaultHd(email)): boolean {
  return isAllowedGoogleProfile({ email, email_verified: emailVerified, hd });
}

function defaultHd(email: unknown): unknown {
  return typeof email === "string" ? (email.trim().toLowerCase().split("@").at(-1) ?? "") : "example.com";
}

describe("DEFAULT_GOOGLE_DOMAINS", () => {
  it("is exactly the two company domains", () => {
    expect([...DEFAULT_GOOGLE_DOMAINS]).toEqual(["example.com", "example.net"]);
  });
});

describe("allowedGoogleDomains — fails closed onto the default, never onto 'any domain'", () => {
  it("unset, empty, whitespace-only and ',,,' all resolve to the hardcoded default", () => {
    // `vi.stubEnv(k, undefined)` deletes the key, which is the "never written" case.
    for (const value of [undefined, "", "   ", ",,,", " , , "] as const) {
      vi.stubEnv("AUTH_GOOGLE_ALLOWED_DOMAINS", value as unknown as string);
      expect(allowedGoogleDomains(), JSON.stringify(value)).toEqual([...DEFAULT_GOOGLE_DOMAINS]);
    }
  });

  it("never returns an empty list for any of those inputs — an empty allowlist must not exist", () => {
    for (const value of [undefined, "", "   ", ",,,", "\t\n"] as const) {
      vi.stubEnv("AUTH_GOOGLE_ALLOWED_DOMAINS", value as unknown as string);
      expect(allowedGoogleDomains().length, JSON.stringify(value)).toBeGreaterThan(0);
    }
  });

  it("parses a written list: trimmed, lower-cased, empties dropped, deduplicated", () => {
    vi.stubEnv("AUTH_GOOGLE_ALLOWED_DOMAINS", "  example.net , example.com ,, example.net ");
    expect(allowedGoogleDomains()).toEqual(["example.net", "example.com"]);
  });

  it("a written list REPLACES the default rather than adding to it", () => {
    vi.stubEnv("AUTH_GOOGLE_ALLOWED_DOMAINS", "example.test");
    expect(allowedGoogleDomains()).toEqual(["example.test"]);
    expect(allows("someone@example.com")).toBe(false);
    expect(allows("someone@example.test")).toBe(true);
  });
});

describe("isAllowedGoogleProfile — the allowlist match is EXACT", () => {
  it("allows the two default domains", () => {
    vi.stubEnv("AUTH_GOOGLE_ALLOWED_DOMAINS", "");
    expect(allows("jeremy@example.com")).toBe(true);
    expect(allows("jeremy@example.net")).toBe(true);
  });

  it("is case-insensitive on the whole address: user@example.com is ALLOWED", () => {
    expect(allows("user@example.com")).toBe(true);
    expect(allows("User.Name@example.net")).toBe(true);
    vi.stubEnv("AUTH_GOOGLE_ALLOWED_DOMAINS", "example.com");
    expect(allows("user@example.com")).toBe(true);
  });

  it("refuses a look-alike prefix — this is what endsWith() would have admitted", () => {
    expect(allows("attacker@evil-example.com")).toBe(false);
    expect(allows("attacker@notexample.net")).toBe(false);
  });

  it("refuses a look-alike suffix — this is what an unescaped dot in a regexp would have admitted", () => {
    expect(allows("attacker@example.com.attacker.tld")).toBe(false);
    expect(allows("attacker@example.net.attacker.tld")).toBe(false);
  });

  it("refuses a subdomain of an allowed domain", () => {
    expect(allows("attacker@sub.example.com")).toBe(false);
    expect(allows("attacker@mail.example.net")).toBe(false);
  });

  it("refuses a malformed address: no @, more than one @, empty local part, empty domain", () => {
    // `hd` is pinned to an ALLOWED domain throughout, so every refusal below is the address parsing
    // doing the work rather than the Workspace rule quietly covering for it.
    const HD = "example.com";
    expect(allows("example.com", true, HD)).toBe(false);
    expect(allows("a@b@example.com", true, HD)).toBe(false);
    expect(allows("attacker@example.com@evil.tld", true, HD)).toBe(false);
    expect(allows("@example.com", true, HD)).toBe(false);
    expect(allows("   @example.com", true, HD)).toBe(false);
    expect(allows("someone@", true, HD)).toBe(false);
    expect(allows("", true, HD)).toBe(false);
  });

  it("refuses a non-string email whatever the verification says", () => {
    for (const value of [undefined, null, 42, {}, ["jeremy@example.com"]]) {
      expect(allows(value), JSON.stringify(value) ?? "undefined").toBe(false);
    }
  });

  it("refuses anything that is not a profile object at all", () => {
    for (const value of [undefined, null, "jeremy@example.com", 42, true]) {
      expect(isAllowedGoogleProfile(value), JSON.stringify(value) ?? "undefined").toBe(false);
    }
  });
});

describe("isAllowedGoogleProfile — email_verified must be exactly true", () => {
  it("refuses false, the STRING \"true\", undefined, null, 1 and an object", () => {
    // Built directly rather than through `allows`: passing `undefined` positionally would trigger the
    // helper's DEFAULT of `true`, so the one case most worth asserting would have tested nothing.
    for (const value of [false, "true", "TRUE", undefined, null, 0, 1, {}, []]) {
      const profile = { email: "jeremy@example.com", email_verified: value, hd: "example.com" };
      expect(isAllowedGoogleProfile(profile), JSON.stringify(value) ?? "undefined").toBe(false);
    }
  });

  it("an unverified address is refused even when its domain is allowed, and a verified one is allowed", () => {
    expect(allows("jeremy@example.com", false)).toBe(false);
    expect(allows("jeremy@example.com", true)).toBe(true);
  });
});

/**
 * The Workspace half. `email` + `email_verified` says somebody proved control of that inbox once; `hd` says
 * Google manages the account under that domain. A PERSONAL Google account can be created against a company
 * address, verified by mail, and then outlive the Workspace account it shadows — it carries `email_verified:
 * true` and NO `hd`, which is the exact shape the first case below refuses.
 */
describe("isAllowedGoogleProfile — the hd claim must be present and allowlisted", () => {
  it("refuses a verified, in-domain address on an account with NO hd — the consumer-account class", () => {
    expect(isAllowedGoogleProfile({ email: "jeremy@example.com", email_verified: true })).toBe(false);
  });

  it("refuses a non-string hd: null, undefined, true, a number, an object, an array of the right domain", () => {
    // Direct, for the same reason as above: `allows(…, …, undefined)` would fall back to the helper's
    // default hd, which is exactly the claim under test.
    for (const hd of [null, undefined, true, 1, {}, ["example.com"]]) {
      const profile = { email: "jeremy@example.com", email_verified: true, hd };
      expect(isAllowedGoogleProfile(profile), JSON.stringify(hd) ?? "undefined").toBe(false);
    }
  });

  it("refuses an hd that is not on the allowlist, however the address reads", () => {
    for (const hd of ["gmail.com", "evil-example.com", "sub.example.com", "", "   "]) {
      expect(allows("jeremy@example.com", true, hd), JSON.stringify(hd)).toBe(false);
    }
  });

  it("allows an hd that is a DIFFERENT allowlisted domain — a Workspace with a secondary domain", () => {
    // Google can issue someone@example.net an hd of the Workspace's primary domain. Both are company
    // domains and both are listed, so demanding hd === the address's domain would refuse a real colleague.
    expect(allows("someone@example.net", true, "example.com")).toBe(true);
    expect(allows("someone@example.com", true, "example.net")).toBe(true);
  });

  it("trims and lower-cases the hd before matching, and matches it EXACTLY", () => {
    expect(allows("jeremy@example.com", true, "  example.com ")).toBe(true);
    expect(allows("jeremy@example.com", true, "example.com.attacker.tld")).toBe(false);
  });

  it("honours a configured allowlist for the hd too, not just for the address", () => {
    vi.stubEnv("AUTH_GOOGLE_ALLOWED_DOMAINS", "example.test");
    expect(allows("someone@example.test", true, "example.test")).toBe(true);
    expect(allows("someone@example.test", true, "example.com")).toBe(false);
  });
});

/**
 * What the REFUSAL audit row is allowed to say. The local part never appears; a domain that is not a
 * plausible bare domain is `null`, so the caller writes the literal `domain:invalid` rather than letting
 * attacker-chosen text into an append-only ledger.
 */
describe("refusedGoogleDomain — the domain only, and only when it is one", () => {
  it("returns the lower-cased domain of a well-formed address, allowlisted or not", () => {
    expect(refusedGoogleDomain("attacker@GMAIL.com")).toBe("gmail.com");
    expect(refusedGoogleDomain("jeremy@example.com")).toBe("example.com");
    expect(refusedGoogleDomain(" Someone@Sub.example.net ")).toBe("sub.example.net");
  });

  it("never returns the local part", () => {
    expect(refusedGoogleDomain("first.last+tag@gmail.com")).toBe("gmail.com");
  });

  it("returns null for anything that is not one address with one plausible bare domain", () => {
    for (const value of [
      undefined,
      null,
      42,
      {},
      "",
      "example.com",
      "a@b@example.com",
      "@example.com",
      "someone@",
      "someone@localhost",
      "someone@-evil.com",
      "someone@evil .com",
      `someone@${"a".repeat(260)}.com`,
      "someone@x\u0000.com",
    ]) {
      expect(refusedGoogleDomain(value), JSON.stringify(value) ?? "undefined").toBeNull();
    }
  });
});

describe("googleGroups — unset means no access (I12), unknown names are dropped", () => {
  it("unset or blank yields []", () => {
    for (const value of [undefined, "", "   ", ",,,"] as const) {
      vi.stubEnv("AUTH_GOOGLE_GROUPS", value as unknown as string);
      expect(googleGroups(), JSON.stringify(value)).toEqual([]);
    }
  });

  it("parses known groups, drops unknown ones, dedupes and orders per OKTA_GROUPS", () => {
    vi.stubEnv("AUTH_GOOGLE_GROUPS", " client_services , ops_team ,not_a_group, ops_team ");
    expect(googleGroups()).toEqual(["ops_team", "client_services"]);
  });

  it("an OPS-PORTAL-style name is NOT mapped here — only exact internal values grant anything", () => {
    vi.stubEnv("AUTH_GOOGLE_GROUPS", "OPSPORTAL-Operations,OPSPORTAL-Admin");
    expect(googleGroups()).toEqual([]);
  });
});

describe("isValidGoogleDomain / isValidGoogleDomainList — what parseEnv refuses at boot", () => {
  it("accepts bare domains", () => {
    for (const ok of ["example.com", "example.net", "a.co", "sub.example.co.uk", "xn--80ak6aa92e.com"]) {
      expect(isValidGoogleDomain(ok), ok).toBe(true);
    }
  });

  it("refuses a scheme, an @, whitespace, a single label, and a leading/trailing dot or hyphen", () => {
    for (const bad of [
      "https://example.com",
      "user@example.com",
      "cedarRidge wealth.com",
      "cedarridgewealth",
      ".example.com",
      "example.com.",
      "-example.com",
      "cedarridgewealth-.com",
      "ever..greenwealth.com",
      "example.com/path",
      "example.com:443",
      "*.example.com",
      "",
      "   ",
    ]) {
      expect(isValidGoogleDomain(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("a list is valid only when it has at least one entry and every entry is a domain", () => {
    expect(isValidGoogleDomainList("example.com")).toBe(true);
    expect(isValidGoogleDomainList(" example.com , example.net ")).toBe(true);
    // A written value that resolves to nothing is refused at boot, even though the runtime helper above
    // safely falls back to the default — the two answer different questions.
    expect(isValidGoogleDomainList(",,,")).toBe(false);
    expect(isValidGoogleDomainList("example.com,not a domain")).toBe(false);
    expect(isValidGoogleDomainList("example.com,@example.net")).toBe(false);
  });
});

describe("isValidGoogleGroupList — what parseEnv refuses at boot", () => {
  it("accepts a list of known internal groups", () => {
    expect(isValidGoogleGroupList("ops_team")).toBe(true);
    expect(isValidGoogleGroupList(" ops_team , client_services , advisors , compliance_officers ")).toBe(true);
  });

  it("refuses an unknown name, an OPS-PORTAL-style name and a list that resolves to nothing", () => {
    expect(isValidGoogleGroupList("ops-team")).toBe(false);
    expect(isValidGoogleGroupList("ops_team,not_a_group")).toBe(false);
    expect(isValidGoogleGroupList("OPSPORTAL-Operations")).toBe(false);
    expect(isValidGoogleGroupList(",,,")).toBe(false);
  });
});
