"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  ownerNameOptions,
  STAGE_ORDER,
  TRANSFER_OWNERS,
  defaultOwnerName,
  stageLabel,
  type TransferOwner,
  type TransferStage,
} from "@/lib/data/transfer-types";
import { Button, Pill } from "@/components/ui";
import {
  setOwner,
  setStage,
} from "@/app/(authenticated)/asset-transfer/actions";
import styles from "./TransferToolbar.module.css";

// Detail toolbar controls (WO ticket, TDD §6) — stage select (all three,
// forward AND backward), "Mark done → <next>" (green Funded pill at the end),
// and the structured owner select (+ constrained owner-person dropdown, ticket).
//
// SOFT gates (locked, the owner 2026-07-02): `setStage` never blocks — when the
// move crosses an unmet gate the action still succeeds and returns the
// warnings, rendered here as the amber advisory banner ("moved anyway").
// A DB/RLS rejection renders as the red banner (clean, never a 500).
// VIEWER (canWrite=false): read-only stage/owner pills, no controls.

const OWNER_LABEL: Record<TransferOwner, string> = {
  OPERATIONS: "Operations",
  CLIENT_SERVICE: "Client Service",
  ADVISOR: "Advisor",
};

export function TransferToolbar({
  transferId,
  stage,
  ownerKind,
  ownerName,
  canWrite,
  canChangeStage = canWrite,
}: {
  transferId: string;
  stage: TransferStage;
  ownerKind: TransferOwner;
  ownerName: string | null;
  canWrite: boolean;
  canChangeStage?: boolean;
}) {
  const [warnings, setWarnings] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const idx = STAGE_ORDER.indexOf(stage);
  const next = idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : null;

  const moveTo = (to: TransferStage) => {
    startTransition(async () => {
      const result = await setStage(transferId, to);
      if (result.ok) {
        setError(null);
        setBlocked([]);
        setWarnings(result.warnings);
      } else if ("blocked" in result) {
        // ticket S3 HARD gate: DECISION→IN_TRANSFER refused, no write. The
        // stage `<select>` reverts to DECISION on its own — it is bound to the
        // `stage` prop, which is unchanged because no revalidation fired.
        setError(null);
        setWarnings([]);
        setBlocked(result.unmet);
      } else {
        setWarnings([]);
        setBlocked([]);
        setError(result.errors[0]?.message ?? "Save failed.");
      }
    });
  };

  const assign = (kind: TransferOwner, displayName: string) => {
    startTransition(async () => {
      const result = await setOwner(transferId, kind, displayName);
      setError(result && !result.ok ? result.errors[0]?.message : null);
    });
  };

  const ownerOptions = ownerNameOptions(ownerKind, ownerName);

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        {canWrite ? (
          <>
            <label className={styles.control}>
              <span className={styles.label}>Stage</span>
              <select
                className={styles.select}
                value={stage}
                disabled={pending || !canChangeStage}
                onChange={(e) => moveTo(e.target.value as TransferStage)}
                aria-label="Stage"
              >
                {STAGE_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {stageLabel(s)}
                  </option>
                ))}
              </select>
            </label>

            {next ? (
              <Button
                size="sm"
                variant="primary"
                disabled={pending || !canChangeStage}
                onClick={() => moveTo(next)}
              >
                Mark done → {stageLabel(next)}
              </Button>
            ) : (
              <Pill tone="green" dot>
                Funded
              </Pill>
            )}

            <span className={styles.spacer} />

            <label className={styles.control}>
              <span className={styles.label}>Owner</span>
              <select
                className={styles.select}
                value={ownerKind}
                disabled={pending}
                onChange={(e) =>
                  assign(
                    e.target.value as TransferOwner,
                    defaultOwnerName(e.target.value as TransferOwner),
                  )
                }
                aria-label="Owner"
              >
                {TRANSFER_OWNERS.map((o) => (
                  <option key={o} value={o}>
                    {OWNER_LABEL[o]}
                  </option>
                ))}
              </select>
            </label>
            <select
              className={styles.select}
              value={ownerName ?? ""}
              disabled={pending}
              aria-label="Owner name"
              onChange={(e) => assign(ownerKind, e.target.value)}
            >
              {ownerOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            <Link
              className={styles.editLink}
              href={`/asset-transfer/${transferId}/edit`}
            >
              Edit record
            </Link>
          </>
        ) : (
          <>
            <Pill tone={stage === "FUNDED" ? "green" : "blue"}>
              {stageLabel(stage)}
            </Pill>
            <Pill tone="gray">
              {OWNER_LABEL[ownerKind]}
              {ownerName ? ` · ${ownerName}` : ""}
            </Pill>
          </>
        )}
      </div>

      {blocked.length > 0 && (
        <div className={styles.blockBanner} role="alert">
          <p className={styles.blockHead}>
            Complete these requirements before changing stage:
          </p>
          {blocked.map((u) => (
            <p key={u} className={styles.blockLine}>
              {u}
            </p>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className={styles.warnBanner} role="status">
          <p className={styles.warnHead}>
            Moved anyway — gates are advisory (soft). The transition is on the
            audit record.
          </p>
          {warnings.map((w) => (
            <p key={w} className={styles.warnLine}>
              {w}
            </p>
          ))}
        </div>
      )}

      {error && (
        <div className={styles.errorBanner} role="alert">
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}
