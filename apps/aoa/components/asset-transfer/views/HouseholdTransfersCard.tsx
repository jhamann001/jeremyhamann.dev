import Link from "next/link";
import { Suspense } from "react";
import type { Identity } from "@/lib/rls";
import { getAssetTransferWorkspace } from "@/lib/data/asset-transfer-workspace";
import { linkedHoldingsEnabled } from "@/lib/data/transfer-linked-holdings";
import { HouseholdLinkedHoldings } from "@/components/asset-transfer/linked-holdings/HouseholdLinkedHoldings";
import { plural } from "./view-helpers";
import { TransferTable } from "./TransfersView";
import "@/components/asset-transfer/workspace/workspace.css";
import "@/components/asset-transfer/workspace/workspace-dark.css";

/** One household's transfers on its household page, in the Asset Transfer tab's table style. */
export async function HouseholdTransfersCard({ identity, sourceSfIds, householdId, scope }: {
  identity: Identity; sourceSfIds: string[]; householdId: string; scope: string;
}) {
  const { transfers } = await getAssetTransferWorkspace(identity, { householdSfIds: sourceSfIds });
  const funded = transfers.filter(transfer => transfer.stage === "FUNDED").length;
  return (
    <section className="atw atw-card" aria-labelledby="household-transfers-title" data-household-transfers>
      <div className="section">
        <div className="sectionhead">
          <div>
            <h2 id="household-transfers-title">Transfers</h2>
            <p>{plural(transfers.length, "transfer")} · {funded} funded. Open a transfer for its tasks, activity and mailing history.</p>
          </div>
          <Link className="btn" href="/asset-transfer" prefetch={false}>All transfers →</Link>
        </div>
        <TransferTable transfers={transfers} scope={scope} listHref={`/households/${householdId}`} from="household"
          empty="No transfers for this household yet." />
      </div>
      {linkedHoldingsEnabled() ? <Suspense fallback={null}><HouseholdLinkedHoldings transfers={transfers} /></Suspense> : null}
    </section>
  );
}
