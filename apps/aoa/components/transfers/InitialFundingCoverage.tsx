import { initialFundingCoverage } from "@/lib/data/funding-request-check";
import { readTradeRequestsForUserCached } from "@/lib/data/trade-requests";
import { EXTERNAL_APPS } from "@/lib/external-apps";
import { Pill } from "@/components/ui";
import styles from "./ReceivingAccountsCard.module.css";

/** Optional, read-only indicator. Render under Suspense after resolving the
 *  transfer and linked client through RLS. The source read is request-memoized
 *  with FundingPictureCard, and an unavailable source never means "missing". */
export async function InitialFundingCoverage({
  cedarRidgeUserId,
  accountLast4,
}: {
  cedarRidgeUserId: string;
  accountLast4: string;
}) {
  let requests;
  try {
    requests = await readTradeRequestsForUserCached(cedarRidgeUserId);
  } catch {
    return null;
  }
  const coverage = initialFundingCoverage({ last4: accountLast4 }, requests);
  return (
    <span className={styles.funding}>
      {coverage.covered ? (
        <Pill tone="green">Initial funding · {coverage.requestId}</Pill>
      ) : (
        <>
          <Pill tone="gold">No initial funding request</Pill>
          <a
            className={styles.fundingCta}
            href={EXTERNAL_APPS.tradeRequests}
            target="_blank"
            rel="noopener noreferrer"
          >
            Create funding request ↗
          </a>
        </>
      )}
    </span>
  );
}
