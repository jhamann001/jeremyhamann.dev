import { describe, expect, it } from "vitest";
import {
  CHECKLIST_ITEMS, checkedCount, checklistAccess, checklistStamp, checklistTabLabel, uncheckedCount,
} from "@/lib/trade-requests/checklist-view";

// ticket: checklist rules — access by role and status (AC-48, AC-86, AC-87),
// counts (AC-140), tab label (P2-116) and the "Checked by" line (AC-130).

describe("checklist view (ticket)", () => {
  it("lists the seven standalone items in order, three with a text field", () => {
    expect(CHECKLIST_ITEMS.map((item) => item.label)).toEqual([
      "Exclusions & restrictions applied (DNB / DNS)",
      "Meridian templates created for all accounts",
      "Asset location completed",
      "Transition used",
      "Legacy / ACAT positions liquidated",
      "Residual cash trades placed",
      "Advisor-instructed tickers traded",
    ]);
    expect(CHECKLIST_ITEMS.filter((item) => item.field).map((item) => [item.key, item.field!.label])).toEqual([
      ["templates", "Template name(s)"], ["transition", "Transition model"], ["advisor_tickers", "Tickers / instructions"],
    ]);
  });

  it("lets reviewers edit an undecided request, locks a decided one and keeps advisors read-only", () => {
    for (const role of ["ADMIN", "OPERATIONS"]) {
      for (const status of ["Pending Review", "Needs Info", "Pending Current Asset Liquidation"]) expect(checklistAccess(role, status)).toBe("edit");
      for (const status of ["Approved", "Rejected", "Completed"]) expect(checklistAccess(role, status)).toBe("locked");
    }
    for (const status of ["Pending Review", "Approved"]) expect(checklistAccess("ADVISOR", status)).toBe("read_only");
    for (const role of ["CLIENT_SERVICE", "VIEWER", ""]) expect(checklistAccess(role, "Pending Review")).toBe("read_only");
  });

  it("counts checked items only; text alone does not complete an item", () => {
    const state = { exclusions: { checked: true }, templates: { checked: false, value: "Synthetic" }, transition: { checked: true } };
    expect(checkedCount(state)).toBe(2);
    expect(uncheckedCount(state)).toBe(5);
    expect(uncheckedCount({})).toBe(7);
  });

  it("labels the tab with the unchecked count while any item is unchecked", () => {
    expect(checklistTabLabel(7)).toBe("Pre-approval Checklist (7)");
    expect(checklistTabLabel(1)).toBe("Pre-approval Checklist (1)");
    expect(checklistTabLabel(0)).toBe("Pre-approval Checklist");
  });

  it("stamps an item with its last change, checked or not", () => {
    const fmt = (iso: string) => iso.slice(0, 10);
    expect(checklistStamp({ checked: false, by: "Riley Ops", at: "2026-10-15T15:00:00.000Z" }, fmt)).toBe("Checked by Riley Ops · 2026-10-15");
    expect(checklistStamp({ checked: true }, fmt)).toBeNull();
    expect(checklistStamp(undefined, fmt)).toBeNull();
  });
});
