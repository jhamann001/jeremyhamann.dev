import { withUserScope, type Identity } from "@/lib/rls";

export const TRADE_PROFILE_REVIEW_ROLES = new Set([
  "ADMIN",
  "OPERATIONS",
  "ADVISOR",
  "CLIENT_SERVICE",
]);

export type TradeProfileSelectionRecord = {
  id: string;
  clientSfId: string;
  accountId: string;
  requestId: string;
  requestDecidedAt: string;
  reviewedRequestIds: string[];
  note: string;
  selectedBy: string | null;
  selectedAt: string;
};

export function canConfirmTradeProfile(role: string | null | undefined): boolean {
  return TRADE_PROFILE_REVIEW_ROLES.has(role ?? "");
}

/** RLS-scoped confirmed sources for one visible client. */
export async function tradeProfileSelectionsForClient(
  identity: Identity,
  clientSfId: string,
): Promise<TradeProfileSelectionRecord[]> {
  if (!clientSfId) return [];
  const rows = await withUserScope(identity, (tx) =>
    tx.tradeProfileSelection.findMany({
      where: { client_sf_id: clientSfId },
      orderBy: { custodian_account_id: "asc" },
    }),
  );
  return rows.map((row) => ({
    id: row.id,
    clientSfId: row.client_sf_id,
    accountId: row.custodian_account_id,
    requestId: row.selected_request_id,
    requestDecidedAt: row.selected_request_decided_at.toISOString(),
    reviewedRequestIds: row.reviewed_request_ids,
    note: row.selection_note,
    selectedBy: row.selected_by,
    selectedAt: row.selected_at.toISOString(),
  }));
}
