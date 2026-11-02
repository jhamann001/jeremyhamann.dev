import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { destinationConfirmationKey, pickerCandidates, pickerDestination, sourceConfirmationKey } from "@/lib/data/transfer-acat-picker";
import type { AcatListRow } from "@/lib/data/acat-status";

const row: AcatListRow = {
  id: "synthetic-source", acatTransferId: "abcdefab-cdef-abcd-efab-cdefabcdefab",
  clientName: "Synthetic Client", controlNumber: "private-control", direction: "INCOMING", type: "FULL",
  accountType: "IRA", status: "SUBMITTED", transferringContra: "Synthetic Custodian", statementAmount: 10000,
  acatDate: "2026-09-24", lastActivityAt: "2026-09-24", apexAccountId: "********1234",
  statementAccountNumber: "********5678", dtccNumber: "private-dtcc",
  assetMap: { total: 0, mapped: 0, unmapped: 0, pending: 0, expected: 0 },
};

describe("server-only ACAT picker projection", () => {
  it.each([
    { value: "562501056643", expected: "••••6643" },
    { value: "********6643", expected: "••••6643" },
    { value: "  562501056643  ", expected: "••••6643" },
    { value: "1234", expected: "••••" },
    { value: "123", expected: "••••" },
    { value: "", expected: null },
    { value: null, expected: null },
  ])("defensively masks account value $value", ({ value, expected }) => {
    const [projected] = pickerCandidates([{ ...row, statementAccountNumber: value, apexAccountId: value }], []);
    expect(projected.statementAccountMasked).toBe(expected);
    expect(projected.receivingAccountMasked).toBe(expected);
    expect(projected).not.toHaveProperty("acatTransferId");
    expect(projected).not.toHaveProperty("statementAccountNumber");
    expect(projected).not.toHaveProperty("apexAccountId");
    expect(projected).not.toHaveProperty("controlNumber");
    expect(projected).not.toHaveProperty("dtccNumber");
  });

  it("recognizes legacy UUID links regardless of case", () => {
    const [projected] = pickerCandidates([row], [{ acat_record_id: null, acat_transfer_id: row.acatTransferId.toUpperCase() }]);
    expect(projected.unavailableReason).toBe("Already linked to a transfer");
  });

  it("does not change the review key for capitalization of the same UUID", () => {
    expect(sourceConfirmationKey({ ...row, acatTransferId: row.acatTransferId.toUpperCase() })).toBe(sourceConfirmationKey(row));
  });

  it("preserves case when comparing opaque, non-UUID transfer IDs", () => {
    const [projected] = pickerCandidates([{ ...row, acatTransferId: "Opaque-Source" }], [{
      acat_record_id: null, acat_transfer_id: "opaque-source",
    }]);
    expect(projected.unavailableReason).toBeNull();
  });

  it("does not mark separate placeholder-ID records linked by a shared placeholder", () => {
    const [projected] = pickerCandidates([{ ...row, acatTransferId: "N/A" }], [{ acat_record_id: "another-record", acat_transfer_id: "N/A" }]);
    expect(projected.unavailableReason).toBeNull();
  });

  it.each([
    { id: "changed-record" }, { acatTransferId: "changed-id" }, { clientName: "Changed client" },
    { transferringContra: "Changed custodian" }, { statementAccountNumber: "********5555" },
    { apexAccountId: "********4444" }, { accountType: "INDIVIDUAL" }, { type: "PARTIAL" },
    { direction: "OUTGOING" }, { acatDate: "2026-09-25" }, { statementAmount: 20000 },
  ])("requires renewed review when machine-visible source identity changes (%j)", (changes) => {
    expect(sourceConfirmationKey({ ...row, ...changes })).not.toBe(sourceConfirmationKey(row));
  });

  it("does not treat progressing status or asset mapping as changed identity", () => {
    expect(sourceConfirmationKey({ ...row, status: "ACCEPTED", lastActivityAt: "2026-09-25", assetMap: {
      total: 1, expected: 1, mapped: 1, unmapped: 0, pending: 0,
    } })).toBe(sourceConfirmationKey(row));
  });

  it("normalizes blank and placeholder transfer IDs consistently", () => {
    expect(sourceConfirmationKey({ ...row, acatTransferId: " N/A " })).toBe(sourceConfirmationKey({ ...row, acatTransferId: "" }));
  });
});

describe("destination confirmation", () => {
  const target = {
    id: "synthetic-transfer", client_sf_id: "synthetic-client", household_sf_id: "synthetic-household",
    client_first_name: "Synthetic", client_last_name: "Client", household_name: "Synthetic Household",
  };
  it.each(Object.keys(target) as (keyof typeof target)[])("detects a changed %s", (key) => {
    expect(destinationConfirmationKey({ ...target, [key]: "changed" })).not.toBe(destinationConfirmationKey(target));
  });
  it("keeps CRM IDs server-side", () => {
    expect(pickerDestination(target)).toEqual({
      id: target.id, clientName: "Synthetic Client", householdName: "Synthetic Household",
      confirmationKey: destinationConfirmationKey(target),
    });
  });
});
