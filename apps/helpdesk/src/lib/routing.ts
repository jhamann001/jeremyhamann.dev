/**
 * Category routing helpers — pure, layer L1.
 * Source of truth is `ROUTING_TABLE` in src/types/domain.ts; everything here is derived from it.
 * Category → queue is a default, not a constraint (moves never change the category and vice versa).
 */
import { QUEUE_KEYS, ROUTING_TABLE, TICKET_CATEGORIES } from "@/types/domain";
import type { DisclaimerKey, QueueKey, RoutingRule, TicketCategory, TicketPriority } from "@/types/domain";

function byCategory<T>(pick: (rule: RoutingRule) => T): Readonly<Record<TicketCategory, T>> {
  const out = {} as Record<TicketCategory, T>;
  for (const category of TICKET_CATEGORIES) out[category] = pick(ROUTING_TABLE[category]);
  return Object.freeze(out);
}

/** The routing rule for a category (a copy, so callers cannot mutate the shared table). */
export function routeCategory(c: TicketCategory): RoutingRule {
  const rule = ROUTING_TABLE[c];
  return { queueKey: rule.queueKey, priority: rule.priority, disclaimerKey: rule.disclaimerKey };
}

export const DEFAULT_QUEUE_BY_CATEGORY: Readonly<Record<TicketCategory, QueueKey>> = byCategory((r) => r.queueKey);

export const DEFAULT_PRIORITY_BY_CATEGORY: Readonly<Record<TicketCategory, TicketPriority>> = byCategory(
  (r) => r.priority,
);

export const DEFAULT_DISCLAIMER_BY_CATEGORY: Readonly<Record<TicketCategory, DisclaimerKey>> = byCategory(
  (r) => r.disclaimerKey,
);

export const CATEGORIES_BY_QUEUE: Readonly<Record<QueueKey, readonly TicketCategory[]>> = Object.freeze(
  (() => {
    const out = {} as Record<QueueKey, readonly TicketCategory[]>;
    for (const queue of QUEUE_KEYS) {
      out[queue] = Object.freeze(TICKET_CATEGORIES.filter((c) => ROUTING_TABLE[c].queueKey === queue));
    }
    return out;
  })(),
);
