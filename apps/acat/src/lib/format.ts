export function maskAccountNumber(value: string): string {
  const chars = [...value];
  let alphaCount = 0;
  let cutoff = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== "-") {
      alphaCount++;
      if (alphaCount === 4) { cutoff = i; break; }
    }
  }
  if (alphaCount < 4) return value;
  return chars.map((c, i) => (i < cutoff && c !== "-") ? "•" : c).join("");
}

export function formatDollar(value: number): string {
  // Negatives (e.g. an ACAT Out / transfer) keep the sign in front of the
  // dollar mark — "-$54K", not "$-54K" — and reuse the same abbreviations.
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const m = abs / 1_000_000;
    return `${sign}$${m >= 10 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}$${Math.round(abs / 1_000)}K`;
  }
  return `${sign}$${abs.toLocaleString()}`;
}

// `statementAmount` is stored as integer cents (see schema.prisma). UI
// inputs accept the human forms operators type ("$54,677.68", "54677.68",
// "54,677"); we parse them to cents on submit and convert back on display.

export function parseMoneyToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

export function formatCentsAsDollar(cents: number): string {
  return formatDollar(cents / 100);
}

// Editable inputs prefer the precise "$54,677.68" form so operators can see
// (and round-trip) their original value, rather than the abbreviated $54K
// formatDollar produces for read-only displays.
export function formatCentsExact(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.abs(cents) / 100;
  return `${sign}$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function normalizeMoneyStringExact(value: string | null | undefined): string | null {
  if (value == null || !value.trim()) return null;
  const cents = parseMoneyToCents(value);
  return cents == null ? null : formatCentsExact(cents);
}

export function formatMoneyStringExact(value: string | null | undefined): string {
  if (value == null || !value.trim()) return "";
  return normalizeMoneyStringExact(value) ?? value.trim();
}

export function normalizeStatementAmountSign(cents: number, direction?: string | null): number {
  return direction?.trim().toLowerCase() === "out" ? -Math.abs(cents) : cents;
}

function validIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MONTH_NUMBER: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** Normalize stored/input dates for calculations while accepting legacy MM-DD-YYYY rows. */
export function normalizeDateToIso(value: string | Date | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const trimmed = value.trim();
  // Historical imports stored otherwise-valid ISO dates with a space before
  // the time component (for example, "2025-06-27 00:00:00"). Accept both
  // that legacy database shape and the standard `T` separator.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(trimmed);
  if (iso) return validIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const mdy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(trimmed);
  if (mdy) return validIsoDate(Number(mdy[3]), Number(mdy[1]), Number(mdy[2]));
  const named = /^([a-z]+)\s+(\d{1,2}),\s*(\d{4})$/i.exec(trimmed);
  if (named) {
    const month = MONTH_NUMBER[named[1].toLowerCase()];
    return month ? validIsoDate(Number(named[3]), month, Number(named[2])) : null;
  }
  return null;
}

/** User-facing transfer dates are consistently MM-DD-YYYY. */
export function formatDateMMDDYYYY(value: string | Date | null | undefined): string {
  const iso = normalizeDateToIso(value);
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${month}-${day}-${year}`;
}
