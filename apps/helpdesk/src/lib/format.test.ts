/**
 * Pure unit tests for the avatar-initials helper (src/lib/format.ts).
 *
 * The rule under test is "an initial is a letter or a digit, never punctuation". It exists because the
 * seeded machine actors are named "Integration (machine)" / "Scheduled jobs (machine)", and those rows
 * author every ingested ticket — a naive first-character-of-each-token helper rendered "I(" in the
 * "Created by" avatar and in the audit view, which are exactly the surfaces a compliance reviewer reads
 * to answer who created a record.
 *
 * It also pins the DELIVERY VOCABULARY of `ACTION_LABELS`, for the same reader: the audit ledger is the
 * one surface used to reconstruct what actually reached a client, so it may not use a stronger word than
 * the underlying event supports, and it may not disagree with the delivery chip
 * (`src/components/tickets/delivery-chip-label.ts`) or the build record P16 about what a state is called.
 */
import { describe, expect, it } from "vitest";
import { MACHINE_USER_SEED } from "../../prisma/machine-users";
import { AUDIT_ACTIONS, MESSAGE_DELIVERY_STATUS_LABELS } from "@/types/domain";
import { ACTION_LABELS, initials } from "@/lib/format";

describe("initials", () => {
  it("takes first and last initials of an ordinary name", () => {
    expect(initials("Dana Whitfield", "dana@example.com")).toBe("DW");
    expect(initials("dana whitfield", "dana@example.com")).toBe("DW");
  });

  it("uses first and LAST token, not the first two", () => {
    expect(initials("Maria de la Cruz", "maria@example.com")).toBe("MC");
    expect(initials("J. R. R. Tolkien", "jrr@example.com")).toBe("JT");
  });

  it("gives a single initial for a single-token name", () => {
    expect(initials("Cher", "cher@example.com")).toBe("C");
  });

  it("drops a bracketed qualifier instead of initialling its bracket", () => {
    expect(initials("Integration (machine)", "integration@wm-helpdesk.local")).toBe("I");
    expect(initials("Scheduled jobs (machine)", "jobs@wm-helpdesk.local")).toBe("SJ");
    expect(initials("Ingest [bot]", "ingest@wm-helpdesk.local")).toBe("I");
    expect(initials("Outbox {svc}", "outbox@wm-helpdesk.local")).toBe("O");
  });

  it("falls back to the qualifier when it is the whole name", () => {
    expect(initials("(machine)", "svc@wm-helpdesk.local")).toBe("M");
  });

  it("skips leading punctuation inside a token", () => {
    expect(initials("'Nour Al-Amin", "nour@example.com")).toBe("NA");
    expect(initials("Mary-Jane —Watson", "mj@example.com")).toBe("MW");
  });

  it("keeps non-ASCII letters rather than stripping them", () => {
    expect(initials("Émile Zola", "emile@example.com")).toBe("ÉZ");
    expect(initials("Øystein Berg", "oystein@example.com")).toBe("ØB");
  });

  it("returns exactly two characters at most, even for letters that grow when upper-cased", () => {
    for (const name of ["ßeta Tester", "Émile Zola", "Integration (machine)", "Dana Whitfield"]) {
      expect(Array.from(initials(name, "x@example.com")).length).toBeLessThanOrEqual(2);
    }
  });

  it("falls back to the email local part when the name is empty or unusable", () => {
    expect(initials(null, "dana.whitfield@example.com")).toBe("DA");
    expect(initials("   ", "dana.whitfield@example.com")).toBe("DA");
    expect(initials("---", "dana.whitfield@example.com")).toBe("DA");
  });

  it("returns a placeholder when neither name nor email yields a character", () => {
    expect(initials(null, "")).toBe("?");
    expect(initials("", "@example.com")).toBe("?");
  });

  it("renders no punctuation for any seeded machine actor", () => {
    for (const u of MACHINE_USER_SEED) {
      const out = initials(u.name, u.email);
      expect(out).toMatch(/^[\p{Lu}\p{N}]{1,2}$/u);
    }
  });
});

describe("ACTION_LABELS delivery copy", () => {
  it("never claims a reply was delivered", () => {
    // MESSAGE_SENT is written when a mail provider ACCEPTED the message (src/server/outbox.ts); an
    // accepted message can still bounce, so no ledger label may say a reply arrived anywhere.
    for (const action of AUDIT_ACTIONS) {
      expect(ACTION_LABELS[action], action).not.toMatch(/\bdelivered\b/i);
    }
  });

  it("names a successful send with the same word the delivery chip prints", () => {
    expect(ACTION_LABELS.MESSAGE_SENT).toBe("Reply sent");
    expect(ACTION_LABELS.MESSAGE_SENT.toLowerCase()).toContain(
      MESSAGE_DELIVERY_STATUS_LABELS.SENT.toLowerCase(),
    );
  });

  it("keeps 'delivery' only where failure is established", () => {
    // The asymmetry is deliberate: a FAILED row proves the provider did not accept the reply, so
    // nothing was delivered. Success proves acceptance only.
    expect(ACTION_LABELS.MESSAGE_FAILED).toMatch(/fail/i);
    expect(ACTION_LABELS.MESSAGE_FAILED).not.toMatch(/\bsent\b/i);
  });

  it("does not say a public reply was sent when saving it only wrote a comment", () => {
    // Saving a public reply writes the comment and enqueues a delivery; the send is reported by the
    // MESSAGE_* actions. The composer button reads "Save reply to ticket" for the same reason.
    expect(ACTION_LABELS.COMMENT_ADDED_PUBLIC).not.toMatch(/\bsent\b/i);
    expect(ACTION_LABELS.COMMENT_ADDED_PUBLIC).toBe("Public reply added");
  });

  it("uses 'sent' in exactly the actions that report a send RESULT, and nowhere else", () => {
    // The rule is that the word may never claim more than the event proves. Wave B adds one more
    // event that genuinely proves it: `WEBHOOK_DELIVERY_SENT` is written only when a receiver
    // ACCEPTED the request, which is exactly the same standard `MESSAGE_SENT` is held to. Everything
    // else stays out — `COMMENT_ADDED_PUBLIC` says "added", `MESSAGE_QUEUED` says "queued", and
    // `WEBHOOK_DELIVERY_FAILED` / `MESSAGE_BOUNCED` describe failures rather than un-sends.
    const sayingSent = AUDIT_ACTIONS.filter((a) => /\bsent\b/i.test(ACTION_LABELS[a]));
    expect(sayingSent).toEqual(["MESSAGE_SENT", "WEBHOOK_DELIVERY_SENT"]);
  });
});
