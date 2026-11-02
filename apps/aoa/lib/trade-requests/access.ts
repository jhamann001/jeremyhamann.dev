// Workspace roles (owner rulings D1/D2), matched exactly. auth.ts already
// normalizes the session role; the client applies this to the stored role,
// which is what refuses legacy values such as HEAD_OF_ADVISORY.
export const TRADE_REQUESTS_WORKSPACE_ROLES = ["ADMIN", "OPERATIONS", "ADVISOR"] as const;
export type TradeRequestsWorkspaceRole = (typeof TRADE_REQUESTS_WORKSPACE_ROLES)[number];

export function canUseTradeRequestsWorkspace(role: string | null | undefined): role is TradeRequestsWorkspaceRole {
  return (TRADE_REQUESTS_WORKSPACE_ROLES as readonly string[]).includes(role ?? "");
}
