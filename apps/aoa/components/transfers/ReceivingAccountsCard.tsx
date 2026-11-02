"use client";

import { useState, useTransition, type ReactNode } from "react";
import type { TransferAccountRow } from "@/lib/data/transfer-types";
import type { DerivedReceivingAccount } from "@/lib/data/receiving-account-match";
import { Button } from "@/components/ui";
import { setAccountStatus } from "@/app/(authenticated)/asset-transfer/actions";
import styles from "./ReceivingAccountsCard.module.css";

// "Receiving accounts to open" card body (WO ticket, TDD ADR-3) —
// gate-step rows (OPEN ✓ / TO_OPEN ○) feeding the ACCOUNTS_OPEN gate, with an
// audited status toggle per row (transfer.account_status {accountId, from,
// to}; opened_at stamped on OPEN, cleared on TO_OPEN). Manual rows come from the
// record. VIEWER: static rows, no toggles.
//
// S6: when a mapping account is linked, a DERIVED, READ-ONLY row is shown first —
// the receiving registration implied by the linked account's type, resolved
// OPEN/TO_OPEN live from Apex (mirror.account). It has no toggle (its status is
// authoritative from Apex, never hand-set) and no DB row.

const stamp = (d: Date | string): string =>
  new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function ReceivingAccountsCard({
  transferId,
  accounts,
  canWrite,
  derived = null,
  fundingCoverage = null,
}: {
  transferId: string;
  accounts: TransferAccountRow[];
  canWrite: boolean;
  /** The receiving account derived from the transfer's linked asset map (S6),
   *  or null when nothing is linked / no client to match against Apex. */
  derived?: DerivedReceivingAccount | null;
  /** Streamed server content for the optional initial-funding check. Keeping it
   *  in its own Suspense boundary leaves local account controls available while
   *  the external source loads. The linked user ID stays on the server. */
  fundingCoverage?: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (accountId: string, open: boolean) => {
    startTransition(async () => {
      const result = await setAccountStatus(
        transferId,
        accountId,
        open ? "OPEN" : "TO_OPEN",
      );
      setError(result && !result.ok ? result.errors[0]?.message : null);
    });
  };

  if (accounts.length === 0 && !derived) {
    return (
      <p className={styles.empty}>
        No receiving accounts tracked yet on this record.
      </p>
    );
  }

  return (
    <div className={styles.wrap}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <ul className={styles.list}>
        {/* S6: derived, read-only receiving account from the linked asset map —
            OPEN/TO_OPEN resolved live from Apex, no toggle, shown first. */}
        {derived && (
          <li className={styles.row}>
            <span
              className={derived.status === "OPEN" ? styles.markerOpen : styles.markerToOpen}
              aria-hidden="true"
            >
              {derived.status === "OPEN" ? "✓" : "○"}
            </span>
            <span className={styles.text}>
              <span className={styles.label}>
                {derived.registrationType}{" "}
                <span className={styles.fromMap}>· from linked asset map</span>
              </span>
              <span className={styles.status}>
                {derived.status === "OPEN"
                  ? `Already open at Apex${
                      derived.apexAccountMasked ? ` · ${derived.apexAccountMasked}` : ""
                    }`
                  : "Needs to be opened"}
              </span>
              {/* Initial-Funding check: confirm the account is on a funding
                  request, or flag that it isn't (INITIAL_FUNDING_CHECK). */}
              {fundingCoverage}
            </span>
          </li>
        )}
        {accounts.map((a) => {
          const open = a.status === "OPEN";
          return (
            <li key={a.id} className={styles.row}>
              <span
                className={open ? styles.markerOpen : styles.markerToOpen}
                aria-hidden="true"
              >
                {open ? "✓" : "○"}
              </span>
              <span className={styles.text}>
                <span className={styles.label}>{a.label}</span>
                <span className={styles.status}>
                  {open
                    ? `Open${a.opened_at ? ` · ${stamp(a.opened_at)}` : ""}`
                    : "To open"}
                </span>
              </span>
              {canWrite && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => toggle(a.id, !open)}
                >
                  {open ? "Mark to open" : "Mark opened"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
