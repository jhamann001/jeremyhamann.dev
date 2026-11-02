import { expect, test } from "@playwright/test";
import { FORM_FIXTURE } from "./forms-fixture";
import { blockExternalRequests, portrait, openForm, expand, generateResponse, downloadPdf, verifyDraft } from "./mapped-form-browser-helpers";

test.beforeEach(async ({ context }) => blockExternalRequests(context));

test("domestic wire keeps sending, receiving and ultimate-recipient accounts separate", async ({ page }, testInfo) => {
  await openForm(page, FORM_FIXTURE.owner.id, "Prepare Form: Domestic Wire Request");
  await page.getByLabel("Sending Apex account", { exact: true }).selectOption(FORM_FIXTURE.firstAccount.id);
  await page.getByLabel("Wire amount", { exact: true }).fill("$1,250.25");
  await page.getByLabel("Receiving bank name", { exact: true }).fill("Example Bank");
  await page.getByLabel("Receiving account number (bank-information section)", { exact: true }).fill("0000123456");
  await page.getByLabel("Beneficiary / recipient / for further credit to name", { exact: true }).fill("Adah Sample");
  await page.getByLabel("Ultimate beneficiary account number", { exact: true }).fill("0000765432");
  await (await expand(page, "Intermediary Bank, Only if Instructed")).getByLabel("Intermediary bank name", { exact: true }).fill("Sample Intermediary");
  await page.getByRole("checkbox").check();
  const { pdf } = await downloadPdf(page, testInfo, "FICTIONAL-partial-wire.pdf");
  verifyDraft(pdf, 1, {
    "APEX ACCOUNT NO": "SYNTH-0001", "WIRE AMOUNT": "1250.25", "Bank Name Required": "Example Bank", "Account No": "0000123456",
    "BeneficiaryRecipientFor Further Credit to Name": "Adah Sample", "Beneficiary Account No": "0000765432", "Bank Name Required_2": "Sample Intermediary",
  });
});

test("wire API rejects source-account forgery and cross-client accounts", async ({ page }) => {
  await openForm(page, FORM_FIXTURE.owner.id, "Prepare Form: Domestic Wire Request");
  const request = { formId: "apex-domestic-wire", clientId: FORM_FIXTURE.owner.id, accountIds: [FORM_FIXTURE.firstAccount.id], values: { fields: {}, confirmAccount: true } };
  const forged = await page.request.post("/api/forms/generate", { data: { ...request, values: { fields: { apexAccountNumber: "FORGED-00009" }, confirmAccount: true } } });
  expect(forged.status()).toBe(422);
  const wrongOwner = await page.request.post("/api/forms/generate", { data: { ...request, accountIds: [FORM_FIXTURE.otherAccount.id] } });
  expect(wrongOwner.status()).toBe(404);
  for (const response of [forged, wrongOwner]) {
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
});

test("changing the selected account clears every manual wire entry and requires confirmation again", async ({ page }, testInfo) => {
  await openForm(page, FORM_FIXTURE.owner.id, "Prepare Form: Domestic Wire Request");
  const account = page.getByLabel("Sending Apex account", { exact: true });
  await account.selectOption(FORM_FIXTURE.firstAccount.id);
  await expand(page, "Intermediary Bank, Only if Instructed");
  const inputs = page.locator('input[type="text"]');
  expect(await inputs.count()).toBeGreaterThan(10);
  for (const input of await inputs.all()) await input.fill("Sample Value");
  await page.getByRole("checkbox").check();
  await account.selectOption(FORM_FIXTURE.secondAccount.id);
  for (const input of await inputs.all()) await expect(input).toHaveValue("");
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  const unconfirmed = generateResponse(page);
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  expect((await unconfirmed).status()).toBe(422);
  await page.getByRole("checkbox").check();
  const { pdf } = await downloadPdf(page, testInfo, "FICTIONAL-after-account-switch.pdf");
  verifyDraft(pdf, 1, { "APEX ACCOUNT NO": "SYNTH-0002" });
});

test("leaving a mapped form during generation aborts the request and never downloads the old client's PDF", async ({ page }) => {
  await openForm(page, FORM_FIXTURE.owner.id, "Prepare Form: Domestic Wire Request");
  await page.getByLabel("Sending Apex account", { exact: true }).selectOption(FORM_FIXTURE.firstAccount.id);
  await page.getByRole("checkbox").check();
  let release!: () => void;
  let received!: () => void;
  let finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const intercepted = new Promise<void>(resolve => { received = resolve; });
  const handlerFinished = new Promise<void>(resolve => { finished = resolve; });
  const downloads: string[] = [];
  page.on("download", download => downloads.push(download.suggestedFilename()));
  await page.route("**/api/forms/generate", async route => {
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const body = await response.body();
      received();
      await held;
      await route.fulfill({ response, body }).catch(() => {}); // The browser has aborted the request.
    } finally { finished(); }
  });
  try {
    await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
    await intercepted;
    await expect(page.getByRole("button", { name: "Generating…", exact: true })).toBeDisabled();
    const failed = page.waitForEvent("requestfailed", { predicate: request => request.url().endsWith("/api/forms/generate"), timeout: 20_000 });
    // This existing Next Link performs client navigation, exercising unmount
    // cleanup rather than relying on a full browser document reload.
    await page.getByRole("link", { name: "← Jordan Sample", exact: true }).click();
    expect((await failed).failure()?.errorText).toMatch(/abort|cancel/i);
    await expect(page).toHaveURL(new RegExp(`${portrait(FORM_FIXTURE.owner.id)}\\?portraitTab=financial$`));
    await page.goto(portrait(FORM_FIXTURE.other.id));
    await expect(page).toHaveURL(new RegExp(`${portrait(FORM_FIXTURE.other.id)}$`));
    release();
    await handlerFinished;
    expect(downloads).toEqual([]);
    await expect(page.getByText("Form downloaded", { exact: false })).toHaveCount(0);
  } finally { release(); }
});
