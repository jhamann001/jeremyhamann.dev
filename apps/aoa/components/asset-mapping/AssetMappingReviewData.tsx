import {
  listAccountReviewQueue,
  listKnownAccounts,
} from "@/lib/data/asset-map-review";
import type { Identity } from "@/lib/data/types";
import { Card, Kpi } from "@/components/ui";
import { AccountReviewList } from "./AccountReviewList";
import { KnownAccountsList } from "./KnownAccountsList";
import styles from "./AssetMappingReviewData.module.css";

// Async SERVER component behind the review page's <Suspense>. Account-grain only
// (the household confirm/verify card was retired, S1). Two surfaces, the
// acat-tracking grouped-by-status idiom (S2):
//   • ACTION queue (listAccountReviewQueue) — accounts that need a decision:
//     NEEDS_REVIEW + accounts under households the matcher couldn't bind (the
//     fold-in client picker lives on the row).
//   • ALREADY KNOWN (listKnownAccounts) — AUTO_LINKED (machine-decided) +
//     CONFIRMED (human-attributed); no action needed, collapsed by default.
// Rendered inside <Suspense> so its awaits never block the page shell.

export async function AssetMappingReviewData({ identity }: { identity: Identity }) {
  const [folders, known] = await Promise.all([
    listAccountReviewQueue(identity),
    listKnownAccounts(identity),
  ]);

  const accountsToAttribute = folders.reduce((n, f) => n + f.accounts.length, 0);
  const householdsToMatch = folders.filter((f) => !f.folderResolved).length;
  const alreadyKnown = known.reduce((n, f) => n + f.accounts.length, 0);

  return (
    <>
      <div className={styles.kpis}>
        <Card>
          <Kpi
            label="Accounts to attribute"
            value={accountsToAttribute}
            caption="Resolve each account's owner(s)"
          />
        </Card>
        <Card>
          <Kpi
            label="Households to match"
            value={householdsToMatch}
            caption="Pick the client right on the account"
          />
        </Card>
        <Card>
          <Kpi
            label="Already known"
            value={alreadyKnown}
            caption="Machine-linked or confirmed — no action needed"
          />
        </Card>
      </div>

      <AccountReviewList folders={folders} />
      <KnownAccountsList folders={known} />
    </>
  );
}
