import { describe, it, expect } from "vitest";
import {
  applyFilters,
  evaluateRule,
  generateRuleId,
  operatorsForType,
  defaultOperatorForType,
  FilterRule,
} from "./record-filters";
import { mockAcats } from "./mock-data";
import { AcatRecord } from "./types";
import { getField } from "./record-fields";

const sarah = mockAcats[0]; // PendingReview, Schwab, statementAmount 26800000 cents ($268,000)
const michael = mockAcats[1]; // Completed, Fidelity, statementAmount 41250000 cents ($412,500)
const linda = mockAcats[6]; // WaitingForApex, direction=Out

function rule(partial: Partial<FilterRule>): FilterRule {
  return {
    id: partial.id ?? generateRuleId(),
    field: partial.field ?? "clientName",
    operator: partial.operator ?? "contains",
    value: partial.value,
    value2: partial.value2,
    values: partial.values,
  };
}

describe("operator catalog", () => {
  it("returns operators for every field type", () => {
    expect(operatorsForType("text").length).toBeGreaterThan(0);
    expect(operatorsForType("enum").length).toBeGreaterThan(0);
    expect(operatorsForType("date").length).toBeGreaterThan(0);
    expect(operatorsForType("number").length).toBeGreaterThan(0);
    expect(operatorsForType("boolean").length).toBeGreaterThan(0);
    expect(operatorsForType("multiselect").length).toBeGreaterThan(0);
  });

  it("provides a sensible default operator for every field type", () => {
    expect(defaultOperatorForType("text")).toBe("contains");
    expect(defaultOperatorForType("enum")).toBe("is_one_of");
    expect(defaultOperatorForType("date")).toBe("on");
    expect(defaultOperatorForType("number")).toBe("eq");
    expect(defaultOperatorForType("boolean")).toBe("is_true");
    expect(defaultOperatorForType("multiselect")).toBe("contains_any");
  });
});

describe("text operators", () => {
  it("contains is case-insensitive", () => {
    expect(
      evaluateRule(sarah, rule({ field: "clientName", operator: "contains", value: "sarah" }))
    ).toBe(true);
    expect(
      evaluateRule(sarah, rule({ field: "clientName", operator: "contains", value: "michael" }))
    ).toBe(false);
  });

  it("not_contains", () => {
    expect(
      evaluateRule(sarah, rule({ field: "clientName", operator: "not_contains", value: "michael" }))
    ).toBe(true);
  });

  it("is / is_not are exact (case-insensitive)", () => {
    expect(
      evaluateRule(sarah, rule({ field: "clientName", operator: "is", value: "Sarah Jenkins" }))
    ).toBe(true);
    expect(
      evaluateRule(sarah, rule({ field: "clientName", operator: "is_not", value: "Michael Torres" }))
    ).toBe(true);
  });

  it("is_empty / is_not_empty", () => {
    const sparse: AcatRecord = { ...sarah, controlNumber: undefined };
    expect(
      evaluateRule(sparse, rule({ field: "controlNumber", operator: "is_empty" }))
    ).toBe(true);
    expect(
      evaluateRule(sarah, rule({ field: "controlNumber", operator: "is_not_empty" }))
    ).toBe(true);
  });
});

describe("enum operators", () => {
  it("offers and filters Waiting for Statement by its displayed label", () => {
    const waiting: AcatRecord = { ...sarah, status: "WaitingForStatement" };
    expect(getField("status")?.options).toContain("Waiting for Statement");
    expect(applyFilters([waiting, michael], [rule({
      field: "status",
      operator: "is_one_of",
      values: ["Waiting for Statement"],
    })])).toEqual([waiting]);
  });

  it("is_one_of with empty list matches everything", () => {
    expect(
      evaluateRule(sarah, rule({ field: "direction", operator: "is_one_of", values: [] }))
    ).toBe(true);
  });

  it("is_one_of matches a member", () => {
    expect(
      evaluateRule(sarah, rule({ field: "direction", operator: "is_one_of", values: ["In"] }))
    ).toBe(true);
    expect(
      evaluateRule(linda, rule({ field: "direction", operator: "is_one_of", values: ["In"] }))
    ).toBe(false);
  });

  it("is_none_of excludes members", () => {
    expect(
      evaluateRule(linda, rule({ field: "direction", operator: "is_none_of", values: ["In"] }))
    ).toBe(true);
    expect(
      evaluateRule(sarah, rule({ field: "direction", operator: "is_none_of", values: ["In"] }))
    ).toBe(false);
  });

  it("filters transfer workflows by their user-facing labels", () => {
    const manual: AcatRecord = { ...sarah, transferWorkflow: "MANUAL" };
    expect(
      evaluateRule(
        manual,
        rule({
          field: "transferWorkflow",
          operator: "is_one_of",
          values: ["Manual"],
        })
      )
    ).toBe(true);
    expect(
      evaluateRule(
        manual,
        rule({
          field: "transferWorkflow",
          operator: "is_one_of",
          values: ["DRS"],
        })
      )
    ).toBe(false);
  });
});

describe("date operators", () => {
  // sarah.acatDate = "2026-04-10"
  it("on", () => {
    expect(
      evaluateRule(sarah, rule({ field: "acatDate", operator: "on", value: "2026-04-10" }))
    ).toBe(true);
    expect(
      evaluateRule(sarah, rule({ field: "acatDate", operator: "on", value: "2026-04-11" }))
    ).toBe(false);
  });

  it("before", () => {
    expect(
      evaluateRule(sarah, rule({ field: "acatDate", operator: "before", value: "2026-04-11" }))
    ).toBe(true);
    expect(
      evaluateRule(sarah, rule({ field: "acatDate", operator: "before", value: "2026-04-10" }))
    ).toBe(false);
  });

  it("after", () => {
    expect(
      evaluateRule(sarah, rule({ field: "acatDate", operator: "after", value: "2026-04-09" }))
    ).toBe(true);
    expect(
      evaluateRule(sarah, rule({ field: "acatDate", operator: "after", value: "2026-04-10" }))
    ).toBe(false);
  });

  it("between is inclusive and tolerant of swapped operands", () => {
    expect(
      evaluateRule(
        sarah,
        rule({ field: "acatDate", operator: "between", value: "2026-04-10", value2: "2026-04-15" })
      )
    ).toBe(true);
    expect(
      evaluateRule(
        sarah,
        rule({ field: "acatDate", operator: "between", value: "2026-04-15", value2: "2026-04-10" })
      )
    ).toBe(true);
    expect(
      evaluateRule(
        sarah,
        rule({ field: "acatDate", operator: "between", value: "2026-04-11", value2: "2026-04-15" })
      )
    ).toBe(false);
  });

  it("returns false when the record has no value to compare", () => {
    // ticket: completedDate was dropped. reconCompletedAt is the new
    // auto-managed timestamp; it's null/undefined on the test fixture.
    expect(
      evaluateRule(sarah, rule({ field: "reconCompletedAt", operator: "on", value: "2026-04-10" }))
    ).toBe(false);
  });

  it("filters by residual follow-up date", () => {
    const residual: AcatRecord = {
      ...sarah,
      residualFollowUpDate: "2026-09-15",
    };
    expect(
      evaluateRule(
        residual,
        rule({
          field: "residualFollowUpDate",
          operator: "on",
          value: "2026-09-15",
        })
      )
    ).toBe(true);
  });
});

describe("boolean operators", () => {
  it("filters records that require residual monitoring", () => {
    const monitored: AcatRecord = {
      ...sarah,
      residualMonitoringRequired: true,
    };
    expect(
      evaluateRule(
        monitored,
        rule({
          field: "residualMonitoringRequired",
          operator: "is_true",
        })
      )
    ).toBe(true);
    expect(
      evaluateRule(
        monitored,
        rule({
          field: "residualMonitoringRequired",
          operator: "is_false",
        })
      )
    ).toBe(false);
  });
});

describe("number operators", () => {
  it("eq / neq / gt / lt", () => {
    expect(
      evaluateRule(sarah, rule({ field: "statementAmount", operator: "eq", value: "26800000" }))
    ).toBe(true);
    expect(
      evaluateRule(sarah, rule({ field: "statementAmount", operator: "neq", value: "26800000" }))
    ).toBe(false);
    expect(
      evaluateRule(michael, rule({ field: "statementAmount", operator: "gt", value: "30000000" }))
    ).toBe(true);
    expect(
      evaluateRule(sarah, rule({ field: "statementAmount", operator: "lt", value: "30000000" }))
    ).toBe(true);
  });

  it("between_num is inclusive and tolerant of swapped operands", () => {
    expect(
      evaluateRule(
        sarah,
        rule({ field: "statementAmount", operator: "between_num", value: "20000000", value2: "30000000" })
      )
    ).toBe(true);
    expect(
      evaluateRule(
        sarah,
        rule({ field: "statementAmount", operator: "between_num", value: "30000000", value2: "20000000" })
      )
    ).toBe(true);
    expect(
      evaluateRule(
        michael,
        rule({ field: "statementAmount", operator: "between_num", value: "20000000", value2: "30000000" })
      )
    ).toBe(false);
  });
});

describe("multiselect operators", () => {
  const multi: AcatRecord = { ...sarah, methodRequested: "API, Full Docusign" };

  it("contains_any matches when any needle is present", () => {
    expect(
      evaluateRule(multi, rule({ field: "methodRequested", operator: "contains_any", values: ["API"] }))
    ).toBe(true);
    expect(
      evaluateRule(multi, rule({ field: "methodRequested", operator: "contains_any", values: ["N/A"] }))
    ).toBe(false);
  });

  it("contains_all requires every needle", () => {
    expect(
      evaluateRule(
        multi,
        rule({
          field: "methodRequested",
          operator: "contains_all",
          values: ["API", "Full Docusign"],
        })
      )
    ).toBe(true);
    expect(
      evaluateRule(
        multi,
        rule({
          field: "methodRequested",
          operator: "contains_all",
          values: ["API", "N/A"],
        })
      )
    ).toBe(false);
  });

  it("empty needles match every record", () => {
    expect(
      evaluateRule(
        multi,
        rule({ field: "methodRequested", operator: "contains_any", values: [] })
      )
    ).toBe(true);
  });
});

describe("applyFilters", () => {
  it("returns the input when there are no rules", () => {
    expect(applyFilters(mockAcats, [])).toBe(mockAcats);
  });

  it("AND-joins multiple rules", () => {
    const out = applyFilters(mockAcats, [
      rule({ field: "direction", operator: "is_one_of", values: ["In"] }),
      rule({ field: "statementAmount", operator: "gt", value: "30000000" }),
    ]);
    const ids = out.map((a) => a.id);
    expect(ids).toContain(michael.id);
    expect(ids).not.toContain(sarah.id);
    expect(ids).not.toContain(linda.id);
  });

  it("matches against derived fields like daysOpen", () => {
    const before = applyFilters(mockAcats, [
      rule({ field: "daysOpen", operator: "gt", value: "0" }),
    ]);
    expect(before.length).toBeGreaterThan(0);
  });

  it("invalid field is treated as a no-op", () => {
    const out = applyFilters(mockAcats, [
      rule({
        field: "nonExistent" as unknown as FilterRule["field"],
        operator: "contains",
        value: "x",
      }),
    ]);
    expect(out).toEqual(mockAcats);
  });
});

describe("generateRuleId", () => {
  it("generates unique-ish ids", () => {
    const a = generateRuleId();
    const b = generateRuleId();
    expect(a).not.toBe(b);
    expect(a.startsWith("rule_")).toBe(true);
  });
});
