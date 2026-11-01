/**
 * DSN parsing tests (§3.2 `MESSAGE_BOUNCED`).
 *
 * Three claims:
 *   1. The structural DSN shapes are recognised and OUR Message-ID comes back out of each of them.
 *      That id is the key — without it a bounce transitions nothing.
 *   2. Hard and soft are read from the evidence in the right order: the enhanced status class first,
 *      `Action: delayed` above it, the SMTP class next, phrases last.
 *   3. **Ambiguity resolves to soft.** A wrong "soft" costs a retry. A wrong "hard" puts a client's
 *      address in front of an administrator as a candidate to stop writing to.
 */
import { describe, expect, it } from "vitest";
import { normalizeMessageId, parseDsn } from "@/lib/email/bounce";

const OUR_ID = "wm.dlv_9f2c.aa11@example.com";

const GOOGLE_HARD = {
  headers: {
    "Content-Type": 'multipart/report; report-type=delivery-status; boundary="000000000000"',
    From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    Subject: "Delivery Status Notification (Failure)",
  },
  body: [
    "The response was:",
    "550 5.1.1 The email account that you tried to reach does not exist.",
    "",
    "Final-Recipient: rfc822; marla@fastmail.test",
    "Action: failed",
    "Status: 5.1.1",
    "Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.",
    "",
    `Message-ID: <${OUR_ID}>`,
    "Subject: [HD-88] Wire status",
  ].join("\n"),
};

const EXCHANGE_SOFT = {
  headers: {
    "content-type": "multipart/report; report-type=delivery-status",
    from: "postmaster@corp.test",
    subject: "Undeliverable: [HD-88] Wire status",
  },
  body: [
    "Action: failed",
    "Status: 4.2.2",
    "Diagnostic-Code: smtp;552 4.2.2 The recipient's mailbox is full and cannot accept messages now.",
    "",
    `Original-Message-ID: <${OUR_ID}>`,
  ].join("\n"),
};

describe("parseDsn — detection", () => {
  it("recognises multipart/report with a delivery-status part", () => {
    expect(parseDsn(GOOGLE_HARD.headers, GOOGLE_HARD.body).isBounce).toBe(true);
  });

  it("recognises an X-Failed-Recipients header on its own", () => {
    const report = parseDsn({ "X-Failed-Recipients": "marla@fastmail.test" }, "could not be delivered");
    expect(report.isBounce).toBe(true);
  });

  it("recognises a bare RFC 3464 machine part with no useful content type", () => {
    expect(parseDsn({}, "Action: failed\nStatus: 5.1.1").isBounce).toBe(true);
  });

  it("does NOT call an ordinary client message a bounce", () => {
    const report = parseDsn(
      { from: "marla@fastmail.test", subject: "Wire not received" },
      "The wire has not landed. Could you check?",
    );
    expect(report).toEqual({ isBounce: false, type: null, originalMessageId: null, status: null });
  });

  it("does NOT call an out-of-office a bounce", () => {
    const report = parseDsn(
      { from: "marla@fastmail.test", subject: "Automatic reply: Wire", "auto-submitted": "auto-replied" },
      "I am currently out of the office.",
    );
    expect(report.isBounce).toBe(false);
  });

  it("does NOT believe a postmaster address on its own — a human at postmaster@ still reaches us", () => {
    const report = parseDsn(
      { from: "postmaster@corp.test", subject: "Undeliverable: something" },
      "Hello, I think one of your messages was blocked. Can you resend it?",
    );
    expect(report.isBounce).toBe(false);
  });

  it("tolerates a missing, hostile or non-string input", () => {
    expect(parseDsn({}, "").isBounce).toBe(false);
    expect(parseDsn(null as unknown as Record<string, string>, null as unknown as string).isBounce).toBe(false);
    expect(parseDsn({ subject: 7 as unknown as string }, "x").isBounce).toBe(false);
  });
});

describe("parseDsn — the original Message-ID", () => {
  it("reads it out of the returned headers part", () => {
    expect(parseDsn(GOOGLE_HARD.headers, GOOGLE_HARD.body).originalMessageId).toBe(OUR_ID);
  });

  it("reads an explicit Original-Message-ID field in the body", () => {
    expect(parseDsn(EXCHANGE_SOFT.headers, EXCHANGE_SOFT.body).originalMessageId).toBe(OUR_ID);
  });

  it("reads the X-Original-Message-ID header", () => {
    const report = parseDsn(
      { "X-Original-Message-ID": `<${OUR_ID}>`, "x-failed-recipients": "a@b.test" },
      "could not be delivered",
    );
    expect(report.originalMessageId).toBe(OUR_ID);
  });

  it("falls back to the DSN's own In-Reply-To", () => {
    const report = parseDsn(
      { "in-reply-to": `<${OUR_ID}>`, "x-failed-recipients": "a@b.test" },
      "could not be delivered",
    );
    expect(report.originalMessageId).toBe(OUR_ID);
  });

  it("is null when the DSN names nothing — the bounce then transitions nothing", () => {
    const report = parseDsn({}, "Action: failed\nStatus: 5.1.1");
    expect(report.isBounce).toBe(true);
    expect(report.originalMessageId).toBeNull();
  });
});

describe("parseDsn — hard versus soft", () => {
  it("a 5.x enhanced status is hard", () => {
    const report = parseDsn(GOOGLE_HARD.headers, GOOGLE_HARD.body);
    expect(report.type).toBe("hard");
    expect(report.status).toBe("5.1.1");
  });

  it("a 4.x enhanced status is soft", () => {
    const report = parseDsn(EXCHANGE_SOFT.headers, EXCHANGE_SOFT.body);
    expect(report.type).toBe("soft");
    expect(report.status).toBe("4.2.2");
  });

  it("Action: delayed overrides a 5.x that an MTA emitted beside it", () => {
    const report = parseDsn({}, "Action: delayed\nStatus: 5.4.7\nwill retry");
    expect(report.type).toBe("soft");
  });

  it("falls back to the SMTP reply class when there is no enhanced status", () => {
    expect(parseDsn({ "x-failed-recipients": "a@b.test" }, "550 User unknown").type).toBe("hard");
    expect(parseDsn({ "x-failed-recipients": "a@b.test" }, "451 Try again later").type).toBe("soft");
  });

  it("reads the phrases only when there is no code at all", () => {
    expect(parseDsn({ "x-failed-recipients": "a@b.test" }, "no such user here").type).toBe("hard");
    expect(parseDsn({ "x-failed-recipients": "a@b.test" }, "the mailbox is full").type).toBe("soft");
  });

  it("resolves an unreadable bounce to SOFT — a wrong hard stops the desk answering somebody", () => {
    const report = parseDsn({ "x-failed-recipients": "a@b.test" }, "something went wrong");
    expect(report.isBounce).toBe(true);
    expect(report.type).toBe("soft");
    expect(report.status).toBeNull();
  });
});

describe("normalizeMessageId", () => {
  it("strips angle brackets, lower-cases and bounds", () => {
    expect(normalizeMessageId("  <ABC@X.Test>  ")).toBe("abc@x.test");
    expect(normalizeMessageId("abc@x.test")).toBe("abc@x.test");
  });

  it("refuses anything that cannot be a Message-ID", () => {
    expect(normalizeMessageId(undefined)).toBeNull();
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId("has a space@x.test")).toBeNull();
    expect(normalizeMessageId(`<${"a".repeat(500)}@x.test>`)).toBeNull();
  });
});
