import Link from "next/link";
import { recordedFundingMethod } from "@/lib/data/transfer-funding-method-change";
import type { TransferBoardClientRow } from "@/lib/data/transfer-board-client";
import {
  FUNDING_TYPE_ETA,
  FUNDING_TYPE_LABEL,
  type TransferOwner,
} from "@/lib/data/transfer-types";
import type { AcatChip } from "@/lib/data/acat-lane";
import { Pill } from "@/components/ui";
import { syncFlagLabel } from "@/lib/data/transfer-archive";
import { usdCompact } from "@/lib/format";
import { AcatStatusChip } from "./AcatStatusChip";
import styles from "./TransferCard.module.css";

// One transfer card (mockup `.tcard`). The whole card is a Link to the detail
// route `/asset-transfer/<id>` — T3's route (until T3 merges the click lands
// on a 404 in dev; the URL is the frozen contract, WO AC 3). Content: client,
// household sub-line (absent on prospect-shaped rows), value (usdCompact —
// the Decimal-coercion regression check: a raw Decimal would render garbage
// here), task progress ONLY when tasks exist (no bar, no NaN on a zero-task
// record), owner chip, red "Bouncing" badge (derived rule, ADR-7), the derived
// days-in-stage pill, and — when the transfer links a live-status ACAT — a
// compact transfer-triage summary (funding method, from/to route with a masked
// receiving account, next unfinished checklist item, progress, owner, concise
// exceptions, and age-in-stage). A linked live-status ACAT remains an
// at-a-glance chip; full transfer/ACAT detail stays on the linked detail route.

const OWNER_LABEL: Record<TransferOwner, string> = {
  OPERATIONS: "Operations",
  CLIENT_SERVICE: "Client Service",
  ADVISOR: "Advisor",
};

export function TransferCard({
  row,
  chip,
  onNavigate,
}: {
  row: TransferBoardClientRow;
  chip?: AcatChip;
  onNavigate?: (href: string) => void;
}) {
  const pct =
    row.tasksTotal > 0 ? Math.round((row.tasksDone / row.tasksTotal) * 100) : 0;
  const owner =
    OWNER_LABEL[row.owner_kind] +
    (row.owner_name ? ` · ${row.owner_name}` : "");
  const method = recordedFundingMethod(row);
  const funding = method ? FUNDING_TYPE_LABEL[method] : null;
  const fundingEta = method ? FUNDING_TYPE_ETA[method] : null;
  const sourceFirm = row.transferring_firm?.trim() || null;
  const receivingType =
    row.receivingAccount?.registrationType ??
    row.asset_map_account_type?.trim() ??
    null;
  const receiving = row.receivingAccount
    ? row.receivingAccount.status === "OPEN"
      ? [receivingType, row.receivingAccount.apexAccountMasked]
          .filter(Boolean)
          .join(" ")
      : `${receivingType} · account to open`
    : receivingType;
  const nextAction = row.nextIncompleteTask ?? row.next_step?.trim() ?? null;

  return (
    <Link href={`/asset-transfer/${row.id}`} className={styles.card} prefetch={false}
      data-list-row-id={row.id} onClick={() => onNavigate?.(`/asset-transfer/${row.id}`)}>
      <h4 className={styles.name}>
        {row.client_first_name} {row.client_last_name}
      </h4>
      {row.household_name && (
        <div className={styles.household}>{row.household_name}</div>
      )}
      <div className={styles.valueRow}>
        <span className={styles.value}>{usdCompact(row.value)}</span>
        {funding && <span className={styles.fundingMethod}>{funding}</span>}
      </div>
      {(sourceFirm || receiving) && (
        <div
          className={styles.route}
          title={
            sourceFirm && receiving
              ? `From ${sourceFirm} to ${receiving}`
              : sourceFirm
                ? `From ${sourceFirm}`
                : `To ${receiving}`
          }
        >
          {sourceFirm && (
            <span>
              <b>From</b> {sourceFirm}
            </span>
          )}
          {sourceFirm && receiving && <span aria-hidden="true">→</span>}
          {receiving && (
            <span
              className={
                row.receivingAccount?.status === "TO_OPEN"
                  ? styles.receivingPending
                  : undefined
              }
            >
              <b>To</b> {receiving}
            </span>
          )}
        </div>
      )}
      {nextAction ? (
        <div className={styles.nextAction} title={nextAction}>
          <b>Next</b> {nextAction}
        </div>
      ) : row.tasksTotal > 0 && row.tasksDone === row.tasksTotal ? (
        <div className={`${styles.nextAction} ${styles.complete}`}>
          Checklist complete
        </div>
      ) : null}
      {row.tasksTotal > 0 && (
        <div className={styles.progress}>
          <div className={styles.bar}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <span>
            {row.tasksDone}/{row.tasksTotal} done
          </span>
        </div>
      )}
      <div className={styles.foot}>
        <span className={styles.owner}>{owner}</span>
        {row.bouncing && <Pill tone="red">Bouncing</Pill>}
        {/* Needs-review chip (transfer-syncflag-surface): the reconciler set
            sync_flag (deal regressed to Potential / deal removed) — the flagged
            transfer must not look identical to a healthy one. Short label on
            the card; the full reason rides the title tooltip (the
            AcatStatusChip span-title idiom). Resolution lives on the detail
            page this card links to. */}
        {row.sync_flag != null && (
          <span title={syncFlagLabel(row.sync_flag) ?? undefined}>
            <Pill tone="amber" dot>
              Needs review
            </Pill>
          </span>
        )}
        {chip && <AcatStatusChip chip={chip} />}
        <span
          className={styles.days}
          title={
            fundingEta
              ? `${row.daysInStage} days in this stage; typical ${funding} arrival: ${fundingEta}`
              : `${row.daysInStage} days in this stage`
          }
        >
          {row.daysInStage}d in stage
          {row.stage === "IN_TRANSFER" && fundingEta
            ? ` · est. ${fundingEta}`
            : ""}
        </span>
      </div>
    </Link>
  );
}
