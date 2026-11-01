import { describe, expect, it } from "vitest";
import { SUSPENDED_INTAKE_REASONS } from "@/types/domain";
import {
  SYSTEM_SENDER_LOCAL_PARTS,
  bareAddress,
  classifyInbound,
  withoutPlusTag,
} from "@/lib/email/classify";
import { EXPECTED_BRANCHES, INBOUND_FIXTURES, parseRawMessage } from "@/lib/email/__fixtures__/inbound-corpus";

const HUMAN = {
  from: "Marla Whitfield <marla.whitfield@fastmail.test>",
  "delivered-to": "service@example.com",
  subject: "Statement request",
  "content-type": 'text/plain; charset="UTF-8"',
};

describe("bareAddress / withoutPlusTag", () => {
  it("pulls the address out of every common From spelling", () => {
    expect(bareAddress('"Okonkwo, Dean" <dean@brightline.test>')).toBe("dean@brightline.test");
    expect(bareAddress("<dean@brightline.test>")).toBe("dean@brightline.test");
    expect(bareAddress("DEAN@Brightline.TEST")).toBe("dean@brightline.test");
    expect(bareAddress("mailto:dean@brightline.test")).toBe("dean@brightline.test");
  });

  it("returns null for non-addresses", () => {
    expect(bareAddress(undefined)).toBeNull();
    expect(bareAddress("")).toBeNull();
    expect(bareAddress("Mail Delivery Subsystem")).toBeNull();
    expect(bareAddress("a".repeat(400))).toBeNull();
  });

  it("drops a plus tag", () => {
    expect(withoutPlusTag("service+wm.a.b@example.com")).toBe("service@example.com");
    expect(withoutPlusTag("service@example.com")).toBe("service@example.com");
  });
});

describe("classifyInbound", () => {
  it("returns null for an ordinary human message", () => {
    expect(classifyInbound(HUMAN, "Could you send the August statement?")).toBeNull();
  });

  it("is case-insensitive over header names", () => {
    expect(classifyInbound({ From: "a@b.test", "X-Spam-Flag": "YES" }, "")).toBe("SPAM");
  });

  it("detects a DSN by content type, by X-Failed-Recipients and by subject", () => {
    expect(
      classifyInbound({ ...HUMAN, "content-type": "multipart/report; report-type=delivery-status; boundary=x" }, ""),
    ).toBe("BOUNCE");
    expect(classifyInbound({ ...HUMAN, "x-failed-recipients": "a@b.test" }, "")).toBe("BOUNCE");
    expect(classifyInbound({ ...HUMAN, subject: "Undeliverable: Statement request" }, "")).toBe("BOUNCE");
  });

  it("needs DSN language before treating a postmaster address as a bounce", () => {
    const headers = { ...HUMAN, from: "postmaster@fastmail.test", subject: "A question about your desk" };
    expect(classifyInbound(headers, "Hello, I run the mail server and had a question.")).toBe("SYSTEM_SENDER");
    expect(classifyInbound(headers, "550 5.1.1 the email account that you tried to reach does not exist")).toBe(
      "BOUNCE",
    );
  });

  it("puts BOUNCE ahead of AUTO_REPLY for a DSN that is also auto-submitted", () => {
    const headers = {
      ...HUMAN,
      from: "mailer-daemon@fastmail.test",
      "auto-submitted": "auto-generated",
      "content-type": "multipart/report; report-type=delivery-status",
    };
    expect(classifyInbound(headers, "")).toBe("BOUNCE");
  });

  it("detects an out-of-office by Auto-Submitted, by subject and by body", () => {
    expect(classifyInbound({ ...HUMAN, "auto-submitted": "auto-replied" }, "")).toBe("AUTO_REPLY");
    expect(classifyInbound({ ...HUMAN, subject: "Automatic reply: Statement request" }, "")).toBe("AUTO_REPLY");
    expect(classifyInbound(HUMAN, "I am currently out of the office until 28 September.")).toBe("AUTO_REPLY");
  });

  it("does not treat Auto-Submitted: no as an auto-reply", () => {
    expect(classifyInbound({ ...HUMAN, "auto-submitted": "no" }, "Hello")).toBeNull();
  });

  it("treats bulk / list traffic as an auto-reply", () => {
    expect(classifyInbound({ ...HUMAN, precedence: "bulk" }, "")).toBe("AUTO_REPLY");
    expect(classifyInbound({ ...HUMAN, "list-unsubscribe": "<https://x.test/u>" }, "")).toBe("AUTO_REPLY");
    expect(classifyInbound({ ...HUMAN, "list-id": "<news.x.test>" }, "")).toBe("AUTO_REPLY");
  });

  it("detects a system sender by local part, ignoring a plus tag and the domain", () => {
    for (const local of ["noreply", "no-reply", "do-not-reply", "notifications", "alerts"]) {
      expect(classifyInbound({ ...HUMAN, from: `${local}@custodian.test` }, "")).toBe("SYSTEM_SENDER");
      expect(classifyInbound({ ...HUMAN, from: `${local}+batch7@custodian.test` }, "")).toBe("SYSTEM_SENDER");
    }
    expect(SYSTEM_SENDER_LOCAL_PARTS).toContain("no-reply");
  });

  it("does not mistake a person whose address merely contains 'alert' for a system sender", () => {
    expect(classifyInbound({ ...HUMAN, from: "alberta.reyes@brightline.test" }, "Hello")).toBeNull();
    expect(classifyInbound({ ...HUMAN, from: "alerts.team@brightline.test" }, "Hello")).toBeNull();
  });

  it("detects spam flags from Google, SpamAssassin and Microsoft", () => {
    expect(classifyInbound({ ...HUMAN, "x-spam-flag": "YES" }, "")).toBe("SPAM");
    expect(classifyInbound({ ...HUMAN, "x-spam-status": "Yes, score=9.1" }, "")).toBe("SPAM");
    expect(classifyInbound({ ...HUMAN, "x-spam-level": "*******" }, "")).toBe("SPAM");
    expect(classifyInbound({ ...HUMAN, "x-forefront-antispam-report": "CIP:1.2.3.4;SFV:SPM;" }, "")).toBe("SPAM");
    expect(classifyInbound({ ...HUMAN, "x-gm-spam": "1" }, "")).toBe("SPAM");
  });

  it("does not flag a low SpamAssassin score", () => {
    expect(classifyInbound({ ...HUMAN, "x-spam-level": "**" }, "Hello")).toBeNull();
    expect(classifyInbound({ ...HUMAN, "x-spam-status": "No, score=-1.2" }, "Hello")).toBeNull();
  });

  it("detects a loop when the desk's own mailbox is the sender, or a loop header is present", () => {
    expect(
      classifyInbound({ ...HUMAN, from: "service@example.com", "delivered-to": "service@example.com" }, ""),
    ).toBe("LOOP_DETECTED");
    expect(classifyInbound({ ...HUMAN, "x-loop": "service@example.com" }, "")).toBe("LOOP_DETECTED");
  });

  it("sees through the reply tag when comparing From with Delivered-To", () => {
    expect(
      classifyInbound(
        { ...HUMAN, from: "service@example.com", "delivered-to": "service+wm.a.b@example.com" },
        "",
      ),
    ).toBe("LOOP_DETECTED");
  });

  it("never throws on absent, empty or non-string header values", () => {
    expect(classifyInbound({}, "")).toBeNull();
    expect(classifyInbound({ from: "" }, "")).toBeNull();
    expect(classifyInbound({ from: 7 as unknown as string }, "")).toBeNull();
    expect(classifyInbound(null as unknown as Record<string, string>, "")).toBeNull();
    expect(classifyInbound(HUMAN, undefined as unknown as string)).toBeNull();
  });

  it("only ever returns a reason from the contract enum", () => {
    for (const f of INBOUND_FIXTURES) {
      const { headers, body } = parseRawMessage(f.raw);
      const reason = classifyInbound(headers, body);
      if (reason !== null) expect(SUSPENDED_INTAKE_REASONS).toContain(reason);
    }
  });

  it("classifies every corpus fixture the way EXPECTED_BRANCHES says", () => {
    const CLASSIFIER_REASONS = new Set(["AUTO_REPLY", "BOUNCE", "SYSTEM_SENDER", "SPAM", "LOOP_DETECTED"]);
    for (const f of INBOUND_FIXTURES) {
      const expected = EXPECTED_BRANCHES[f.key];
      expect(expected, `fixture ${f.key} has no expectation`).toBeDefined();
      const { headers, body } = parseRawMessage(f.raw);
      const reason = classifyInbound(headers, body);
      if (expected.outcome === "suspended" && CLASSIFIER_REASONS.has(expected.reason)) {
        expect(reason, `fixture ${f.key}`).toBe(expected.reason);
      } else {
        // Every other fixture must pass the classifier untouched — a ticket or comment branch, or a
        // suspension this module is not responsible for (UNAUTHENTICATED, UNKNOWN_MAILBOX, …).
        expect(reason, `fixture ${f.key}`).toBeNull();
      }
    }
  });
});
