import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";

declare global {
  interface Window {
    preparationTest: {
      requests: { recordId: string }[];
      respond(index: number, scenario?: string): void;
      reject(index: number): void;
    };
  }
}

// Every source response is synthetic. The actual component, catalog and pure
// resolver run in the browser; only the authenticated server action is stubbed.
test.beforeEach(async ({ page, context }) => {
  await context.route("**/*", (route) => route.abort());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const result = await build({
    stdin: { contents: `
      import { createElement, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { TransferPreparationPanel } from './components/transfers/TransferPreparationPanel';
      import { resolveTransferPreparation } from './lib/transfers/transfer-preparation';
      import { libraryFixture } from './test/fixtures/custodian-library';
      const example = libraryFixture.custodians[0];
      const library = { ...libraryFixture, custodians: [
        { ...example, id: 'synthetic-brokerage', name: 'Example Brokerage', transferType: 'ACAT_API', fees: [] },
        { ...example, id: 'synthetic-empower', name: 'Empower / Pershing', transferType: 'MIXED', fees: [] },
        { ...example, id: 'synthetic-victory', name: 'Victory Funds', fees: [] },
        { ...example, id: 'synthetic-unknown', name: 'Unknown Example Custodian', fees: [], watchouts: 'Synthetic long conditional note. '.repeat(80) },
      ] };
      window.preparationTest = {
        requests: [],
        respond(index, scenario = 'empower') {
          const request = this.requests[index];
          if (['forbidden', 'invalid', 'not_found', 'unavailable'].includes(scenario)) {
            request.resolve({ ok: false, reason: scenario }); return;
          }
          const context = { recordId: request.recordId, library, record: {
            direction: scenario === 'brokerage' ? 'IN' : 'Incoming',
            type: scenario === 'brokerage' ? 'PARTIAL' : 'Full account transfer', accountType: 'IRA',
            transferringContra: scenario === 'brokerage' ? 'Example Brokerage'
              : scenario === 'unknown' ? 'Unknown Example Custodian'
              : scenario === 'victory' ? 'Victory Funds' : 'Empower / Pershing',
          } };
          request.resolve({ ok: true, context, preparation: resolveTransferPreparation(context), checkedAt: '2026-09-22T16:00:00.000Z' });
        },
        reject(index) { this.requests[index].reject(new Error('Synthetic source failure')); },
      };
      function Fixture() {
        const [recordId, setRecordId] = useState('record-without-acat-id');
        return createElement('div', null,
          createElement('h1', null, 'Transfer details'),
          createElement('button', { onClick: () => setRecordId('record-two') }, 'Show another record'),
          createElement(TransferPreparationPanel, { recordId }));
      }
      createRoot(document.getElementById('root')).render(createElement(Fixture));
    `, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, outdir: "unused-transfer-preparation-output",
    format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    alias: { "@": process.cwd() },
    plugins: [{
      name: "synthetic-preparation-action",
      setup(bundler) {
        bundler.onResolve({ filter: /\/form-actions$/ }, () => ({ path: "form-actions", namespace: "fixture-form" }));
        bundler.onLoad({ filter: /.*/, namespace: "fixture-form" }, () => ({ loader: "js", contents: `
          export async function loadTransferForm() { return { ok: false, reason: 'disabled' }; }
          export async function confirmReceivingTitle() { throw new Error('Unexpected confirmation'); }
          export async function generateTransferForm() { throw new Error('Unexpected generation'); }
          export async function updateTransferScope() { throw new Error('Unexpected scope update'); }
        ` }));
        bundler.onResolve({ filter: /preparation-actions$/ }, () => ({ path: "preparation-actions", namespace: "fixture" }));
        bundler.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: `
          export function loadTransferPreparation(recordId) {
            return new Promise((resolve, reject) => window.preparationTest.requests.push({ recordId, resolve, reject }));
          }
        ` }));
      },
    }],
  });
  await page.setContent('<html><body><main id="root" style="padding:16px;max-width:560px;margin:auto"></main></body></html>');
  await page.addStyleTag({ content: readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8") });
  await page.addStyleTag({ content: ':root { --font-sans: sans-serif; --font-serif: Georgia; --font-mono: monospace; }' });
  for (const file of result.outputFiles) {
    if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text });
    if (file.path.endsWith(".js")) await page.addScriptTag({ content: file.text });
  }
  await expect.poll(async () => errors.length ? errors.join("; ") : await page.getByText("Review transfer requirements", { exact: true }).count()).toBe(1);
});

async function openAndRespond(page: Page, scenario = "empower", index = 0) {
  await page.getByText("Review transfer requirements", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.preparationTest.requests.length)).toBe(index + 1);
  await page.evaluate(({ index, scenario }) => window.preparationTest.respond(index, scenario), { index, scenario });
  await expect(page.getByText("Review required", { exact: true })).toBeVisible();
}

test("loads only on expansion, supports keyboard choices and keeps the plan unsaved", async ({ page }, testInfo) => {
  expect(await page.evaluate(() => window.preparationTest.requests.length)).toBe(0);
  const summary = page.getByText("Review transfer requirements", { exact: true });
  await summary.focus();
  await expect(summary).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Checking the transfer and custodian library…");
  expect(await page.evaluate(() => window.preparationTest.requests[0].recordId)).toBe("record-without-acat-id");
  await page.evaluate(() => window.preparationTest.respond(0));
  const route = page.getByLabel("Form route for this draft", { exact: false });
  await expect(route).toBeVisible();
  await expect(page.getByText("No form selected.", { exact: false })).toBeVisible();
  await route.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await route.selectOption("empower-direct-rollover");
  await expect(page.getByText("Manual preparation required.", { exact: false })).toBeVisible();
  await expect(page.getByText("Review required", { exact: true })).toBeVisible();
  await page.getByText(/^Proposed tasks ·/).click();
  await expect(page.getByText("Review this plan with CS and Operations. No tasks have been created or assigned.")).toBeVisible();
  await expect(page.locator("li").filter({ has: page.getByText("CS", { exact: true }) }).first()).toBeVisible();
  await expect(page.locator("li").filter({ has: page.getByText("Operations", { exact: true }) }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /save|submit|generate|create task/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Custodian library and fees" })).toHaveAttribute("href", "/acat-tracking?view=library");
  await expect(page.getByRole("link", { name: /Open Transfer Tracker/ })).toHaveAttribute("rel", "noopener noreferrer");
  await page.screenshot({ path: testInfo.outputPath("transfer-preparation-desktop.png"), fullPage: true });
});

test("ordinary partial transfer identifies paperwork and keeps position choices for review", async ({ page }, testInfo) => {
  await openAndRespond(page, "brokerage");
  await expect(page.getByText("Incoming", { exact: true })).toBeVisible();
  await expect(page.getByText("Partial", { exact: true })).toBeVisible();
  await expect(page.getByText("Apex Customer Account Transfer Request", { exact: true })).toBeVisible();
  await expect(page.getByText(/Confirm which positions, quantities and cash/)).toBeVisible();
  await expect(page.getByText("Review required", { exact: true })).toBeVisible();
  await page.getByText(/^Proposed tasks ·/).click();
  await expect(page.getByText("Review this plan with CS and Operations. No tasks have been created or assigned.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("transfer-preparation-partial.png"), fullPage: true });
});

test("refresh clears previous output and draft choices before a failed source responds", async ({ page }) => {
  await openAndRespond(page);
  await page.getByLabel("Form route for this draft", { exact: false }).selectOption("empower-direct-rollover");
  await page.getByRole("button", { name: "Refresh source" }).click();
  await expect(page.getByText("Manual preparation required.", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Review required", { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.preparationTest.respond(1, "unavailable"));
  await expect(page.getByRole("alert")).toContainText("Transfer requirements are unavailable.");
  await page.getByRole("button", { name: "Refresh source" }).click();
  await page.evaluate(() => window.preparationTest.respond(2));
  await expect(page.getByLabel("Form route for this draft", { exact: false })).toHaveValue("");
  await expect(page.getByText("No form selected.", { exact: false })).toBeVisible();
});

test("changing custodian resets the route and a different record resets the disclosure", async ({ page }) => {
  await openAndRespond(page);
  await page.getByLabel("Form route for this draft", { exact: false }).selectOption("empower-direct-rollover");
  await page.getByLabel("Custodian for this draft", { exact: false }).selectOption("synthetic-victory");
  await expect(page.getByText("Manual preparation required.", { exact: false })).toHaveCount(0);
  await page.getByLabel("Custodian for this draft", { exact: false }).selectOption("synthetic-empower");
  await expect(page.getByLabel("Form route for this draft", { exact: false })).toHaveValue("");
  await page.getByRole("button", { name: "Show another record" }).click();
  await expect(page.getByLabel("Custodian for this draft", { exact: false })).toHaveCount(0);
  await expect(page.locator("details").first()).toHaveJSProperty("open", false);
  await openAndRespond(page, "victory", 1);
  await expect(page.getByLabel("Custodian for this draft", { exact: false })).toHaveValue("");
  expect(await page.evaluate(() => window.preparationTest.requests[1].recordId)).toBe("record-two");
});

test("an old response cannot overwrite a new record", async ({ page }) => {
  await page.getByText("Review transfer requirements", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.preparationTest.requests.length)).toBe(1);
  await page.getByRole("button", { name: "Show another record" }).click();
  await openAndRespond(page, "victory", 1);
  await page.evaluate(() => window.preparationTest.respond(0));
  await expect(page.getByLabel("Form route for this draft", { exact: false })).toHaveCount(0);
  await expect(page.locator("dd").filter({ hasText: /^Victory Funds$/ })).toBeVisible();
});

test("a rejected action is recoverable and a forbidden response shows no requirements", async ({ page }) => {
  await page.getByText("Review transfer requirements", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.preparationTest.requests.length)).toBe(1);
  await page.evaluate(() => window.preparationTest.reject(0));
  await expect(page.getByRole("alert")).toContainText("Transfer requirements are unavailable.");
  await page.getByRole("button", { name: "Refresh source" }).click();
  await page.evaluate(() => window.preparationTest.respond(1, "forbidden"));
  await expect(page.getByRole("alert")).toContainText("You don't have access");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByText("Review required", { exact: true })).toHaveCount(0);
});

test("unknown routes and long source notes remain readable on narrow screens", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAndRespond(page, "unknown");
  await expect(page.getByText("No form selected.", { exact: false })).toBeVisible();
  await expect(page.getByText("Review required", { exact: true })).toBeVisible();
  await expect(page.getByText(/ready for generation|ready to submit/i)).toHaveCount(0);
  await page.getByText("Source requirements and notes", { exact: true }).click();
  await expect(page.getByText("Synthetic long conditional note.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("transfer-preparation-mobile.png"), fullPage: true });
});
