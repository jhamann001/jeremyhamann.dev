/**
 * The dev-only requester-domain guard. Reviewed and extended by slice B11,
 * which owns `src/lib/requester-guard.ts` from the foundation hand-over.
 *
 * Two properties matter more than the matching itself: UNSET means no guard (never "allow nothing"),
 * and the refusal names the DOMAIN rather than echoing the client's address into an error body.
 *
 * B11 added the three cases below the foundation's, each of which is a way this control could be
 * believed to work while not working:
 *
 *  - **A leading dot is not a wildcard.** `.example.com` reads to a person like "and its subdomains".
 *    `allowedRequesterDomains` strips the dot and the matcher compares whole domains, so it means
 *    `example.com` EXACTLY — and `mail.example.com` is still refused. If the desk ever wants subdomain
 *    matching it has to be written, and the writing is what the reviewer would see.
 *  - **The guard runs before the write, at the one call site that matters.** A guard nothing calls is a
 *    comment; this asserts `createTicketCore` calls it, and calls it before it records anything.
 *  - **Production leaves it unset by design**, and `.env.example` says why — so a future operator
 *    setting it "for safety" in production, where the domain list is every domain Cedar Ridge's clients
 *    use, is making a decision against a written one rather than filling in a blank.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allowedRequesterDomains } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { assertRequesterAllowed, isRequesterDomainAllowed } from "@/lib/requester-guard";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const DOMAINS = ["example.com", "test.invalid"];

describe("allowedRequesterDomains", () => {
  it("undefined for unset, and for a value that lists nothing usable — never an empty list", () => {
    // An empty list would be fail-closed in the wrong direction: it would refuse EVERY ticket.
    expect(allowedRequesterDomains(undefined)).toBeUndefined();
    expect(allowedRequesterDomains("")).toBeUndefined();
    expect(allowedRequesterDomains("  , ,")).toBeUndefined();
  });

  it("lower-cases, trims, drops a leading dot and de-duplicates", () => {
    expect(allowedRequesterDomains(" Example.COM , .test.invalid ,example.com ")).toEqual([
      "example.com",
      "test.invalid",
    ]);
  });
});

describe("isRequesterDomainAllowed", () => {
  it("matches the domain exactly, case-insensitively", () => {
    expect(isRequesterDomainAllowed("a@example.com", DOMAINS)).toBe(true);
    // The DOMAIN half of an address is case-insensitive by RFC, so the guard lower-cases it before
    // comparing. The local part is left alone — it is not what this decides on.
    expect(isRequesterDomainAllowed("A@EXAMPLE.COM", DOMAINS)).toBe(true);
    expect(isRequesterDomainAllowed("a@test.invalid", DOMAINS)).toBe(true);
    expect(isRequesterDomainAllowed("a@other.test", DOMAINS)).toBe(false);
  });

  it("does NOT match a subdomain — `a.example.com` is a different domain", () => {
    expect(isRequesterDomainAllowed("a@mail.example.com", DOMAINS)).toBe(false);
    expect(isRequesterDomainAllowed("a@example.com.evil.test", DOMAINS)).toBe(false);
  });

  it("allows a phone-only ticket (no address to check) and refuses a malformed one", () => {
    expect(isRequesterDomainAllowed(null, DOMAINS)).toBe(true);
    expect(isRequesterDomainAllowed(undefined, DOMAINS)).toBe(true);
    expect(isRequesterDomainAllowed("not-an-address", DOMAINS)).toBe(false);
  });

  it("takes the LAST @, so a local part containing one cannot smuggle a domain in", () => {
    expect(isRequesterDomainAllowed('"a@example.com"@other.test', DOMAINS)).toBe(false);
  });
});

describe("assertRequesterAllowed", () => {
  it("is a no-op when the guard is unset — production leaves it unset by design", () => {
    expect(() => assertRequesterAllowed("anyone@anywhere.test", undefined)).not.toThrow();
  });

  it("passes an allowed address and a phone-only ticket", () => {
    expect(() => assertRequesterAllowed("a@example.com", DOMAINS)).not.toThrow();
    expect(() => assertRequesterAllowed(null, DOMAINS)).not.toThrow();
  });

  it("throws ValidationError naming the DOMAIN, never the full address", () => {
    let thrown: unknown;
    try {
      assertRequesterAllowed("margaret.thompson@realclient.test", DOMAINS);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    const message = (thrown as ValidationError).message;
    expect(message).toContain("realclient.test");
    // The refusal reaches an error body, and an error body is not a place to echo a client's address.
    expect(message).not.toContain("margaret.thompson");
  });
});

describe("a leading dot is accepted and ignored — it is NOT a subdomain wildcard", () => {
  it("normalises `.example.com` to `example.com`", () => {
    expect(allowedRequesterDomains(".example.com")).toEqual(["example.com"]);
    expect(allowedRequesterDomains(".Example.COM , example.com")).toEqual(["example.com"]);
  });

  it("still refuses a subdomain of a dotted entry, and accepts the domain itself", () => {
    const domains = allowedRequesterDomains(".example.com") ?? [];
    expect(isRequesterDomainAllowed("a@example.com", domains)).toBe(true);
    // The dot looks like a wildcard and is not one. If that is ever wanted, it has to be written.
    expect(isRequesterDomainAllowed("a@mail.example.com", domains)).toBe(false);
    expect(isRequesterDomainAllowed("a@deep.mail.example.com", domains)).toBe(false);
    // And the reverse direction: a longer allowed domain does not admit its parent.
    const deep = allowedRequesterDomains("mail.example.com") ?? [];
    expect(isRequesterDomainAllowed("a@example.com", deep)).toBe(false);
  });

  it("does not let a suffix match stand in for a domain match", () => {
    const domains = ["example.com"];
    expect(isRequesterDomainAllowed("a@notexample.com", domains)).toBe(false);
    expect(isRequesterDomainAllowed("a@example.com.attacker.test", domains)).toBe(false);
    expect(isRequesterDomainAllowed("a@example.co", domains)).toBe(false);
  });

  it("ignores a trailing dot difference rather than accepting the root-anchored form", () => {
    // `example.com.` is the DNS root-anchored spelling. It is not what the list holds, so it is refused
    // rather than quietly normalised — the guard compares strings and says so.
    expect(isRequesterDomainAllowed("a@example.com.", ["example.com"])).toBe(false);
  });
});

describe("the guard is wired where it has to be", () => {
  it("createTicketCore calls assertRequesterAllowed before it records anything", () => {
    const ingest = readFileSync(path.join(ROOT, "src/server/ingest.ts"), "utf8");
    const body = /export async function createTicketCore[\s\S]*?const existing = await findIngestReceipt/.exec(
      ingest,
    )?.[0];
    expect(body, "createTicketCore was restructured — re-check where the guard runs").toBeTruthy();
    expect(body).toContain("assertRequesterAllowed(");
    expect(body).toContain("allowedRequesterDomains(env.ALLOWED_REQUESTER_DOMAINS)");
  });

  it("importTicketCore does NOT apply it — a historical ticket's domain is already a fact", () => {
    // The guard exists to stop a dev instance acquiring a REAL client address on a NEW ticket. An
    // import is a backfill of addresses the firm already corresponded with, and refusing them would
    // make the cutover tool unusable on the one instance where the guard is set.
    const importer = readFileSync(path.join(ROOT, "src/server/import.ts"), "utf8");
    expect(importer).not.toContain("assertRequesterAllowed");
  });
});

describe("production leaves it unset, and the reason is written down", () => {
  it(".env.example ships the key blank and says why", () => {
    const example = readFileSync(path.join(ROOT, ".env.example"), "utf8");
    expect(example).toMatch(/^ALLOWED_REQUESTER_DOMAINS=\s*$/m);
    const block = example.slice(Math.max(0, example.indexOf("ALLOWED_REQUESTER_DOMAINS=") - 800));
    expect(block).toContain("Production leaves it UNSET");
  });

  it("an empty or whitespace-only value is treated as unset, never as an empty allowlist", () => {
    // The failure this forbids: a deploy that sets the variable to "" and silently refuses every
    // ticket the desk receives.
    for (const raw of ["", " ", ",", " , , ", "."]) {
      expect(allowedRequesterDomains(raw)).toBeUndefined();
      expect(() => assertRequesterAllowed("anyone@anywhere.test", allowedRequesterDomains(raw))).not.toThrow();
    }
  });
});
