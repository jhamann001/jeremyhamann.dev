import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { PDFCheckBox, PDFDocument, PDFHexString, PDFName, PDFString, PDFTextField } from "pdf-lib";
import { FORM_FIXTURE } from "./forms-fixture";
import { signInOperations } from "./operations-browser-helpers";
import { openFormLibrary } from "./mapped-form-browser-helpers";

const portrait = (id: string) => `/client-portrait/${id}`;
const beneficiaries = [
  { fullName: "Adah Sample", relationship: "Child", dateOfBirth: "01/02/1990", telephoneNumber: "202-555-0101", sharePercentage: 60, address: "100 Example Lane, Example City, NY 10001", emailAddress: "taylor.sample@example.test", taxId: "900-00-0002" },
  { fullName: "Alex Sample", relationship: "Sibling", dateOfBirth: "03/14/1992", telephoneNumber: "202-555-0102", sharePercentage: 40, address: "200 Example Lane, Example City, NY 10001", emailAddress: "alex.sample@example.test", taxId: "900-00-0003" },
];
const draftValues = {
  accountHolderName: "Jordan Sample", accountHolderTaxId: "900-00-0001",
  beneficiaryCompletion: "staff", certifyNotMarried: false, primary: beneficiaries, contingent: [],
};
const blankBeneficiaryValues = {
  fullName: "", relationship: "", dateOfBirth: "", telephoneNumber: "",
  sharePercentage: null, address: "", emailAddress: "", taxId: "",
};

test.beforeEach(async ({ context }) => {
  // Browser calls are local-only, including any optional shell badge requests.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === "http://127.0.0.1:3103" ? route.continue() : route.abort("blockedbyclient");
  });
});

async function openFinancial(page: Page, id: string) {
  await signInOperations(page, portrait(id));
  const financialTab = page.getByRole("link", { name: "Core Financial", exact: true });
  await financialTab.click();
  // The pane must change on this click, not merely update the URL and require
  // a reload. This catches the shared NavigationTabs controlled-state seam.
  await expect(financialTab).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Form Library", exact: true })).toBeVisible();
  await openFormLibrary(page);
}

async function fillBeneficiaries(page: Page, invalidFirstPhone = false) {
  await page.getByLabel(/^Account-holder SSN or TIN/).fill("900-00-0001");
  await page.getByRole("button", { name: "Add primary", exact: true }).click();
  const labels = {
    fullName: /^Full legal name/, relationship: /^Relationship/, dateOfBirth: /^Date of birth/,
    telephoneNumber: /^Telephone number/, sharePercentage: /^Share percentage/,
    address: /^Address/, emailAddress: /^Email address/, taxId: /^SSN or TIN/,
  };
  for (const [index, beneficiary] of beneficiaries.entries()) {
    for (const [key, label] of Object.entries(labels)) {
      const value = invalidFirstPhone && index === 0 && key === "telephoneNumber"
        ? "123" : String(beneficiary[key as keyof typeof beneficiary]);
      await page.getByLabel(label).nth(index).fill(value);
    }
  }
}

function verifyHolderTaxId(form: ReturnType<PDFDocument["getForm"]>, normalizedTaxId: string) {
  const field = form.getTextField("Social Security Number");
  expect(field.getText() ?? "").toBe(normalizedTaxId);
  if (normalizedTaxId === "") {
    expect(field.isReadOnly()).toBe(false);
    expect(field.isRequired()).toBe(true);
    const tooltip = field.acroField.dict.lookup(PDFName.of("TU"));
    expect(tooltip instanceof PDFHexString || tooltip instanceof PDFString).toBe(true);
    if (tooltip instanceof PDFHexString || tooltip instanceof PDFString) {
      expect(tooltip.decodeText()).toMatch(/client.*complet/i);
      expect(tooltip.decodeText()).toMatch(/SSN|TIN|Social Security/i);
    }
  }
}

async function verifyPdf(bytes: Uint8Array, accountNumber: string, normalizedTaxId = "900000001", shares: readonly [string, string] = ["60", "40"]) {
  const pdf = await PDFDocument.load(bytes);
  const form = pdf.getForm();
  expect(pdf.getPageCount()).toBe(2);
  // Literal PDF field IDs are intentionally independent of the app's mapping.
  const expected = {
    Name: "Jordan Sample", "Social Security Number": normalizedTaxId, "Account Number": accountNumber,
    Name_2: "Adah Sample", Relationship_2: "Child", "Date of Birth_2": "01/02/1990",
    "Telephone Number_2": "202-555-0101", "Share Percentage_2": shares[0],
    Address_2: "100 Example Lane, Example City, NY 10001", "Email Address_2": "taylor.sample@example.test", "Social Security Number_2": "900000002",
    Name_3: "Alex Sample", Relationship_3: "Sibling", "Date of Birth_3": "03/14/1992",
    "Telephone Number_3": "202-555-0102", "Share Percentage_3": shares[1],
    Address_3: "200 Example Lane, Example City, NY 10001", "Email Address_3": "alex.sample@example.test", "Social Security Number_3": "900000003",
  };
  for (const [name, value] of Object.entries(expected)) expect(form.getTextField(name).getText() ?? "", name).toBe(value);
  verifyHolderTaxId(form, normalizedTaxId);
  for (const field of form.getFields()) {
    if (field instanceof PDFTextField && !(field.getName() in expected)) expect(field.getText() ?? "", field.getName()).toBe("");
    if (field.constructor.name === "PDFSignature") expect(field.acroField.dict.get(PDFName.of("V"))).toBeUndefined();
  }
  const checkbox = form.getCheckBox("If you are not married certify here");
  expect(checkbox.isChecked()).toBe(false);
  expect(checkbox.isReadOnly()).toBe(false);
  checkbox.check();
  const edited = await PDFDocument.load(await pdf.save());
  expect(edited.getForm().getCheckBox("If you are not married certify here").isChecked()).toBe(true);
}

async function verifyClientCompletionPdf(bytes: Uint8Array, accountNumber: string, normalizedTaxId = "900000001") {
  const pdf = await PDFDocument.load(bytes);
  const form = pdf.getForm();
  expect(pdf.getPageCount()).toBe(2);
  const expected = {
    Name: "Jordan Sample", "Social Security Number": normalizedTaxId, "Account Number": accountNumber,
  };
  for (const [name, value] of Object.entries(expected)) expect(form.getTextField(name).getText() ?? "", name).toBe(value);
  verifyHolderTaxId(form, normalizedTaxId);
  for (const field of form.getFields()) {
    if (field instanceof PDFTextField && !(field.getName() in expected)) expect(field.getText() ?? "", field.getName()).toBe("");
    if (field.constructor.name === "PDFSignature") expect(field.acroField.dict.get(PDFName.of("V"))).toBeUndefined();
  }
  // Exact PDF field identifiers, not imported app mappings. Only the first
  // primary beneficiary's eight fields are mandatory in a client-completed PDF.
  for (let suffix = 2; suffix <= 11; suffix += 1) {
    for (const name of ["Name", "Relationship", "Date of Birth", "Telephone Number", "Share Percentage", "Address", "Email Address", "Social Security Number"]) {
      const field = form.getTextField(`${name}_${suffix}`);
      expect(field.getText() ?? "", field.getName()).toBe("");
      expect(field.isReadOnly(), field.getName()).toBe(false);
      expect(field.isRequired(), field.getName()).toBe(suffix === 2);
    }
  }
  const checkbox = form.getCheckBox("If you are not married certify here");
  expect(checkbox.isChecked()).toBe(false);
  expect(checkbox.isReadOnly()).toBe(false);
  form.getTextField("Name_2").setText("Editable Fictional Beneficiary");
  checkbox.check();
  const edited = await PDFDocument.load(await pdf.save());
  expect(edited.getForm().getTextField("Name_2").getText()).toBe("Editable Fictional Beneficiary");
  expect(edited.getForm().getCheckBox("If you are not married certify here").isChecked()).toBe(true);
}

async function verifyGenericAcatPdf(bytes: Uint8Array, accountNumber: string, accountTitle: string, normalizedTaxId = "") {
  const pdf = await PDFDocument.load(bytes);
  const form = pdf.getForm();
  expect(pdf.getPageCount()).toBe(2);
  expect(form.getFields()).toHaveLength(95);
  // Independent literal template IDs. No delivering-account, transfer-type,
  // liquidation, signature or Letter of Authorization values are inferred.
  const expected: Record<string, string> = {
    "ACCOUNT TITLE": accountTitle,
    "APEX CLEARING ACCOUNT NO": accountNumber,
    "SSNTAX ID NO": normalizedTaxId,
  };
  for (const [name, value] of Object.entries(expected)) expect(form.getTextField(name).getText() ?? "", name).toBe(value);
  const loaWidgets = new Set((pdf.getPage(1).node.Annots()?.asArray() ?? []).map((ref) => pdf.context.lookup(ref)));
  for (const field of form.getFields()) {
    if (field instanceof PDFTextField && !(field.getName() in expected)) expect(field.getText() ?? "", field.getName()).toBe("");
    if (field instanceof PDFCheckBox) expect(field.isChecked(), field.getName()).toBe(false);
    if (field.constructor.name === "PDFSignature") expect(field.acroField.dict.get(PDFName.of("V"))).toBeUndefined();
    if (field instanceof PDFTextField && field.acroField.getWidgets().some((widget) => loaWidgets.has(widget.dict))) {
      expect(field.getText() ?? "", `Blank LOA page: ${field.getName()}`).toBe("");
    }
  }
}

async function verifyPartialBeneficiaryPdf(bytes: Uint8Array, knownFields: Record<string, string>, usedRows: readonly number[]) {
  const pdf = await PDFDocument.load(bytes);
  const form = pdf.getForm();
  expect(pdf.getPageCount()).toBe(2);
  expect(form.getFields()).toHaveLength(91);
  const expected: Record<string, string> = { Name: "Jordan Sample", "Account Number": "SYNTH-0001", ...knownFields };
  for (const [name, value] of Object.entries(expected)) expect(form.getTextField(name).getText() ?? "", name).toBe(value);
  verifyHolderTaxId(form, "");
  for (const field of form.getFields()) {
    if (field instanceof PDFTextField && !(field.getName() in expected)) expect(field.getText() ?? "", field.getName()).toBe("");
    if (field instanceof PDFCheckBox) expect(field.isChecked(), field.getName()).toBe(false);
    if (field.constructor.name === "PDFSignature") expect(field.acroField.dict.get(PDFName.of("V"))).toBeUndefined();
  }
  for (let suffix = 2; suffix <= 11; suffix += 1) {
    for (const prefix of ["Name", "Relationship", "Date of Birth", "Telephone Number", "Share Percentage", "Address", "Email Address", "Social Security Number"]) {
      const name = `${prefix}_${suffix}`;
      const field = form.getTextField(name);
      expect(field.isReadOnly(), name).toBe(false);
      if (usedRows.includes(suffix) && !knownFields[name]) {
        expect(field.isRequired(), name).toBe(true);
        const tooltip = field.acroField.dict.lookup(PDFName.of("TU"));
        expect(tooltip instanceof PDFHexString || tooltip instanceof PDFString, name).toBe(true);
        if (tooltip instanceof PDFHexString || tooltip instanceof PDFString) expect(tooltip.decodeText(), name).toMatch(/client.*complet/i);
      } else if (!usedRows.includes(suffix)) {
        expect(field.isRequired(), `Unused row: ${name}`).toBe(false);
      }
    }
  }
}

test("form library stays visible without an eligible account, with no actionable prepare link", async ({ page }, testInfo) => {
  await openFinancial(page, FORM_FIXTURE.empty.id);
  await expect(page.getByText("No accounts with a confirmed Apex account number available. Select or link an account before preparing a form.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Prepare Form: ACAT Transfer", exact: true })).toHaveCount(0);
  await page.getByRole("heading", { name: "Form Library", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("synthetic-no-eligible-accounts.png"), fullPage: true });
});

test("always-visible optional entry generates a client-completed draft when all beneficiary fields and holder SSN are blank", async ({ page }, testInfo) => {
  await openFinancial(page, FORM_FIXTURE.owner.id);
  await page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true }).click();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByLabel(/^Full legal name/)).toHaveCount(1);
  for (const label of [/^Full legal name/, /^Relationship/, /^Date of birth/, /^Telephone number/, /^Share percentage/, /^Address/, /^Email address/, /^SSN or TIN/]) {
    await expect(page.getByLabel(label)).toBeVisible();
    await expect(page.getByLabel(label)).toHaveValue("");
  }
  await expect(page.getByRole("button", { name: "Add primary", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add contingent", exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Account-holder name/)).toHaveValue("Jordan Sample");
  await expect(page.getByLabel(/^IRA account/)).toHaveValue(FORM_FIXTURE.firstAccount.id);
  await expect(page.getByRole("checkbox", { name: /The account holder has confirmed/ })).not.toBeChecked();
  await expect(page.getByLabel(/^Account-holder SSN or TIN \(optional\)/)).toHaveValue("");
  const downloadPromise = page.waitForEvent("download");
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const [download, response] = await Promise.all([downloadPromise, responsePromise]);
  expect(response.status()).toBe(200);
  expect(response.headers()["x-aoa-client-completion-required"]).toBe("true");
  expect(response.headers()["x-aoa-review-state"]).toBe("ready_for_human_review");
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.request().postDataJSON().values).toMatchObject({ accountHolderTaxId: "", beneficiaryCompletion: "partial", primary: [blankBeneficiaryValues], contingent: [], certifyNotMarried: false });
  const output = testInfo.outputPath("FICTIONAL-SYNTH-0001-client-completion-review.pdf");
  await download.saveAs(output);
  await verifyClientCompletionPdf(await readFile(output), "SYNTH-0001", "");
  await testInfo.attach("fictional-client-completion-pdf", { path: output, contentType: "application/pdf" });
  await expect(page.getByRole("status")).toContainText("Values were not saved");
  await expect(page.getByRole("status")).toContainText("Client completion required");
  await expect(page.getByRole("heading", { name: "Account-holder SSN or TIN · Required from client", exact: true })).toBeVisible();
  await page.getByRole("heading", { name: "IRA Beneficiary Designation", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("synthetic-client-completion-inputs.png"), fullPage: true });
  await page.getByText("Primary beneficiary 1", { exact: true }).locator("../..").screenshot({ path: testInfo.outputPath("synthetic-optional-blank-primary-fields.png") });
});

test("fully entered beneficiaries still require client completion when the holder SSN is blank", async ({ page }, testInfo) => {
  await openFinancial(page, FORM_FIXTURE.owner.id);
  await page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true }).click();
  await fillBeneficiaries(page);
  await page.getByLabel(/^Account-holder SSN or TIN \(optional\)/).fill("");
  const downloadPromise = page.waitForEvent("download");
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const [download, response] = await Promise.all([downloadPromise, responsePromise]);
  expect(response.status()).toBe(200);
  expect(response.headers()["x-aoa-client-completion-required"]).toBe("true");
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.request().postDataJSON().values).toMatchObject({ beneficiaryCompletion: "partial", accountHolderTaxId: "" });
  const output = testInfo.outputPath("FICTIONAL-SYNTH-0001-staff-beneficiaries-holder-SSN-blank.pdf");
  await download.saveAs(output);
  await verifyPdf(await readFile(output), "SYNTH-0001", "");
  await testInfo.attach("fictional-staff-beneficiaries-holder-ssn-blank", { path: output, contentType: "application/pdf" });
  await expect(page.getByRole("status")).toContainText("Client completion required");
  await expect(page.getByRole("heading", { name: "Account-holder SSN or TIN · Required from client", exact: true })).toBeVisible();
  await expect(page.getByRole("status")).not.toContainText("Beneficiary details required from client");
  await page.getByRole("heading", { name: "Account Holder", exact: true }).locator("../..").screenshot({ path: testInfo.outputPath("synthetic-optional-holder-ssn.png") });
});

test("last-four, masked and malformed holder SSNs are rejected without leaking partial values into a draft", async ({ page }, testInfo) => {
  await openFinancial(page, FORM_FIXTURE.owner.id);
  await page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true }).click();
  const holderTaxId = page.getByLabel(/^Account-holder SSN or TIN \(optional\)/);
  await expect(holderTaxId).toHaveValue("");
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  for (const partial of ["1234", "***-**-1234", "90000000X"]) {
    await holderTaxId.fill(partial);
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(422);
    expect(response.headers()["content-type"]).toContain("application/json");
    expect((await response.json()).details).toEqual(expect.arrayContaining([expect.objectContaining({ path: "accountHolderTaxId" })]));
    await expect(page.locator('ul[aria-live="polite"]')).toContainText(/Account-holder SSN or TIN/i);
    expect(downloads).toEqual([]);
  }
  await holderTaxId.fill("");
  const downloadPromise = page.waitForEvent("download");
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const [download, response] = await Promise.all([downloadPromise, responsePromise]);
  expect(response.status()).toBe(200);
  expect(response.headers()["x-aoa-client-completion-required"]).toBe("true");
  expect(response.request().postDataJSON().values.accountHolderTaxId).toBe("");
  const output = testInfo.outputPath("FICTIONAL-SYNTH-0001-after-partial-SSN-cleared.pdf");
  await download.saveAs(output);
  await verifyClientCompletionPdf(await readFile(output), "SYNTH-0001", "");
  const pdf = await PDFDocument.load(await readFile(output));
  const populatedText = pdf.getForm().getFields().filter((field): field is PDFTextField => field instanceof PDFTextField).map((field) => field.getText() ?? "");
  for (const partial of ["1234", "***-**-1234", "90000000X"]) expect(populatedText.join("\n")).not.toContain(partial);
  expect(downloads).toHaveLength(1);
});

test("clearing entered beneficiary details excludes the cleared data and still produces a usable client-completed draft", async ({ page }, testInfo) => {
  await openFinancial(page, FORM_FIXTURE.owner.id);
  await page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true }).click();
  await fillBeneficiaries(page);
  await page.getByRole("button", { name: "Add contingent", exact: true }).click();
  await page.getByLabel(/^Full legal name/).nth(2).fill("Abigail Fictional");
  await page.getByLabel(/^Email address/).nth(2).fill("robin.fictional@example.test");
  for (const label of [/^Full legal name/, /^Relationship/, /^Date of birth/, /^Telephone number/, /^Share percentage/, /^Address/, /^Email address/, /^SSN or TIN/]) {
    for (const field of await page.getByLabel(label).all()) {
      await field.fill("");
      await expect(field).toHaveValue("");
    }
  }
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByLabel(/^Full legal name/)).toHaveCount(3);
  await page.getByLabel(/^IRA account/).selectOption(FORM_FIXTURE.secondAccount.id);
  await expect(page.getByLabel(/^Account-holder SSN or TIN \(optional\)/)).toHaveValue("");
  const downloadPromise = page.waitForEvent("download");
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const [download, response] = await Promise.all([downloadPromise, responsePromise]);
  expect(response.status()).toBe(200);
  expect(response.headers()["x-aoa-client-completion-required"]).toBe("true");
  const posted = response.request().postDataJSON();
  expect(posted.values).toMatchObject({ accountHolderTaxId: "", beneficiaryCompletion: "partial", primary: [blankBeneficiaryValues, blankBeneficiaryValues], contingent: [blankBeneficiaryValues] });
  for (const cleared of ["Adah Sample", "Alex Sample", "Abigail Fictional", "taylor.sample@example.test", "robin.fictional@example.test", "900-00-0002", "900-00-0003"]) {
    expect(JSON.stringify(posted)).not.toContain(cleared);
  }
  const output = testInfo.outputPath("FICTIONAL-SYNTH-0002-cleared-beneficiaries-review.pdf");
  await download.saveAs(output);
  await verifyClientCompletionPdf(await readFile(output), "SYNTH-0002", "");
  await testInfo.attach("fictional-cleared-beneficiaries-pdf", { path: output, contentType: "application/pdf" });
  await expect(page.getByRole("status")).toContainText("Client completion required");
});

test("portrait selection, two IRA choices, invalid supplied phone and exact 60/40 PDF data", async ({ page }, testInfo) => {
  await openFinancial(page, FORM_FIXTURE.owner.id);
  await page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "IRA Beneficiary Designation", exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Account-holder name/)).toHaveValue("Jordan Sample");
  const account = page.getByLabel(/^IRA account/);
  await expect(account).toHaveValue(FORM_FIXTURE.firstAccount.id);
  await expect(account.locator("option")).toHaveCount(2);
  await expect(account).not.toContainText("0003");
  const certification = page.getByRole("checkbox", { name: /The account holder has confirmed/ });
  await expect(certification).not.toBeChecked();
  await certification.check();
  await expect(certification).toBeChecked();
  await certification.uncheck();
  await fillBeneficiaries(page, true);
  const validation = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  expect((await validation).status()).toBe(422);
  await expect(page.getByText("Primary beneficiary 1 — Telephone number: Enter a valid telephone number", { exact: true })).toBeVisible();
  await page.getByLabel(/^Telephone number/).first().fill("202-555-0101");

  for (const [index, choice] of [FORM_FIXTURE.firstAccount, FORM_FIXTURE.secondAccount].entries()) {
    if (index > 0) {
      await account.selectOption(choice.id);
      await expect(page.getByLabel(/^Account-holder SSN or TIN \(optional\)/)).toHaveValue("");
      await expect(page.getByRole("status")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Account-holder SSN or TIN · Required from client", exact: true })).toBeVisible();
      await page.getByLabel(/^Account-holder SSN or TIN \(optional\)/).fill("900-00-0001");
    }
    await expect(page.getByRole("heading", { name: "Account-holder SSN or TIN · Required from client", exact: true })).toHaveCount(0);
    const downloadPromise = page.waitForEvent("download");
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
    const [download, response] = await Promise.all([downloadPromise, responsePromise]);
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON().values.beneficiaryCompletion).toBe("partial");
    expect(response.headers()["x-aoa-client-completion-required"]).toBe("false");
    expect(response.headers()["x-aoa-review-state"]).toBe("ready_for_human_review");
    expect(response.headers()["cache-control"]).toContain("no-store");
    const output = testInfo.outputPath(`FICTIONAL-${choice.number}-60-40-review.pdf`);
    await download.saveAs(output);
    await verifyPdf(await readFile(output), choice.number);
    await testInfo.attach(`fictional-${choice.number}-pdf`, { path: output, contentType: "application/pdf" });
    await expect(page.getByRole("status")).toContainText("Values were not saved");
    if (choice.id === FORM_FIXTURE.firstAccount.id) {
      await page.getByRole("heading", { name: "IRA Beneficiary Designation", exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("synthetic-60-40-inputs.png"), fullPage: true });
    }
  }
  const persisted = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
  expect(persisted).not.toContain("taylor.sample@example.test");
  expect(persisted).not.toContain("900-00-0002");
  await page.reload();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByLabel(/^Account-holder SSN or TIN/)).toHaveValue("");
  await expect(certification).not.toBeChecked();
  await expect(page.getByLabel(/^Full legal name/)).toHaveCount(1);
  await expect(page.getByLabel(/^Full legal name/).first()).toHaveValue("");
  await expect(page.getByLabel(/^Telephone number/).first()).toHaveValue("");
  await expect(page.getByLabel(/^Email address/).first()).toHaveValue("");
  await expect(page.getByLabel(/^SSN or TIN/).first()).toHaveValue("");
});

test("server controls the account number and rejects another owner's account", async ({ page }) => {
  await signInOperations(page, portrait(FORM_FIXTURE.owner.id));
  const request = {
    formId: "ira_beneficiary_designation", clientId: FORM_FIXTURE.owner.id,
    accountIds: [FORM_FIXTURE.secondAccount.id], values: { ...draftValues, accountNumber: "FORGED-NOT-THE-ACCOUNT" },
  };
  const response = await page.request.post("/api/forms/generate", { data: request });
  expect(response.status()).toBe(200);
  await verifyPdf(await response.body(), "SYNTH-0002");
  const wrongOwner = await page.request.post("/api/forms/generate", { data: { ...request, accountIds: [FORM_FIXTURE.otherAccount.id] } });
  expect(wrongOwner.status()).toBe(404);
  expect(await wrongOwner.json()).toEqual({ error: "client_account_not_found" });
  const clientRequest = { ...request, values: { ...draftValues, beneficiaryCompletion: "client", primary: [], contingent: [], accountNumber: "FORGED-NOT-THE-ACCOUNT" } };
  const clientResponse = await page.request.post("/api/forms/generate", { data: clientRequest });
  expect(clientResponse.status()).toBe(200);
  expect(clientResponse.headers()["x-aoa-client-completion-required"]).toBe("true");
  await verifyClientCompletionPdf(await clientResponse.body(), "SYNTH-0002");
  const wrongClientOwner = await page.request.post("/api/forms/generate", { data: { ...clientRequest, accountIds: [FORM_FIXTURE.otherAccount.id] } });
  expect(wrongClientOwner.status()).toBe(404);
  expect(await wrongClientOwner.json()).toEqual({ error: "client_account_not_found" });
  for (const mode of ["client", "staff", "partial"]) {
    const omittedHolderTaxId = await page.request.post("/api/forms/generate", { data: {
      ...request,
      values: { accountHolderName: "Jordan Sample", beneficiaryCompletion: mode, certifyNotMarried: false, primary: mode === "client" ? [] : beneficiaries, contingent: [] },
    } });
    expect(omittedHolderTaxId.status()).toBe(200);
    expect(omittedHolderTaxId.headers()["x-aoa-client-completion-required"]).toBe("true");
    if (mode === "client") await verifyClientCompletionPdf(await omittedHolderTaxId.body(), "SYNTH-0002", "");
    else await verifyPdf(await omittedHolderTaxId.body(), "SYNTH-0002", "");
  }
  // Existing API callers remain strict unless they explicitly choose partial.
  for (const mode of ["staff", undefined]) {
    const strictIncomplete = await page.request.post("/api/forms/generate", { data: {
      ...request,
      values: { accountHolderName: "Jordan Sample", accountHolderTaxId: "", ...(mode ? { beneficiaryCompletion: mode } : {}), primary: [{ fullName: "John Sample", relationship: "Husband" }], contingent: [] },
    } });
    expect(strictIncomplete.status()).toBe(422);
    expect(strictIncomplete.headers()["content-type"]).toContain("application/json");
  }
});

test("an expired-session HTML response cannot become a downloaded PDF", async ({ page }) => {
  await openFinancial(page, FORM_FIXTURE.owner.id);
  await page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true }).click();
  await page.getByLabel(/^IRA account/).selectOption(FORM_FIXTURE.secondAccount.id);
  await fillBeneficiaries(page);
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.route("**/api/forms/generate", (route) => route.fulfill({
    status: 200, contentType: "text/html",
    body: "<!doctype html><html><body><h1>Dev sign-in</h1></body></html>",
  }));
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  await expect(page.locator('ul[aria-live="polite"]')).toContainText("Your session may have expired. Sign in again, then retry. No file was downloaded.");
  await expect(page.getByRole("button", { name: "Generate PDF", exact: true })).toBeEnabled();
  expect(downloads).toEqual([]);
  await expect(page.getByText(/Form downloaded/)).toHaveCount(0);
});

test("generic ACAT requires receiving-title confirmation and leaves transfer instructions and LOA blank", async ({ page }, testInfo) => {
  await openFinancial(page, FORM_FIXTURE.owner.id);
  await expect(page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Prepare Form: ACAT Transfer", exact: true })).toBeVisible();
  await page.getByRole("region", { name: "Form Library", exact: true }).screenshot({ path: testInfo.outputPath("synthetic-two-form-library-card.png") });
  await page.getByRole("link", { name: "Prepare Form: ACAT Transfer", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${portrait(FORM_FIXTURE.owner.id)}/forms/acat$`));
  await expect(page.getByRole("heading", { name: "ACAT Transfer", exact: true })).toBeVisible();
  const account = page.getByLabel(/^Receiving Apex account/);
  const title = page.getByLabel(/^Receiving account title/);
  const taxId = page.getByLabel(/^Account-holder SSN or TIN \(optional\)/);
  const confirmation = page.getByRole("checkbox", { name: "I confirmed the full receiving account title against the account record, including all owners or the entity name.", exact: true });
  await expect(account).toHaveValue(FORM_FIXTURE.firstAccount.id);
  await expect(account.locator("option")).toHaveCount(2);
  await expect(title).toHaveValue("Jordan Sample");
  await expect(taxId).toHaveValue("");
  await expect(confirmation).not.toBeChecked();
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  const validation = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const rejected = await validation;
  expect(rejected.status()).toBe(422);
  expect((await rejected.json()).details).toEqual(expect.arrayContaining([expect.objectContaining({ path: "confirmAccountTitle" })]));
  await expect(page.locator('ul[aria-live="polite"]')).toContainText(/confirm.*account.*title/i);
  expect(downloads).toEqual([]);
  await confirmation.check();

  for (const [index, choice] of [FORM_FIXTURE.firstAccount, FORM_FIXTURE.secondAccount].entries()) {
    const expectedTitle = index === 0 ? "Jordan Sample" : "Jordan Q. Sample";
    const expectedTaxId = index === 0 ? "" : "900000001";
    if (index === 1) {
      await account.selectOption(choice.id);
      await expect(confirmation).not.toBeChecked();
      await confirmation.check();
      await title.fill(expectedTitle);
      await expect(confirmation).not.toBeChecked();
      await taxId.fill("900-00-0001");
      await confirmation.check();
    }
    const downloadPromise = page.waitForEvent("download");
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
    const [download, response] = await Promise.all([downloadPromise, responsePromise]);
    expect(response.status()).toBe(200);
    expect(response.headers()["x-aoa-review-state"]).toBe("ready_for_human_review");
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["content-type"]).toContain("application/pdf");
    const posted = response.request().postDataJSON();
    expect(posted.formId).toBe("apex-acat-generic");
    expect(posted.accountIds).toEqual([choice.id]);
    expect(posted.values).toMatchObject({ accountHolderName: expectedTitle, confirmAccountTitle: true });
    expect(posted.values).not.toHaveProperty("accountNumber");
    const output = testInfo.outputPath(`FICTIONAL-${choice.number}-generic-ACAT-${index === 0 ? "without" : "with"}-TIN.pdf`);
    await download.saveAs(output);
    await verifyGenericAcatPdf(await readFile(output), choice.number, expectedTitle, expectedTaxId);
    await testInfo.attach(`fictional-${choice.number}-generic-acat-pdf`, { path: output, contentType: "application/pdf" });
    await expect(page.getByRole("status")).toContainText("Values were not saved");
  }
  expect(downloads).toHaveLength(2);
  await page.getByRole("heading", { name: "ACAT Transfer", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("synthetic-generic-acat-form.png"), fullPage: true });
  await page.getByRole("heading", { name: "Receiving Account Information", exact: true }).locator("../..").screenshot({ path: testInfo.outputPath("synthetic-generic-acat-receiving-fields.png") });
  await page.getByRole("heading", { name: "Before Sending", exact: true }).locator("../..").screenshot({ path: testInfo.outputPath("synthetic-generic-acat-review-requirements.png") });
  // A TIN entered for one account must not silently carry into another account.
  await account.selectOption(FORM_FIXTURE.firstAccount.id);
  await expect(taxId).toHaveValue("");
  await expect(confirmation).not.toBeChecked();
  const persisted = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
  expect(persisted).not.toContain("900-00-0001");
  expect(persisted).not.toContain("Jordan Q. Sample");
  await page.reload();
  await expect(account).toHaveValue(FORM_FIXTURE.firstAccount.id);
  await expect(title).toHaveValue("Jordan Sample");
  await expect(taxId).toHaveValue("");
  await expect(confirmation).not.toBeChecked();
});

test("generic ACAT uses the selected authorized account and rejects forged receiving numbers and other owners", async ({ page }) => {
  await signInOperations(page, portrait(FORM_FIXTURE.owner.id));
  const request = {
    formId: "apex-acat-generic", clientId: FORM_FIXTURE.owner.id,
    accountIds: [FORM_FIXTURE.secondAccount.id],
    values: { accountHolderName: "Jordan Q. Sample", accountHolderTaxId: "", confirmAccountTitle: true },
  };
  const response = await page.request.post("/api/forms/generate", { data: request });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  await verifyGenericAcatPdf(await response.body(), "SYNTH-0002", "Jordan Q. Sample");
  const forged = await page.request.post("/api/forms/generate", { data: { ...request, values: { ...request.values, accountNumber: "FORGED-NOT-THE-ACCOUNT" } } });
  expect(forged.status()).toBe(422);
  expect(forged.headers()["content-type"]).toContain("application/json");
  const wrongOwner = await page.request.post("/api/forms/generate", { data: { ...request, accountIds: [FORM_FIXTURE.otherAccount.id] } });
  expect(wrongOwner.status()).toBe(404);
  expect(await wrongOwner.json()).toEqual({ error: "client_account_not_found" });
});

test("John Sample and Husband alone carry through while every unknown beneficiary field stays blank", async ({ page }, testInfo) => {
  await openFinancial(page, FORM_FIXTURE.owner.id);
  await page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true }).click();
  await expect(page.getByLabel(/^Account-holder SSN or TIN \(optional\)/)).toHaveValue("");
  await page.getByLabel(/^Full legal name/).first().fill("John Sample");
  await page.getByLabel(/^Relationship/).first().fill("Husband");
  await expect(page.getByLabel(/^Share percentage/).first()).toHaveValue("");
  await expect(page.getByText("Required from client", { exact: true })).toHaveCount(6);
  // An added but unused row remains optional and must not manufacture data.
  await page.getByRole("button", { name: "Add primary", exact: true }).click();
  await expect(page.getByText("Required from client", { exact: true })).toHaveCount(6);
  await expect(page.getByText(/Before signing, primary shares must total 100%/)).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const [download, response] = await Promise.all([downloadPromise, responsePromise]);
  expect(response.status()).toBe(200);
  expect(response.headers()["x-aoa-client-completion-required"]).toBe("true");
  expect(response.headers()["cache-control"]).toContain("no-store");
  const values = response.request().postDataJSON().values;
  expect(values).toMatchObject({ beneficiaryCompletion: "partial", accountHolderTaxId: "", contingent: [] });
  expect(values.primary[0]).toEqual({ fullName: "John Sample", relationship: "Husband", dateOfBirth: "", telephoneNumber: "", sharePercentage: null, address: "", emailAddress: "", taxId: "" });
  expect(values.primary[1]).toEqual({ fullName: "", relationship: "", dateOfBirth: "", telephoneNumber: "", sharePercentage: null, address: "", emailAddress: "", taxId: "" });
  const output = testInfo.outputPath("FICTIONAL-John-Sample-Husband-partial-beneficiary.pdf");
  await download.saveAs(output);
  await verifyPartialBeneficiaryPdf(await readFile(output), { Name_2: "John Sample", Relationship_2: "Husband" }, [2]);
  await testInfo.attach("fictional-john-husband-partial-beneficiary", { path: output, contentType: "application/pdf" });
  await expect(page.getByRole("status")).toContainText("Client completion required");
  await page.getByRole("heading", { name: "Primary Beneficiaries", exact: true }).locator("../..").screenshot({ path: testInfo.outputPath("synthetic-john-husband-partial-fields.png") });
  await page.getByRole("heading", { name: "IRA Beneficiary Designation", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("synthetic-john-husband-partial-form.png"), fullPage: true });
});

test("partially known primary and contingent shares stay pending without inventing missing values", async ({ page }, testInfo) => {
  await openFinancial(page, FORM_FIXTURE.owner.id);
  await page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true }).click();
  await page.getByLabel(/^Full legal name/).first().fill("John Sample");
  await page.getByLabel(/^Relationship/).first().fill("Husband");
  await page.getByLabel(/^Share percentage/).first().fill("60");
  await page.getByRole("button", { name: "Add contingent", exact: true }).click();
  await page.getByLabel(/^Full legal name/).nth(1).fill("Casey Sample");
  await page.getByLabel(/^Relationship/).nth(1).fill("Sister");
  await page.getByLabel(/^Share percentage/).nth(1).fill("25");
  await expect(page.getByText(/Primary percentages entered: 60%.*Before signing, primary shares must total 100%/)).toBeVisible();
  await expect(page.getByText(/Contingent percentages entered: 25%.*Before signing, contingent shares must total 100%/)).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const [download, response] = await Promise.all([downloadPromise, responsePromise]);
  expect(response.status()).toBe(200);
  expect(response.headers()["x-aoa-client-completion-required"]).toBe("true");
  const values = response.request().postDataJSON().values;
  expect(values.beneficiaryCompletion).toBe("partial");
  expect(values.primary[0]).toMatchObject({ fullName: "John Sample", sharePercentage: 60 });
  expect(values.contingent[0]).toMatchObject({ fullName: "Casey Sample", sharePercentage: 25 });
  const output = testInfo.outputPath("FICTIONAL-primary-60-contingent-25-partial-beneficiaries.pdf");
  await download.saveAs(output);
  await verifyPartialBeneficiaryPdf(await readFile(output), {
    Name_2: "John Sample", Relationship_2: "Husband", "Share Percentage_2": "60",
    Name_7: "Casey Sample", Relationship_7: "Sister", "Share Percentage_7": "25",
  }, [2, 7]);
  await testInfo.attach("fictional-partial-primary-and-contingent", { path: output, contentType: "application/pdf" });
  await expect(page.getByRole("status")).toContainText("Client completion required");
});

test("partial entry rejects supplied invalid fields and totals over 100 but allows a pending 95 percent total", async ({ page }, testInfo) => {
  await openFinancial(page, FORM_FIXTURE.owner.id);
  await page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true }).click();
  await fillBeneficiaries(page);
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  const invalidFields = [
    { label: /^Date of birth/, invalid: "02/30/1990", valid: "01/02/1990", path: "primary.0.dateOfBirth" },
    { label: /^Email address/, invalid: "not-an-email", valid: "taylor.sample@example.test", path: "primary.0.emailAddress" },
    { label: /^Telephone number/, invalid: "123", valid: "202-555-0101", path: "primary.0.telephoneNumber" },
    { label: /^SSN or TIN/, invalid: "***-**-1234", valid: "900-00-0002", path: "primary.0.taxId" },
    { label: /^Share percentage/, invalid: "0", valid: "60", path: "primary.0.sharePercentage" },
    { label: /^Share percentage/, invalid: "1.5", valid: "60", path: "primary.0.sharePercentage" },
  ];
  for (const field of invalidFields) {
    await page.getByLabel(field.label).first().fill(field.invalid);
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(422);
    expect(response.headers()["content-type"]).toContain("application/json");
    expect((await response.json()).details).toEqual(expect.arrayContaining([expect.objectContaining({ path: field.path })]));
    expect(downloads).toEqual([]);
    await page.getByLabel(field.label).first().fill(field.valid);
  }
  await page.getByLabel(/^Share percentage/).nth(1).fill("50");
  const overTotal = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const rejected = await overTotal;
  expect(rejected.status()).toBe(422);
  expect((await rejected.json()).details).toEqual(expect.arrayContaining([expect.objectContaining({ path: "primary", message: expect.stringMatching(/100/) })]));
  expect(downloads).toEqual([]);

  // All identity/contact fields (including the holder SSN) are present: the
  // incomplete group total alone must still require client completion.
  await page.getByLabel(/^Share percentage/).nth(1).fill("35");
  await expect(page.getByText(/Primary percentages entered: 95%.*Before signing, primary shares must total 100%/)).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const [download, response] = await Promise.all([downloadPromise, responsePromise]);
  expect(response.status()).toBe(200);
  expect(response.headers()["x-aoa-client-completion-required"]).toBe("true");
  const output = testInfo.outputPath("FICTIONAL-complete-beneficiaries-pending-95-percent-total.pdf");
  await download.saveAs(output);
  await verifyPdf(await readFile(output), "SYNTH-0001", "900000001", ["60", "35"]);
  await testInfo.attach("fictional-pending-95-percent-total", { path: output, contentType: "application/pdf" });
  await expect(page.getByRole("status")).toContainText("Client completion required");
  expect(downloads).toHaveLength(1);
});

test("typed and pasted beneficiary dates and domestic phones format on blur and reach the correct PDF rows", async ({ page }, testInfo) => {
  await openFinancial(page, FORM_FIXTURE.owner.id);
  await page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true }).click();
  await page.getByLabel(/^Full legal name/).first().fill("Adah Sample");
  const primaryDob = page.getByLabel(/^Date of birth/).first();
  const primaryPhone = page.getByLabel(/^Telephone number/).first();
  await primaryDob.pressSequentially("01021990");
  await expect(primaryDob).toBeFocused();
  await expect(primaryDob).toHaveValue("01021990");
  // Formatting deliberately waits for blur so editing is never overwritten.
  await primaryDob.press("Tab");
  await expect(primaryDob).toHaveValue("01/02/1990");
  await primaryPhone.pressSequentially("2025550101");
  await expect(primaryPhone).toBeFocused();
  await expect(primaryPhone).toHaveValue("2025550101");
  await primaryPhone.blur();
  await expect(primaryDob).toHaveValue("01/02/1990");
  await expect(primaryPhone).toHaveValue("202-555-0101");

  await page.getByRole("button", { name: "Add contingent", exact: true }).click();
  await page.getByLabel(/^Full legal name/).nth(1).fill("Alex Sample");
  const contingentDob = page.getByLabel(/^Date of birth/).nth(1);
  const contingentPhone = page.getByLabel(/^Telephone number/).nth(1);
  // insertText delivers the entire paste-like value in one input event without
  // reading or changing the user's system clipboard.
  await contingentDob.focus();
  await page.keyboard.insertText("03141992");
  await expect(contingentDob).toBeFocused();
  await expect(contingentDob).toHaveValue("03141992");
  await contingentDob.press("Tab");
  await expect(contingentDob).toHaveValue("03/14/1992");
  await contingentPhone.focus();
  await page.keyboard.insertText("2025550102");
  await expect(contingentPhone).toBeFocused();
  await expect(contingentPhone).toHaveValue("2025550102");
  await contingentPhone.blur();
  await expect(contingentDob).toHaveValue("03/14/1992");
  await expect(contingentPhone).toHaveValue("202-555-0102");

  const downloadPromise = page.waitForEvent("download");
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const [download, response] = await Promise.all([downloadPromise, responsePromise]);
  expect(response.status()).toBe(200);
  expect(response.headers()["x-aoa-client-completion-required"]).toBe("true");
  expect(response.headers()["cache-control"]).toContain("no-store");
  const values = response.request().postDataJSON().values;
  expect(values.beneficiaryCompletion).toBe("partial");
  expect(values.primary).toHaveLength(1);
  expect(values.contingent).toHaveLength(1);
  expect(values.primary[0]).toMatchObject({ fullName: "Adah Sample", dateOfBirth: "01/02/1990", telephoneNumber: "202-555-0101", sharePercentage: null });
  expect(values.contingent[0]).toMatchObject({ fullName: "Alex Sample", dateOfBirth: "03/14/1992", telephoneNumber: "202-555-0102", sharePercentage: null });
  const output = testInfo.outputPath("FICTIONAL-autoformatted-primary-and-contingent.pdf");
  await download.saveAs(output);
  await verifyPartialBeneficiaryPdf(await readFile(output), {
    Name_2: "Adah Sample", "Date of Birth_2": "01/02/1990", "Telephone Number_2": "202-555-0101",
    Name_7: "Alex Sample", "Date of Birth_7": "03/14/1992", "Telephone Number_7": "202-555-0102",
  }, [2, 7]);
  await testInfo.attach("fictional-autoformatted-beneficiary-pdf", { path: output, contentType: "application/pdf" });
  await expect(page.getByRole("status")).toContainText("Form downloaded");
  for (const formattedField of [primaryDob, primaryPhone, contingentDob, contingentPhone]) {
    await formattedField.focus();
    await formattedField.blur();
    await expect(page.getByRole("status")).toContainText("Form downloaded");
  }
  await page.getByText("Primary beneficiary 1", { exact: true }).locator("../..").screenshot({ path: testInfo.outputPath("synthetic-autoformatted-primary-fields.png") });
});

test("beneficiary formatting stays editable, preserves extra digits and rejects invalid calendar dates", async ({ page }) => {
  await openFinancial(page, FORM_FIXTURE.owner.id);
  await page.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true }).click();
  await page.getByLabel(/^Full legal name/).first().fill("Adah Sample");
  const dob = page.getByLabel(/^Date of birth/).first();
  const phone = page.getByLabel(/^Telephone number/).first();
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));

  await dob.pressSequentially("0102");
  await expect(dob).toHaveValue("0102");
  await dob.blur();
  await expect(dob).toHaveValue("0102");
  await dob.fill("01021990");
  await expect(dob).toHaveValue("01021990");
  await dob.blur();
  await expect(dob).toHaveValue("01/02/1990");
  await dob.focus();
  await dob.evaluate((input: HTMLInputElement) => input.setSelectionRange(input.value.length, input.value.length));
  await dob.press("Backspace");
  await expect(dob).toHaveValue("01/02/199");
  await dob.pressSequentially("0");
  await expect(dob).toHaveValue("01/02/1990");
  await dob.fill("");
  await expect(dob).toHaveValue("");

  await phone.pressSequentially("202555");
  await expect(phone).toHaveValue("202555");
  await phone.blur();
  await expect(phone).toHaveValue("202555");
  await phone.fill("2025550101");
  await expect(phone).toHaveValue("2025550101");
  await phone.blur();
  await expect(phone).toHaveValue("202-555-0101");
  await phone.focus();
  await phone.evaluate((input: HTMLInputElement) => input.setSelectionRange(input.value.length, input.value.length));
  await phone.press("Backspace");
  await expect(phone).toHaveValue("202-555-010");
  await phone.pressSequentially("1");
  await expect(phone).toHaveValue("202-555-0101");
  await phone.focus();
  await phone.evaluate((input: HTMLInputElement) => input.setSelectionRange(4, 4));
  await phone.press("Backspace");
  await expect(phone).toBeFocused();
  await expect(phone).toHaveValue("202555-0101");
  // Edit an internal digit while the separator is missing; only leaving the
  // field may reinsert separators. The 555-01xx fixture stays fictional.
  await phone.focus();
  await phone.evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 1));
  await phone.press("Delete");
  await phone.pressSequentially("1");
  await expect(phone).toHaveValue("212555-0101");
  await phone.blur();
  await expect(phone).toHaveValue("212-555-0101");
  await phone.fill("");
  await expect(phone).toHaveValue("");

  // Overlength input is kept intact, including when the user leaves the field.
  await dob.fill("010219900");
  await expect(dob).toHaveValue("010219900");
  await dob.blur();
  await expect(dob).toHaveValue("010219900");
  await phone.fill("12025550101");
  await expect(phone).toHaveValue("12025550101");
  await phone.blur();
  await expect(phone).toHaveValue("12025550101");
  const overlengthPromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const overlength = await overlengthPromise;
  expect(overlength.status()).toBe(422);
  expect(overlength.request().postDataJSON().values.primary[0]).toMatchObject({ dateOfBirth: "010219900", telephoneNumber: "12025550101" });
  expect((await overlength.json()).details).toEqual(expect.arrayContaining([expect.objectContaining({ path: "primary.0.dateOfBirth" })]));
  expect(downloads).toEqual([]);

  for (const extendedPhone of ["+1 202-555-0101", "202-555-0101 ext. 123"]) {
    await phone.fill(extendedPhone);
    await expect(phone).toHaveValue(extendedPhone);
    await phone.blur();
    await expect(phone).toHaveValue(extendedPhone);
  }
  await phone.fill("");
  await dob.fill("02291991");
  await expect(dob).toBeFocused();
  await expect(dob).toHaveValue("02291991");
  await dob.blur();
  await expect(dob).toHaveValue("02/29/1991");
  const invalidDatePromise = page.waitForResponse((response) => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const invalidDate = await invalidDatePromise;
  expect(invalidDate.status()).toBe(422);
  expect(invalidDate.request().postDataJSON().values.primary[0]).toMatchObject({ dateOfBirth: "02/29/1991", telephoneNumber: "" });
  expect((await invalidDate.json()).details).toEqual(expect.arrayContaining([expect.objectContaining({ path: "primary.0.dateOfBirth" })]));
  await expect(page.locator('ul[aria-live="polite"]')).toContainText(/Date of birth/i);
  expect(downloads).toEqual([]);
});
