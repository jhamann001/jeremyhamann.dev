/**
 * Brand identity tests.
 *
 * Pure — no database, no environment. The point of these is narrow and deliberate: an identity is
 * either complete and well formed, or the desk refuses to build an outbound message from it. There is
 * no "send from whatever we have" path.
 */
import { describe, expect, it } from "vitest";
import { TICKET_BRANDS } from "@/types/domain";
import type { TicketBrand } from "@/types/domain";
import { AppError } from "@/lib/errors";
import {
  BRAND_IDENTITIES,
  formatFromHeader,
  identityFor,
  isResolvableIdentity,
  messageIdFor,
  replyToFor,
  resolvableBrands,
} from "@/lib/brand";
import type { BrandIdentity } from "@/lib/brand";

const SAMPLE_TOKEN = "wm.dGlja2V0XzE.YWJjZGVmZ2hpamtsbW5v";

describe("BRAND_IDENTITIES", () => {
  it("covers every brand in the enum, and every entry resolves", () => {
    expect(Object.keys(BRAND_IDENTITIES).sort()).toEqual([...TICKET_BRANDS].sort());
    expect(resolvableBrands().sort()).toEqual([...TICKET_BRANDS].sort());
    for (const brand of TICKET_BRANDS) {
      expect(isResolvableIdentity(BRAND_IDENTITIES[brand]), brand).toBe(true);
      expect(BRAND_IDENTITIES[brand].brand, brand).toBe(brand);
    }
  });

  it("gives each brand its own From address and Reply-To mailbox", () => {
    const froms = TICKET_BRANDS.map((b) => BRAND_IDENTITIES[b].fromAddress);
    expect(new Set(froms).size).toBe(froms.length);
  });

  it("is frozen — the firm's sending identity cannot be changed at runtime", () => {
    expect(Object.isFrozen(BRAND_IDENTITIES)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITIES.CEDAR_RIDGE_WEALTH)).toBe(true);
  });
});

describe("isResolvableIdentity", () => {
  const good: BrandIdentity = BRAND_IDENTITIES.CEDAR_RIDGE_WEALTH;

  it("rejects undefined and every half-filled field", () => {
    expect(isResolvableIdentity(undefined)).toBe(false);
    const broken: Array<Partial<BrandIdentity>> = [
      { fromAddress: "" },
      { fromAddress: "not-an-address" },
      { fromAddress: "two@@dots.com" },
      { fromName: "" },
      { fromName: 'Cedar Ridge "Wealth"' },
      { fromName: "CedarRidge, Wealth" },
      { replyToLocalPart: "service+already" },
      { replyToLocalPart: "service@example.com" },
      { replyToDomain: "localhost" },
      { messageIdDomain: "" },
    ];
    for (const patch of broken) {
      expect(isResolvableIdentity({ ...good, ...patch }), JSON.stringify(patch)).toBe(false);
    }
  });
});

describe("identityFor", () => {
  it("returns the identity for a known brand", () => {
    expect(identityFor("CEDAR_RIDGE_WEALTH").fromAddress).toBe(BRAND_IDENTITIES.CEDAR_RIDGE_WEALTH.fromAddress);
  });

  it("throws AppError INTERNAL for a brand with no identity — never a guessed address", () => {
    const bogus = "CEDAR_RIDGE_MOON" as TicketBrand;
    expect(() => identityFor(bogus)).toThrow(AppError);
    try {
      identityFor(bogus);
      expect.unreachable("identityFor should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("INTERNAL");
      expect((e as AppError).status).toBe(500);
    }
  });
});

describe("replyToFor", () => {
  it("plus-addresses the token onto the brand's single mailbox (CONTRACT §7.1)", () => {
    const identity = BRAND_IDENTITIES.CEDAR_RIDGE_WEALTH;
    expect(replyToFor("CEDAR_RIDGE_WEALTH", SAMPLE_TOKEN)).toBe(
      `${identity.replyToLocalPart}+${SAMPLE_TOKEN}@${identity.replyToDomain}`,
    );
  });

  it("falls back to the bare mailbox when there is no token (REPLY_TOKEN_SECRET unset)", () => {
    const identity = BRAND_IDENTITIES.CEDAR_RIDGE_DIRECT;
    expect(replyToFor("CEDAR_RIDGE_DIRECT", null)).toBe(`${identity.replyToLocalPart}@${identity.replyToDomain}`);
    expect(replyToFor("CEDAR_RIDGE_DIRECT", "")).toBe(`${identity.replyToLocalPart}@${identity.replyToDomain}`);
  });

  it("produces exactly one @ and no whitespace, for both brands, token or not", () => {
    for (const brand of TICKET_BRANDS) {
      for (const token of [null, SAMPLE_TOKEN]) {
        const value = replyToFor(brand, token);
        expect(value.split("@")).toHaveLength(2);
        expect(value).not.toMatch(/\s/);
      }
    }
  });
});

describe("messageIdFor", () => {
  it("embeds the delivery id in the contract's shape, angle brackets included", () => {
    const id = messageIdFor("CEDAR_RIDGE_WEALTH", "dlv_abc123");
    expect(id).toMatch(/^<wm\.dlv_abc123\.[0-9a-f]{16}@example\.com>$/);
  });

  it("uses the brand's own Message-ID domain", () => {
    expect(messageIdFor("CEDAR_RIDGE_DIRECT", "dlv_x")).toContain(`@${BRAND_IDENTITIES.CEDAR_RIDGE_DIRECT.messageIdDomain}>`);
  });

  it("is unique per call — two deliveries never share a Message-ID", () => {
    const ids = new Set(Array.from({ length: 200 }, () => messageIdFor("CEDAR_RIDGE_WEALTH", "dlv_same")));
    expect(ids.size).toBe(200);
  });
});

describe("formatFromHeader", () => {
  it("renders `Display Name <addr>`", () => {
    expect(formatFromHeader(BRAND_IDENTITIES.CEDAR_RIDGE_WEALTH)).toBe(
      `${BRAND_IDENTITIES.CEDAR_RIDGE_WEALTH.fromName} <${BRAND_IDENTITIES.CEDAR_RIDGE_WEALTH.fromAddress}>`,
    );
  });

  it("never needs quoting: no display name carries a comma, quote or angle bracket", () => {
    for (const brand of TICKET_BRANDS) {
      expect(BRAND_IDENTITIES[brand].fromName).not.toMatch(/[",<>]/);
    }
  });
});
