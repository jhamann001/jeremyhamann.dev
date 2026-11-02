import type { Identity } from "@/lib/rls";
import type { TransferRow } from "@/lib/data/transfer-types";
import { readTransferFeeReview } from "@/lib/data/transfer-fee-review";
import { acatFeeRequestsHref, acatFeeRequestsReadEnabled, acatReimbursementCreateEnabled } from "@/lib/operations/fee-request-link";
import { TransferFeeReviewView } from "./TransferFeeReviewView";

export function TransferFeeReviewLoading() {
  return <div className="subtle" role="status"><strong>Fee review</strong><p>Loading custodian fees and the linked fee records…</p></div>;
}

/** The parent has already read and authorized this transfer under RLS. */
export async function TransferFeeReview({ identity, transfer, legacyEntries }: {
  identity: Identity;
  transfer: Pick<TransferRow, "id" | "acat_record_id" | "transferring_firm" | "delivering_custodian_id" | "archived_at" | "client_first_name" | "client_last_name">;
  legacyEntries: { recordedAt: string }[];
}) {
  const review = await readTransferFeeReview(identity, transfer);
  return <TransferFeeReviewView review={review} clientName={`${transfer.client_first_name} ${transfer.client_last_name}`.trim()}
    archived={transfer.archived_at !== null} legacyEntries={legacyEntries}
    feeRequestsHref={acatFeeRequestsHref(identity.role)}
    reimbursement={acatReimbursementCreateEnabled(identity.role)}
    requestsOnFile={acatFeeRequestsReadEnabled(identity.role)} />;
}
