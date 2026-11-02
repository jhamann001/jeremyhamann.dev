"use client";

import Link from "next/link";
import type { PartialAcatPosition } from "@/lib/data/transfer-asset-map";
import { usd } from "@/lib/format";
import { Pill } from "@/components/ui";
import { useTransferPlanDraft } from "./TransferPlanDraftProvider";
import styles from "./BasisDecisionTable.module.css";

// Partial-ACAT "What to transfer" — the linked asset map's positions (symbol +
// value + cost basis) with an editable is-transferring Yes/No. Rows come from
// mirror.acat_asset_map_position and seed from the pipeline's eligibility (or
// last approved override). UI changes stay in the shared draft until the whole
// funding plan is approved. Reuses BasisDecisionTable's styles.

export function PartialAcatPositionsTable({
  positions,
}: {
  positions: PartialAcatPosition[];
}) {
  const draft = useTransferPlanDraft();

  if (positions.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyText}>
          No positions on the linked asset map yet.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.banner} role="note">
        <strong>⚠ Avoid ossification.</strong> Don&apos;t transfer in
        highly-appreciated lots — bring low basis in for TLH; leave or gift the
        winners.
      </div>

      {positions.some((position) => position.ineligible) ? (
        <div className={styles.decisionLink}>
          <div>
            <strong>Standard partial-ACAT route</strong>
            <span>
              Only eligible positions transfer. Excluded assets remain at the
              current custodian, so no separate decision is required.
            </span>
          </div>
          <Link href="/tasks">View execution tasks →</Link>
        </div>
      ) : null}

      {draft.errors.find((error) => error.field === "positions") && (
        <p className={styles.error} role="alert">
          {draft.errors.find((error) => error.field === "positions")?.message}
        </p>
      )}

      <div className={styles.scroller}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Position</th>
              <th className={styles.num}>Value</th>
              <th className={styles.num}>Cost basis</th>
              <th>Transferring</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const selected = draft.partialPosition(
                p.symbol,
                p.isTransferring,
              );
              return (
                <tr key={p.symbol}>
                  <td>
                    <span className={styles.symbol}>{p.symbol}</span>
                    <span className={styles.desc}>
                      {p.description}
                      {p.ineligible ? " · not transfer-eligible" : ""}
                    </span>
                  </td>
                  <td className={styles.num}>
                    {p.marketValue == null ? "—" : usd(p.marketValue)}
                  </td>
                  <td className={styles.num}>
                    {p.costBasis == null ? "—" : usd(p.costBasis)}
                  </td>
                  <td>
                    {draft.canEdit ? (
                      <select
                        className={styles.select}
                        value={selected ? "yes" : "no"}
                        disabled={draft.pending}
                        onChange={(e) =>
                          draft.setPartialPosition(
                            p.symbol,
                            e.target.value === "yes",
                          )
                        }
                        aria-label={`Transferring ${p.symbol}`}
                      >
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    ) : (
                      <Pill tone={selected ? "green" : "gray"}>
                        {selected ? "Yes" : "No"}
                      </Pill>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
