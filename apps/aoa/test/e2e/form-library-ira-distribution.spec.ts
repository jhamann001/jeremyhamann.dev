import { expect, test } from "@playwright/test";
import { FORM_FIXTURE } from "./forms-fixture";
import { blockExternalRequests, openForm, expand, downloadPdf, verifyDraft } from "./mapped-form-browser-helpers";

test.beforeEach(async ({ context }) => blockExternalRequests(context));

test("IRA distribution accepts an unfinished recipient and only the explicitly selected method", async ({ page }, testInfo) => {
  await openForm(page, FORM_FIXTURE.owner.id, "Prepare Form: Traditional IRA Distribution Request");
  await expect(page.getByLabel("Distributing Traditional / SEP / SIMPLE IRA", { exact: true })).toHaveValue(FORM_FIXTURE.firstAccount.id);
  await expect(page.getByLabel("Account type, if confirmed", { exact: true })).toHaveValue("");
  const recipient = await expand(page, "Beneficiary or Former Spouse, Only When Applicable");
  await recipient.getByLabel("Beneficiary / former spouse legal name", { exact: true }).fill("Alex Example");
  await recipient.getByLabel("Relationship", { exact: true }).fill("Former spouse");
  const distribution = await expand(page, "Confirmed Distribution Details");
  await expect(distribution.getByLabel("Distribution method", { exact: true })).toHaveValue("");
  await distribution.getByLabel("Distribution method", { exact: true }).selectOption("one_time");
  await distribution.getByLabel("One-time payment amount", { exact: true }).fill("1250.50");
  await page.getByRole("checkbox").check();
  const { pdf } = await downloadPdf(page, testInfo, "FICTIONAL-partial-IRA-distribution.pdf");
  verifyDraft(pdf, 14, {
    "Full Legal Name": "Jordan Sample", "Account No": "SYNTH-0001", "Full Legal Name_2": "Alex Example", Relationship: "Former spouse", "PAYMENT IN THE AMOUNT OF": "1250.50",
  }, ["Check Box75"]);
});
