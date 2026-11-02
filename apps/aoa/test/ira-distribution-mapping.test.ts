import { describe, expect, it } from "vitest";
import { IRA_DISTRIBUTION_SPEC } from "@/lib/forms/ira-distribution-spec";
import { isDefinitionEligibleForAccountType } from "@/lib/forms/form-definition";
import { parseMappedDraft } from "@/lib/forms/mapped-form-validation";
import { ACCOUNT, OWNER, draft, render, verifyAllMappedInputsRender, verifySourceTemplate, verifyUnknownFieldsBlank } from "./helpers/mapped-pdf";

describe("IRA Distribution Request mapping", () => {
  it("pins all original pages and native fields", async () => {
    await verifySourceTemplate(IRA_DISTRIBUTION_SPEC);
  });

  it("accepts a SEP IRA and excludes a Roth IRA", () => {
    expect(isDefinitionEligibleForAccountType(IRA_DISTRIBUTION_SPEC.definition, "Roth IRA")).toBe(false);
    expect(isDefinitionEligibleForAccountType(IRA_DISTRIBUTION_SPEC.definition, "SEP IRA")).toBe(true);
  });

  it("keeps every unknown text value, election and signature blank", async () => {
    await verifyUnknownFieldsBlank(IRA_DISTRIBUTION_SPEC, "Full Legal Name", "Account No");
  });

  it("places a partial former-spouse entry only in that section and leaves its unknown values blank", async () => {
    const form = (await render(IRA_DISTRIBUTION_SPEC, { recipientName: "Alex Example", recipientRelationship: "Former spouse", accountType: "traditional", oneTimeAmount: "1250.50", distributionMethod: "one_time" })).getForm();
    expect(form.getTextField("Full Legal Name").getText()).toBe(OWNER);
    expect(form.getTextField("Full Legal Name_2").getText()).toBe("Alex Example");
    expect(form.getTextField("Relationship").getText()).toBe("Former spouse");
    for (const name of ["Account No_2", "SSNITINTax ID Required by the IRS_2", "Date of Birth Optional_2", "Withhold", "Text46", "Text47", "Text48", "Text49", "Text50"]) expect(form.getTextField(name).getText() ?? "").toBe("");
    expect(form.getTextField("PAYMENT IN THE AMOUNT OF").getText()).toBe("1250.50");
    expect(form.getCheckBox("Check Box75").isChecked()).toBe(true);
    expect(form.getCheckBox("Check Box76").isChecked()).toBe(false);
    expect(form.getCheckBox("Check Box77").isChecked()).toBe(false);
    for (const name of ["Check Box4", "Check Box5", "Check Box6", "Check Box7", "Check Box14"]) expect(form.getCheckBox(name).isChecked()).toBe(false);
  });

  it("rejects last-four-only information when a full tax ID is supplied", () => {
    expect(parseMappedDraft(IRA_DISTRIBUTION_SPEC, { fields: { accountHolderTaxId: "0001" }, confirmAccount: true }, ACCOUNT, OWNER).ok).toBe(false);
  });

  it("allows unfinished instructions but rejects contradictions and distinguishes scheduling from birth dates", () => {
    expect(draft(IRA_DISTRIBUTION_SPEC, { oneTimeAmount: "100" }).fields.distributionMethod).toBe("");
    expect(parseMappedDraft(IRA_DISTRIBUTION_SPEC, { fields: { oneTimeAmount: "100", distributionMethod: "scheduled" }, confirmAccount: true }, ACCOUNT, OWNER).ok).toBe(false);
    expect(parseMappedDraft(IRA_DISTRIBUTION_SPEC, { fields: { scheduledAmount: "100", distributionMethod: "one_time" }, confirmAccount: true }, ACCOUNT, OWNER).ok).toBe(false);
    expect(draft(IRA_DISTRIBUTION_SPEC, { scheduledBeginningDate: "01/01/2199", distributionMethod: "scheduled" }).fields.scheduledBeginningDate).toBe("01/01/2199");
    expect(parseMappedDraft(IRA_DISTRIBUTION_SPEC, { fields: { accountHolderDateOfBirth: "01/01/2199" }, confirmAccount: true }, ACCOUNT, OWNER).ok).toBe(false);
  });

  it("renders every mapped input with synthetic data without truncation", async () => {
    await verifyAllMappedInputsRender(IRA_DISTRIBUTION_SPEC, "Full Legal Name");
  });
});
