/**
 * Outbound signature blocks — pure, layer L1.
 *
 * The block at the foot of every client reply. CODE, not configuration, for exactly the reason
 * `src/lib/brand.ts` and `src/lib/disclaimers.ts` are code: it is firm
 * wording a client reads on regulated correspondence, so it belongs in a diff a reviewer approved and
 * a commit somebody can date — not in a console field where a change leaves no trace.
 *
 * **NO PERSONAL CONTACT DETAILS, and the rule is structural rather than editorial.** A signature is
 * rendered from the four fields of {@link BrandSignature} and nothing else; there is no field a mobile
 * number, a direct line or a named individual can be put in. That is deliberate:
 *
 *  - a desk reply is from the DESK. The person who typed it may be on leave when the client calls back,
 *    and a direct line in the archive outlives the person it belonged to;
 *  - a phone number in a signature is an authentication surface. It is the string a client reads back
 *    to somebody claiming to be us, and the string an attacker most wants to replace. One number, in
 *    one reviewed file, is auditable; a number each person types is not;
 *  - `assertNoPersonalContact` refuses a signature carrying a phone-shaped run or a personal-looking
 *    address at module load, so a future edit that adds one fails the test suite rather than a review.
 *
 * WHAT A BLOCK MAY CARRY: the sending desk's display name, the firm's legal name, one line about what
 * the reference number is for, and the `HD-<n>` reference itself. WHAT IT MAY NOT CARRY: an individual,
 * a phone number, a street address, a marketing line, or anything read out of the ticket other than its
 * number.
 *
 * **DRAFT.** The wording below is mirrored verbatim in the build record for
 * the owner's approval, and `signature.test.ts` asserts the two agree. Nothing transmits it: the outbound
 * path writes it onto a `MessageDelivery` row and a poller outside this repo is what eventually sends.
 */
import type { TicketBrand } from "@/types/domain";
import { TICKET_BRANDS } from "@/types/domain";

/**
 * One brand's signature. Four strings, all firm-level.
 *
 * There is no `phone`, no `signerName` and no `address` field, and adding one is the change this
 * module's comment argues against — see `assertNoPersonalContact`, which also refuses the values.
 */
export type BrandSignature = {
  brand: TicketBrand;
  /** Who the mail is from, as a client should read it. Matches `BRAND_IDENTITIES[brand].fromName`. */
  deskName: string;
  /** The legal entity, on its own line under the desk name. */
  firmName: string;
  /** One sentence telling the client what to do with the reference. No marketing, no links. */
  referenceNote: string;
};

/** The separator between a reply body and its signature, in the text part. An em dash on its own line. */
export const SIGNATURE_SEPARATOR = "—" as const;

/**
 * DRAFT wording, pending the owner's confirmation (the build record).
 * Frozen so a caller cannot mutate the firm's sign-off at runtime.
 */
export const BRAND_SIGNATURES: Readonly<Record<TicketBrand, BrandSignature>> = Object.freeze({
  CEDAR_RIDGE_WEALTH: Object.freeze({
    brand: "CEDAR_RIDGE_WEALTH",
    deskName: "Cedar Ridge Wealth Client Service",
    firmName: "Cedar Ridge Wealth",
    referenceNote:
      "Reply to this email with the reference below in the subject line and your message joins this request.",
  }),
  CEDAR_RIDGE_DIRECT: Object.freeze({
    brand: "CEDAR_RIDGE_DIRECT",
    deskName: "Cedar Ridge Direct Support",
    firmName: "Cedar Ridge Direct",
    referenceNote:
      "Reply to this email with the reference below in the subject line and your message joins this request.",
  }),
}) as Readonly<Record<TicketBrand, BrandSignature>>;

/**
 * A run of digits, spaces, dots, dashes and parentheses long enough to be a telephone number, plus the
 * `tel:` scheme and the obvious spellings. Seven digits is the shortest thing anybody dials.
 */
const PHONE_SHAPED = /(?:\btel:|\+\d[\d\s().-]{6,}|\b(?:\(?\d{3}\)?[\s.-]?){2}\d{4}\b|\b\d{7,}\b)/;
/** Any address at all: a signature names a desk, and a desk's address is already the `From` header. */
const ADDRESS_SHAPED = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * Refuses a signature that carries an individual's contact details. Called once per brand at module
 * load, so a future edit fails immediately rather than reaching a client.
 *
 * It checks the VALUES rather than trusting the type, because the type is the thing an edit changes.
 */
export function assertNoPersonalContact(signature: BrandSignature): void {
  for (const [field, value] of Object.entries(signature)) {
    if (typeof value !== "string") continue;
    if (PHONE_SHAPED.test(value)) {
      throw new Error(
        `Signature for ${signature.brand} carries a phone-shaped value in "${field}". ` +
          "A signature block names the desk, never a number a client can be talked into calling back.",
      );
    }
    if (ADDRESS_SHAPED.test(value)) {
      throw new Error(
        `Signature for ${signature.brand} carries an email address in "${field}". ` +
          "The sending identity is already in the From and Reply-To headers (src/lib/brand.ts).",
      );
    }
  }
}

for (const brand of TICKET_BRANDS) {
  assertNoPersonalContact(BRAND_SIGNATURES[brand]);
}

/** The signature for a brand. Total over `TicketBrand`, so there is no unsigned reply. */
export function signatureFor(brand: TicketBrand): BrandSignature {
  return BRAND_SIGNATURES[brand];
}

/** `Reference: HD-1482` — the one ticket fact a signature interpolates. */
export function referenceLine(ticketNumber: number): string {
  return `Reference: HD-${ticketNumber}`;
}

/**
 * The signature as PLAIN TEXT, ready to follow a blank line after the body.
 *
 * Four lines and no trailing whitespace on any of them. Trailing spaces are what turn a plain-text part
 * into `=20` soft breaks once an MTA quoted-printable-encodes it, which is the usual reason a clean
 * text part arrives looking broken.
 */
export function renderSignatureText(signature: BrandSignature, ticketNumber: number): string {
  return [
    SIGNATURE_SEPARATOR,
    signature.deskName,
    signature.firmName,
    "",
    signature.referenceNote,
    referenceLine(ticketNumber),
  ].join("\n");
}

/**
 * The signature as an HTML fragment for the foot of the message.
 *
 * `escape` is the caller's escaper (`escapeHtml` in `render-outbound.ts`) rather than a second copy
 * here: one escaping implementation, tested once. The values are firm-authored constants, so this is
 * defence in depth rather than the primary control — but a signature is the last thing in the document
 * and an unescaped `<` in it would swallow the rest of the message.
 */
export function renderSignatureHtml(
  signature: BrandSignature,
  ticketNumber: number,
  escape: (text: string) => string,
  style: string,
): string {
  return [
    `<p style="${style}">`,
    `${escape(signature.deskName)}<br />`,
    `${escape(signature.firmName)}`,
    "</p>",
    `<p style="${style}">`,
    `${escape(signature.referenceNote)}<br />`,
    `${escape(referenceLine(ticketNumber))}`,
    "</p>",
  ].join("");
}
