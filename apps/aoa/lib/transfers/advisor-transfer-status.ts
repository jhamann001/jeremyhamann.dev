// Client Transfers advisor list (ticket): the pure, client-safe pieces shared by
// the tracker reader, the server action and the list component. No server-only
// import lives here so the client bundle can use it.
//
// Everything below is a port of the tracker advisor page at tracker main 25555c2
// (src/components/AdvisorTransfersView.tsx, src/lib/types.ts, src/lib/format.ts,
// src/lib/advisor-redaction.ts) so the AoA list reads exactly like the tracker's.

/** The 15 columns the tracker's advisor redaction exposes (ADVISOR_VISIBLE_KEYS). */
export const ADVISOR_TRANSFER_KEYS = [
  "id",
  "clientName",
  "status",
  "direction",
  "type",
  "accountType",
  "transferringContra",
  "wealthAdvisor",
  "additionalResources",
  "originalClientRequestDate",
  "opsSubmissionDateToApex",
  "apexCompletionDate",
  "acatDate",
  "statementAmount",
  "custodian",
] as const;

export type AdvisorTransferRow = {
  id: string;
  clientName: string;
  status: string;
  direction: string | null;
  type: string | null;
  accountType: string | null;
  transferringContra: string | null;
  wealthAdvisor: string | null;
  additionalResources: string | null;
  originalClientRequestDate: string | null;
  opsSubmissionDateToApex: string | null;
  apexCompletionDate: string | null;
  acatDate: string;
  statementAmount: number | null;
  custodian: { id: string; name: string; avgProcessingDays: number } | null;
};

export type AdvisorTransferSet = "active" | "completed" | "all";

/** Tracker ACAT_STATUS_LABELS, verbatim (includes WaitingForStatement). */
export const ADVISOR_STATUS_LABELS: Readonly<Record<string, string>> = {
  WaitingForApex: "Waiting for Apex",
  PendingAccountOpening: "Pending Account Opening",
  WaitingOnClient: "Waiting on Client",
  WaitingForStatement: "Waiting for Statement",
  AcatReceived: "ACAT Received",
  ToCome: "To Come",
  Submitted: "Submitted",
  PendingReview: "Pending Review",
  PendingContraResponse: "Pending Contra Response",
  Accepted: "Accepted",
  PendingSettlement: "Pending Settlement",
  PendingBookkeeping: "Pending Bookkeeping",
  Matched: "Recon: Matched",
  Mismatch: "Recon: Mismatch",
  Pending: "Recon: Pending",
  Completed: "Completed",
  Rejected: "Rejected",
  Purged: "Purged",
  Canceled: "Canceled",
  Deferred: "Deferred",
};

/** Tracker TERMINAL_STATUSES. */
export const ADVISOR_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "Completed",
  "Rejected",
  "Purged",
  "Canceled",
  "Deferred",
]);

/** An unmapped status renders as its raw string, like the tracker's `?? acat.status`. */
export function advisorStatusLabel(status: string): string {
  return Object.hasOwn(ADVISOR_STATUS_LABELS, status) ? ADVISOR_STATUS_LABELS[status] : status;
}

export function isAdvisorTerminal(status: string): boolean {
  return ADVISOR_TERMINAL_STATUSES.has(status);
}

/**
 * Active means not terminal, Completed means terminal, All means both. Search
 * keeps a row when the text is contained in client, contra or advisor; the set
 * and the search both apply. Newest `acatDate` first, the tracker's order.
 */
export function filterAdvisorTransfers(
  rows: readonly AdvisorTransferRow[],
  query: string,
  set: AdvisorTransferSet,
): AdvisorTransferRow[] {
  const q = query.trim().toLowerCase();
  return rows
    .filter((row) => {
      if (set === "active") return !isAdvisorTerminal(row.status);
      if (set === "completed") return isAdvisorTerminal(row.status);
      return true;
    })
    .filter((row) => {
      if (!q) return true;
      return (
        row.clientName.toLowerCase().includes(q) ||
        (row.transferringContra?.toLowerCase().includes(q) ?? false) ||
        (row.wealthAdvisor?.toLowerCase().includes(q) ?? false)
      );
    })
    .sort((a, b) => new Date(b.acatDate).getTime() - new Date(a.acatDate).getTime());
}

export function countAdvisorTransfers(rows: readonly AdvisorTransferRow[]): { active: number; completed: number } {
  let active = 0;
  let completed = 0;
  for (const row of rows) {
    if (isAdvisorTerminal(row.status)) completed += 1;
    else active += 1;
  }
  return { active, completed };
}

// --- Dates and values: verbatim copies of tracker src/lib/format.ts (25555c2) ---

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

function normalizeDateToIso(value: string | Date | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const trimmed = value.trim();
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

/** Transfer dates are MM-DD-YYYY, "" when the value is empty or not a date. */
export function formatAdvisorDate(value: string | Date | null | undefined): string {
  const iso = normalizeDateToIso(value);
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${month}-${day}-${year}`;
}

/** Integer cents as dollars, `-$1,234.56` for negatives. */
export function formatAdvisorValue(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.abs(cents) / 100;
  return `${sign}$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
