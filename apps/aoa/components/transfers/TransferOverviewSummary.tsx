import type { ReactNode } from "react";
import { recordedFundingMethod } from "@/lib/data/transfer-funding-method-change";
import { FUNDING_TYPE_ETA, FUNDING_TYPE_LABEL, type TransferRow, type TransferOwner } from "@/lib/data/transfer-types";
import type { DerivedReceivingAccount } from "@/lib/data/receiving-account-match";
import styles from "./TransferOverviewSummary.module.css";

const OWNER_LABEL: Record<TransferOwner, string> = {
  OPERATIONS: "Operations",
  CLIENT_SERVICE: "Client Service",
  ADVISOR: "Advisor",
};

type OverviewTransfer = Pick<TransferRow,
  | "funding_type" | "funding_plan_complete" | "funding_plan_version" | "transferring_firm"
  | "asset_map_custodian" | "asset_map_account_type" | "asset_map_account_number"
  | "owner_kind" | "owner_name" | "next_step" | "next_step_owner" | "pending_nudge"
> & Partial<Pick<TransferRow, "stage" | "recorded_funding_type">>;

/** Saved facts; the page supplies the separate, explicit method-change control. */
export function TransferOverviewSummary({
  transfer,
  receiving,
  nextTask,
  openExceptions,
  blockingExceptions,
  assetMapUnavailable = false,
  assetMapEnabled = true,
  fundingMethodControl,
}: {
  transfer: OverviewTransfer;
  receiving: DerivedReceivingAccount | null;
  nextTask: string | null;
  openExceptions: number;
  blockingExceptions: number;
  assetMapUnavailable?: boolean;
  assetMapEnabled?: boolean;
  fundingMethodControl?: ReactNode;
}) {
  const custodian = (assetMapEnabled && transfer.asset_map_custodian) || transfer.transferring_firm;
  const account = assetMapEnabled
    ? [transfer.asset_map_account_type, transfer.asset_map_account_number
      ? `••••${transfer.asset_map_account_number.slice(-4)}` : null].filter(Boolean).join(" · ")
    : "";
  const recordedNextStep = transfer.next_step?.trim();
  const method = recordedFundingMethod({ ...transfer, stage: transfer.stage ?? "DECISION" });
  const funded = transfer.stage === "FUNDED";
  const approval = transfer.funding_plan_complete
    ? transfer.funding_plan_version > 0 ? `Approved · version ${transfer.funding_plan_version}` : "Legacy completion — approval needed"
    : "Plan not approved";
  return (
    <section className={styles.overview} aria-label="Transfer overview">
      <dl className={styles.facts}>
        <div>
          <dt>{funded ? "Recorded funding method" : "Saved funding method"}</dt>
          <dd>{method ? FUNDING_TYPE_LABEL[method] : "Not yet selected"}</dd>
          {!funded && method && FUNDING_TYPE_ETA[method] && (
            <dd className={styles.note}>Est. {FUNDING_TYPE_ETA[method]}</dd>
          )}
          <dd className={styles.note}>{funded
            ? `Saved plan: ${transfer.funding_type ? FUNDING_TYPE_LABEL[transfer.funding_type] : "Not selected"} · ${approval}`
            : approval}</dd>
          {fundingMethodControl && <dd>{fundingMethodControl}</dd>}
        </div>
        <div>
          <dt>Delivering account</dt>
          <dd>{custodian || "Custodian not yet recorded"}</dd>
          <dd className={styles.note}>{account || "Account details not yet linked"}</dd>
        </div>
        <div>
          <dt>Apex account match</dt>
          <dd>{receiving?.status === "OPEN"
            ? [receiving.registrationType, receiving.apexAccountMasked].filter(Boolean).join(" · ")
            : receiving ? "No open match in synced data — verify" : "Not yet matched"}</dd>
          <dd className={styles.note}>{receiving?.status === "OPEN"
            ? "Open match in synced data; verify the intended destination."
            : "Review receiving accounts below."}</dd>
        </div>
        <div>
          <dt>Transfer owner</dt>
          <dd>{OWNER_LABEL[transfer.owner_kind] || "Unassigned"}</dd>
          <dd className={styles.note}>{transfer.owner_name || "No individual assigned"}</dd>
        </div>
      </dl>
      <div className={styles.next}>
        <div>
          <span className={styles.label}>{recordedNextStep ? "Next recorded step" : "Next checklist item"}</span>
          <p>{recordedNextStep || nextTask || "No next step recorded"}</p>
          {recordedNextStep && <span className={styles.note}>Step owner: {transfer.next_step_owner || "Not assigned"}</span>}
        </div>
        <div className={blockingExceptions > 0 ? styles.warning : styles.exceptions}>
          <span className={styles.label}>Transfer exceptions</span>
          <p>{openExceptions} open · {blockingExceptions} blocking</p>
        </div>
      </div>
      {assetMapUnavailable && <p className={styles.warning}>Linked asset map unavailable. Review Information &amp; linked records.</p>}
      {transfer.pending_nudge && <p className={styles.note}>Pending nudge: {transfer.pending_nudge}</p>}
    </section>
  );
}
