import { withUserScope, type Identity } from "@/lib/rls";

// RLS-scoped read seam for mirror.linked_external_account_summary (written by
// app/api/cron/linked-external-account-summary). Admin/Operations read the firm;
// Advisor/Client Service read only clients whose household they can see (an
// advisor's own book; every client household for Client Service).
//
// DECIMAL TRAP (see lib/data/account-aum.ts): numeric columns arrive as Prisma
// Decimals, which do not serialize across the RSC boundary, so Number()-coercion
// lives here at the seam.

export type LinkedExternalAccountSummary = {
  externalAccountId: string;
  clientSfId: string | null;
  householdSfId: string | null;
  institutionName: string | null;
  accountSubtype: string | null;
  mask: string | null;
  cashAmount: number | null;
  securitiesAmount: number | null;
  holdingsTotal: number | null;
  institutionBalance: number | null;
  asOf: Date | null;
  linkStatus: string;
  lineageKey: string | null;
  priorExternalAccountId: string | null;
};

type RawRow = {
  external_account_id: string;
  client_sf_id: string | null;
  household_sf_id: string | null;
  institution_name: string | null;
  account_subtype: string | null;
  mask: string | null;
  cash_amount: unknown;
  securities_amount: unknown;
  holdings_total: unknown;
  institution_balance: unknown;
  as_of: Date | null;
  link_status: string;
  lineage_key: string | null;
  prior_external_account_id: string | null;
};

export async function linkedExternalSummariesForClient(
  identity: Identity,
  clientSfId: string,
): Promise<LinkedExternalAccountSummary[]> {
  return withUserScope(identity, async (tx) => {
    const rows = await tx.$queryRaw<RawRow[]>`
      SELECT external_account_id, client_sf_id, household_sf_id, institution_name,
             account_subtype, mask, cash_amount, securities_amount, holdings_total,
             institution_balance, as_of, link_status, lineage_key,
             prior_external_account_id
      FROM mirror.linked_external_account_summary
      WHERE link_status = 'ACTIVE'
        AND left(client_sf_id, 15) = left(${clientSfId}, 15)
      ORDER BY institution_name NULLS LAST, mask NULLS LAST`;
    return rows.map((r) => ({
      externalAccountId: r.external_account_id,
      clientSfId: r.client_sf_id,
      householdSfId: r.household_sf_id,
      institutionName: r.institution_name,
      accountSubtype: r.account_subtype,
      mask: r.mask,
      cashAmount: r.cash_amount == null ? null : Number(r.cash_amount),
      securitiesAmount:
        r.securities_amount == null ? null : Number(r.securities_amount),
      holdingsTotal: r.holdings_total == null ? null : Number(r.holdings_total),
      institutionBalance:
        r.institution_balance == null ? null : Number(r.institution_balance),
      asOf: r.as_of,
      linkStatus: r.link_status,
      lineageKey: r.lineage_key,
      priorExternalAccountId: r.prior_external_account_id,
    }));
  });
}
