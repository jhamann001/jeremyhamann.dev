import { expect, test } from "@playwright/test";
import { FORM_FIXTURE } from "./forms-fixture";
import { blockExternalRequests, openForm, expand, generateResponse, downloadPdf, verifyDraft } from "./mapped-form-browser-helpers";

test.beforeEach(async ({ context }) => blockExternalRequests(context));

test("TOD accepts partial beneficiaries without IDs or allocations and preserves independent address rows", async ({ page }, testInfo) => {
  await openForm(page, FORM_FIXTURE.other.id, "Prepare Form: Transfer on Death");
  await expect(page.getByLabel("TOD account", { exact: true })).toHaveValue(FORM_FIXTURE.taxableAccount.id);
  await expect(page.getByLabel("Primary account-holder name", { exact: true })).toHaveValue("Morgan Example");
  await expect(page.getByLabel("Designation type", { exact: true })).toHaveValue("");
  const first = await expand(page, "Primary Beneficiary 1");
  await first.getByLabel("Beneficiary name", { exact: true }).fill("Adah Sample");
  await first.getByLabel("Relationship", { exact: true }).fill("Child");
  const dob = first.getByLabel("Date of birth", { exact: true });
  await dob.fill("01021990");
  await expect(dob).toHaveValue("01021990");
  await dob.blur();
  await expect(dob).toHaveValue("01/02/1990");
  const phone = first.getByLabel("Telephone number", { exact: true });
  await phone.fill("2025550101");
  await phone.blur();
  await expect(phone).toHaveValue("202-555-0101");
  await (await expand(page, "Primary Beneficiary 3")).getByLabel("Address", { exact: true }).fill("30 Example Lane");
  await (await expand(page, "Primary Beneficiary 6")).getByLabel("Address", { exact: true }).fill("60 Sample Lane");
  const unconfirmed = generateResponse(page);
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  expect((await unconfirmed).status()).toBe(422);
  await page.getByRole("checkbox").check();
  const { pdf } = await downloadPdf(page, testInfo, "FICTIONAL-partial-TOD.pdf");
  verifyDraft(pdf, 5, {
    "Primary - Account Holder Name": "Morgan Example", "Primary - Apex Account Number": "SYN-00004",
    "Beneficiary 1 - Name": "Adah Sample", "Beneficiary 1 - Relationship": "Child",
    "Beneficiary 1 - Date of Birth": "01/02/1990", "Beneficiary 1 - Telephone Number": "202-555-0101",
    "Beneficiary 3 - Address": "30 Example Lane", "Beneficiary 6 - Address": "60 Sample Lane",
  });
  await page.getByRole("heading", { name: "Transfer on Death", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("synthetic-mapped-TOD.png"), fullPage: true });
});

test("TOD API rejects a retirement account even when it belongs to the selected client", async ({ page }) => {
  await openForm(page, FORM_FIXTURE.other.id, "Prepare Form: Transfer on Death");
  const wrongTod = await page.request.post("/api/forms/generate", { data: { formId: "apex-transfer-on-death", clientId: FORM_FIXTURE.owner.id, accountIds: [FORM_FIXTURE.firstAccount.id], values: { fields: {}, confirmAccount: true } } });
  expect(wrongTod.status()).toBe(422);
  for (const response of [wrongTod]) {
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
});
