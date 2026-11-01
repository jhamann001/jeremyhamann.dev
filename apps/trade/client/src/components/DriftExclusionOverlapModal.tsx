import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { ExclusionOverlapReport } from '@trade-request/shared';

interface DriftExclusionOverlapModalProps {
  report: ExclusionOverlapReport | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatMaxDelta(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`;
}

interface StatProps {
  label: string;
  value: string;
}

function Stat({ label, value }: StatProps) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2">
      <div className="text-lg font-semibold text-[var(--text-primary)]">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
    </div>
  );
}

export function DriftExclusionOverlapModal({
  report,
  loading,
  error,
  onClose,
  onRetry,
}: DriftExclusionOverlapModalProps) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="exclusion-overlap-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl">
        <header className="flex items-start justify-between border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 id="exclusion-overlap-modal-title" className="text-lg font-semibold text-[var(--text-primary)]">
              Exclusion overlap diagnostic
            </h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              On-demand readout of how many current per-symbol breaches are currently locked by exclusions.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md p-1.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {loading && <div className="text-sm text-[var(--text-muted)]">Loading diagnostic…</div>}

          {!loading && error && (
            <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
              <p>{error}</p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-3 rounded-md border border-red-300 px-3 py-1 text-xs font-medium hover:bg-red-100"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && report && (
            <>
              <p className="text-xs text-[var(--text-muted)]">
                Run date: <span className="font-medium text-[var(--text-primary)]">{report.runDateLocal}</span>
              </p>

              <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
                <Stat label="Accounts compared" value={String(report.totalAccounts)} />
                <Stat label="Out of tolerance" value={String(report.outAccounts)} />
                <Stat label="Distinct exclusions" value={String(report.totalExclusions)} />
                <Stat label="Per-symbol breaches" value={String(report.totalBreaches)} />
                <Stat label="Locked breaches" value={`${report.lockedTotal}`} />
                <Stat label="Locked share" value={formatPct(report.lockedSharePct)} />
              </div>

              <section>
                <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">Lock classification</h3>
                <div className="rounded-md border border-[var(--border)]">
                  <table className="min-w-full text-sm">
                    <thead className="bg-[var(--bg-surface)] text-[var(--text-muted)]">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Class</th>
                        <th className="px-3 py-2 text-right font-medium">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-[var(--border)]">
                        <td className="px-3 py-2">actionable</td>
                        <td className="px-3 py-2 text-right">{report.counts.actionable}</td>
                      </tr>
                      <tr className="border-t border-[var(--border)]">
                        <td className="px-3 py-2">locked_blanket</td>
                        <td className="px-3 py-2 text-right">{report.counts.locked_blanket}</td>
                      </tr>
                      <tr className="border-t border-[var(--border)]">
                        <td className="px-3 py-2">locked_dnb_under</td>
                        <td className="px-3 py-2 text-right">{report.counts.locked_dnb_under}</td>
                      </tr>
                      <tr className="border-t border-[var(--border)]">
                        <td className="px-3 py-2">locked_dns_over</td>
                        <td className="px-3 py-2 text-right">{report.counts.locked_dns_over}</td>
                      </tr>
                      <tr className="border-t border-[var(--border)]">
                        <td className="px-3 py-2">sign_mismatch_unlocked</td>
                        <td className="px-3 py-2 text-right">{report.counts.sign_mismatch_unlocked}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold text-[var(--text-primary)]">
                  Worst 10 accounts by max delta
                </h3>
                <div className="overflow-auto rounded-md border border-[var(--border)]">
                  <table className="min-w-full text-sm">
                    <thead className="bg-[var(--bg-surface)] text-[var(--text-muted)]">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Account</th>
                        <th className="px-3 py-2 text-left font-medium">Household</th>
                        <th className="px-3 py-2 text-left font-medium">Status</th>
                        <th className="px-3 py-2 text-right font-medium">Max Δ</th>
                        <th className="px-3 py-2 text-right font-medium">Breaches</th>
                        <th className="px-3 py-2 text-right font-medium">Locked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.worstAccounts.map((row) => (
                        <tr key={row.accountId} className="border-t border-[var(--border)]">
                          <td className="px-3 py-2">
                            <div className="font-medium text-[var(--text-primary)]">{row.accountTitle}</div>
                            <div className="font-mono text-xs text-[var(--text-muted)]">{row.accountId}</div>
                          </td>
                          <td className="px-3 py-2">{row.household}</td>
                          <td className="px-3 py-2">{row.status}</td>
                          <td className="px-3 py-2 text-right">{formatMaxDelta(row.maxDelta)}</td>
                          <td className="px-3 py-2 text-right">{row.breachCount}</td>
                          <td className="px-3 py-2 text-right">{row.lockedCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
