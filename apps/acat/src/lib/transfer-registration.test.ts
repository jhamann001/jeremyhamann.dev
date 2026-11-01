import { describe, expect, it } from "vitest";
import { receivingRegistrationSchema, suggestedReceivingRegistration } from "./transfer-registration";
import { confirmReceivingTitleSchema } from "./transfer-form-contract";

describe("receiving registration choices", () => {
  it.each(["Individual", "Traditional IRA", "Roth IRA", "SEP IRA", "SIMPLE IRA", "Trust",
    "Joint tenants with rights of survivorship", "Joint tenants in common", "Community Property",
    "Inherited Traditional IRA", "Inherited Roth IRA"])("accepts canonical new confirmation: %s", (registration) => {
    expect(confirmReceivingTitleSchema.safeParse({ expectedRevision: "a".repeat(64),
      operationId: "2a076e5e-c974-4421-80cb-320a36b40cf5", title: "Synthetic Client", registration, confirmed: true }).success).toBe(true);
  });
  it.each([
    ["Brokerage / Individual", "Individual"], ["Individual Brokerage", "Individual"],
    ["Joint Account (JTWROS - Rights of Survivorship)", "Joint tenants with rights of survivorship"],
    ["Joint Account (TIC - Tenants in Common)", "Joint tenants in common"],
    ["JT WROS", "Joint tenants with rights of survivorship"], ["JTWROS", "Joint tenants with rights of survivorship"],
    ["JT TIC", "Joint tenants in common"], ["TIC", "Joint tenants in common"],
    ["Community Property Registration", "Community Property"],
    ["Inherited Traditional IRA (w/ beneficiaries)", "Inherited Traditional IRA"],
  ])("recognizes existing %s without allowing it as a new noncanonical save", (oldValue, canonical) => {
    expect(suggestedReceivingRegistration(oldValue)).toBe(canonical);
    expect(receivingRegistrationSchema.safeParse(oldValue).success).toBe(false);
  });
  it("suggests known labels across case/outer whitespace without weakening strict new writes", () => {
    expect(suggestedReceivingRegistration("  rOtH iRa  ")).toBe("Roth IRA");
    expect(suggestedReceivingRegistration("  jtwros  ")).toBe("Joint tenants with rights of survivorship");
    expect(receivingRegistrationSchema.safeParse("  rOtH iRa  ").success).toBe(false);
  });
  it.each([undefined, null, "", "IRA", "Joint", "Inherited IRA", "Other", "Individul", "Synthetic Test Client - 3",
    "constructor", "__proto__", "toString"])("does not guess or inherit a mapping for %s", (value) => {
    expect(suggestedReceivingRegistration(value)).toBe("");
    expect(receivingRegistrationSchema.safeParse(value).success).toBe(false);
  });
});
