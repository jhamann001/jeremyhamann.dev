"use client";

import type { AccountDriftHistoryRow, AccountDriftRunRow, AccountTaxSummary } from "@/lib/trade-requests/shared-types";
import {
  BUCKET_LABEL, TOLERANCE_PCT_RENDER, formatPct, formatSignedUsd, formatUsd, type Bucket,
} from "@/lib/trade-requests/drift-view/model";
import { accountDriftDetailsSchema, type SectorAllocation } from "@/lib/trade-requests/drift-view/schemas";
import styles from "./Drift.module.css";

// The expanded account row (standalone DriftTabV2.tsx:553-713, 1992-2181): per-bucket comparison, tax and
// cost basis, equity sleeve, per-symbol breakdown and equity holdings, in the standalone order and wording.

function ToleranceBadge({ ok }: { ok: boolean }) {
  return <span className={styles.pill} data-tone={ok ? "ok" : "caution"}>{ok ? "In tolerance" : "Out of tolerance"}</span>;
}

function SignedSpan({ value }: { value: number }) {
  return <span className={value < 0 ? styles.loss : styles.gain}>{formatSignedUsd(value)}</span>;
}

type BucketData = { positionPct: number; templatePct: number; deltaPct: number };

function BucketComparisonTable({ buckets }: { buckets: Record<Bucket, BucketData> }) {
  const rows: Array<{ name: Bucket; data: BucketData }> = [
    { name: "cash", data: buckets.cash },
    { name: "fixed", data: buckets.fixed },
    { name: "equity", data: buckets.equity },
  ];
  return (
    <table className={`${styles.table} ${styles.stack}`}>
      <thead>
        <tr><th>Bucket</th><th className={styles.num}>Position %</th><th className={styles.num}>Template %</th><th className={styles.num}>Δpp</th><th>Status</th></tr>
      </thead>
      <tbody>
        {rows.map(({ name, data }) => {
          const ok = data.deltaPct <= TOLERANCE_PCT_RENDER;
          return (
            <tr key={name}>
              <td data-label="Bucket">{BUCKET_LABEL[name]}</td>
              <td data-label="Position %" className={styles.num}>{formatPct(data.positionPct)}</td>
              <td data-label="Template %" className={styles.num}>{formatPct(data.templatePct)}</td>
              <td data-label="Δpp" className={`${styles.num} ${ok ? "" : styles.strong}`}>{data.deltaPct.toFixed(2)}</td>
              <td data-label="Status"><ToleranceBadge ok={ok} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TaxPanel({ tax }: { tax: AccountTaxSummary }) {
  return (
    <div>
      <div className={styles.detailHead}>
        <h3>Tax &amp; cost basis</h3>
        <span className={styles.caption}>basis coverage: {tax.basisCoveragePct.toFixed(0)}%</span>
      </div>
      <div className={styles.taxStats}>
        <div className={styles.taxStat}>
          <small>Unrealized G/L</small>
          <SignedSpan value={tax.unrealizedGainUsd} />
          <small>ST {formatSignedUsd(tax.unrealizedShortTermGainUsd)} · LT {formatSignedUsd(tax.unrealizedLongTermGainUsd)}</small>
        </div>
        <div className={styles.taxStat}>
          <small>Realized G/L YTD</small>
          <SignedSpan value={tax.realizedGainYtdUsd ?? 0} />
          <small>ST {formatSignedUsd(tax.realizedShortTermYtdUsd ?? 0)} · LT {formatSignedUsd(tax.realizedLongTermYtdUsd ?? 0)}</small>
        </div>
        <div className={styles.taxStat}>
          <small>Transferred-in</small>
          <span className={styles.strong}>{formatUsd(tax.transferInValueUsd)}</span>
          <small>{tax.transferInPct.toFixed(0)}% of account</small>
        </div>
        {(tax.transitionConfirmed || tax.transitionCandidate) && (
          <div className={styles.taxStat}>
            <small>Transition</small>
            <span className={styles.strong}>{tax.transitionConfirmed ? "🔄 Active transition" : "Transition candidate"}</span>
            <small>
              {tax.transitionConfirmed
                ? [
                    tax.transitionTargetName ? `→ ${tax.transitionTargetName}` : null,
                    tax.transitionEstRealizedGainUsd != null ? `est. realized ${formatSignedUsd(tax.transitionEstRealizedGainUsd)}` : null,
                  ].filter(Boolean).join(" · ") || "confirmed by Meridian feed"
                : "taxable · no template · mostly transfer-in (heuristic)"}
            </small>
          </div>
        )}
      </div>
      {tax.hasMissingBasis && (
        <p className={styles.audit}>⚠ Some positions have missing/zero cost basis — unrealized gain may be overstated.</p>
      )}
      {tax.symbols.length > 0 && (
        <table className={`${styles.table} ${styles.stack}`}>
          <thead>
            <tr><th>Symbol</th><th className={styles.num}>Market value</th><th className={styles.num}>Cost basis</th><th className={styles.num}>Unrealized</th><th>Term</th><th>Origin</th></tr>
          </thead>
          <tbody>
            {tax.symbols.map((s) => {
              const term =
                Math.abs(s.unrealizedLongTermGainUsd) >= Math.abs(s.unrealizedShortTermGainUsd) && s.unrealizedLongTermGainUsd !== 0
                  ? "LT"
                  : "ST";
              return (
                <tr key={s.symbol}>
                  <td data-label="Symbol">{s.symbol}</td>
                  <td data-label="Market value" className={styles.num}>{formatUsd(s.marketValueUsd)}</td>
                  <td data-label="Cost basis" className={styles.num}>{formatUsd(s.costBasisUsd)}</td>
                  <td data-label="Unrealized" className={`${styles.num} ${s.unrealizedGainUsd < 0 ? styles.loss : styles.gain}`}>{formatSignedUsd(s.unrealizedGainUsd)}</td>
                  <td data-label="Term">{term}</td>
                  <td data-label="Origin">{s.transferInPct > 0 ? <span>🔄 transfer-in</span> : <span className={styles.muted}>—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function sliceTone(kind: SectorAllocation["slices"][number]["kind"]): string {
  if (kind === "sector") return "var(--blue)";
  if (kind === "assetClass") return "var(--gold)";
  return "var(--muted)";
}

function SectorAllocationPanel({ allocation }: { allocation: SectorAllocation }) {
  const { slices, classifiedPct, unclassifiedPct } = allocation;
  if (slices.length === 0) return null;
  const total = classifiedPct + unclassifiedPct || 1;
  return (
    <div>
      <h3>Equity sleeve — sector / asset class</h3>
      <table className={`${styles.table} ${styles.stack}`}>
        <thead>
          <tr><th>Classification</th><th>Type</th><th className={styles.num}>% of account</th><th className={styles.num}>% of equity</th></tr>
        </thead>
        <tbody>
          {slices.map((s) => (
            <tr key={s.label}>
              <td data-label="Classification"><span className={styles.swatch} style={{ backgroundColor: sliceTone(s.kind) }} />{s.label}</td>
              <td data-label="Type" className={styles.muted}>{s.kind === "sector" ? "GICS sector" : s.kind === "assetClass" ? "Fund / asset class" : "—"}</td>
              <td data-label="% of account" className={styles.num}>{s.pct.toFixed(1)}%</td>
              <td data-label="% of equity" className={styles.num}>{((s.pct / total) * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type SymbolDetail = { symbol: string; bucket: Bucket; positionPct: number; targetPct?: number; deltaPct?: number; breach?: boolean };

function SymbolBreakdownTable({ symbols }: { symbols: SymbolDetail[] }) {
  return (
    <table className={`${styles.table} ${styles.stack}`}>
      <thead>
        <tr><th>Symbol</th><th>Bucket</th><th className={styles.num}>Position %</th><th className={styles.num}>Target %</th><th className={styles.num}>Δpp</th><th>Status</th></tr>
      </thead>
      <tbody>
        {symbols.map((s) => {
          const target = s.targetPct ?? 0;
          const delta = s.deltaPct ?? Math.abs(s.positionPct - target);
          const ok = delta <= TOLERANCE_PCT_RENDER;
          const label = s.symbol === "__SETTLEMENT_CASH__" ? "Settlement cash" : s.symbol;
          return (
            <tr key={s.symbol}>
              <td data-label="Symbol">{label}</td>
              <td data-label="Bucket">{BUCKET_LABEL[s.bucket]}</td>
              <td data-label="Position %" className={styles.num}>{formatPct(s.positionPct)}</td>
              <td data-label="Target %" className={styles.num}>{formatPct(target)}</td>
              <td data-label="Δpp" className={`${styles.num} ${ok ? "" : styles.strong}`}>{delta.toFixed(2)}</td>
              <td data-label="Status"><ToleranceBadge ok={ok} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EquityHoldingsTable({ holdings }: { holdings: Array<{ symbol: string; positionPct: number }> }) {
  return (
    <table className={`${styles.table} ${styles.stack}`}>
      <thead>
        <tr><th>Symbol</th><th className={styles.num}>Position %</th></tr>
      </thead>
      <tbody>
        {holdings.map((h) => (
          <tr key={h.symbol}>
            <td data-label="Symbol">{h.symbol}</td>
            <td data-label="Position %" className={styles.num}>{formatPct(h.positionPct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AccountDetail({ row, detailLoading, detailError, detailRun }: {
  row: AccountDriftHistoryRow;
  detailLoading: boolean;
  detailError: string | null;
  detailRun: AccountDriftRunRow | null;
}) {
  if (detailLoading) return <div className={styles.muted}>Loading detail…</div>;
  if (detailError) return <div className={styles.loss}>{detailError}</div>;
  if (!detailRun || detailRun.accountId !== row.accountId) return <div className={styles.muted}>Detail not available.</div>;
  const parsed = accountDriftDetailsSchema.safeParse(detailRun.details);
  if (!parsed.success) return <div className={styles.muted}>Detail payload could not be decoded.</div>;
  const details = parsed.data;
  return (
    <div className={styles.detail} data-drift-detail>
      <div>
        <h3>Per-bucket comparison</h3>
        <BucketComparisonTable buckets={details.buckets} />
      </div>
      {details.tax && <TaxPanel tax={details.tax} />}
      {details.sectorAllocation && details.sectorAllocation.slices.length > 0 && (
        <SectorAllocationPanel allocation={details.sectorAllocation} />
      )}
      {details.symbolsWithTargets.length > 0 && (
        <div>
          <h3>Per-symbol breakdown — cash &amp; fixed</h3>
          <SymbolBreakdownTable symbols={details.symbolsWithTargets} />
        </div>
      )}
      {details.equityHoldings.length > 0 && (
        <div>
          <h3>Equity holdings (rolled up to bucket)</h3>
          <EquityHoldingsTable holdings={details.equityHoldings} />
        </div>
      )}
      {details.suspectedCashEquivMisclassified.length > 0 && (
        <small className={styles.audit}>
          Audit: {details.suspectedCashEquivMisclassified.join(", ")} look like money-market funds but were routed to
          equity (not in INSTRUMENTS).
        </small>
      )}
    </div>
  );
}
