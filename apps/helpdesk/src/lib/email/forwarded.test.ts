/**
 * Forwarded-mail detection tests.
 *
 * Two claims carry the weight:
 *   1. The four mail clients that matter are all recognised, and the embedded original sender comes
 *      out of each of their block shapes.
 *   2. Ordinary client mail is NOT recognised. A false positive here puts a client's own message in a
 *      review queue instead of a queue, which is a slower failure than a missed forward and a much
 *      easier one to stop noticing.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeForwarded,
  FORWARD_HEADER_SCAN_LINES,
  hasForwardSubjectPrefix,
  stripForwardPrefixes,
} from "@/lib/email/forwarded";

const GMAIL = [
  "Passing this on.",
  "",
  "---------- Forwarded message ---------",
  "From: Marla Whitfield <marla.whitfield@fastmail.test>",
  "Date: Fri, 18 Sep 2026 at 09:14",
  "Subject: Wire not received",
  "To: Dean Okonkwo <dean@example.com>",
  "",
  "The wire has not landed yet.",
].join("\n");

const APPLE = [
  "See below.",
  "",
  "Begin forwarded message:",
  "",
  "From: Marla Whitfield <marla.whitfield@fastmail.test>",
  "Subject: Wire not received",
  "Date: 18 September 2026 at 09:14:02 BST",
  "To: Dean Okonkwo <dean@example.com>",
  "",
  "The wire has not landed yet.",
].join("\n");

const OUTLOOK = [
  "FYI",
  "",
  "-----Original Message-----",
  "From: Marla Whitfield <marla.whitfield@fastmail.test>",
  "Sent: Friday, September 18, 2026 9:14 AM",
  "To: Dean Okonkwo <dean@example.com>",
  "Subject: Wire not received",
  "",
  "The wire has not landed yet.",
].join("\n");

const OUTLOOK_WEB = [
  "FYI",
  "",
  "________________________________",
  "From: Marla Whitfield <marla.whitfield@fastmail.test>",
  "Sent: Friday, September 18, 2026 9:14 AM",
  "To: Dean Okonkwo <dean@example.com>",
  "Subject: Wire not received",
  "",
  "The wire has not landed yet.",
].join("\n");

describe("hasForwardSubjectPrefix", () => {
  it("recognises the spellings mail clients actually emit", () => {
    for (const subject of ["Fwd: Wire", "FW: Wire", "Fw: Wire", "fwd:Wire", "Re: Fwd: Wire", "TR : Wire", "WG: Wire"]) {
      expect(hasForwardSubjectPrefix(subject), subject).toBe(true);
    }
  });

  it("does not treat a reply as a forward", () => {
    expect(hasForwardSubjectPrefix("Re: Wire")).toBe(false);
    expect(hasForwardSubjectPrefix("RE: RE: Wire")).toBe(false);
  });

  it("does not match a word that merely starts with the letters", () => {
    expect(hasForwardSubjectPrefix("Forwarding address change")).toBe(false);
    expect(hasForwardSubjectPrefix("FWIW the wire cleared")).toBe(false);
  });

  it("tolerates a missing or non-string subject", () => {
    expect(hasForwardSubjectPrefix(undefined)).toBe(false);
    expect(hasForwardSubjectPrefix(null)).toBe(false);
    expect(hasForwardSubjectPrefix("")).toBe(false);
  });
});

describe("stripForwardPrefixes", () => {
  it("removes a stacked run and collapses whitespace", () => {
    expect(stripForwardPrefixes("Re: Fwd:   Wire not received")).toBe("Wire not received");
    expect(stripForwardPrefixes("FW: [HD-12] Wire")).toBe("[HD-12] Wire");
  });

  it("leaves an unprefixed subject alone", () => {
    expect(stripForwardPrefixes("Wire not received")).toBe("Wire not received");
  });
});

describe("analyzeForwarded — the four block shapes", () => {
  const cases: Array<[string, string]> = [
    ["Gmail", GMAIL],
    ["Apple Mail", APPLE],
    ["Outlook", OUTLOOK],
    ["Outlook on the web", OUTLOOK_WEB],
  ];

  for (const [name, body] of cases) {
    it(`parses the original sender, subject and date out of a ${name} forward`, () => {
      const result = analyzeForwarded({ Subject: "Fwd: Wire not received" }, body);
      expect(result.isForwarded).toBe(true);
      expect(result.candidateFrom).toBe("marla.whitfield@fastmail.test");
      expect(result.originalSubject).toBe("Wire not received");
      expect(result.originalDate).toBeTruthy();
    });
  }

  it("recognises a block with no forward prefix on the subject", () => {
    const result = analyzeForwarded({ subject: "Wire not received" }, GMAIL);
    expect(result.isForwarded).toBe(true);
    expect(result.candidateFrom).toBe("marla.whitfield@fastmail.test");
  });

  it("recognises a Fwd: subject whose body carries pasted headers and no marker", () => {
    const body = ["From: Marla Whitfield <marla.whitfield@fastmail.test>", "Subject: Wire", "", "Body"].join("\n");
    const result = analyzeForwarded({ subject: "Fwd: Wire" }, body);
    expect(result.isForwarded).toBe(true);
    expect(result.candidateFrom).toBe("marla.whitfield@fastmail.test");
  });

  it("lower-cases the candidate, because it is compared against a lower-cased requester address", () => {
    const body = GMAIL.replace("marla.whitfield@fastmail.test", "Marla.Whitfield@FastMail.Test");
    expect(analyzeForwarded({ subject: "Fwd: x" }, body).candidateFrom).toBe("marla.whitfield@fastmail.test");
  });

  // The address is lower-cased; the NAME beside it must not be. Releasing against the candidate takes
  // `Ticket.requesterName` from this line, and a lower-cased name is a mis-spelled client name on a
  // client-facing record from the moment it is created.
  it("keeps the embedded From line verbatim, so the display name's casing survives", () => {
    for (const body of [GMAIL, APPLE, OUTLOOK, OUTLOOK_WEB]) {
      expect(analyzeForwarded({ subject: "Fwd: Wire not received" }, body).candidateFromHeader).toBe(
        "Marla Whitfield <marla.whitfield@fastmail.test>",
      );
    }
  });

  it("keeps the casing of the address inside that line too, even though the candidate is lower-cased", () => {
    const body = GMAIL.replace("marla.whitfield@fastmail.test", "Marla.Whitfield@FastMail.Test");
    const result = analyzeForwarded({ subject: "Fwd: x" }, body);
    expect(result.candidateFrom).toBe("marla.whitfield@fastmail.test");
    expect(result.candidateFromHeader).toBe("Marla Whitfield <Marla.Whitfield@FastMail.Test>");
  });

  it("reports a bare addr-spec From line as itself — there is no display name in it", () => {
    const body = GMAIL.replace("Marla Whitfield <marla.whitfield@fastmail.test>", "marla.whitfield@fastmail.test");
    expect(analyzeForwarded({ subject: "Fwd: x" }, body).candidateFromHeader).toBe("marla.whitfield@fastmail.test");
  });
});

describe("analyzeForwarded — what it refuses to call a forward", () => {
  it("an ordinary client message", () => {
    const result = analyzeForwarded(
      { subject: "Wire not received" },
      "The wire has not landed yet. Could you check?",
    );
    expect(result).toEqual({
      isForwarded: false,
      candidateFrom: null,
      candidateFromHeader: null,
      originalSubject: null,
      originalDate: null,
    });
  });

  it("a reply carrying quoted history", () => {
    const body = [
      "Thanks — that works.",
      "",
      "On Fri, 18 Sep 2026 at 09:14, Dean Okonkwo <dean@example.com> wrote:",
      "> We have released the wire.",
    ].join("\n");
    expect(analyzeForwarded({ subject: "Re: Wire" }, body).isForwarded).toBe(false);
  });

  it("a rule of underscores that is only a separator", () => {
    const body = ["Here are the details.", "", "________________________________", "", "Thanks."].join("\n");
    expect(analyzeForwarded({ subject: "Details" }, body).isForwarded).toBe(false);
  });

  it("an empty or hostile body", () => {
    expect(analyzeForwarded({}, "").isForwarded).toBe(false);
    expect(analyzeForwarded({ subject: 42 as unknown as string }, "x").isForwarded).toBe(false);
    expect(analyzeForwarded(null as unknown as Record<string, string>, "x").isForwarded).toBe(false);
  });
});

describe("analyzeForwarded — bounds and the no-candidate case", () => {
  it("is forwarded with no candidate when the block names no sender", () => {
    const body = ["---------- Forwarded message ---------", "Subject: Wire", "", "Body"].join("\n");
    const result = analyzeForwarded({ subject: "Fwd: Wire" }, body);
    expect(result.isForwarded).toBe(true);
    expect(result.candidateFrom).toBeNull();
    // The subject still comes out, so a reviewer sees what was forwarded even with no sender.
    expect(result.originalSubject).toBe("Wire");
  });

  it("refuses a From naming several mailboxes — nobody to attribute it to", () => {
    const body = GMAIL.replace(
      "From: Marla Whitfield <marla.whitfield@fastmail.test>",
      "From: Marla <a@x.test>, Ken <b@x.test>",
    );
    expect(analyzeForwarded({ subject: "Fwd: x" }, body).candidateFrom).toBeNull();
  });

  it("stops reading headers once the forwarded body begins", () => {
    const body = [
      "---------- Forwarded message ---------",
      "Subject: Wire",
      "",
      "Please note the following.",
      "From: impostor@attacker.test",
    ].join("\n");
    expect(analyzeForwarded({ subject: "Fwd: Wire" }, body).candidateFrom).toBeNull();
  });

  it("does not scan an unbounded number of lines after the marker", () => {
    const filler = Array.from({ length: FORWARD_HEADER_SCAN_LINES + 10 }, () => "X-Pad: pad").join("\n");
    const body = ["---------- Forwarded message ---------", filler, "From: late@x.test"].join("\n");
    expect(analyzeForwarded({ subject: "Fwd: x" }, body).candidateFrom).toBeNull();
  });

  it("falls back to the stripped outer subject when the block has none", () => {
    const body = ["---------- Forwarded message ---------", "From: a@x.test", "", "Body"].join("\n");
    expect(analyzeForwarded({ subject: "Fwd: Statement request" }, body).originalSubject).toBe("Statement request");
  });
});
