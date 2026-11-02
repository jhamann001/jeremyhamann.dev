// Shared display formatters. Server- and client-component safe (pure, no deps).

/**
 * Whole-dollar USD currency for AUM/value displays, e.g. 2450000 → "$2,450,000".
 * Nullish → "—" (matches the Households detail-page convention).
 *
 * `Number()` guards the Postgres-numeric seam: `$queryRaw` hands `numeric` back
 * as a Prisma Decimal (or string) at runtime despite `number` typings, and
 * `Decimal/​String.prototype.toLocaleString` silently ignore the currency options
 * — which is exactly how "2450000 AUM" leaked into headers unformatted.
 */
export function usd(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/**
 * Penny-precise USD for figures that must tie to the custodian to the cent,
 * e.g. the Households AUM-parity KPIs (ticket): 25335920.80 → "$25,335,920.80".
 * Always two fraction digits. Nullish → "—". Same `Number()` guard as `usd`.
 */
export function usdCents(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Penny-precise USD for a value stored as INTEGER MINOR UNITS (cents) — e.g. the
 * Transfer Tracker's `statementAmount` (Int cents: 14723390 → "$147,233.90"). This
 * is the AOA mirror of the tracker's own `formatCentsExact` (cents/100 → 2-dp
 * currency), so an amount reads identically in both apps. Nullish → "—".
 * NOTE: unlike `usdCents` (which formats a dollar figure), this divides by 100.
 */
export function usdFromCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return usdCents(Number(cents) / 100);
}

/**
 * Compact USD for count pills and big-figure headers, mirroring the mockup's
 * `fmtAbbr`: 2450000 → "$2.45M", 486000 → "$486K", 980 → "$980" (via `usd`).
 * Trailing zeros in the millions decimals are trimmed ("$2.00M" → "$2M").
 * Nullish → "—". Same `Number()` guard as `usd` for the Decimal/string seam.
 */
export function usdCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1e6) {
    const m = (abs / 1e6).toFixed(2).replace(/\.?0+$/, "");
    return `${sign}$${m}M`;
  }
  if (abs >= 1e3) return `${sign}$${Math.round(abs / 1e3)}K`;
  return usd(v);
}
