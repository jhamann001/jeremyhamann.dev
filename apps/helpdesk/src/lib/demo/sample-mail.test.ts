import { describe, expect, it } from "vitest";
import { parseAuthenticationResults } from "@/lib/email/auth-results";
import { parseFromAddress } from "@/lib/email/mailboxes";
import { inboundEmailSchema } from "@/server/email-intake";
import { DEMO_AUTHSERV_ID, DEMO_MAILBOX, clientReplyTo, sampleClientEmail } from "./sample-mail";
import { loadUniverse } from "./universe";

const first = () => 0;

describe("the Outbox's sample mail", () => {
  it("is a valid intake payload from a universe client to the service mailbox, authenticated", () => {
    const email = sampleClientEmail(loadUniverse(), first);
    expect(inboundEmailSchema.safeParse(email).success).toBe(true);
    expect(email.mailbox).toBe(DEMO_MAILBOX);
    expect(email.from).toMatch(/@example\.com>$/);
    const verdict = parseAuthenticationResults(email.headers?.["authentication-results"], [DEMO_AUTHSERV_ID]);
    expect(verdict.authenticated).toBe(true);
  });

  it("answers an Outbox email at its reply-to address, threaded on the desk's Message-ID", () => {
    const reply = clientReplyTo(
      {
        ticketNumber: 2496,
        from: "service@example.com",
        fromName: "Cedar Ridge Wealth",
        replyTo: "service+tok@example.com",
        to: "neil.cole@example.com",
        subject: "[HD-2496] New mailing address",
        textBody: "Hello Neil",
        messageId: "<dlv_1@example.com>",
        inReplyTo: null,
        references: "<first@example.com>",
      },
      "Neil Cole",
      first,
    );
    expect(inboundEmailSchema.safeParse(reply).success).toBe(true);
    expect(reply.mailbox).toBe("service+tok@example.com");
    expect(reply.subject).toBe("Re: [HD-2496] New mailing address");
    expect(reply.headers?.["in-reply-to"]).toBe("<dlv_1@example.com>");
    expect(reply.headers?.references).toBe("<first@example.com> <dlv_1@example.com>");
    expect(reply.textBody).toContain("> Hello Neil");
    expect(parseAuthenticationResults(reply.headers?.["authentication-results"], [DEMO_AUTHSERV_ID]).authenticated).toBe(true);
  });

  it("keeps the client's address whatever the requester's name says", () => {
    const desk = {
      ticketNumber: 2496,
      from: "service@example.com",
      fromName: "Cedar Ridge Wealth",
      replyTo: "service+tok@example.com",
      to: "neil.cole@example.com",
      subject: "[HD-2496] New mailing address",
      textBody: "Hello Neil",
      messageId: "<dlv_1@example.com>",
      inReplyTo: null,
      references: null,
    };
    for (const name of ['x" <attacker@example.net>', "x <attacker@example.net>", "x\r\nBcc: attacker@example.net"]) {
      const reply = clientReplyTo(desk, name, first);
      expect(parseFromAddress(reply.from), name).toBe("neil.cole@example.com");
      expect(reply.from).not.toContain("attacker@example.net>");
    }
  });
});
