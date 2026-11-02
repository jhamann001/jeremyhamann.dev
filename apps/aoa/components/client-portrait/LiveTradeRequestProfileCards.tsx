import type { Identity } from "@/lib/rls";
import { apexAccountsForClient } from "@/lib/data/account-aum";
import {
  deriveAccountScopedTradeRequestProfileFromSummaries,
  type KnownTradeProfileAccount,
} from "@/lib/data/trade-request-profile";
import { readTradeRequestsForUserCached } from "@/lib/data/trade-requests";
import {
  canConfirmTradeProfile,
  tradeProfileSelectionsForClient,
} from "@/lib/data/trade-profile-selection";
import { TradeRequestProfileCards } from "./TradeRequestProfileCards";
import { TradeProfileReviewControls } from "./TradeProfileReviewControls";

/**
 * Live profile join. The raw Cedar Ridge user id and Apex account ULIDs remain
 * inside this server component; only masked account numbers and derived
 * approved facts reach the rendered cards. Authorized users receive a separate
 * audited confirmation control that stores source provenance only.
 */
export async function LiveTradeRequestProfileCards({
  identity,
  clientSfId,
  cedarRidgeUserId,
}: {
  identity: Identity;
  clientSfId: string;
  cedarRidgeUserId: string;
}) {
  try {
    const [requests, apexAccounts, selections] = await Promise.all([
      readTradeRequestsForUserCached(cedarRidgeUserId),
      apexAccountsForClient(identity, clientSfId),
      tradeProfileSelectionsForClient(identity, clientSfId),
    ]);
    const knownAccounts: KnownTradeProfileAccount[] = apexAccounts.map((account) => ({
      accountId: account.custodianAccountId,
      accountNumber: account.apexAccountNumber ?? account.custodianAccountId,
      accountType: account.accountType,
      status: account.accountStatus,
    }));
    const profile = deriveAccountScopedTradeRequestProfileFromSummaries(
      cedarRidgeUserId,
      requests,
      knownAccounts,
      Object.fromEntries(
        selections.map((selection) => [
          selection.accountId,
          {
            requestId: selection.requestId,
            reviewedRequestIds: selection.reviewedRequestIds,
          },
        ]),
      ),
    );

    return (
      <TradeRequestProfileCards
        profile={profile}
        source="live"
        reviewControls={
          canConfirmTradeProfile(identity.role) ? (
            <TradeProfileReviewControls
              clientSfId={clientSfId}
              accounts={profile.accountReview?.accounts ?? []}
              selections={selections}
            />
          ) : undefined
        }
      />
    );
  } catch {
    // Both data seams log only static failure markers/status. Never log or render
    // the raw join id, account ULID, endpoint URL, or response body here.
    return (
      <p style={{ color: "var(--muted)", marginTop: 16, fontSize: 13 }}>
        Approved investment profile unavailable.
      </p>
    );
  }
}
