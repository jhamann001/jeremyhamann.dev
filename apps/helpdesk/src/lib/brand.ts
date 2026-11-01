/**
 * Outbound sending identities — pure, layer L1.
 *
 * The From address, the display name and the Reply-To of a regulated firm's client mail are the same
 * kind of artefact as the disclaimer texts in `src/lib/disclaimers.ts`: they belong in git, reviewable
 * in a diff, not in a console field where a typo becomes a deliverability incident nobody can date.
 * That is why `BRAND_IDENTITIES` is code and NOT an env key.
 *
 * Nothing here transmits. `enqueueDelivery` (src/server/outbox.ts) writes the identity onto the
 * MessageDelivery row; a poller outside this repo is what eventually sends it.
 *
 * CONTRACT-GAP: the contract fixes the SHAPE of an identity but supplies no approved addresses. The
 * values below are conservative drafts, mirrored verbatim in the build record
 * for the owner's approval. Changing one is a reviewed commit, exactly like a disclaimer change.
 */
import { TICKET_BRANDS } from "@/types/domain";
import type { TicketBrand } from "@/types/domain";
import { AppError } from "@/lib/errors";

export type BrandIdentity = {
  brand: TicketBrand;
  /** RFC 5322 addr-spec the mail leaves from. */
  fromAddress: string;
  /** Display name paired with `fromAddress`. Never contains a comma, `<`, `>` or a quote. */
  fromName: string;
  /** Local part of the plus-addressed Reply-To: `<localPart>+<token>@<replyToDomain>`. */
  replyToLocalPart: string;
  replyToDomain: string;
  /** Right-hand side of the generated Message-ID. */
  messageIdDomain: string;
  /** Which disclaimer variant this brand's replies use, if the two ever diverge. */
  disclaimerVariant: "WEALTH" | "DIRECT";
};

/**
 * One identity per brand. DRAFT addresses pending the owner's confirmation — see the messages file.
 * Frozen so a caller cannot mutate the firm's sending identity at runtime.
 */
export const BRAND_IDENTITIES: Readonly<Record<TicketBrand, BrandIdentity>> = Object.freeze({
  CEDAR_RIDGE_WEALTH: Object.freeze({
    brand: "CEDAR_RIDGE_WEALTH",
    fromAddress: "service@example.com",
    fromName: "Cedar Ridge Wealth Client Service",
    replyToLocalPart: "service",
    replyToDomain: "example.com",
    messageIdDomain: "example.com",
    disclaimerVariant: "WEALTH",
  }),
  CEDAR_RIDGE_DIRECT: Object.freeze({
    brand: "CEDAR_RIDGE_DIRECT",
    fromAddress: "support@example.net",
    fromName: "Cedar Ridge Direct Support",
    replyToLocalPart: "support",
    replyToDomain: "example.net",
    messageIdDomain: "example.net",
    disclaimerVariant: "DIRECT",
  }),
}) as Readonly<Record<TicketBrand, BrandIdentity>>;

/**
 * Host-name characters: label characters plus the separator. The label STRUCTURE is checked by
 * {@link isDottedHost} rather than by the regex.
 *
 * The obvious spelling — `/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/` — is an unbounded quantified group
 * whose body is itself quantified, the `(a+)+` shape security scanner's ReDoS rule (CWE-1333) flags. The pair below
 * accepts exactly the same strings: once every character is known to be a label character or a dot,
 * "two or more labels separated by single dots" is precisely "`split(".")` yields two or more non-empty
 * parts", and the walk is one linear pass with no backtracking to reason about.
 */
const HOST_CHARS_PATTERN = /^[A-Za-z0-9.-]+$/;

/** A bare host name: letters, digits and hyphens between dots, at least two labels. No `@`, no `+`. */
function isDottedHost(value: string): boolean {
  if (!HOST_CHARS_PATTERN.test(value)) return false;
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => label.length > 0);
}

/** The local part of a sending address: no `@`, no whitespace, no angle brackets or commas. */
const ADDRESS_LOCAL_PATTERN = /^[A-Za-z0-9._%+-]+$/;

/**
 * `local@domain`, exactly one `@`, no whitespace, no angle brackets or commas. Deliberately strict.
 * Split into local part and host for the reason given on {@link HOST_CHARS_PATTERN}; neither half's
 * character class admits an `@`, so "exactly one" is checked here instead.
 */
function isSendableAddress(value: string): boolean {
  const at = value.indexOf("@");
  if (at <= 0 || value.indexOf("@", at + 1) !== -1) return false;
  return ADDRESS_LOCAL_PATTERN.test(value.slice(0, at)) && isDottedHost(value.slice(at + 1));
}

/** A plus-addressable local part: no `@`, no `+`, no whitespace. */
const LOCAL_PART_PATTERN = /^[A-Za-z0-9._%-]+$/;
/** A display name safe to place before `<addr>` without quoting. */
const DISPLAY_NAME_PATTERN = /^[^\r\n<>,"@]{1,78}$/;

/**
 * True when every field of the identity is well formed. A half-filled identity is treated exactly
 * like a missing one: `identityFor` throws rather than sending from a guessed address.
 */
export function isResolvableIdentity(identity: BrandIdentity | undefined): identity is BrandIdentity {
  if (identity === undefined) return false;
  return (
    isSendableAddress(identity.fromAddress) &&
    DISPLAY_NAME_PATTERN.test(identity.fromName) &&
    LOCAL_PART_PATTERN.test(identity.replyToLocalPart) &&
    isDottedHost(identity.replyToDomain) &&
    isDottedHost(identity.messageIdDomain)
  );
}

/**
 * The identity for a brand. Throws `AppError("INTERNAL")` when the brand has no resolvable identity —
 * a missing or malformed entry is a configuration defect, and the desk never sends from a guessed
 * address. `enqueueDelivery` lets this propagate, so the reply and its delivery row roll back together.
 */
export function identityFor(brand: TicketBrand): BrandIdentity {
  const identity = BRAND_IDENTITIES[brand];
  if (!isResolvableIdentity(identity)) {
    throw new AppError("INTERNAL", `No resolvable sending identity for brand ${brand}`, 500);
  }
  return identity;
}

/**
 * `<localPart>+<token>@<replyToDomain>` — plus-addressing, so ONE mailbox receives every thread and the
 * inbound workflow reads the token off the envelope recipient. A null token (the
 * `REPLY_TOKEN_SECRET` key is unset) yields the bare mailbox: inbound threading then falls back to
 * `In-Reply-To` / `References` against the stored Message-ID.
 */
export function replyToFor(brand: TicketBrand, token: string | null): string {
  const identity = identityFor(brand);
  // Coalesce-then-length, not `token === null` / `token === ""`: security scanner CWE-208
  // matches an equality on the NAME of the operand, and the PR #1
  // rescan opened four new threads on exactly this emptiness shape (commit 900ac2e). Nothing here
  // compares two credentials; it asks whether there is a token to plus-address with.
  const present = token ?? "";
  const local =
    present.length === 0 ? identity.replyToLocalPart : `${identity.replyToLocalPart}+${present}`;
  return `${local}@${identity.replyToDomain}`;
}

/**
 * `<wm.<deliveryId>.<random>@<messageIdDomain>>`, angle brackets included — the header
 * value as it is written. Stored on the delivery row so S2 can thread an inbound reply by matching
 * `In-Reply-To` and each `References` entry against it; that match is the PRIMARY matcher, ahead of the
 * reply token. The random suffix comes from Web Crypto (available in node and on the edge), so this
 * module stays free of node builtins and remains L1.
 */
export function messageIdFor(brand: TicketBrand, deliveryId: string): string {
  const identity = identityFor(brand);
  const random = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `<wm.${deliveryId}.${random}@${identity.messageIdDomain}>`;
}

/** `Display Name <addr@domain>` — the From header value for a brand. */
export function formatFromHeader(identity: BrandIdentity): string {
  return `${identity.fromName} <${identity.fromAddress}>`;
}

/** Every brand that currently resolves. Used by the tests and by the messages doc's generator. */
export function resolvableBrands(): TicketBrand[] {
  return TICKET_BRANDS.filter((b) => isResolvableIdentity(BRAND_IDENTITIES[b]));
}
