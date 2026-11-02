import { readFile } from "node:fs/promises";
import { expect, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { PDFCheckBox, PDFDocument, PDFRadioGroup, PDFSignature, PDFTextField } from "pdf-lib";
import { signInOperations } from "./operations-browser-helpers";

export const portrait = (id: string) => `/client-portrait/${id}`;
export const generateResponse = (page: Page) => page.waitForResponse(response => response.url().endsWith("/api/forms/generate") && response.request().method() === "POST");

export async function blockExternalRequests(context: BrowserContext) {
  await context.route("**/*", route => new URL(route.request().url()).origin === "http://127.0.0.1:3103"
    ? route.continue() : route.abort("blockedbyclient"));
}

export async function openFormLibrary(page: Page) {
  const gallery = page.getByRole("region", { name: "Form Library", exact: true });
  await expect(gallery).toBeVisible();
  const disclosure = gallery.locator("details");
  const summary = disclosure.locator(":scope > summary");
  await expect(summary).toBeVisible();
  if (!(await disclosure.evaluate(element => (element as HTMLDetailsElement).open))) {
    await summary.click();
  }
  await expect(disclosure).toHaveJSProperty("open", true);
  return gallery;
}

export async function openForm(page: Page, clientId: string, linkName: string) {
  await signInOperations(page, portrait(clientId));
  await page.getByRole("link", { name: "Core Financial", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Form Library", exact: true })).toBeVisible();
  const gallery = await openFormLibrary(page);
  await gallery.getByRole("link", { name: linkName, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review and Completion", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
}

export async function expand(page: Page, title: string) {
  const summary = page.locator("summary").filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: ·|$)`) });
  const details = summary.locator("..");
  if (!(await details.getAttribute("open"))) {
    // HTML's boolean open attribute is the empty string when present.
    if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await summary.click();
  }
  return details;
}

export async function downloadPdf(page: Page, testInfo: TestInfo, filename: string) {
  const responsePromise = generateResponse(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Generate PDF", exact: true }).click();
  const [response, download] = await Promise.all([responsePromise, downloadPromise]);
  expect(response.status()).toBe(200);
  expect(response.headers()["x-aoa-review-state"]).toBe("ready_for_human_review");
  expect(response.headers()["x-aoa-client-completion-required"]).toBe("true");
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(download.suggestedFilename()).not.toMatch(/draft/i);
  const output = testInfo.outputPath(filename);
  await download.saveAs(output);
  await expect(page.getByRole("status")).toContainText("Values were not saved");
  await expect(page.getByRole("status")).toContainText("Form downloaded");
  return { pdf: await PDFDocument.load(await readFile(output)), response };
}

/** Literal expected field names below are independent of production mappings. */
export function verifyDraft(pdf: PDFDocument, pages: number, expected: Record<string, string>, checked: readonly string[] = []) {
  expect(pdf.getPageCount()).toBe(pages);
  expect(pdf.getTitle()).not.toMatch(/\bdraft\b/i);
  expect(pdf.getSubject()).toMatch(/human review/i);
  const form = pdf.getForm();
  for (const [name, value] of Object.entries(expected)) expect(form.getTextField(name).getText() ?? "", name).toBe(value);
  for (const field of form.getFields()) {
    if (field instanceof PDFTextField) expect(field.getText() ?? "", field.getName()).toBe(expected[field.getName()] ?? "");
    if (field instanceof PDFCheckBox) expect(field.isChecked(), field.getName()).toBe(checked.includes(field.getName()));
    if (field instanceof PDFRadioGroup) expect(field.getSelected(), field.getName()).toBeUndefined();
    if (field instanceof PDFSignature) expect(field.acroField.V(), field.getName()).toBeUndefined();
  }
}
