import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CRM_DUPLICATE_EVIDENCE_CODES,
  CRM_DUPLICATE_HARD_CONFLICT_CODES,
  buildCrmDuplicateLearningSummary,
  isExactAccountDuplicateSignal,
  isCrmContactIdentityOverrideEligible,
  normalizeCrmDuplicateEntityType,
  normalizeCrmDuplicateView,
  normalizeCrmContactId,
  normalizeCrmHouseholdId,
} from "@/lib/data/crm-duplicate-review";

describe("CRM duplicate review contracts", () => {
  it("accepts only the five bounded CRM Explorer review views", () => {
    expect(normalizeCrmDuplicateView("potential")).toBe("potential");
    expect(normalizeCrmDuplicateView("snoozed")).toBe("snoozed");
    expect(normalizeCrmDuplicateView("not_duplicate")).toBe("not_duplicate");
    expect(normalizeCrmDuplicateView("confirmed")).toBe("confirmed");
    expect(normalizeCrmDuplicateView("all")).toBe("all");
    expect(normalizeCrmDuplicateView("merged")).toBeNull();
    expect(normalizeCrmDuplicateView(undefined)).toBeNull();
  });

  it("accepts only duplicate entity types supported by the review queue", () => {
    expect(normalizeCrmDuplicateEntityType("HOUSEHOLD")).toBe("HOUSEHOLD");
    expect(normalizeCrmDuplicateEntityType("CONTACT")).toBe("CONTACT");
    expect(normalizeCrmDuplicateEntityType("ACCOUNT")).toBe("ACCOUNT");
    expect(normalizeCrmDuplicateEntityType("DEAL")).toBeNull();
    expect(normalizeCrmDuplicateEntityType(undefined)).toBeNull();
  });

  it("keeps early suggestions advisory until comparable human decisions accumulate", () => {
    expect(buildCrmDuplicateLearningSummary({
      evidenceCodes: ["SHARED_CEDAR_RIDGE_USER_ID"],
      hardConflictCodes: [],
      similarConfirmed: 0,
      similarRejected: 0,
    })).toMatchObject({
      recommendation: "CONFIRM_DUPLICATE",
      confidence: "EARLY",
      similarReviewed: 0,
    });
    expect(buildCrmDuplicateLearningSummary({
      evidenceCodes: ["SHARED_CEDAR_RIDGE_USER_ID"],
      hardConflictCodes: [],
      similarConfirmed: 4,
      similarRejected: 1,
    })).toMatchObject({ recommendation: "CONFIRM_DUPLICATE", confidence: "HIGH" });
    expect(buildCrmDuplicateLearningSummary({
      evidenceCodes: ["SHARED_CEDAR_RIDGE_USER_ID"],
      hardConflictCodes: [],
      similarConfirmed: 1,
      similarRejected: 4,
    })).toMatchObject({ recommendation: "KEEP_SEPARATE", confidence: "HIGH" });
  });

  it("lets hard conflicts override historical suggestions", () => {
    expect(buildCrmDuplicateLearningSummary({
      evidenceCodes: ["SHARED_CEDAR_RIDGE_USER_ID"],
      hardConflictCodes: ["CONFLICTING_MEMBER_IDENTITY"],
      similarConfirmed: 10,
      similarRejected: 0,
    })).toMatchObject({ recommendation: "REVIEW_MANUALLY", confidence: "BLOCKED" });
  });

  it("allows an override only for one same-household contact identity warning", () => {
    expect(isCrmContactIdentityOverrideEligible({
      entityType: "CONTACT",
      evidenceCodes: ["EXACT_NORMALIZED_CONTACT_NAME", "SAME_CANONICAL_HOUSEHOLD"],
      hardConflictCodes: ["CONFLICTING_CONTACT_IDENTITY"],
      operatorFlagged: false,
    })).toBe(true);
    expect(isCrmContactIdentityOverrideEligible({
      entityType: "CONTACT",
      evidenceCodes: ["OPERATOR_SUBMITTED", "SAME_CANONICAL_HOUSEHOLD"],
      hardConflictCodes: ["CONFLICTING_CONTACT_IDENTITY"],
      operatorFlagged: true,
    })).toBe(true);
    expect(isCrmContactIdentityOverrideEligible({
      entityType: "CONTACT",
      evidenceCodes: ["OPERATOR_SUBMITTED", "SAME_CANONICAL_HOUSEHOLD"],
      hardConflictCodes: ["CONFLICTING_CONTACT_IDENTITY"],
      operatorFlagged: false,
    })).toBe(false);
    expect(isCrmContactIdentityOverrideEligible({
      entityType: "HOUSEHOLD",
      evidenceCodes: ["EXACT_NORMALIZED_CONTACT_NAME", "SAME_CANONICAL_HOUSEHOLD"],
      hardConflictCodes: ["CONFLICTING_CONTACT_IDENTITY"],
      operatorFlagged: false,
    })).toBe(false);
    expect(isCrmContactIdentityOverrideEligible({
      entityType: "CONTACT",
      evidenceCodes: ["EXACT_NORMALIZED_CONTACT_NAME", "SAME_CANONICAL_HOUSEHOLD"],
      hardConflictCodes: ["CONFLICTING_CONTACT_IDENTITY", "SOURCE_TYPE_MISMATCH"],
      operatorFlagged: false,
    })).toBe(false);
  });

  it("keeps household-name and shell signals in manual review", () => {
    expect(buildCrmDuplicateLearningSummary({
      evidenceCodes: [
        "EXACT_NORMALIZED_HOUSEHOLD_NAME",
        "SAME_ADVISOR_AND_STAGE",
        "EMPTY_SHELL_WITH_POPULATED_MATCH",
      ],
      hardConflictCodes: [],
      similarConfirmed: 0,
      similarRejected: 0,
    })).toMatchObject({
      recommendation: "REVIEW_MANUALLY",
      confidence: "EARLY",
      similarReviewed: 0,
    });
  });

  it("keeps Operations-submitted pairs in manual review", () => {
    expect(buildCrmDuplicateLearningSummary({
      evidenceCodes: ["OPERATOR_SUBMITTED"],
      hardConflictCodes: [],
      similarConfirmed: 0,
      similarRejected: 0,
    })).toMatchObject({
      recommendation: "REVIEW_MANUALLY",
      confidence: "EARLY",
      similarReviewed: 0,
    });
  });

  it("accepts only 15- or 18-character CRM household IDs", () => {
    expect(normalizeCrmHouseholdId(" 001J1235589jlVHIAY ")).toBe("001J1235589jlVHIAY");
    expect(normalizeCrmHouseholdId("001Gl29857YKa5g")).toBe("001Gl29857YKa5g");
    expect(normalizeCrmHouseholdId("001-not-a-salesforce-id")).toBeNull();
    expect(normalizeCrmHouseholdId(undefined)).toBeNull();
  });

  it("accepts only 003-prefixed CRM contact IDs", () => {
    expect(normalizeCrmContactId(" 003Q1572387QNovIAG ")).toBe("003Q1572387QNovIAG");
    expect(normalizeCrmContactId("003Sk61874AN1yo")).toBe("003Sk61874AN1yo");
    expect(normalizeCrmContactId("001J1235589jlVHIAY")).toBeNull();
    expect(normalizeCrmContactId("003-not-a-salesforce-id")).toBeNull();
    expect(normalizeCrmContactId(undefined)).toBeNull();
  });

  it("keeps evidence and hard-conflict vocabularies controlled", () => {
    expect(CRM_DUPLICATE_EVIDENCE_CODES).toEqual([
      "SOURCE_MERGE_REPLACEMENT",
      "SHARED_CEDAR_RIDGE_USER_ID",
      "EXACT_CUSTODIAN_IDENTITY",
      "OFFICIAL_ACCOUNT_REPLACEMENT",
      "EXACT_NORMALIZED_HOUSEHOLD_NAME",
      "SAME_ADVISOR_AND_STAGE",
      "EMPTY_SHELL_WITH_POPULATED_MATCH",
      "EXACT_NORMALIZED_CONTACT_NAME",
      "SAME_CANONICAL_HOUSEHOLD",
      "SOURCE_CONTACT_DATA_CONCENTRATED",
      "OPERATOR_SUBMITTED",
    ]);
    expect(CRM_DUPLICATE_HARD_CONFLICT_CODES).toEqual([
      "CONFLICTING_MEMBER_IDENTITY",
      "DISTINCT_CUSTODIAN_IDENTITIES",
      "SOURCE_TYPE_MISMATCH",
      "CONFLICTING_CONTACT_IDENTITY",
    ]);
  });

  it("never treats distinct Companion and main custodial IDs as duplicates", () => {
    expect(isExactAccountDuplicateSignal({
      leftCustodianId: "APEX-COMPANION-01",
      rightCustodianId: "APEX-BROKERAGE-01",
      officialReplacement: false,
    })).toBe(false);
    expect(isExactAccountDuplicateSignal({
      leftCustodianId: "APEX-SAME-01",
      rightCustodianId: "APEX-SAME-01",
      officialReplacement: false,
    })).toBe(true);
    expect(isExactAccountDuplicateSignal({
      leftCustodianId: "OLD-01",
      rightCustodianId: "NEW-01",
      officialReplacement: true,
    })).toBe(true);
    expect(isExactAccountDuplicateSignal({
      leftCustodianId: null,
      rightCustodianId: "NEW-01",
      officialReplacement: true,
    })).toBe(false);
  });
});
