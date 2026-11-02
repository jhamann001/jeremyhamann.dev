import { expect, test } from "@playwright/test";
import { FORM_FIXTURE } from "./forms-fixture";
import { blockExternalRequests, openForm, downloadPdf, verifyDraft } from "./mapped-form-browser-helpers";

test.beforeEach(async ({ context }) => blockExternalRequests(context));

test("ACH uses the selected segmented Apex account and only supplied bank details", async ({ page }, testInfo) => {
  await openForm(page, FORM_FIXTURE.other.id, "Prepare Form: ACH Agreement");
  await page.getByLabel("Apex account to link", { exact: true }).selectOption(FORM_FIXTURE.taxableAccount.id);
  await expect(page.getByLabel("Primary account owner name", { exact: true })).toHaveValue("Morgan Example");
  await expect(page.getByLabel("Bank account type", { exact: true })).toHaveValue("");
  await page.getByLabel("Bank name", { exact: true }).fill("Example Bank");
  await page.getByLabel("Bank account number", { exact: true }).fill("0000123456");
  await page.getByLabel("Primary owner street address", { exact: true }).fill("100 Example Lane");
  await page.getByRole("checkbox").check();
  const { pdf } = await downloadPdf(page, testInfo, "FICTIONAL-partial-ACH.pdf");
  verifyDraft(pdf, 1, {
    "Branch 1": "S", "Branch 2": "Y", "Branch 3": "N", "Digit 1": "0", "Digit 2": "0", "Digit 3": "0", "Digit 4": "0", "Digit 5": "4",
    "PRIMARY ACCOUNT OWNER NAME": "Morgan Example", "Name of Bank": "Example Bank", "Bank Account No": "0000123456", ADDRESS: "100 Example Lane",
  });
});
