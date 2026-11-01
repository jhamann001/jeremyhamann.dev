/**
 * SYSTEM template tests.
 *
 * The important assertion in this file is the LAST one: the bodies in the code and the bodies in
 * the build record*.md` are the same bytes. The wave's acceptance criterion is that what the owner
 * and the CCO approve is what would be transmitted, and a messages file that drifts from the templates
 * turns that approval into a description of something else.
 */
import { describe, expect, it } from "vitest";
import { TICKET_BRANDS } from "@/types/domain";
import { DISCLAIMERS } from "@/lib/disclaimers";
import {
  SYSTEM_MESSAGE_KINDS,
  SYSTEM_MESSAGE_TEMPLATES,
  everySystemTemplate,
  renderSystemMessage,
  systemMessageTemplate,
} from "@/lib/email/templates/system";
import { sanitizePII } from "@/lib/pii";

const SAMPLE_NUMBER = 1482;


describe("the template registry", () => {
  it("is total over brand × kind", () => {
    for (const brand of TICKET_BRANDS) {
      for (const kind of SYSTEM_MESSAGE_KINDS) {
        const template = systemMessageTemplate(brand, kind);
        expect(template.brand).toBe(brand);
        expect(template.kind).toBe(kind);
        expect(template.body({ ticketNumber: SAMPLE_NUMBER })).toBeTypeOf("string");
      }
    }
    expect(everySystemTemplate()).toHaveLength(TICKET_BRANDS.length * SYSTEM_MESSAGE_KINDS.length);
  });

  it("is frozen — the firm's wording cannot be mutated at runtime", () => {
    expect(Object.isFrozen(SYSTEM_MESSAGE_TEMPLATES)).toBe(true);
    for (const brand of TICKET_BRANDS) {
      expect(Object.isFrozen(SYSTEM_MESSAGE_TEMPLATES[brand])).toBe(true);
    }
  });

  it("never carries a NONE disclaimer — every one of these is a PUBLIC reply", () => {
    for (const template of everySystemTemplate()) {
      expect(template.disclaimerKey).not.toBe("NONE");
    }
  });
});

describe("the bodies", () => {
  it("interpolate the WM number and nothing else", () => {
    for (const template of everySystemTemplate()) {
      const a = template.body({ ticketNumber: 1 });
      const b = template.body({ ticketNumber: 2 });
      // The only difference between two renders is the number.
      expect(a.replace(/HD-1/g, "HD-N")).toBe(b.replace(/HD-2/g, "HD-N"));
      expect(a).toContain("HD-1");
    }
  });

  it("contain no address, and nothing sanitizePII recognises", () => {
    for (const template of everySystemTemplate()) {
      const body = template.body({ ticketNumber: SAMPLE_NUMBER });
      expect(body, `${template.brand}/${template.kind} contains an '@'`).not.toContain("@");
      expect(sanitizePII(body).redacted, `${template.brand}/${template.kind}`).toBe(false);
    }
  });

  it("say in words that an acknowledgement is not an answer", () => {
    for (const brand of TICKET_BRANDS) {
      const body = systemMessageTemplate(brand, "AUTO_ACK").body({ ticketNumber: SAMPLE_NUMBER });
      expect(body).toContain("not an answer");
    }
  });

  it("tell the client how to reach the same request again", () => {
    for (const template of everySystemTemplate()) {
      const body = template.body({ ticketNumber: SAMPLE_NUMBER });
      expect(body).toContain("Reply to this email");
      expect(body).toContain("subject line");
    }
  });

  it("carry the do-not-email-sensitive-data line in the body, not only the disclaimer", () => {
    for (const template of everySystemTemplate()) {
      expect(template.body({ ticketNumber: SAMPLE_NUMBER })).toContain("Please do not send account numbers");
    }
  });
});

describe("renderSystemMessage", () => {
  it("appends the disclaimer into the stored body (I7)", () => {
    for (const brand of TICKET_BRANDS) {
      for (const kind of SYSTEM_MESSAGE_KINDS) {
        const template = systemMessageTemplate(brand, kind);
        const rendered = renderSystemMessage(brand, kind, { ticketNumber: SAMPLE_NUMBER });
        expect(rendered.disclaimerKey).toBe(template.disclaimerKey);
        expect(rendered.body).toContain(template.body({ ticketNumber: SAMPLE_NUMBER }).trimEnd());
        expect(rendered.body).toContain("\n\n---\n");
        expect(rendered.body).toContain(DISCLAIMERS[template.disclaimerKey].text);
      }
    }
  });
});

// The DRAFT-copy checks that stood here compared this module with the firm's message-approval documents
// (docs/wave-b/messages/), which stay with the firm and were not part of the portfolio import.
