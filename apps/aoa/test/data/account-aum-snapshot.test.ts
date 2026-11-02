import { describe, expect, it } from "vitest";
import { validateAccountAumSnapshot } from "@/lib/data/account-aum-snapshot";
import { FIRM_ACCOUNT_IDS } from "@/lib/data/firm-household";

const DATE = "2026-08-21";
const CLOSED = "01SYNTH91CNZDPTY5FVCZAQCB1";
const override = [{
  custodianAccountId: CLOSED,
  provisionalCloseDate: "2026-04-14",
  reason: "approved operational rule",
  sourceReference: "close request 2026-01-14",
}];

function open(id: string, extra: Record<string, unknown> = {}) {
  return {
    custodian_account_id: id, apex_account_number: "ABC1234", client_sf_id: "003A",
    household_sf_id: "001A", account_type: "Individual", is_managed: true,
    account_status: "OPEN", account_cash: 1.01, account_securities: 8.99,
    account_aum: 10, balance_as_of: DATE, source_snapshot_as_of: DATE,
    balance_current: true, close_date: null, source_record_class: "CLIENT", ...extra,
    expected_snapshot_rows: 6, expected_open_accounts: 1,
    expected_closed_accounts: 1, expected_corporate_accounts: 4,
    expected_current_balance_rows: 5,
  };
}

function validPayload(sourceCloseDate: string | null = null) {
  return [
    open("01CLIENT"),
    open(CLOSED, {
      apex_account_number: "1G7AX6R", account_status: "CLOSED", account_cash: null,
      account_securities: null, account_aum: null, balance_as_of: null,
      balance_current: null, close_date: sourceCloseDate,
    }),
    ...[...FIRM_ACCOUNT_IDS].map((id) => open(id, {
      apex_account_number: null, client_sf_id: null, household_sf_id: null,
      account_type: null, is_managed: false, source_record_class: "UNMAPPED_BALANCE",
    })),
  ];
}

describe("validateAccountAumSnapshot", () => {
  it("accepts a complete same-date snapshot and applies an audited fallback", () => {
    const result = validateAccountAumSnapshot(validPayload(), override);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.provisionalCloseDates).toBe(1);
    expect(result.snapshot.rows.find((row) => row.custodianAccountId === CLOSED)).toMatchObject({
      closeDate: "2026-04-14", closeDateSource: "PROVISIONAL_OVERRIDE", accountAum: 0,
      balanceCurrent: false,
    });
  });

  it("automatically prefers a later authoritative Apex close date", () => {
    const result = validateAccountAumSnapshot(validPayload("2026-05-02"), override);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.provisionalCloseDates).toBe(0);
    expect(result.snapshot.sourceCloseDates).toBe(1);
    expect(result.snapshot.rows.find((row) => row.custodianAccountId === CLOSED)).toMatchObject({
      closeDate: "2026-05-02", closeDateSource: "APEX",
    });
  });

  it("rejects missing closed dates without an approved fallback", () => {
    const result = validateAccountAumSnapshot(validPayload(), []);
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([
      { index: 1, reason: "closed_date_missing" },
    ]) });
  });

  it("rejects a CLOSED source row carrying any nonzero raw balance", () => {
    const payload = validPayload();
    payload[1] = { ...payload[1], account_cash: 0.01, account_aum: 0.01,
      balance_as_of: DATE, balance_current: true };
    expect(validateAccountAumSnapshot(payload, override)).toMatchObject({
      ok: false, errors: expect.arrayContaining([
        { index: 1, reason: "closed_account_nonzero_balance" },
      ]),
    });
  });

  it("accepts a newly closed account with its final current zero-dollar balance", () => {
    const payload = validPayload("2026-08-22");
    payload[1] = {
      ...payload[1],
      account_cash: 0,
      account_securities: 0,
      account_aum: 0,
      balance_as_of: DATE,
      balance_current: true,
    };
    for (const row of payload) row.expected_current_balance_rows = 6;

    const result = validateAccountAumSnapshot(payload, override);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.expectedCurrentAccounts).toBe(6);
    expect(result.snapshot.rows.find((row) => row.custodianAccountId === CLOSED)).toMatchObject({
      accountStatus: "CLOSED",
      accountAum: 0,
      balanceCurrent: false,
      closeDate: "2026-08-22",
    });
  });

  it("still rejects a claimed current-balance count without matching balance evidence", () => {
    const payload = validPayload();
    for (const row of payload) row.expected_current_balance_rows = 6;

    expect(validateAccountAumSnapshot(payload, override)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        { index: -1, reason: "current_account_count_mismatch" },
      ]),
    });
  });

  it("rejects mixed dates, duplicate accounts, partial firm coverage, and penny drift", () => {
    const mixed = validPayload();
    mixed[0] = { ...mixed[0], source_snapshot_as_of: "2026-08-20", balance_as_of: "2026-08-20" };
    expect(validateAccountAumSnapshot(mixed, override)).toMatchObject({
      ok: false, errors: expect.arrayContaining([{ index: -1, reason: "snapshot_dates_mixed" }]),
    });

    const duplicate = validPayload(); duplicate.push({ ...duplicate[0] });
    expect(validateAccountAumSnapshot(duplicate, override)).toMatchObject({
      ok: false, errors: expect.arrayContaining([{ index: 6, reason: "custodian_account_id_duplicate" }]),
    });

    expect(validateAccountAumSnapshot(validPayload().slice(0, -1), override)).toMatchObject({
      ok: false, errors: expect.arrayContaining([
        { index: -1, reason: "snapshot_row_count_mismatch" },
      ]),
    });

    const drift = validPayload(); drift[0] = { ...drift[0], account_aum: 10.02 };
    expect(validateAccountAumSnapshot(drift, override)).toMatchObject({
      ok: false, errors: expect.arrayContaining([{ index: 0, reason: "balance_does_not_reconcile" }]),
    });
  });
});
