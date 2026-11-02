import { describe, expect, it } from "vitest";
import { ROTH_DISTRIBUTION_SPEC } from "@/lib/forms/roth-distribution-spec";
import { isDefinitionEligibleForAccountType } from "@/lib/forms/form-definition";
import { parseMappedDraft } from "@/lib/forms/mapped-form-validation";
import { ACCOUNT, OWNER, draft, render, verifyAllMappedInputsRender, verifySourceTemplate, verifyUnknownFieldsBlank } from "./helpers/mapped-pdf";

describe("Roth IRA Distribution Request mapping", () => {
  it("pins all original pages and native fields", async () => {
    await verifySourceTemplate(ROTH_DISTRIBUTION_SPEC);
  });

  it("accepts a Roth IRA and excludes a Traditional IRA", () => {
    expect(isDefinitionEligibleForAccountType(ROTH_DISTRIBUTION_SPEC.definition, "Roth IRA")).toBe(true);
    expect(isDefinitionEligibleForAccountType(ROTH_DISTRIBUTION_SPEC.definition, "Traditional IRA")).toBe(false);
  });

  it("keeps every unknown text value, election and signature blank", async () => {
    await verifyUnknownFieldsBlank(ROTH_DISTRIBUTION_SPEC, "Full Legal Name", "Account No");
  });

  it("maps Roth last-four IDs, native owner DOB and distinct delivery fields without selecting a route", async () => {
    const form = (await render(ROTH_DISTRIBUTION_SPEC, {
      accountHolderTaxId: "0001", recipientTaxId: "0002", accountHolderDateOfBirth: "03041970", accountHolderPhone: "2025550100",
      alternateAddress: "10 Sample St", wireBankAddress: "20 Example St", wireAccountNumber: "1234567890", journalAccountNumber: "VJCNM-79860",
      scheduledAmount: "500", scheduledBeginningDate: "10012026", distributionMethod: "scheduled",
    })).getForm();
    expect(form.getTextField("SSNITINTax ID Required by the IRS").getText()).toBe("0001");
    expect(form.getTextField("SSNITINTax ID Required by the IRS_2").getText()).toBe("0002");
    expect(form.getTextField("Date of Birth Optional").getText()).toBe("03/04/1970");
    expect(form.getTextField("Date of Birth Optional_2").getText() ?? "").toBe("");
    expect(form.getTextField("Phone Number Optional").getText()).toBe("202-555-0100");
    expect(form.getTextField("ADDRESS").getText()).toBe("10 Sample St");
    expect(form.getTextField("ADDRESS_2").getText()).toBe("20 Example St");
    expect(form.getTextField("ACCT NO").getText()).toBe("1234567890");
    expect(form.getTextField("ACCOUNT NO").getText()).toBe("VJCNM-79860");
    expect(form.getTextField("Text94").getText()).toBe("500");
    expect(form.getTextField("BEGINNING DATE").getText()).toBe("10/01/2026");
    expect(form.getCheckBox("Check Box111").isChecked()).toBe(true);
    for (const name of ["Check Box110", "Check Box112", "Check Box113", "Check Box114", "Check Box115", "Check Box116", "Check Box118", "Check Box119"]) expect(form.getCheckBox(name).isChecked()).toBe(false);
    for (const name of ["der or Beneficiary Signature", "Date", "Signature", "Date_2", "Signature_2", "Date_3", "Signature_3", "Date_4"]) expect(form.getTextField(name).getText() ?? "").toBe("");
  });

  it("rejects full tax IDs for last-four-only fields", () => {
    expect(parseMappedDraft(ROTH_DISTRIBUTION_SPEC, { fields: { accountHolderTaxId: "900000001" }, confirmAccount: true }, ACCOUNT, OWNER).ok).toBe(false);
  });

  it("allows unfinished instructions but rejects contradictions and distinguishes scheduling from birth dates", () => {
    expect(draft(ROTH_DISTRIBUTION_SPEC, { oneTimeAmount: "100" }).fields.distributionMethod).toBe("");
    expect(parseMappedDraft(ROTH_DISTRIBUTION_SPEC, { fields: { oneTimeAmount: "100", distributionMethod: "scheduled" }, confirmAccount: true }, ACCOUNT, OWNER).ok).toBe(false);
    expect(parseMappedDraft(ROTH_DISTRIBUTION_SPEC, { fields: { scheduledAmount: "100", distributionMethod: "one_time" }, confirmAccount: true }, ACCOUNT, OWNER).ok).toBe(false);
    expect(draft(ROTH_DISTRIBUTION_SPEC, { scheduledBeginningDate: "01/01/2199", distributionMethod: "scheduled" }).fields.scheduledBeginningDate).toBe("01/01/2199");
    expect(parseMappedDraft(ROTH_DISTRIBUTION_SPEC, { fields: { accountHolderDateOfBirth: "01/01/2199" }, confirmAccount: true }, ACCOUNT, OWNER).ok).toBe(false);
  });

  it("renders every mapped input with synthetic data without truncation", async () => {
    await verifyAllMappedInputsRender(ROTH_DISTRIBUTION_SPEC, "Full Legal Name");
  });
});
