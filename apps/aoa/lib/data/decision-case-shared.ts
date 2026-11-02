/**
 * Browser-safe Decision Center labels and value types.
 *
 * Keep this module free of database, RLS, and other server-only imports. Client
 * workspaces need these labels at runtime; importing them from decision-cases
 * would also pull Prisma into the browser bundle.
 */
export const DECISION_OWNER_TEAMS = [
  "OPERATIONS",
  "CLIENT_SERVICE",
  "ADVISORY",
  "TRADE_DESK",
] as const;

export type DecisionOwnerTeamValue = (typeof DECISION_OWNER_TEAMS)[number];

export const DECISION_OWNER_LABEL: Record<DecisionOwnerTeamValue, string> = {
  OPERATIONS: "Operations",
  CLIENT_SERVICE: "Client Service",
  ADVISORY: "Advisory",
  TRADE_DESK: "Trade Desk",
};

/** Transfer detail route; archived transfers still load there, read-only. */
export function transferDetailHref(transferId: string): string {
  return `/asset-transfer/${encodeURIComponent(transferId)}`;
}
