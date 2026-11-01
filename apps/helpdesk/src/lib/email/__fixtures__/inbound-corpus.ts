/**
 * Inbound email fixture corpus — test input only, imported by the S2 unit and integration tests.
 *
 * Every message below is a hand-written RFC 5322 message in the shape Google Workspace hands to the
 * n8n Gmail trigger: a header block, a blank line, and a body. **Every person, address and account
 * reference is invented.** No real client data, no real advisor data; the two firm domains are
 * Cedar Ridge's own. Any digit run that looks like an account or routing number is deliberately
 * fabricated so the PII tests have something to bite on — note that since Decision #116 a routing
 * number is deliberately NOT redacted, so the routing runs below are there to prove a pass-through.
 *
 * The corpus covers one branch of the intake state machine per fixture, and `EXPECTED_BRANCHES`
 * below is the index the tests assert against — adding a fixture without an expectation fails.
 */
import type { SuspendedIntakeReason } from "@/types/domain";

/** What the intake path should do with a fixture, at the granularity the tests assert. */
export type ExpectedBranch =
  | { outcome: "ticket"; note: string }
  | { outcome: "comment"; note: string }
  | { outcome: "suspended"; reason: SuspendedIntakeReason; note: string };

export type InboundFixture = {
  /** Stable key used by the tests and by EXPECTED_BRANCHES. */
  key: string;
  /** The inbound address the message was delivered to (the mailbox-map key, plus any reply tag). */
  mailbox: string;
  /** Opaque pointer to the raw message in the workflow's own store. */
  rawRef: string;
  /** The full raw message: headers, blank line, body. */
  raw: string;
  /** Present when the message carried an HTML part instead of (or as well as) the text part. */
  htmlBody?: string;
};

/** Headers and body of a raw message, with RFC 5322 folded headers unwrapped. */
export type ParsedRawMessage = {
  headers: Record<string, string>;
  body: string;
};

/**
 * Splits a raw message into a lower-cased header map and its body. Repeated headers are joined with
 * "\n" (which is how several `Authentication-Results` or `Received` lines reach the parser), folded
 * continuation lines are unwrapped, and everything after the first blank line is the body.
 */
export function parseRawMessage(raw: string): ParsedRawMessage {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const split = normalized.indexOf("\n\n");
  const headerBlock = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? "" : normalized.slice(split + 2);

  const headers: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of headerBlock.split("\n")) {
    if (/^[ \t]/.test(line) && currentKey !== null) {
      headers[currentKey] = `${headers[currentKey]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[key] = headers[key] === undefined ? value : `${headers[key]}\n${value}`;
    currentKey = key;
  }
  return { headers, body };
}

const PASS = "mx.google.com; spf=pass (google.com: domain of %FROM% designates 209.85.220.41 as permitted sender) smtp.mailfrom=%FROM%; dkim=pass header.i=@%DOMAIN% header.s=20230601 header.b=Qj7bKq2p; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=%DOMAIN%";

function authPass(address: string): string {
  const domain = address.slice(address.indexOf("@") + 1);
  return PASS.replaceAll("%FROM%", address).replaceAll("%DOMAIN%", domain);
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

export const INBOUND_FIXTURES: readonly InboundFixture[] = [
  {
    key: "new-thread-plain",
    mailbox: "service@example.com",
    rawRef: "n8n:exec-84021",
    raw: `Delivered-To: service@example.com
Return-Path: <marla.whitfield@fastmail.test>
Authentication-Results: ${authPass("marla.whitfield@fastmail.test")}
Message-ID: <CAF8y9Qm2s7ZK1nW@mail.fastmail.test>
Date: Mon, 14 Sep 2026 09:12:44 -0400
From: Marla Whitfield <marla.whitfield@fastmail.test>
To: Cedar Ridge Client Service <service@example.com>
Subject: Statement request for the joint account
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Good morning,

Could you send me the August statement for our joint account? I looked in the
portal but only see July.

Thank you,
Marla Whitfield
(555) 012-8841
`,
  },
  {
    key: "new-thread-html",
    mailbox: "operations@example.com",
    rawRef: "n8n:exec-84022",
    raw: `Delivered-To: operations@example.com
Return-Path: <dean.okonkwo@brightline.test>
Authentication-Results: ${authPass("dean.okonkwo@brightline.test")}
Message-ID: <0c11e4b8-4f2a-4a77-9a0e-8ad9d7c11a55@brightline.test>
Date: Tue, 15 Sep 2026 14:03:10 -0400
From: "Okonkwo, Dean" <dean.okonkwo@brightline.test>
To: operations@example.com
Subject: Transfer paperwork - which form do I need?
MIME-Version: 1.0
Content-Type: text/html; charset="UTF-8"

(html part; see htmlBody)
`,
    htmlBody: `<html><head><style>p{margin:0}</style></head><body>
<div dir="ltr"><p>Hello,</p>
<p>I am moving an outside IRA over. Your site lists two options:</p>
<table border="1" cellpadding="4">
<tr><th>Form</th><th>Use</th></tr>
<tr><td>ACAT full</td><td>Move everything</td></tr>
<tr><td>ACAT partial</td><td>Move selected positions</td></tr>
</table>
<p>The page I was reading is <a href="https://example.com/forms/transfers">here</a>, and I
also found <a href="https://example.com/help">https://example.com/help</a>.</p>
<p>Which one applies if I want to keep two bond positions where they are?</p>
<p>Thanks,<br>Dean</p>
</div></body></html>`,
  },
  {
    key: "reply-message-id",
    mailbox: "service@example.com",
    rawRef: "n8n:exec-84023",
    raw: `Delivered-To: service@example.com
Return-Path: <marla.whitfield@fastmail.test>
Authentication-Results: ${authPass("marla.whitfield@fastmail.test")}
Message-ID: <CAF8y9Qm44tAA9@mail.fastmail.test>
In-Reply-To: <wm.PLACEHOLDER_DELIVERY.7f31a2@example.com>
References: <wm.PLACEHOLDER_DELIVERY.7f31a2@example.com>
Date: Mon, 14 Sep 2026 16:41:02 -0400
From: Marla Whitfield <marla.whitfield@fastmail.test>
To: Cedar Ridge Client Service <service+wm.PLACEHOLDER_TOKEN@example.com>
Subject: Re: [HD-1041] Statement request for the joint account
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

That worked, thank you. One more thing - can you also send July again? I think I
deleted it.

Marla

On Mon, Sep 14, 2026 at 11:04 AM Your Service Team <service@example.com> wrote:
> Hello Marla,
>
> The August statement is attached.
>
> --
> Cedar Ridge Wealth Client Service
> This message is for informational purposes only and is not tax or legal advice.
`,
  },
  {
    key: "reply-token-only",
    mailbox: "service+wm.PLACEHOLDER_TOKEN@example.com",
    rawRef: "n8n:exec-84024",
    raw: `Delivered-To: service+wm.PLACEHOLDER_TOKEN@example.com
Return-Path: <priya.raghavan@lpl.test>
Authentication-Results: ${authPass("priya.raghavan@lpl.test")}
Message-ID: <AM0PR09MB4412D1@lpl.test>
Date: Wed, 16 Sep 2026 08:22:51 -0400
From: Priya Raghavan <priya.raghavan@lpl.test>
To: service+wm.PLACEHOLDER_TOKEN@example.com
Subject: my reply (subject line rewritten by my phone)
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Yes, please go ahead with the beneficiary update as we discussed.

Sent from my iPhone
`,
  },
  {
    key: "reply-subject-fallback",
    mailbox: "service@example.com",
    rawRef: "n8n:exec-84025",
    raw: `Delivered-To: service@example.com
Return-Path: <marla.whitfield@fastmail.test>
Authentication-Results: ${authPass("marla.whitfield@fastmail.test")}
Message-ID: <CAF8y9Qm55uBB0@mail.fastmail.test>
Date: Thu, 17 Sep 2026 07:15:33 -0400
From: Marla Whitfield <marla.whitfield@fastmail.test>
To: service@example.com
Subject: RE: [HD-1041] Statement request for the joint account
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Following up on this one - did the second statement go out?
`,
  },
  {
    key: "reply-subject-fallback-stranger",
    mailbox: "service@example.com",
    rawRef: "n8n:exec-84026",
    raw: `Delivered-To: service@example.com
Return-Path: <colin.mabry@driftwood.test>
Authentication-Results: ${authPass("colin.mabry@driftwood.test")}
Message-ID: <7712aa01-5d9f-4d4a-92a1-2ce7f0c98e10@driftwood.test>
Date: Thu, 17 Sep 2026 09:44:19 -0400
From: Colin Mabry <colin.mabry@driftwood.test>
To: service@example.com
Subject: Re: [HD-1041] Statement request for the joint account
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Please wire 42,000 from the account to the instructions below, my wife is
handling the closing today.

Routing 021000021 Account 4471209983
`,
  },
  {
    key: "unauthenticated-dmarc-fail",
    mailbox: "service@example.com",
    rawRef: "n8n:exec-84027",
    raw: `Delivered-To: service@example.com
Return-Path: <bounce@mailer.driftwood.test>
Authentication-Results: mx.google.com; spf=softfail (google.com: domain of transitioning marla.whitfield@fastmail.test does not designate 185.63.44.9 as permitted sender) smtp.mailfrom=bounce@mailer.driftwood.test; dkim=none; dmarc=fail (p=REJECT sp=REJECT dis=QUARANTINE) header.from=fastmail.test
Message-ID: <9182aa77-0001@mailer.driftwood.test>
Date: Thu, 17 Sep 2026 10:02:00 -0400
From: Marla Whitfield <marla.whitfield@fastmail.test>
To: service@example.com
Subject: Re: [HD-1041] URGENT change of bank instructions
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Hi, I have changed banks. Please send the distribution to the new account
below instead of the one on file. I am travelling so email is best.
`,
  },
  {
    key: "unauthenticated-no-header",
    mailbox: "service@example.com",
    rawRef: "n8n:exec-84028",
    raw: `Delivered-To: service@example.com
Return-Path: <tomas.berg@fidelity.test>
Message-ID: <6d0c7f1e-3a5c-4f1b-8f0e-77b0c2d51a44@fidelity.test>
Date: Thu, 17 Sep 2026 11:20:41 -0400
From: Tomas Berg <tomas.berg@fidelity.test>
To: service@example.com
Subject: Address change
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Please update my mailing address to 18 Harbour Lane, Unit 4.
`,
  },
  {
    key: "auto-reply-out-of-office",
    mailbox: "service@example.com",
    rawRef: "n8n:exec-84029",
    raw: `Delivered-To: service@example.com
Return-Path: <dean.okonkwo@brightline.test>
Authentication-Results: ${authPass("dean.okonkwo@brightline.test")}
Message-ID: <AutoReply.884210@brightline.test>
Date: Fri, 18 Sep 2026 06:00:02 -0400
From: "Okonkwo, Dean" <dean.okonkwo@brightline.test>
To: service@example.com
Subject: Automatic reply: Your transfer paperwork
Auto-Submitted: auto-replied
X-Auto-Response-Suppress: All
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

I am currently out of the office and will return on 28 September. For anything
urgent please contact my colleague.
`,
  },
  {
    key: "bounce-dsn",
    mailbox: "service@example.com",
    rawRef: "n8n:exec-84030",
    raw: `Delivered-To: service@example.com
Return-Path: <>
Authentication-Results: mx.google.com; spf=pass (google.com: best guess record for domain of postmaster@mail.fastmail.test designates 66.111.4.25 as permitted sender) smtp.helo=mail.fastmail.test; dkim=none; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=fastmail.test
Message-ID: <DSN.7781200@mail.fastmail.test>
Date: Fri, 18 Sep 2026 06:04:11 -0400
From: Mail Delivery Subsystem <mailer-daemon@mail.fastmail.test>
To: service@example.com
Subject: Delivery Status Notification (Failure)
Auto-Submitted: auto-generated
X-Failed-Recipients: m.whitfeld@fastmail.test
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="0000dsn"

--0000dsn
Content-Type: text/plain; charset="UTF-8"

Delivery to the following recipient failed permanently:

  m.whitfeld@fastmail.test

Technical details of permanent failure:
550 5.1.1 The email account that you tried to reach does not exist.
--0000dsn--
`,
  },
  {
    key: "system-sender-noreply",
    mailbox: "operations@example.com",
    rawRef: "n8n:exec-84031",
    raw: `Delivered-To: operations@example.com
Return-Path: <no-reply@custodian-alerts.test>
Authentication-Results: ${authPass("no-reply@custodian-alerts.test")}
Message-ID: <alerts-2026-09-18-0007@custodian-alerts.test>
Date: Fri, 18 Sep 2026 07:00:00 -0400
From: Custodian Alerts <no-reply@custodian-alerts.test>
To: operations@example.com
Subject: Daily position file is available
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

The position file for 2026-09-17 has been posted to your SFTP folder.
`,
  },
  {
    key: "spam-flagged",
    mailbox: "service@example.com",
    rawRef: "n8n:exec-84032",
    raw: `Delivered-To: service@example.com
Return-Path: <offers@win-big-today.test>
Authentication-Results: ${authPass("offers@win-big-today.test")}
Message-ID: <promo-9912@win-big-today.test>
Date: Fri, 18 Sep 2026 07:41:55 -0400
From: Investment Offers <offers@win-big-today.test>
To: service@example.com
Subject: Your portfolio could be earning 40% monthly
X-Spam-Flag: YES
X-Spam-Level: *******
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Reply now to unlock guaranteed monthly returns with no downside risk.
`,
  },
  {
    key: "unknown-mailbox",
    mailbox: "careers@example.com",
    rawRef: "n8n:exec-84033",
    raw: `Delivered-To: careers@example.com
Return-Path: <sana.iqbal@applicants.test>
Authentication-Results: ${authPass("sana.iqbal@applicants.test")}
Message-ID: <cv-4412@applicants.test>
Date: Fri, 18 Sep 2026 08:15:00 -0400
From: Sana Iqbal <sana.iqbal@applicants.test>
To: careers@example.com
Subject: Application - client service associate
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Please find my application for the client service associate role.
`,
  },
  {
    key: "loop-delivered-to-self",
    mailbox: "service@example.com",
    rawRef: "n8n:exec-84034",
    raw: `Delivered-To: service@example.com
Return-Path: <service@example.com>
Authentication-Results: ${authPass("service@example.com")}
Message-ID: <loop-0001@example.com>
Date: Fri, 18 Sep 2026 08:30:00 -0400
From: Cedar Ridge Client Service <service@example.com>
To: service@example.com
Subject: Re: Re: Re: Automatic acknowledgement
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Your message has been received by Cedar Ridge Client Service.
`,
  },
  {
    key: "empty-body",
    mailbox: "service@example.com",
    rawRef: "n8n:exec-84035",
    raw: `Delivered-To: service@example.com
Return-Path: <tomas.berg@fidelity.test>
Authentication-Results: ${authPass("tomas.berg@fidelity.test")}
Message-ID: <empty-77120@fidelity.test>
Date: Fri, 18 Sep 2026 08:45:00 -0400
From: Tomas Berg <tomas.berg@fidelity.test>
To: service@example.com
Subject: (no subject)
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"


`,
  },
  {
    key: "outlook-quoted-reply",
    mailbox: "operations@example.com",
    rawRef: "n8n:exec-84036",
    raw: `Delivered-To: operations@example.com
Return-Path: <dean.okonkwo@brightline.test>
Authentication-Results: ${authPass("dean.okonkwo@brightline.test")}
Message-ID: <AM0PR09MB4412E2@brightline.test>
In-Reply-To: <wm.PLACEHOLDER_DELIVERY.7f31a2@example.com>
Date: Fri, 18 Sep 2026 09:10:00 -0400
From: "Okonkwo, Dean" <dean.okonkwo@brightline.test>
To: operations@example.com
Subject: RE: [HD-1042] Transfer paperwork
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Partial, please. I want to keep the two municipal bonds where they are.

Dean Okonkwo
Brightline Manufacturing
________________________________
From: Your Service Team <operations@example.com>
Sent: Thursday, September 17, 2026 4:12 PM
To: Okonkwo, Dean <dean.okonkwo@brightline.test>
Subject: [HD-1042] Transfer paperwork

Hello Dean, full or partial transfer?
`,
  },
  {
    key: "attachment-bearing",
    mailbox: "operations@example.com",
    rawRef: "n8n:exec-84037",
    raw: `Delivered-To: operations@example.com
Return-Path: <priya.raghavan@lpl.test>
Authentication-Results: ${authPass("priya.raghavan@lpl.test")}
Message-ID: <att-55120@lpl.test>
Date: Fri, 18 Sep 2026 09:30:00 -0400
From: Priya Raghavan <priya.raghavan@lpl.test>
To: operations@example.com
Subject: Signed beneficiary form attached
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="000att"

--000att
Content-Type: text/plain; charset="UTF-8"

Attached is the signed form. Let me know if the notary page is needed as well.
--000att
Content-Type: application/pdf; name="beneficiary-form.pdf"
Content-Disposition: attachment; filename="beneficiary-form.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQKJVBERi0xLjQK
--000att--
`,
  },
  {
    key: "closed-ticket-followup",
    mailbox: "service@example.com",
    rawRef: "n8n:exec-84038",
    raw: `Delivered-To: service@example.com
Return-Path: <marla.whitfield@fastmail.test>
Authentication-Results: ${authPass("marla.whitfield@fastmail.test")}
Message-ID: <CAF8y9Qm99zCC1@mail.fastmail.test>
In-Reply-To: <wm.PLACEHOLDER_DELIVERY.7f31a2@example.com>
Date: Sat, 19 Sep 2026 10:05:00 -0400
From: Marla Whitfield <marla.whitfield@fastmail.test>
To: service@example.com
Subject: Re: [HD-1041] Statement request for the joint account
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Sorry to reopen this months later - the September statement is missing too.
`,
  },
  {
    key: "pii-in-body",
    mailbox: "operations@example.com",
    rawRef: "n8n:exec-84039",
    raw: `Delivered-To: operations@example.com
Return-Path: <tomas.berg@fidelity.test>
Authentication-Results: ${authPass("tomas.berg@fidelity.test")}
Message-ID: <pii-31200@fidelity.test>
Date: Sat, 19 Sep 2026 10:40:00 -0400
From: Tomas Berg <tomas.berg@fidelity.test>
To: operations@example.com
Subject: ACH setup for the distribution
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

Here are the details you asked for.

SSN: 345-67-8901
Account number 4471209983
Routing 021000021

Please set up the monthly distribution.
`,
  },
] as const;

/** The branch each fixture must take. Keys must match INBOUND_FIXTURES exactly. */
export const EXPECTED_BRANCHES: Readonly<Record<string, ExpectedBranch>> = {
  "new-thread-plain": { outcome: "ticket", note: "authenticated first contact on a mapped mailbox" },
  "new-thread-html": { outcome: "ticket", note: "HTML-only part; links preserved, table flattened" },
  "reply-message-id": { outcome: "comment", note: "In-Reply-To matches a stored MessageDelivery" },
  "reply-token-only": { outcome: "comment", note: "reply token on the envelope recipient; subject rewritten" },
  "reply-subject-fallback": { outcome: "comment", note: "[HD-n] fallback: sender == requester and DMARC pass" },
  "reply-subject-fallback-stranger": {
    outcome: "ticket",
    note: "[HD-n] present but the sender is NOT the requester — never joins the thread",
  },
  "unauthenticated-dmarc-fail": { outcome: "suspended", reason: "UNAUTHENTICATED", note: "dmarc=fail, spoofed From" },
  "unauthenticated-no-header": { outcome: "suspended", reason: "UNAUTHENTICATED", note: "no Authentication-Results" },
  "auto-reply-out-of-office": { outcome: "suspended", reason: "AUTO_REPLY", note: "Auto-Submitted: auto-replied" },
  "bounce-dsn": { outcome: "suspended", reason: "BOUNCE", note: "multipart/report delivery-status" },
  "system-sender-noreply": { outcome: "suspended", reason: "SYSTEM_SENDER", note: "no-reply@ local part" },
  "spam-flagged": { outcome: "suspended", reason: "SPAM", note: "X-Spam-Flag: YES" },
  "unknown-mailbox": { outcome: "suspended", reason: "UNKNOWN_MAILBOX", note: "careers@ is not in MAILBOX_MAP" },
  "loop-delivered-to-self": { outcome: "suspended", reason: "LOOP_DETECTED", note: "From == Delivered-To" },
  "empty-body": { outcome: "suspended", reason: "PARSE_FAILED", note: "no text and no html part" },
  "outlook-quoted-reply": { outcome: "comment", note: "Outlook history block stripped" },
  "attachment-bearing": { outcome: "ticket", note: "attachment parts handed to the attachment store" },
  "closed-ticket-followup": { outcome: "ticket", note: "reply on a CLOSED ticket opens a linked ticket" },
  "pii-in-body": { outcome: "ticket", note: "SSN / account redacted before persistence; routing kept (Decision #116)" },
};

/** Fixture lookup by key; throws rather than returning undefined so a typo fails loudly in a test. */
export function fixture(key: string): InboundFixture {
  const found = INBOUND_FIXTURES.find((f) => f.key === key);
  if (found === undefined) throw new Error(`Unknown inbound fixture: ${key}`);
  return found;
}
