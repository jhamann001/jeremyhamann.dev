import "server-only";
import { tradeRequestsDriftViewEnabled, tradeRequestsRosterAdminEnabled } from "@/lib/flags";
import { canUseTradeRequestsWorkspace } from "./access";
import { isAoaServed } from "./serving-state";

export type WorkspaceSections = { drift: boolean; roster: boolean };

const NONE: WorkspaceSections = { drift: false, roster: false };

// The Drift and Roster screens (ticket) exist only while AOA holds the live results: switch on and
// Trade Requests AOA-served. Drift for every workspace role; Roster for ADMIN with roster administration
// switched on. The serving state is read only when the switch is on.
export async function tradeRequestsWorkspaceSections(role: string): Promise<WorkspaceSections> {
  if (!tradeRequestsDriftViewEnabled() || !canUseTradeRequestsWorkspace(role)) return NONE;
  if (!(await isAoaServed())) return NONE;
  return { drift: true, roster: role === "ADMIN" && tradeRequestsRosterAdminEnabled() };
}
