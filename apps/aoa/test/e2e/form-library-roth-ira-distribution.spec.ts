import { expect, test } from "@playwright/test";
import { FORM_FIXTURE } from "./forms-fixture";
import { blockExternalRequests, openForm, expand, downloadPdf, verifyDraft } from "./mapped-form-browser-helpers";

test.beforeEach(async ({ context }) => blockExternalRequests(context));

test("Roth distribution normalizes known dates and phones while leaving tax ID and elections blank", async ({ page }, testInfo) => {
  await openForm(page, FORM_FIXTURE.owner.id, "Prepare Form: Roth IRA Distribution Request");
  await expect(page.getByLabel("Distributing Roth IRA account", { exact: true })).toHaveValue(FORM_FIXTURE.secondAccount.id);
  const dob = page.getByLabel("Account holder date of birth", { exact: true });
  await dob.fill("01021970");
  await dob.blur();
  await expect(dob).toHaveValue("01/02/1970");
  const phone = page.getByLabel("Account holder phone", { exact: true });
  await phone.fill("2025550100");
  await phone.blur();
  await expect(phone).toHaveValue("202-555-0100");
  await expect(page.getByLabel("Account holder tax ID — last 4 digits", { exact: true })).toHaveValue("");
  await (await expand(page, "Beneficiary or Former Spouse, Only When Applicable")).getByLabel("Relationship", { exact: true }).fill("Child");
  await expect((await expand(page, "Confirmed Distribution Details")).getByLabel("Distribution method", { exact: true })).toHaveValue("");
  await page.getByRole("checkbox").check();
  const { pdf } = await downloadPdf(page, testInfo, "FICTIONAL-partial-Roth-distribution.pdf");
  verifyDraft(pdf, 7, { "Full Legal Name": "Jordan Sample", "Account No": "SYNTH-0002", "Date of Birth Optional": "01/02/1970", "Phone Number Optional": "202-555-0100", Relationship: "Child" });
});

test("Roth distribution API rejects a full tax ID in a last-four-only field", async ({ page }) => {
  await openForm(page, FORM_FIXTURE.owner.id, "Prepare Form: Roth IRA Distribution Request");
  const fullRothId = await page.request.post("/api/forms/generate", { data: { formId: "roth_ira_distribution_request", clientId: FORM_FIXTURE.owner.id, accountIds: [FORM_FIXTURE.secondAccount.id], values: { fields: { accountHolderTaxId: "900000001" }, confirmAccount: true } } });
  expect(fullRothId.status()).toBe(422);
  for (const response of [fullRothId]) {
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
});
