import { describe, expect, it } from "vitest";
import { parseAuthenticationResults, TRUSTED_AUTHSERV_IDS } from "@/lib/email/auth-results";
import { INBOUND_FIXTURES, parseRawMessage } from "@/lib/email/__fixtures__/inbound-corpus";

/** The Google Workspace verdict, exactly as Gmail writes it on delivery. */
const GOOGLE_PASS =
  "mx.google.com; spf=pass (google.com: domain of marla@fastmail.test designates 66.111.4.25 as permitted sender) smtp.mailfrom=marla@fastmail.test; dkim=pass header.i=@fastmail.test header.s=fm1 header.b=AbCdEf; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=fastmail.test";

const GOOGLE_FAIL =
  "mx.google.com; spf=softfail (google.com: domain of transitioning marla@fastmail.test does not designate 185.63.44.9 as permitted sender) smtp.mailfrom=bounce@mailer.test; dkim=none; dmarc=fail (p=REJECT sp=REJECT dis=QUARANTINE) header.from=fastmail.test";

/** What an attacker types into the message they compose. It is indistinguishable, as text, from the real thing. */
const FORGED_PASS =
  "mx.google.com; spf=pass; dkim=pass; dmarc=pass header.from=example.com";

describe("parseAuthenticationResults", () => {
  it("reads a Google Workspace pass line", () => {
    expect(parseAuthenticationResults(GOOGLE_PASS)).toEqual({
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      authenticated: true,
      authservId: "mx.google.com",
      trustedAuthserv: true,
      headerCount: 1,
    });
  });

  it("is false for dmarc=fail even when SPF passes", () => {
    const raw = "mx.google.com; spf=pass smtp.mailfrom=bounce@mailer.test; dkim=none; dmarc=fail header.from=fastmail.test";
    expect(parseAuthenticationResults(raw)).toEqual({
      spf: "pass",
      dkim: "none",
      dmarc: "fail",
      authenticated: false,
      authservId: "mx.google.com",
      trustedAuthserv: true,
      headerCount: 1,
    });
  });

  it("is false and 'unknown' everywhere when the header is missing", () => {
    for (const raw of [null, undefined, "", "   "]) {
      expect(parseAuthenticationResults(raw)).toEqual({
        spf: "unknown",
        dkim: "unknown",
        dmarc: "unknown",
        authenticated: false,
        authservId: null,
        trustedAuthserv: false,
        headerCount: 0,
      });
    }
  });

  it("distinguishes 'no header' (unknown) from 'no policy' (none)", () => {
    expect(parseAuthenticationResults("mx.google.com; dmarc=none").dmarc).toBe("none");
    expect(parseAuthenticationResults(undefined).dmarc).toBe("unknown");
    expect(parseAuthenticationResults("mx.google.com; dmarc=none").authenticated).toBe(false);
  });

  it("treats any dkim=pass among several signatures in ONE header as a pass", () => {
    const raw = "mx.google.com; dkim=fail header.i=@a.test; dkim=pass header.i=@b.test; dmarc=pass; spf=pass";
    const verdict = parseAuthenticationResults(raw);
    expect(verdict.dkim).toBe("pass");
    expect(verdict.authenticated).toBe(true);
  });

  it("keeps the first verdict when none of the results pass", () => {
    expect(parseAuthenticationResults("mx.google.com; dkim=temperror; dkim=fail; dmarc=fail").dkim).toBe("temperror");
  });

  it("does not read a property inside a comment as a verdict", () => {
    // `dis=NONE` and `policy.dmarc=` must not overwrite the real dmarc verdict.
    const raw = "mx.google.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE policy.dmarc=fail) header.from=x.test";
    expect(parseAuthenticationResults(raw).dmarc).toBe("pass");
  });

  it("does not read arc-dkim or header.spf as a verdict", () => {
    const raw = "mx.google.com; arc-dkim=fail; header.spf=fail; dmarc=pass";
    const verdict = parseAuthenticationResults(raw);
    expect(verdict.dkim).toBe("unknown");
    expect(verdict.spf).toBe("unknown");
    expect(verdict.authenticated).toBe(true);
  });

  it("maps an unrecognised verdict word to 'unknown' rather than trusting it", () => {
    expect(parseAuthenticationResults("mx.google.com; dmarc=definitely-fine").dmarc).toBe("unknown");
    expect(parseAuthenticationResults("mx.google.com; dmarc=definitely-fine").authenticated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // RFC 8601 §5 — only the topmost header, written by the trusted MTA, counts.
  // -------------------------------------------------------------------------

  describe("only the topmost header is read", () => {
    it("REFUSES a forged pass appended below the receiving MTA's fail", () => {
      // The attack: the sender puts their own Authentication-Results into the message they compose.
      // Gmail prepends its real verdict and does not strip theirs, so both arrive.
      const verdict = parseAuthenticationResults(`${GOOGLE_FAIL}\n${FORGED_PASS}`);
      expect(verdict.dmarc).toBe("fail");
      expect(verdict.authenticated).toBe(false);
      expect(verdict.headerCount).toBe(2);
    });

    it("does not let a forged pass rescue any single method either", () => {
      const verdict = parseAuthenticationResults(`${GOOGLE_FAIL}\n${FORGED_PASS}`);
      expect(verdict.spf).toBe("softfail");
      expect(verdict.dkim).toBe("none");
    });

    it("ignores a second header even when the first one is a pass", () => {
      const verdict = parseAuthenticationResults(`${GOOGLE_PASS}\nmx.google.com; dmarc=fail`);
      expect(verdict.dmarc).toBe("pass");
      expect(verdict.headerCount).toBe(2);
      expect(verdict.authenticated).toBe(true);
    });

    it("does not assemble one verdict out of several headers", () => {
      // Previously these three joined lines produced a full pass. Only the first line is read now,
      // so DKIM and DMARC are never stated and the message is unauthenticated.
      const verdict = parseAuthenticationResults(
        "mx.google.com; spf=pass\nmx.google.com; dkim=pass\nmx.google.com; dmarc=pass",
      );
      expect(verdict.spf).toBe("pass");
      expect(verdict.dkim).toBe("unknown");
      expect(verdict.dmarc).toBe("unknown");
      expect(verdict.authenticated).toBe(false);
    });

    it("counts headers without being confused by blank or whitespace-only lines", () => {
      expect(parseAuthenticationResults(`\n  \n${GOOGLE_PASS}\n\n`).authenticated).toBe(true);
      expect(parseAuthenticationResults(`\n  \n${GOOGLE_PASS}\n\n`).headerCount).toBe(1);
    });

    it("tolerates \\r\\n-style trailing whitespace around a header", () => {
      expect(parseAuthenticationResults(`  ${GOOGLE_PASS}  `).authenticated).toBe(true);
    });
  });

  describe("authserv-id", () => {
    it("trusts mx.google.com and nothing else by default", () => {
      expect(TRUSTED_AUTHSERV_IDS).toEqual(["mx.google.com"]);
    });

    it("refuses a dmarc=pass written by an unrecognised authserv-id", () => {
      const verdict = parseAuthenticationResults("relay.attacker.test; spf=pass; dkim=pass; dmarc=pass");
      expect(verdict.dmarc).toBe("pass");
      expect(verdict.authservId).toBe("relay.attacker.test");
      expect(verdict.trustedAuthserv).toBe(false);
      expect(verdict.authenticated).toBe(false);
    });

    it("refuses a header that states no authserv-id at all", () => {
      const verdict = parseAuthenticationResults("spf=pass; dkim=pass; dmarc=pass");
      expect(verdict.dmarc).toBe("pass");
      expect(verdict.authservId).toBeNull();
      expect(verdict.trustedAuthserv).toBe(false);
      expect(verdict.authenticated).toBe(false);
    });

    it("accepts the optional RFC 8601 version token after the authserv-id", () => {
      const verdict = parseAuthenticationResults("mx.google.com 1; spf=pass; dkim=pass; dmarc=pass");
      expect(verdict.authservId).toBe("mx.google.com");
      expect(verdict.authenticated).toBe(true);
    });

    it("compares the authserv-id case-insensitively", () => {
      expect(parseAuthenticationResults("MX.Google.COM; dmarc=pass").authenticated).toBe(true);
    });

    it("does not read a comment before the semicolon as the authserv-id", () => {
      expect(parseAuthenticationResults("mx.google.com (Google Workspace); dmarc=pass").authservId).toBe(
        "mx.google.com",
      );
    });

    it("refuses a lookalike authserv-id", () => {
      for (const id of ["mx.google.com.attacker.test", "mx-google.com", "notmx.google.com"]) {
        expect(parseAuthenticationResults(`${id}; dmarc=pass`).authenticated).toBe(false);
      }
    });

    it("honours an explicit trust list, and trusts nobody when it is empty", () => {
      expect(parseAuthenticationResults("mail.example.test; dmarc=pass", ["mail.example.test"]).authenticated).toBe(
        true,
      );
      expect(parseAuthenticationResults(GOOGLE_PASS, []).authenticated).toBe(false);
      expect(parseAuthenticationResults(GOOGLE_PASS, ["  "]).authenticated).toBe(false);
    });
  });

  it("agrees with every fixture in the corpus", () => {
    const byKey = new Map(
      INBOUND_FIXTURES.map((f) => [f.key, parseAuthenticationResults(parseRawMessage(f.raw).headers["authentication-results"])]),
    );
    expect(byKey.get("new-thread-plain")?.authenticated).toBe(true);
    expect(byKey.get("new-thread-plain")?.authservId).toBe("mx.google.com");
    expect(byKey.get("unauthenticated-dmarc-fail")?.authenticated).toBe(false);
    expect(byKey.get("unauthenticated-dmarc-fail")?.spf).toBe("softfail");
    expect(byKey.get("unauthenticated-no-header")?.authenticated).toBe(false);
    expect(byKey.get("unauthenticated-no-header")?.dmarc).toBe("unknown");
  });

  it("holds every fixture the corpus expects to be UNAUTHENTICATED", () => {
    for (const fixture of INBOUND_FIXTURES) {
      const header = parseRawMessage(fixture.raw).headers["authentication-results"];
      const verdict = parseAuthenticationResults(header);
      if (verdict.authenticated) {
        expect(verdict.authservId, `${fixture.key} authenticated on an untrusted authserv-id`).toBe("mx.google.com");
      }
    }
  });
});
