import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REPLY_TOKEN_PATTERN,
  REPLY_TOKEN_SIGNATURE_BYTES,
  extractReplyToken,
  formatReplyToken,
  verifyReplyToken,
  verifyReplyTokenWithRotation,
} from "@/lib/email/reply-token";

/**
 * The signing keys are derived per run rather than written down: a literal handed to `createHmac` is
 * a security scanner CWE-798 finding ("Usage of Hardcoded HMAC Key") in any tracked file, tests included, and a
 * key that is different on every run is also a stronger test — nothing here may depend on the bytes.
 * Each label keeps the key readable in a failure message; the random tail is what makes them distinct.
 */
function testSecret(label: string): string {
  return `${label}-${randomBytes(24).toString("base64url")}`;
}

const SECRET = testSecret("reply-token-secret-current");
const OTHER_SECRET = testSecret("reply-token-secret-foreign");
const TICKET = "clt7x2q9a0001abcdxyz0001";

describe("formatReplyToken", () => {
  it("produces the contract format: wm.<base64url(id)>.<base64url(first 16 HMAC bytes)>", () => {
    const token = formatReplyToken(TICKET, SECRET);
    expect(token).not.toBeNull();
    const parts = (token as string).split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("wm");
    expect(Buffer.from(parts[1], "base64url").toString("utf8")).toBe(TICKET);

    const expectedSig = createHmac("sha256", SECRET)
      .update(TICKET, "utf8")
      .digest()
      .subarray(0, REPLY_TOKEN_SIGNATURE_BYTES)
      .toString("base64url");
    expect(parts[2]).toBe(expectedSig);
    expect(parts[2]).toHaveLength(22); // 16 bytes, base64url, unpadded
  });

  it("matches REPLY_TOKEN_PATTERN and carries no padding", () => {
    const token = formatReplyToken(TICKET, SECRET) as string;
    expect(REPLY_TOKEN_PATTERN.test(token)).toBe(true);
    expect(token).not.toContain("=");
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
  });

  it("is deterministic for the same id and secret, and differs across secrets", () => {
    expect(formatReplyToken(TICKET, SECRET)).toBe(formatReplyToken(TICKET, SECRET));
    expect(formatReplyToken(TICKET, SECRET)).not.toBe(formatReplyToken(TICKET, OTHER_SECRET));
  });

  it("returns null when the secret is unset or empty — the fail-closed rule", () => {
    expect(formatReplyToken(TICKET, undefined)).toBeNull();
    expect(formatReplyToken(TICKET, "")).toBeNull();
  });

  it("refuses an implausible ticket id rather than signing it", () => {
    expect(formatReplyToken("not a cuid", SECRET)).toBeNull();
    expect(formatReplyToken("", SECRET)).toBeNull();
    expect(formatReplyToken("a".repeat(65), SECRET)).toBeNull();
  });
});

describe("verifyReplyToken", () => {
  it("round-trips the ticket id", () => {
    const token = formatReplyToken(TICKET, SECRET) as string;
    expect(verifyReplyToken(token, SECRET)).toBe(TICKET);
  });

  it("rejects a token signed with another secret", () => {
    const token = formatReplyToken(TICKET, OTHER_SECRET) as string;
    expect(verifyReplyToken(token, SECRET)).toBeNull();
  });

  it("rejects a tampered signature, a tampered id and a swapped pair", () => {
    const token = formatReplyToken(TICKET, SECRET) as string;
    const [, id, sig] = token.split(".");
    // Tamper the FIRST signature character, not the last, and flip it to a guaranteed-different one.
    //
    // The signature is 16 bytes in base64url, so the 22nd character carries only TWO significant
    // bits: exactly four characters are canonical there (A, Q, g, w) and the other sixty re-decode to
    // one of those same four byte values. Splicing a replacement onto `sig.slice(0, 21)` therefore
    // yields a different STRING that, one run in four, is the identical 16 BYTES — an assertion that
    // passes on the string comparison rather than on the signature check, and that broke outright
    // while the replacement was a hard-coded `A`. Every bit of character 0 is significant, so a
    // different character there is a different signature under any reading of the token, whatever
    // the verifier compares. The secret is derived per run; nothing here may depend on its value.
    expect(sig).toHaveLength(22);
    const tamperedSig = `${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    expect(tamperedSig).not.toBe(sig);
    expect(verifyReplyToken(`wm.${id}.${tamperedSig}`, SECRET)).toBeNull();

    // The trailing character, done the way it has to be done: swapped for another CANONICAL one, so
    // the two decode to different bytes however the comparison is implemented.
    const canonicalTail = "AQgw";
    expect(canonicalTail).toContain(sig[21]);
    const rotatedTail = canonicalTail[(canonicalTail.indexOf(sig[21]) + 1) % canonicalTail.length];
    expect(rotatedTail).not.toBe(sig[21]);
    expect(verifyReplyToken(`wm.${id}.${sig.slice(0, 21)}${rotatedTail}`, SECRET)).toBeNull();

    const otherId = Buffer.from("clt7x2q9a0001abcdxyz0002", "utf8").toString("base64url");
    expect(verifyReplyToken(`wm.${otherId}.${sig}`, SECRET)).toBeNull();
    expect(verifyReplyToken(`wm.${sig}.${id}`, SECRET)).toBeNull();
  });

  it("rejects a non-canonical encoding of the id half", () => {
    const padded = `${Buffer.from(TICKET, "utf8").toString("base64url")}`;
    // A signature computed over the id is valid, but an id half that re-encodes differently is not.
    const token = formatReplyToken(TICKET, SECRET) as string;
    expect(verifyReplyToken(token.replace(padded, `${padded}_`), SECRET)).toBeNull();
  });

  it("returns null for every malformed shape without throwing", () => {
    for (const bad of ["", "wm", "wm.", "wm..", "not-a-token", "WM.aaaa.bbbb", "wm.aaa.bbb.ccc", "wm.aaa!.bbbb"]) {
      expect(verifyReplyToken(bad, SECRET)).toBeNull();
    }
  });

  it("returns null when the secret is unset, even for a well-formed token", () => {
    const token = formatReplyToken(TICKET, SECRET) as string;
    expect(verifyReplyToken(token, undefined)).toBeNull();
    expect(verifyReplyToken(token, "")).toBeNull();
  });

  it("tolerates surrounding whitespace, as a header value would carry", () => {
    const token = formatReplyToken(TICKET, SECRET) as string;
    expect(verifyReplyToken(`  ${token}\n`, SECRET)).toBe(TICKET);
  });
});

describe("extractReplyToken", () => {
  const token = formatReplyToken(TICKET, SECRET) as string;

  it("finds the token in a plus-addressed recipient, with and without a display name", () => {
    expect(extractReplyToken(`service+${token}@example.com`)).toBe(token);
    expect(extractReplyToken(`"Cedar Ridge Wealth" <service+${token}@example.com>`)).toBe(token);
  });

  it("finds a bare token and one inside a multi-recipient header", () => {
    expect(extractReplyToken(token)).toBe(token);
    expect(extractReplyToken(`a@b.test, service+${token}@example.com, c@d.test`)).toBe(token);
  });

  it("returns null when there is no token-shaped substring", () => {
    expect(extractReplyToken("service@example.com")).toBeNull();
    expect(extractReplyToken("")).toBeNull();
    expect(extractReplyToken("wm.short.sig")).toBeNull();
  });

  it("is stateless across repeated calls (no lastIndex leak from the global scan)", () => {
    const value = `service+${token}@example.com`;
    expect(extractReplyToken(value)).toBe(token);
    expect(extractReplyToken(value)).toBe(token);
    expect(extractReplyToken(value)).toBe(token);
  });
});


describe("verifyReplyTokenWithRotation", () => {
  const RETIRED_A = testSecret("reply-token-secret-retired-one");
  const RETIRED_B = testSecret("reply-token-secret-retired-two");

  it("verifies a token minted under the CURRENT secret and says so", () => {
    const token = formatReplyToken(TICKET, SECRET) as string;
    expect(verifyReplyTokenWithRotation(token, SECRET, [RETIRED_A])).toEqual({
      ticketId: TICKET,
      generation: "current",
      secretIndex: 0,
    });
  });

  it("verifies a token already in a client's mailbox after the secret rotated, naming which retired key matched", () => {
    const oldToken = formatReplyToken(TICKET, RETIRED_B) as string;
    // Without the overlap this is simply invalid and the client's reply is held for a human.
    expect(verifyReplyToken(oldToken, SECRET)).toBeNull();
    expect(verifyReplyTokenWithRotation(oldToken, SECRET, [RETIRED_A, RETIRED_B])).toEqual({
      ticketId: TICKET,
      generation: "previous",
      secretIndex: 2,
    });
  });

  it("still refuses a token signed with a secret that is on neither list", () => {
    const foreign = formatReplyToken(TICKET, OTHER_SECRET) as string;
    expect(verifyReplyTokenWithRotation(foreign, SECRET, [RETIRED_A, RETIRED_B])).toBeNull();
  });

  it("accepts a retired secret even when the CURRENT secret is unset, and refuses when every candidate is unusable", () => {
    const oldToken = formatReplyToken(TICKET, RETIRED_A) as string;
    expect(verifyReplyTokenWithRotation(oldToken, undefined, [RETIRED_A])?.generation).toBe("previous");
    expect(verifyReplyTokenWithRotation(oldToken, undefined, [])).toBeNull();
    expect(verifyReplyTokenWithRotation(oldToken, "", [""])).toBeNull();
  });

  it("refuses a malformed token whatever the key list is, and never throws", () => {
    for (const bad of ["", "wm.a.b", "not-a-token", "wm..", `wm.${"A".repeat(600)}.${"B".repeat(22)}`]) {
      expect(verifyReplyTokenWithRotation(bad, SECRET, [RETIRED_A])).toBeNull();
    }
  });

  it("verifyReplyToken is the no-rotation case of the same function", () => {
    const token = formatReplyToken(TICKET, SECRET) as string;
    expect(verifyReplyToken(token, SECRET)).toBe(TICKET);
    expect(verifyReplyToken(token, OTHER_SECRET)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// REPLY_TOKEN_PREVIOUS_SECRETS is for VERIFICATION ONLY
// ---------------------------------------------------------------------------

describe("rotation is one-directional", () => {
  const CURRENT = "current-secret-that-is-long-enough-32ch";
  const RETIRED = "retired-secret-that-is-long-enough-32ch";

  it("signs only with the CURRENT secret — a retired key never mints a new token", () => {
    // `formatReplyToken` takes ONE secret and has no parameter for the retired list. That is the
    // control: there is no call shape in which a retired key can sign. Asserted on the output so the
    // claim survives a future signature change as well as the current one.
    const minted = formatReplyToken(TICKET, CURRENT) as string;
    expect(minted).toBe(formatReplyToken(TICKET, CURRENT));
    expect(minted).not.toBe(formatReplyToken(TICKET, RETIRED));
    expect(verifyReplyToken(minted, CURRENT)).toBe(TICKET);
    expect(verifyReplyToken(minted, RETIRED)).toBeNull();
  });

  it("verifies both generations while a rotation is in flight, and names which one matched", () => {
    const old = formatReplyToken(TICKET, RETIRED) as string;
    const fresh = formatReplyToken(TICKET, CURRENT) as string;

    expect(verifyReplyTokenWithRotation(fresh, CURRENT, [RETIRED])).toEqual({
      ticketId: TICKET,
      generation: "current",
      secretIndex: 0,
    });
    expect(verifyReplyTokenWithRotation(old, CURRENT, [RETIRED])).toEqual({
      ticketId: TICKET,
      generation: "previous",
      secretIndex: 1,
    });
  });

  it("stops accepting the retired key the moment it is dropped from the list", () => {
    const old = formatReplyToken(TICKET, RETIRED) as string;
    expect(verifyReplyTokenWithRotation(old, CURRENT, [RETIRED])).not.toBeNull();
    expect(verifyReplyTokenWithRotation(old, CURRENT, [])).toBeNull();
  });
});
