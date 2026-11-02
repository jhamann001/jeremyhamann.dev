import { expect, test } from "@playwright/test";
import { FORM_FIXTURE } from "./forms-fixture";
import { blockExternalRequests, openForm, expand, generateResponse, downloadPdf, verifyDraft } from "./mapped-form-browser-helpers";

test.beforeEach(async ({ context }) => blockExternalRequests(context));

test("conversion uses receiving Roth, rejects a partial supplied tax ID and allows it to remain blank", async ({ page }, testInfo) => {
  await openForm(page, FORM_FIXTURE.owner.id, "Prepare Form: Direct Conversion Request");
  await expect(page.getByLabel("Receiving Roth IRA account", { exact: true })).toHaveValue(FORM_FIXTURE.secondAccount.id);
  await expect(page.getByLabel("Current IRA account type, if confirmed", { exact: true })).toHaveValue("");
  await page.getByLabel("Delivering Traditional / SIMPLE IRA account number", { exact: true }).fill("ZPGXB-74842");
  const instructions = await expand(page, "Confirmed Conversion Instructions");
  await expect(instructions.getByLabel("Conversion instruction", { exact: true })).toHaveValue("");
  await instructions.getByLabel("Cash amount to convert", { exact: true }).fill("6500");
  const taxId = page.getByLabel("Roth IRA holder SSN / ITIN / tax ID", { exact: true });
  await taxId.fill("1234");
  await page.getByRole("checkbox").check();
  const failed = generateResponse(page);
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  expect((await failed).status()).toBe(422);
  await expect(taxId).toHaveAttribute("aria-invalid", "true");
  await taxId.fill("");
  const { pdf } = await downloadPdf(page, testInfo, "FICTIONAL-partial-conversion.pdf");
  verifyDraft(pdf, 5, { "Full Legal Name": "Jordan Sample", "Receiving Roth IRA Account No": "SYNTH-0002", "Delivering TradSIMPLE Account No": "ZPGXB-74842", undefined_10: "6500" });
  await page.getByRole("heading", { name: "Direct Conversion Request", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("synthetic-mapped-conversion.png"), fullPage: true });
});

test("conversion API rejects selecting a non-Roth receiving account", async ({ page }) => {
  await openForm(page, FORM_FIXTURE.owner.id, "Prepare Form: Direct Conversion Request");
  const wrongConversion = await page.request.post("/api/forms/generate", { data: { formId: "direct_conversion_request", clientId: FORM_FIXTURE.owner.id, accountIds: [FORM_FIXTURE.firstAccount.id], values: { fields: {}, confirmAccount: true } } });
  expect(wrongConversion.status()).toBe(422);
  for (const response of [wrongConversion]) {
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
});
