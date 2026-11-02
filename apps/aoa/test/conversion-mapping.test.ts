import { describe, expect, it } from "vitest";
import { CONVERSION_SPEC } from "@/lib/forms/conversion-spec";
import { isDefinitionEligibleForAccountType } from "@/lib/forms/form-definition";
import { parseMappedDraft } from "@/lib/forms/mapped-form-validation";
import { ACCOUNT, OWNER, draft, render, verifyAllMappedInputsRender, verifySourceTemplate, verifyUnknownFieldsBlank } from "./helpers/mapped-pdf";

describe("Direct Conversion Request mapping", () => {
  it("pins all original pages and native fields", async () => {
    await verifySourceTemplate(CONVERSION_SPEC);
  });

  it("selects the receiving Roth account rather than the delivering Traditional IRA", () => {
    expect(isDefinitionEligibleForAccountType(CONVERSION_SPEC.definition, "Roth IRA")).toBe(true);
    expect(isDefinitionEligibleForAccountType(CONVERSION_SPEC.definition, "Traditional IRA")).toBe(false);
  });

  it("keeps every unknown text value, election and signature blank", async () => {
    await verifyUnknownFieldsBlank(CONVERSION_SPEC, "Full Legal Name", "Receiving Roth IRA Account No");
  });

  it("keeps receiving Roth, delivering IRA, custodian roles, cash amount and tax elections distinct", async () => {
    const form = (await render(CONVERSION_SPEC, {
      deliveringAccountNumber: "BCEMH-51709", receivingCustodianName: "Receiving Custodian Sample",
      deliveringCustodianName: "Delivering Custodian Sample", accountHolderDateOfBirth: "01021970",
      deliveringAccountType: "traditional", conversionInstruction: "partial_cash", conversionCashAmount: "$6,500.25",
    })).getForm();
    expect(form.getTextField("Receiving Roth IRA Account No").getText()).toBe(ACCOUNT);
    expect(form.getTextField("Delivering TradSIMPLE Account No").getText()).toBe("BCEMH-51709");
    expect(form.getTextField("TrusteeCustodian Name").getText()).toBe("Receiving Custodian Sample");
    expect(form.getTextField("TrusteeCustodian Name_2").getText()).toBe("Delivering Custodian Sample");
    expect(form.getTextField("Date of Birth Optional").getText()).toBe("01/02/1970");
    expect(form.getTextField("undefined_10").getText()).toBe("6500.25");
    expect(form.getTextField("CASH AMOUNT").getText() ?? "").toBe("");
    expect(form.getCheckBox("Check Box88").isChecked()).toBe(true);
    expect(form.getCheckBox("Check Box89").isChecked()).toBe(false);
    expect(form.getCheckBox("undefined_7").isChecked()).toBe(true);
    for (const name of ["undefined_5", "undefined_6", "undefined_8", "undefined_9", "Check Box85", "Check Box86", "Check Box87"]) expect(form.getCheckBox(name).isChecked()).toBe(false);
    for (const name of ["must be 0 100", "gnature", "an", "Date mmddyyyy", "Date mmddyyyy_2"]) expect(form.getTextField(name).getText() ?? "").toBe("");
  });

  it("refuses a supplied receiving-account override", () => {
    expect(parseMappedDraft(CONVERSION_SPEC, { fields: { receivingAccountNumber: "BCEMH-51709" }, confirmAccount: true }, ACCOUNT, OWNER).ok).toBe(false);
  });

  it("allows an unfinished instruction but rejects cash contradicting an explicit securities-only election", () => {
    expect(draft(CONVERSION_SPEC, { conversionCashAmount: "100" }).fields.conversionInstruction).toBe("");
    expect(parseMappedDraft(CONVERSION_SPEC, { fields: { conversionCashAmount: "100", conversionInstruction: "partial_securities" }, confirmAccount: true }, ACCOUNT, OWNER).ok).toBe(false);
  });

  it("renders every mapped input with synthetic data without truncation", async () => {
    await verifyAllMappedInputsRender(CONVERSION_SPEC, "Full Legal Name");
  });
});
