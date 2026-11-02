import { describe, expect, it } from "vitest";
import {
  EMPTY_TRANSFER_FORM,
  diffTransferInput,
  toTransferInput,
  transferToFormValues,
  type TransferFormValues,
} from "@/components/transfers/transfer-form";
import { validateTransferInput } from "@/lib/data/transfer-validate";
import type { TransferRow } from "@/lib/data/transfer-types";

// Pure form contract (T3, WO ticket) — string form values ⇄ the shared
// TransferInput write contract. All data invented.

const FILLED: TransferFormValues = {
  client_first_name: "  Sam ",
  client_last_name: "Stone",
  client_sf_id: "C-1",
  household_name: "Stone Household",
  household_sf_id: "HH-1001",
  value: "1280000",
  stage: "DECISION",
  owner_kind: "CLIENT_SERVICE",
  owner_name: "Kayden Altenwerth",
  next_step: "Send the worksheet.",
  next_step_owner: "Operations",
  pending_nudge: "Send asset-decision worksheet",
  acat_transfer_id: "",
};

const ROW: TransferRow = {
  id: "DEMO-T-9999",
  source: "APP",
  client_first_name: "Sam",
  client_last_name: "Stone",
  client_sf_id: "C-1",
  household_name: "Stone Household",
  household_sf_id: "HH-1001",
  value: 1280000,
  stage: "DECISION",
  stage_entered_at: new Date("2026-06-20T00:00:00.000Z"),
  owner_kind: "CLIENT_SERVICE",
  owner_name: "Kayden Altenwerth",
  next_step: "Send the worksheet.",
  next_step_owner: "Operations",
  pending_nudge: "Send asset-decision worksheet",
  acat_transfer_id: null,
  // ticket Slice 2 columns (card/sync-managed, not form-owned).
  funding_type: null,
  accounts_opened_at_apex: false,
  funding_plan_complete: false,
  funding_plan_version: 0,
  funding_plan_approved_at: null,
  funding_plan_approved_by: null,
  funding_initiated: false,
  cash_in_flight: false,
  deal_id: null,
  deal_sf_id: null,
  transferring_firm: null,
  archived_at: null,
  archived_by: null,
  archived_reason: null,
  sync_flag: null,
  acat_record_id: null,
  asset_map_folder_id: null,
  asset_map_custodian: null,
  asset_map_account_number: null,
  asset_map_account_type: null,
  created_by: "ops@example.com",
  updated_by: "ops@example.com",
  created_at: new Date("2026-06-18T00:00:00.000Z"),
  updated_at: new Date("2026-06-20T00:00:00.000Z"),
};

describe("toTransferInput", () => {
  it("pins source to APP and trims/nulls optional blanks", () => {
    const input = toTransferInput({
      ...EMPTY_TRANSFER_FORM,
      client_first_name: " Noor ",
      client_last_name: "Haddad",
      value: "415000",
    });
    expect(input.source).toBe("APP");
    expect(input.client_first_name).toBe("Noor");
    expect(input.client_sf_id).toBeNull();
    expect(input.household_name).toBeNull();
    expect(input.household_sf_id).toBeNull();
    expect(input.owner_name).toBeNull();
    expect(input.next_step).toBeNull();
    expect(input.next_step_owner).toBeNull();
    expect(input.pending_nudge).toBeNull();
    expect(input.value).toBe(415000);
    expect(validateTransferInput(input).ok).toBe(true);
  });

  it("whitespace-only optionals become null too", () => {
    const input = toTransferInput({
      ...FILLED,
      client_sf_id: "   ",
      pending_nudge: " ",
    });
    expect(input.client_sf_id).toBeNull();
    expect(input.pending_nudge).toBeNull();
  });

  it("blank value → NaN so the frozen validator rejects it (never silently 0)", () => {
    const input = toTransferInput({ ...FILLED, value: "" });
    expect(Number.isNaN(input.value)).toBe(true);
    const result = validateTransferInput(input);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === "value")).toBe(true);
  });

  it("non-numeric value → NaN → field-keyed rejection", () => {
    const result = validateTransferInput(
      toTransferInput({ ...FILLED, value: "a lot" }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === "value")).toBe(true);
  });
});

describe("transferToFormValues", () => {
  it("round-trips a seam row through the form contract unchanged", () => {
    const values = transferToFormValues(ROW);
    expect(values.value).toBe("1280000");
    expect(values.stage).toBe("DECISION");
    const input = toTransferInput(values);
    expect(input.client_first_name).toBe(ROW.client_first_name);
    expect(input.value).toBe(ROW.value);
    expect(diffTransferInput(input, toTransferInput(values))).toEqual({});
  });

  it("renders nulls as empty inputs", () => {
    const values = transferToFormValues({
      ...ROW,
      client_sf_id: null,
      household_name: null,
      household_sf_id: null,
      owner_name: null,
      next_step: null,
      next_step_owner: null,
      pending_nudge: null,
    });
    expect(values.client_sf_id).toBe("");
    expect(values.owner_name).toBe("");
    expect(values.pending_nudge).toBe("");
  });
});

describe("diffTransferInput", () => {
  const before = toTransferInput(transferToFormValues(ROW));

  it("identical inputs → empty map (the action no-ops, no audit noise)", () => {
    expect(diffTransferInput(before, { ...before })).toEqual({});
  });

  it("reports per-field {from, to} for exactly the edited fields", () => {
    const after = { ...before, value: 1500000, stage: "IN_TRANSFER" as const };
    expect(diffTransferInput(before, after)).toEqual({
      value: { from: 1280000, to: 1500000 },
      stage: { from: "DECISION", to: "IN_TRANSFER" },
    });
  });

  it("null ⇄ value transitions are changes; null ⇄ null is not", () => {
    const b = { ...before, owner_name: null, next_step: null };
    const a = { ...b, owner_name: "Riley Ops" };
    expect(diffTransferInput(b, a)).toEqual({
      owner_name: { from: null, to: "Riley Ops" },
    });
  });
});

// ticket — the acat_transfer_id write flows through the SAME form contract
// as every other editable field, so setting/clearing it rides updateTransfer's
// existing diff + audit machinery (no new server action, no manual audit call).
describe("acat_transfer_id (ticket)", () => {
  it("toTransferInput trims a set id and nulls a blank one", () => {
    expect(
      toTransferInput({ ...FILLED, acat_transfer_id: "  ACT-123  " })
        .acat_transfer_id,
    ).toBe("ACT-123");
    expect(
      toTransferInput({ ...FILLED, acat_transfer_id: "   " }).acat_transfer_id,
    ).toBeNull();
    expect(
      toTransferInput({ ...FILLED, acat_transfer_id: "" }).acat_transfer_id,
    ).toBeNull();
  });

  it("round-trips a stored id back to the edit form (null → empty input)", () => {
    expect(transferToFormValues(ROW).acat_transfer_id).toBe("");
    expect(
      transferToFormValues({ ...ROW, acat_transfer_id: "ACT-9" })
        .acat_transfer_id,
    ).toBe("ACT-9");
  });

  it("seeds the ACAT field record-id-FIRST (a record-id-only link must never show a blank field)", () => {
    // Before either-id routing, a record-id-only linked transfer seeded ""
    // here — so an untouched save read as an explicit clear and silently
    // unlinked it. The stored link must round-trip visibly.
    expect(
      transferToFormValues({ ...ROW, acat_record_id: "rec-manual-hayes" })
        .acat_transfer_id,
    ).toBe("rec-manual-hayes");
    // Both columns stored → the record id (the primary link key) is shown.
    expect(
      transferToFormValues({
        ...ROW,
        acat_record_id: "rec-lee-8",
        acat_transfer_id: "1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
      }).acat_transfer_id,
    ).toBe("rec-lee-8");
    // Legacy UUID-only link → the UUID is shown (unchanged behavior).
    expect(
      transferToFormValues({
        ...ROW,
        acat_transfer_id: "1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
      }).acat_transfer_id,
    ).toBe("1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b");
  });

  it("diff captures SET (null→id) and CLEAR (id→null) for the audit detail", () => {
    const before = toTransferInput(transferToFormValues(ROW)); // acat null
    const set = { ...before, acat_transfer_id: "ACT-77" };
    expect(diffTransferInput(before, set)).toEqual({
      acat_transfer_id: { from: null, to: "ACT-77" },
    });
    expect(diffTransferInput(set, before)).toEqual({
      acat_transfer_id: { from: "ACT-77", to: null },
    });
  });
});

// ticket Slice 2 — the deal-sourced columns are card/sync-managed, NOT
// form-owned. The create/edit form contract must neither set them (they stay
// undefined out of toTransferInput) nor diff them (they are absent from
// FORM_FIELDS), so their dedicated audited actions are the sole write path.
describe("deal-sourced columns are not form-owned (ticket Slice 2)", () => {
  it("toTransferInput leaves the card/sync columns undefined", () => {
    const input = toTransferInput(FILLED);
    expect(input.funding_type).toBeUndefined();
    expect(input.accounts_opened_at_apex).toBeUndefined();
    expect(input.funding_plan_complete).toBeUndefined();
    expect(input.funding_initiated).toBeUndefined();
    expect(input.cash_in_flight).toBeUndefined();
    expect(input.deal_id).toBeUndefined();
    expect(input.deal_sf_id).toBeUndefined();
    expect(input.transferring_firm).toBeUndefined();
    expect(input.sync_flag).toBeUndefined();
    expect(input.acat_record_id).toBeUndefined();
  });

  it("diffTransferInput ignores card/sync column differences", () => {
    const before = toTransferInput(transferToFormValues(ROW));
    const after = { ...before, funding_type: "ACAT_FULL" as const, cash_in_flight: true };
    // funding_type/cash_in_flight are not in FORM_FIELDS → no diff entry.
    expect(diffTransferInput(before, after)).toEqual({});
  });
});
