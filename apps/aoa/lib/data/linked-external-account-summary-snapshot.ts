// Validates the card 6898 (AOA Plaid Linked Account Summary Ingest) payload
// before the cron writes mirror.linked_external_account_summary. Pure: no I/O,
// and error entries carry only a row index and reason — never row values.

export type ValidatedLinkedExternalSummaryRow = {
  externalAccountId: string;
  clientSfId: string | null;
  householdSfId: string | null;
  institutionName: string | null;
  accountSubtype: string | null;
  mask: string | null;
  cashAmount: number | null;
  securitiesAmount: number | null;
  holdingsTotal: number | null;
  institutionBalance: number | null;
  asOf: Date;
  linkStatus: "ACTIVE";
  lineageKey: string | null;
  priorExternalAccountId: string | null;
};

export type SnapshotValidationError = { index: number; reason: string };

export type SnapshotValidationResult =
  | { ok: true; rows: ValidatedLinkedExternalSummaryRow[]; skipped: number }
  | { ok: false; errors: SnapshotValidationError[] };

type RawRow = Record<string, unknown>;

function strOrNull(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseAsOf(value: unknown): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Accepts only link_status === "ACTIVE". DEACTIVATED, EXPIRED, and
 *  EXPIRING_SOON are excluded warehouse statuses.
 *
 *  Card 6898 also returns active depository links (checking, savings) that
 *  have no investment holdings or balance rows, so as_of and every amount are
 *  null. A summary must carry an as-of date, so those rows are skipped and
 *  counted. A row with any amount but no as_of is still a validation error. */
export function validateLinkedExternalSummarySnapshot(
  payload: unknown,
): SnapshotValidationResult {
  if (!Array.isArray(payload)) {
    return { ok: false, errors: [{ index: -1, reason: "not_array" }] };
  }
  const rows: ValidatedLinkedExternalSummaryRow[] = [];
  const errors: SnapshotValidationError[] = [];
  let skipped = 0;
  payload.forEach((raw, index) => {
    const row = (raw ?? {}) as RawRow;
    const externalAccountId = strOrNull(row.external_account_id);
    const asOf = parseAsOf(row.as_of);
    const linkStatus = strOrNull(row.link_status);
    const cashAmount = finiteNumber(row.cash_amount);
    const securitiesAmount = finiteNumber(row.securities_amount);
    const holdingsTotal = finiteNumber(row.holdings_total);
    const institutionBalance = finiteNumber(row.institution_balance);
    if (!externalAccountId) {
      errors.push({ index, reason: "missing_external_account_id" });
      return;
    }
    if (linkStatus !== "ACTIVE") {
      errors.push({ index, reason: "inactive_link" });
      return;
    }
    if (!asOf) {
      const hasInvestmentData = [cashAmount, securitiesAmount, holdingsTotal, institutionBalance]
        .some((value) => value !== null);
      if (hasInvestmentData) errors.push({ index, reason: "missing_as_of" });
      else skipped += 1;
      return;
    }
    rows.push({
      externalAccountId,
      clientSfId: strOrNull(row.client_sf_id),
      householdSfId: strOrNull(row.household_sf_id),
      institutionName: strOrNull(row.institution_name),
      accountSubtype: strOrNull(row.account_subtype),
      mask: strOrNull(row.mask),
      cashAmount,
      securitiesAmount,
      holdingsTotal,
      institutionBalance,
      asOf,
      linkStatus: "ACTIVE",
      lineageKey: strOrNull(row.lineage_key),
      priorExternalAccountId: strOrNull(row.prior_external_account_id),
    });
  });
  return errors.length ? { ok: false, errors } : { ok: true, rows, skipped };
}
