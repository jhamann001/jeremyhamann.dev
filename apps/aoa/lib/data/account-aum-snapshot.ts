import { FIRM_ACCOUNT_IDS, FIRM_HOUSEHOLD_ID } from "./firm-household";
import type { AccountCloseDateOverride } from "./account-close-date-overrides";

export const BALANCE_RECONCILIATION_TOLERANCE = 0.01;

export type CloseDateSource = "APEX" | "PROVISIONAL_OVERRIDE";

export type ValidatedAccountAumRow = {
  custodianAccountId: string;
  apexAccountNumber: string | null;
  clientSfId: string | null;
  householdSfId: string | null;
  accountType: string | null;
  isManaged: boolean;
  accountStatus: string;
  accountCash: number;
  accountSecurities: number;
  accountAum: number;
  balanceAsOf: string | null;
  sourceSnapshotAsOf: string;
  balanceCurrent: boolean;
  closeDate: string | null;
  closeDateSource: CloseDateSource | null;
  sourceRecordClass: "CLIENT" | "UNMAPPED_BALANCE";
};

export type SnapshotValidationError = { index: number; reason: string };

export type ValidatedAccountAumSnapshot = {
  rows: ValidatedAccountAumRow[];
  sourceSnapshotAsOf: string;
  openAccounts: number;
  closedAccounts: number;
  corporateAccounts: number;
  sourceCloseDates: number;
  provisionalCloseDates: number;
  expectedSnapshotRows: number;
  expectedOpenAccounts: number;
  expectedClosedAccounts: number;
  expectedCorporateAccounts: number;
  expectedCurrentAccounts: number;
};

export type SnapshotValidationResult =
  | { ok: true; snapshot: ValidatedAccountAumSnapshot }
  | { ok: false; errors: SnapshotValidationError[] };

type RawRow = Record<string, unknown>;

function strOrNull(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function dateOnly(value: unknown): string | null {
  if (value == null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) return null;
  const candidate = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${candidate}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonnegativeInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number != null && Number.isInteger(number) && number >= 0 ? number : null;
}

function strictBoolean(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function error(index: number, reason: string): SnapshotValidationError {
  return { index, reason };
}

/** Validate the complete card-6601 account snapshot before any mirror write.
 * Every accepted current balance must reconcile to the cent; CLOSED rows are
 * explicit $0 lifecycle rows and require a source or approved fallback date. */
export function validateAccountAumSnapshot(
  payload: unknown,
  overrides: readonly AccountCloseDateOverride[],
): SnapshotValidationResult {
  if (!Array.isArray(payload) || payload.length === 0) {
    return { ok: false, errors: [error(-1, "snapshot_empty_or_bad_shape")] };
  }

  const overrideByAccount = new Map(
    overrides.map((override) => [override.custodianAccountId, override] as const),
  );
  const rows: ValidatedAccountAumRow[] = [];
  const errors: SnapshotValidationError[] = [];
  const seen = new Set<string>();
  let currentBalanceRows = 0;
  let expectations: {
    snapshotRows: number;
    openAccounts: number;
    closedAccounts: number;
    corporateAccounts: number;
    currentAccounts: number;
  } | null = null;

  for (let index = 0; index < payload.length; index += 1) {
    const raw = payload[index] as RawRow;
    const rowExpectations = {
      snapshotRows: nonnegativeInteger(raw.expected_snapshot_rows),
      openAccounts: nonnegativeInteger(raw.expected_open_accounts),
      closedAccounts: nonnegativeInteger(raw.expected_closed_accounts),
      corporateAccounts: nonnegativeInteger(raw.expected_corporate_accounts),
      currentAccounts: nonnegativeInteger(raw.expected_current_balance_rows),
    };
    if (Object.values(rowExpectations).some((value) => value == null)) {
      errors.push(error(index, "source_expectations_invalid"));
    } else {
      const complete = rowExpectations as {
        snapshotRows: number; openAccounts: number; closedAccounts: number;
        corporateAccounts: number; currentAccounts: number;
      };
      if (!expectations) expectations = complete;
      else if (Object.keys(complete).some((key) =>
        complete[key as keyof typeof complete] !== expectations?.[key as keyof typeof complete])) {
        errors.push(error(index, "source_expectations_mixed"));
      }
    }
    const custodianAccountId = strOrNull(raw.custodian_account_id);
    if (!custodianAccountId) {
      errors.push(error(index, "custodian_account_id_missing"));
      continue;
    }
    if (seen.has(custodianAccountId)) {
      errors.push(error(index, "custodian_account_id_duplicate"));
      continue;
    }
    seen.add(custodianAccountId);

    const sourceRecordClass = strOrNull(raw.source_record_class);
    if (sourceRecordClass !== "CLIENT" && sourceRecordClass !== "UNMAPPED_BALANCE") {
      errors.push(error(index, "source_record_class_invalid"));
      continue;
    }
    const firm = FIRM_ACCOUNT_IDS.has(custodianAccountId);
    if (sourceRecordClass === "UNMAPPED_BALANCE" && !firm) {
      errors.push(error(index, "unexpected_unmapped_balance_account"));
      continue;
    }
    if (sourceRecordClass === "CLIENT" && firm) {
      errors.push(error(index, "firm_account_misclassified"));
      continue;
    }

    const accountStatus = strOrNull(raw.account_status)?.toUpperCase() ?? null;
    if (!accountStatus) {
      errors.push(error(index, "account_status_missing"));
      continue;
    }
    if (accountStatus !== "OPEN" && accountStatus !== "CLOSED") {
      errors.push(error(index, "account_status_invalid"));
      continue;
    }
    const closed = accountStatus === "CLOSED";
    const sourceSnapshotAsOf = dateOnly(raw.source_snapshot_as_of);
    if (!sourceSnapshotAsOf) {
      errors.push(error(index, "source_snapshot_as_of_invalid"));
      continue;
    }
    const balanceAsOf = dateOnly(raw.balance_as_of);
    const balanceCurrent = strictBoolean(raw.balance_current);

    const accountCash = finiteNumber(raw.account_cash);
    const accountSecurities = finiteNumber(raw.account_securities);
    const accountAum = finiteNumber(raw.account_aum);
    const hasInvalidRawBalance = [raw.account_cash, raw.account_securities, raw.account_aum]
      .some((value) => value != null && value !== "" && finiteNumber(value) == null);

    let closeDate: string | null = null;
    let closeDateSource: CloseDateSource | null = null;
    const sourceCloseDate = dateOnly(raw.close_date);
    if (raw.close_date != null && sourceCloseDate == null) {
      errors.push(error(index, "close_date_invalid"));
      continue;
    }
    if (closed) {
      const override = overrideByAccount.get(custodianAccountId);
      if (sourceCloseDate) {
        closeDate = sourceCloseDate;
        closeDateSource = "APEX";
      } else if (override && dateOnly(override.provisionalCloseDate)) {
        closeDate = dateOnly(override.provisionalCloseDate);
        closeDateSource = "PROVISIONAL_OVERRIDE";
      } else {
        errors.push(error(index, "closed_date_missing"));
        continue;
      }
      if (hasInvalidRawBalance) {
        errors.push(error(index, "balance_value_invalid"));
        continue;
      }
      if ([accountCash, accountSecurities, accountAum]
        .some((value) => value != null && Math.abs(value) > 1e-7)) {
        errors.push(error(index, "closed_account_nonzero_balance"));
        continue;
      }
    } else {
      if (balanceCurrent == null) {
        errors.push(error(index, "balance_current_invalid"));
        continue;
      }
      if (hasInvalidRawBalance || accountCash == null || accountSecurities == null || accountAum == null) {
        errors.push(error(index, "balance_value_invalid"));
        continue;
      }
      if (Math.abs(accountAum - accountCash - accountSecurities) >
        BALANCE_RECONCILIATION_TOLERANCE + 1e-7) {
        errors.push(error(index, "balance_does_not_reconcile"));
        continue;
      }
      if (sourceCloseDate) {
        errors.push(error(index, "current_account_has_close_date"));
        continue;
      }
      if (!balanceCurrent || balanceAsOf !== sourceSnapshotAsOf) {
        errors.push(error(index, "current_account_balance_not_current"));
        continue;
      }
    }

    const isManaged = strictBoolean(raw.is_managed);
    if (isManaged == null) {
      errors.push(error(index, "is_managed_invalid"));
      continue;
    }

    // The account master and overnight balances are independent snapshots.
    // An account can be marked CLOSED today while its final zero-dollar balance
    // still belongs to yesterday's latest balance snapshot. Count the balance
    // evidence itself instead of inferring balance coverage from today's OPEN
    // account population.
    if (
      balanceCurrent === true &&
      balanceAsOf === sourceSnapshotAsOf &&
      accountCash != null &&
      accountSecurities != null &&
      accountAum != null
    ) {
      currentBalanceRows += 1;
    }

    rows.push({
      custodianAccountId,
      apexAccountNumber: strOrNull(raw.apex_account_number),
      clientSfId: strOrNull(raw.client_sf_id),
      householdSfId: firm ? FIRM_HOUSEHOLD_ID : strOrNull(raw.household_sf_id),
      accountType: strOrNull(raw.account_type),
      isManaged,
      accountStatus,
      accountCash: closed ? 0 : accountCash!,
      accountSecurities: closed ? 0 : accountSecurities!,
      accountAum: closed ? 0 : accountAum!,
      balanceAsOf: closed ? null : balanceAsOf,
      sourceSnapshotAsOf,
      balanceCurrent: closed ? false : balanceCurrent!,
      closeDate,
      closeDateSource,
      sourceRecordClass,
    });
  }

  const snapshotDates = new Set(rows.map((row) => row.sourceSnapshotAsOf));
  if (snapshotDates.size !== 1) errors.push(error(-1, "snapshot_dates_mixed"));

  const firmRows = rows.filter((row) => FIRM_ACCOUNT_IDS.has(row.custodianAccountId));
  for (const firmAccountId of FIRM_ACCOUNT_IDS) {
    if (!seen.has(firmAccountId)) errors.push(error(-1, "firm_account_missing"));
  }
  if (firmRows.length !== FIRM_ACCOUNT_IDS.size) {
    errors.push(error(-1, "firm_account_coverage_invalid"));
  }

  const openAccounts = rows.filter(
    (row) => row.sourceRecordClass === "CLIENT" && row.accountStatus !== "CLOSED",
  ).length;
  if (openAccounts === 0) errors.push(error(-1, "open_account_coverage_empty"));

  if (!expectations) {
    errors.push(error(-1, "source_expectations_missing"));
  } else {
    if (payload.length !== expectations.snapshotRows || rows.length !== expectations.snapshotRows) {
      errors.push(error(-1, "snapshot_row_count_mismatch"));
    }
    if (openAccounts !== expectations.openAccounts) {
      errors.push(error(-1, "open_account_count_mismatch"));
    }
    const closedAccounts = rows.filter((row) => row.accountStatus === "CLOSED").length;
    if (closedAccounts !== expectations.closedAccounts) {
      errors.push(error(-1, "closed_account_count_mismatch"));
    }
    if (firmRows.length !== expectations.corporateAccounts ||
        expectations.corporateAccounts !== FIRM_ACCOUNT_IDS.size) {
      errors.push(error(-1, "corporate_account_count_mismatch"));
    }
    if (currentBalanceRows !== expectations.currentAccounts) {
      errors.push(error(-1, "current_account_count_mismatch"));
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const sourceSnapshotAsOf = rows[0].sourceSnapshotAsOf;
  return {
    ok: true,
    snapshot: {
      rows,
      sourceSnapshotAsOf,
      openAccounts,
      closedAccounts: rows.filter((row) => row.accountStatus === "CLOSED").length,
      corporateAccounts: firmRows.length,
      sourceCloseDates: rows.filter((row) => row.closeDateSource === "APEX").length,
      provisionalCloseDates: rows.filter(
        (row) => row.closeDateSource === "PROVISIONAL_OVERRIDE",
      ).length,
      expectedSnapshotRows: expectations!.snapshotRows,
      expectedOpenAccounts: expectations!.openAccounts,
      expectedClosedAccounts: expectations!.closedAccounts,
      expectedCorporateAccounts: expectations!.corporateAccounts,
      expectedCurrentAccounts: expectations!.currentAccounts,
    },
  };
}
