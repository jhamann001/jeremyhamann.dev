/**
 * The supervisory review checklist.
 *
 * Small, but the assertions are the ones that matter for a control whose whole value is that the
 * recorded keys mean the same thing a year later: the key list is stable and complete, every key has
 * a label and a detail, and nothing a browser sends can put a value in the ledger that the code
 * cannot explain.
 */
import { describe, expect, it } from "vitest";
import {
  isReviewChecklistKey,
  normalizeChecklist,
  REVIEW_CHECKLIST,
  REVIEW_CHECKLIST_KEYS,
  REVIEW_CHECKLIST_LABELS,
} from "@/lib/review-checklist";

describe("REVIEW_CHECKLIST", () => {
  it("is the five points, in a fixed order, with no duplicates", () => {
    expect([...REVIEW_CHECKLIST_KEYS]).toEqual([
      "DISCLAIMER",
      "NO_UNAPPROVED_CLAIM",
      "NO_UNREDACTED_PII",
      "ACCURATE",
      "ESCALATION_HANDLED",
    ]);
    expect(new Set(REVIEW_CHECKLIST_KEYS).size).toBe(REVIEW_CHECKLIST_KEYS.length);
  });

  it("every key has a non-empty label and detail, and the items match the key list exactly", () => {
    expect(REVIEW_CHECKLIST.map((i) => i.key)).toEqual([...REVIEW_CHECKLIST_KEYS]);
    for (const item of REVIEW_CHECKLIST) {
      expect(item.label.length, item.key).toBeGreaterThan(0);
      expect(item.detail.length, item.key).toBeGreaterThan(10);
      expect(REVIEW_CHECKLIST_LABELS[item.key]).toBe(item.label);
    }
  });

  it("labels are short enough to read down a phone sheet", () => {
    for (const item of REVIEW_CHECKLIST) expect(item.label.length, item.key).toBeLessThanOrEqual(40);
  });
});

describe("normalizeChecklist", () => {
  it("restores the canonical order and deduplicates", () => {
    expect(normalizeChecklist(["ACCURATE", "DISCLAIMER", "ACCURATE"])).toEqual(["DISCLAIMER", "ACCURATE"]);
  });

  it("drops anything it cannot explain, silently (I12)", () => {
    expect(normalizeChecklist(["DISCLAIMER", "NOT_A_KEY", 7, null, undefined, {}])).toEqual(["DISCLAIMER"]);
    expect(normalizeChecklist("DISCLAIMER")).toEqual([]);
    expect(normalizeChecklist(undefined)).toEqual([]);
    expect(normalizeChecklist(null)).toEqual([]);
    expect(normalizeChecklist({ 0: "DISCLAIMER" })).toEqual([]);
  });

  it("accepts every key it declares", () => {
    expect(normalizeChecklist([...REVIEW_CHECKLIST_KEYS])).toEqual([...REVIEW_CHECKLIST_KEYS]);
  });

  it("is case-sensitive — a lower-cased key is not a key", () => {
    expect(isReviewChecklistKey("DISCLAIMER")).toBe(true);
    expect(isReviewChecklistKey("disclaimer")).toBe(false);
    expect(isReviewChecklistKey(" DISCLAIMER ")).toBe(false);
  });
});
