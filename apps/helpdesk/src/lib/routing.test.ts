/**
 * Routing helpers — the §c table, verbatim (§g S2 tests).
 */
import { describe, expect, it } from "vitest";
import { QUEUE_KEYS, ROUTING_TABLE, TICKET_CATEGORIES } from "@/types/domain";
import type { DisclaimerKey, QueueKey, TicketCategory, TicketPriority } from "@/types/domain";
import {
  CATEGORIES_BY_QUEUE,
  DEFAULT_DISCLAIMER_BY_CATEGORY,
  DEFAULT_PRIORITY_BY_CATEGORY,
  DEFAULT_QUEUE_BY_CATEGORY,
  routeCategory,
} from "@/lib/routing";

/** §c, copied by hand so a drift in either ROUTING_TABLE or the helpers is caught here. */
const EXPECTED: Record<TicketCategory, [QueueKey, TicketPriority, DisclaimerKey]> = {
  WIRE_TRANSFER: ["OPERATIONS", "URGENT", "WIRE_VERIFICATION"],
  ACAT: ["OPERATIONS", "STANDARD", "GENERAL_SERVICE"],
  TRADE_CORRECTION: ["OPERATIONS", "URGENT", "GENERAL_SERVICE"],
  CASH_MOVEMENT: ["OPERATIONS", "HIGH", "WIRE_VERIFICATION"],
  PORTAL_RESET: ["CLIENT_SERVICE", "HIGH", "GENERAL_SERVICE"],
  TAX_DOCUMENT: ["CLIENT_SERVICE", "STANDARD", "TAX_DOCUMENT"],
  ADDRESS_CHANGE: ["CLIENT_SERVICE", "STANDARD", "GENERAL_SERVICE"],
  REBALANCING: ["ADVICE", "STANDARD", "INVESTMENT_ADVICE"],
  PLANNING_UPDATE: ["ADVICE", "LOW", "INVESTMENT_ADVICE"],
  TAX_LOSS_HARVESTING: ["ADVICE", "STANDARD", "NOT_TAX_OR_LEGAL_ADVICE"],
  OTHER: ["CLIENT_SERVICE", "STANDARD", "GENERAL_SERVICE"],
  // --- Wave A, copied by hand from the build record "Routing table additions". ---
  ACCOUNT_CLOSURE: ["OPERATIONS", "HIGH", "GENERAL_SERVICE"],
  BENEFICIARY_TOD: ["OPERATIONS", "STANDARD", "NOT_TAX_OR_LEGAL_ADVICE"],
  RETURNED_CHECK: ["OPERATIONS", "HIGH", "WIRE_VERIFICATION"],
  RETURNED_MAIL: ["CLIENT_SERVICE", "STANDARD", "GENERAL_SERVICE"],
  PASSKEY_LOGIN: ["CLIENT_SERVICE", "HIGH", "GENERAL_SERVICE"],
  IDENTITY_VERIFICATION: ["CLIENT_SERVICE", "HIGH", "GENERAL_SERVICE"],
  COMPLAINT: ["CLIENT_SERVICE", "URGENT", "GENERAL_SERVICE"],
  RETIREMENT_DISTRIBUTION: ["OPERATIONS", "HIGH", "NOT_TAX_OR_LEGAL_ADVICE"],
  COST_BASIS: ["OPERATIONS", "STANDARD", "NOT_TAX_OR_LEGAL_ADVICE"],
  VOICEMAIL_CALLBACK: ["CLIENT_SERVICE", "HIGH", "GENERAL_SERVICE"],
  STATEMENT_REQUEST: ["CLIENT_SERVICE", "STANDARD", "GENERAL_SERVICE"],
};

describe("routeCategory (§c table)", () => {
  for (const category of TICKET_CATEGORIES) {
    const [queueKey, priority, disclaimerKey] = EXPECTED[category];
    it(`${category} → ${queueKey} / ${priority} / ${disclaimerKey}`, () => {
      expect(routeCategory(category)).toEqual({ queueKey, priority, disclaimerKey });
      expect(routeCategory(category)).toEqual(ROUTING_TABLE[category]);
    });
  }

  it("returns a fresh copy so callers cannot mutate the shared table", () => {
    const a = routeCategory("WIRE_TRANSFER");
    const b = routeCategory("WIRE_TRANSFER");
    expect(a).not.toBe(b);
    expect(a).not.toBe(ROUTING_TABLE.WIRE_TRANSFER);
    a.priority = "LOW";
    expect(routeCategory("WIRE_TRANSFER").priority).toBe("URGENT");
    expect(ROUTING_TABLE.WIRE_TRANSFER.priority).toBe("URGENT");
  });

  it("no public-reply default is NONE (every category has a firm-approved disclaimer)", () => {
    for (const category of TICKET_CATEGORIES) {
      expect(routeCategory(category).disclaimerKey).not.toBe("NONE");
    }
  });
});

describe("derived maps", () => {
  it("DEFAULT_QUEUE_BY_CATEGORY / DEFAULT_PRIORITY_BY_CATEGORY / DEFAULT_DISCLAIMER_BY_CATEGORY cover every category", () => {
    for (const category of TICKET_CATEGORIES) {
      const [queueKey, priority, disclaimerKey] = EXPECTED[category];
      expect(DEFAULT_QUEUE_BY_CATEGORY[category]).toBe(queueKey);
      expect(DEFAULT_PRIORITY_BY_CATEGORY[category]).toBe(priority);
      expect(DEFAULT_DISCLAIMER_BY_CATEGORY[category]).toBe(disclaimerKey);
    }
    expect(Object.keys(DEFAULT_QUEUE_BY_CATEGORY).sort()).toEqual([...TICKET_CATEGORIES].sort());
    expect(Object.keys(DEFAULT_PRIORITY_BY_CATEGORY).sort()).toEqual([...TICKET_CATEGORIES].sort());
    expect(Object.keys(DEFAULT_DISCLAIMER_BY_CATEGORY).sort()).toEqual([...TICKET_CATEGORIES].sort());
  });

  it("the derived maps are frozen", () => {
    expect(Object.isFrozen(DEFAULT_QUEUE_BY_CATEGORY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PRIORITY_BY_CATEGORY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DISCLAIMER_BY_CATEGORY)).toBe(true);
    expect(Object.isFrozen(CATEGORIES_BY_QUEUE)).toBe(true);
    for (const q of QUEUE_KEYS) expect(Object.isFrozen(CATEGORIES_BY_QUEUE[q])).toBe(true);
  });

  it("CATEGORIES_BY_QUEUE partitions the categories (every category in exactly one queue)", () => {
    // Declaration order of TICKET_CATEGORIES, filtered per queue (Wave A appended eleven categories).
    expect(CATEGORIES_BY_QUEUE.OPERATIONS).toEqual([
      "WIRE_TRANSFER",
      "ACAT",
      "TRADE_CORRECTION",
      "CASH_MOVEMENT",
      "ACCOUNT_CLOSURE",
      "BENEFICIARY_TOD",
      "RETURNED_CHECK",
      "RETIREMENT_DISTRIBUTION",
      "COST_BASIS",
    ]);
    expect(CATEGORIES_BY_QUEUE.CLIENT_SERVICE).toEqual([
      "PORTAL_RESET",
      "TAX_DOCUMENT",
      "ADDRESS_CHANGE",
      "OTHER",
      "RETURNED_MAIL",
      "PASSKEY_LOGIN",
      "IDENTITY_VERIFICATION",
      "COMPLAINT",
      "VOICEMAIL_CALLBACK",
      "STATEMENT_REQUEST",
    ]);
    expect(CATEGORIES_BY_QUEUE.ADVICE).toEqual(["REBALANCING", "PLANNING_UPDATE", "TAX_LOSS_HARVESTING"]);

    const all = QUEUE_KEYS.flatMap((q) => [...CATEGORIES_BY_QUEUE[q]]);
    expect(all.length).toBe(TICKET_CATEGORIES.length);
    expect(new Set(all).size).toBe(TICKET_CATEGORIES.length);
    expect([...all].sort()).toEqual([...TICKET_CATEGORIES].sort());
    for (const q of QUEUE_KEYS) {
      for (const c of CATEGORIES_BY_QUEUE[q]) expect(DEFAULT_QUEUE_BY_CATEGORY[c]).toBe(q);
    }
  });
});
