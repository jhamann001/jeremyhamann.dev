/**
 * Inbound mail for the demo's two Outbox buttons (plan decision D3). In production the firm's mail workflow
 * posts each message it receives to /api/ingest/email; these build the same payload, from the universe's
 * clients, for the stand-in to post over loopback. Every message carries the passing sender-authentication
 * header a receiving mail server adds, stamped by the demo's own stand-in server name, which the demo's
 * EMAIL_TRUSTED_AUTHSERV_IDS trusts; without it intake would hold the message as unauthenticated.
 */
import { randomInt, randomUUID } from "node:crypto";
import type { OutboxEmailPayload } from "@/lib/demo/outbox";
import type { Universe } from "@/lib/demo/universe";
import type { InboundEmail } from "@/server/email-intake";

/** The firm's service mailbox; the demo's MAILBOX_MAP routes it to Client Service. */
export const DEMO_MAILBOX = "service@example.com";
/** The receiving server the stand-in claims to be, as it appears in Authentication-Results. */
export const DEMO_AUTHSERV_ID = "mx.example.com";

type Sample = { subject: string; body: (first: string) => string };

const SAMPLES: readonly Sample[] = [
  {
    subject: "Question about my latest statement",
    body: () =>
      "Hi,\n\nI was going through my September statement and there is a line I don't recognize under activity. " +
      "Could someone explain what it is?\n\nThank you",
  },
  {
    subject: "New mailing address",
    body: () => "Hello,\n\nWe have moved. Could you update the mailing address on our accounts? Happy to confirm it by phone.\n\nThanks",
  },
  {
    subject: "Can't sign in to the app",
    body: () => "Hi there,\n\nThe app keeps rejecting my sign-in since this morning. Could you help me get back in?\n\nThanks",
  },
  {
    subject: "Copies of last year's tax forms",
    body: () => "Hello,\n\nMy accountant is asking for last year's 1099s. Where can I find them?\n\nBest",
  },
  {
    subject: "Moving cash to my checking account",
    body: () =>
      "Hi,\n\nI would like to move some cash to my checking account next week. What do you need from me to set that up?\n\nThanks",
  },
  {
    subject: "Updating my beneficiaries",
    body: () => "Hello,\n\nWe had a grandchild this year and I would like to add her as a beneficiary. What is the process?\n\nThank you",
  },
  {
    subject: "When will my transfer arrive?",
    body: () => "Hi,\n\nI started a transfer from my old brokerage a couple of weeks ago. Any idea when it will be done?\n\nThanks",
  },
];

const REPLIES: readonly ((first: string) => string)[] = [
  (first) => `Thank you, that's very helpful. I'll keep an eye out for the next update.\n\n${first}`,
  (first) => `Thanks for the quick answer. One more question: will this show on my next statement?\n\n${first}`,
  (first) => `Got it, thank you. I can do a call tomorrow morning if that's easier.\n\n${first}`,
];

function authenticationResults(address: string): string {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return `${DEMO_AUTHSERV_ID}; dkim=pass header.d=${domain}; spf=pass smtp.mailfrom=${address}; dmarc=pass header.from=${domain}`;
}

const sampleMessageId = (): string => `<sample.${randomUUID()}@mail.example.com>`;

/** A new message from a universe client to the service mailbox. */
export function sampleClientEmail(universe: Universe, choose: (n: number) => number = randomInt): InboundEmail {
  const person = universe.people[choose(universe.people.length)]!;
  const sample = SAMPLES[choose(SAMPLES.length)]!;
  const name = `${person.first} ${person.last}`;
  const messageId = sampleMessageId();
  return {
    mailbox: DEMO_MAILBOX,
    messageId,
    from: `"${name}" <${person.email}>`,
    subject: sample.subject,
    textBody: `${sample.body(person.first)}\n${name}`,
    headers: {
      from: `"${name}" <${person.email}>`,
      to: DEMO_MAILBOX,
      subject: sample.subject,
      "message-id": messageId,
      "authentication-results": authenticationResults(person.email),
    },
    receivedAt: new Date().toISOString(),
  };
}

/**
 * The client answering an email the desk sent: to the reply-to address the desk set (which carries the
 * ticket's reply token), threaded on the desk's Message-ID, as a mail client would.
 */
export function clientReplyTo(
  email: OutboxEmailPayload,
  clientName: string | null,
  choose: (n: number) => number = randomInt,
): InboundEmail {
  const first = clientName?.trim().split(/\s+/)[0] ?? "";
  const subject = /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`;
  const messageId = sampleMessageId();
  const references = [email.references, email.messageId].filter((v): v is string => !!v).join(" ");
  // The requester's name is visitor-editable, so it is a display name only: nothing in it can name an address.
  const display = clientName?.replace(/["\\<>\r\n\t]/g, "").trim() ?? "";
  const from = display ? `"${display}" <${email.to}>` : email.to;
  const quoted = email.textBody
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return {
    mailbox: email.replyTo,
    messageId,
    from,
    subject,
    textBody: `${REPLIES[choose(REPLIES.length)]!(first)}\n\nOn ${new Date().toUTCString()}, ${email.fromName} wrote:\n${quoted}`,
    headers: {
      from,
      to: email.replyTo,
      subject,
      "message-id": messageId,
      "in-reply-to": email.messageId,
      references,
      "authentication-results": authenticationResults(email.to),
    },
    receivedAt: new Date().toISOString(),
  };
}
