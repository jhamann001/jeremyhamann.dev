"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { ExclusionOverlapResponse } from "@/lib/trade-requests/drift-view/api";
import styles from "./Drift.module.css";

// Port of the standalone DriftExclusionOverlapModal.tsx (trade-request d41b6c9, lines 1-197): same
// statistics, classes and worst-account table; Escape and the backdrop close it.

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatMaxDelta(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  );
}

const CLASSES = ["actionable", "locked_blanket", "locked_dnb_under", "locked_dns_over", "sign_mismatch_unlocked"] as const;

export function ExclusionOverlapDialog({ report, loading, error, onClose, onRetry }: {
  report: ExclusionOverlapResponse | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className={styles.overlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="exclusion-overlap-dialog-title" className={`${styles.dialog} ${styles.dialogWide}`}>
        <header className={styles.dialogHead}>
          <div>
            <h2 id="exclusion-overlap-dialog-title">Exclusion overlap diagnostic</h2>
            <p>On-demand readout of how many current per-symbol breaches are currently locked by exclusions.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className={styles.close} />
        </header>
        <div className={styles.dialogBody}>
          {loading && <div className={styles.muted}>Loading diagnostic…</div>}
          {!loading && error && (
            <div className={styles.notice}>
              <p>{error}</p>
              <button type="button" onClick={onRetry} className={styles.linkButton}>Retry</button>
            </div>
          )}
          {!loading && !error && report && (
            <>
              <p className={styles.lastRun}>
                Run date: <strong>{report.runDateLocal}</strong>
              </p>
              <div className={styles.overlapStats}>
                <Stat label="Accounts compared" value={String(report.totalAccounts)} />
                <Stat label="Out of tolerance" value={String(report.outAccounts)} />
                <Stat label="Distinct exclusions" value={String(report.totalExclusions)} />
                <Stat label="Per-symbol breaches" value={String(report.totalBreaches)} />
                <Stat label="Locked breaches" value={`${report.lockedTotal}`} />
                <Stat label="Locked share" value={formatPct(report.lockedSharePct)} />
              </div>
              <section>
                <h3 className={styles.sectionTitle}>Lock classification</h3>
                <table className={`${styles.table} ${styles.stack}`}>
                  <thead>
                    <tr><th>Class</th><th className={styles.num}>Count</th></tr>
                  </thead>
                  <tbody>
                    {CLASSES.map((c) => (
                      <tr key={c}>
                        <td data-label="Class">{c}</td>
                        <td data-label="Count" className={styles.num}>{report.counts[c]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section>
                <h3 className={styles.sectionTitle}>Worst 10 accounts by max delta</h3>
                <table className={`${styles.table} ${styles.stack}`}>
                  <thead>
                    <tr>
                      <th>Account</th><th>Household</th><th>Status</th>
                      <th className={styles.num}>Max Δ</th><th className={styles.num}>Breaches</th><th className={styles.num}>Locked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.worstAccounts.map((row) => (
                      <tr key={row.accountId}>
                        <td data-label="Account">
                          <div className={styles.title}>
                            <span className={styles.strong}>{row.accountTitle}</span>
                            <span className={styles.accountId}>{row.accountId}</span>
                          </div>
                        </td>
                        <td data-label="Household">{row.household}</td>
                        <td data-label="Status">{row.status}</td>
                        <td data-label="Max Δ" className={styles.num}>{formatMaxDelta(row.maxDelta)}</td>
                        <td data-label="Breaches" className={styles.num}>{row.breachCount}</td>
                        <td data-label="Locked" className={styles.num}>{row.lockedCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
