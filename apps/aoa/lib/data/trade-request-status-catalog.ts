import type { PillTone } from "@/components/ui";
import { humanizeStatus } from "./acat-status-catalog";

// Canonical Trade-Request `RequestStatus` → display label + Pill tone. The raw
// values mirror the Trade-Request app's shared enum exactly
// (trade-request/shared/src/types.ts): 'Pending Review', 'Needs Info',
// 'Pending Current Asset Liquidation', 'Approved', 'Rejected', 'Completed'.
// Reuses humanizeStatus (acat-status-catalog) as the safe fallback so a status
// the app adds later renders readable rather than crashing or disappearing.

export type TradeRequestStatusMeta = { label: string; tone: PillTone };

const CATALOG: Record<string, TradeRequestStatusMeta> = {
  "Pending Review": { label: "Pending Review", tone: "amber" },
  "Needs Info": { label: "Needs Info", tone: "red" },
  "Pending Current Asset Liquidation": {
    label: "Pending Liquidation",
    tone: "amber",
  },
  Approved: { label: "Approved", tone: "green" },
  Rejected: { label: "Rejected", tone: "red" },
  Completed: { label: "Completed", tone: "blue" },
};

/**
 * Resolve a raw request status to its display metadata. Never throws, never
 * null:
 *   • a known raw enum value → its catalog entry;
 *   • a null / blank value → "Unknown status" (gray);
 *   • any other value → a humanized label (gray) that stays visible.
 */
export function resolveTradeRequestStatus(
  raw: string | null | undefined,
): TradeRequestStatusMeta {
  const key = (raw ?? "").trim();
  if (key === "") return { label: "Unknown status", tone: "gray" };
  return Object.hasOwn(CATALOG, key) ? CATALOG[key] : { label: humanizeStatus(key), tone: "gray" };
}
