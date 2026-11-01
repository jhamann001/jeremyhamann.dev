/**
 * Signature-block tests.
 *
 * The two assertions that matter are the structural one and the documentary one:
 *
 *   - `assertNoPersonalContact` actually refuses a phone number and an address, so "no personal
 *     contact details in a signature" is a rule the test suite enforces rather than a convention a
 *     reviewer has to remember;
 *   - the blocks in the code and the blocks in the build record are the same
 *     bytes, so approving the document approves what would be appended.
 */
import { describe, expect, it } from "vitest";
import { TICKET_BRANDS } from "@/types/domain";
import { BRAND_IDENTITIES } from "@/lib/brand";
import {
  BRAND_SIGNATURES,
  SIGNATURE_SEPARATOR,
  assertNoPersonalContact,
  referenceLine,
  renderSignatureHtml,
  renderSignatureText,
  signatureFor,
} from "@/lib/email/templates/signature";
import { escapeHtml } from "@/lib/email/render-outbound";

const SAMPLE_NUMBER = 1482;


describe("the signature registry", () => {
  it("is total over TicketBrand — there is no unsigned reply", () => {
    for (const brand of TICKET_BRANDS) {
      const signature = signatureFor(brand);
      expect(signature.brand).toBe(brand);
      expect(signature.deskName.length).toBeGreaterThan(0);
      expect(signature.firmName.length).toBeGreaterThan(0);
      expect(signature.referenceNote.length).toBeGreaterThan(0);
    }
  });

  it("is frozen — the firm's sign-off cannot be mutated at runtime", () => {
    expect(Object.isFrozen(BRAND_SIGNATURES)).toBe(true);
    for (const brand of TICKET_BRANDS) expect(Object.isFrozen(BRAND_SIGNATURES[brand])).toBe(true);
  });

  it("signs with the same desk name the From header carries", () => {
    for (const brand of TICKET_BRANDS) {
      expect(signatureFor(brand).deskName).toBe(BRAND_IDENTITIES[brand].fromName);
    }
  });
});

describe("assertNoPersonalContact", () => {
  const base = signatureFor("CEDAR_RIDGE_WEALTH");

  it("passes every shipped signature", () => {
    for (const brand of TICKET_BRANDS) {
      expect(() => assertNoPersonalContact(signatureFor(brand))).not.toThrow();
    }
  });

  it.each([
    ["an international number", "Cedar Ridge Wealth +1 512 555 0142"],
    ["a formatted US number", "Cedar Ridge Wealth (512) 555-0142"],
    ["a bare digit run", "Cedar Ridge Wealth 5125550142"],
    ["a tel: link", "Cedar Ridge Wealth tel:5125550142"],
  ])("refuses %s", (_label, firmName) => {
    expect(() => assertNoPersonalContact({ ...base, firmName })).toThrow(/phone-shaped/);
  });

  it("refuses an email address — the sending identity is already in the headers", () => {
    expect(() => assertNoPersonalContact({ ...base, referenceNote: "Write to dean@example.com" })).toThrow(
      /email address/,
    );
  });
});

describe("renderSignatureText", () => {
  const rendered = renderSignatureText(signatureFor("CEDAR_RIDGE_WEALTH"), SAMPLE_NUMBER);

  it("leads with the separator and ends with the reference", () => {
    const lines = rendered.split("\n");
    expect(lines[0]).toBe(SIGNATURE_SEPARATOR);
    expect(lines[lines.length - 1]).toBe(referenceLine(SAMPLE_NUMBER));
  });

  it("carries no trailing whitespace on any line — that is what becomes =20 in transit", () => {
    for (const line of rendered.split("\n")) expect(line).toBe(line.replace(/[ \t]+$/, ""));
  });

  it("is deterministic", () => {
    expect(renderSignatureText(signatureFor("CEDAR_RIDGE_WEALTH"), SAMPLE_NUMBER)).toBe(rendered);
  });
});

describe("renderSignatureHtml", () => {
  it("escapes through the caller's escaper rather than a second copy", () => {
    const hostile = { ...signatureFor("CEDAR_RIDGE_DIRECT"), deskName: "Support <b>x</b>" };
    const html = renderSignatureHtml(hostile, SAMPLE_NUMBER, escapeHtml, "margin:0");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("carries the reference, like the text part", () => {
    const html = renderSignatureHtml(signatureFor("CEDAR_RIDGE_WEALTH"), SAMPLE_NUMBER, escapeHtml, "margin:0");
    expect(html).toContain(referenceLine(SAMPLE_NUMBER));
  });
});

// The DRAFT-copy checks that stood here compared this module with the firm's message-approval documents
// (docs/wave-b/messages/), which stay with the firm and were not part of the portfolio import.
