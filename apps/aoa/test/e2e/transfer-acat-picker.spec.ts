import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

// This mounts the production picker, not a hand-written UI replica. Network,
// server writes and Next refresh are isolated: persistence still needs dev UAT.
async function setup(page: Page, mode = "ok") {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  const bundle = await build({
    stdin: { contents: `
      import {createRoot} from 'react-dom/client';
      import {TransferAcatPicker} from './components/transfers/TransferAcatPicker';
      import {AcatLinkCta} from './components/transfers/AcatLinkCta';
      window.pickerTest = { loadMode: ${JSON.stringify(mode)}, saveMode:'ok', reads:0, writes:[], refreshes:0 };
      createRoot(document.getElementById('root')).render(<>
        <h1>Example Client · Asset Transfer</h1>
        <p>Synthetic component test. No real records, source requests or submissions.</p>
        <section aria-label="Information entry"><TransferAcatPicker transferId="synthetic-transfer" variant="inline"/></section>
        <section aria-label="Status entry"><AcatLinkCta transferId="synthetic-transfer"/></section>
      </>);
    `, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, outdir: "unused-picker-output",
    platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    alias: { "@": process.cwd() },
    plugins: [{ name: "isolate-acat-picker-boundaries", setup(builder) {
      builder.onResolve({ filter: /asset-transfer\/acat-picker-actions$/ }, () => ({ path: "actions", namespace: "synthetic" }));
      builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "synthetic" }));
      builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "synthetic" }));
      builder.onLoad({ filter: /.*/, namespace: "synthetic" }, (args) => ({
        loader: "jsx", resolveDir: process.cwd(), contents: args.path === "actions" ? `
          const base = {clientName:'Adah Example',transferringCustodian:'Illustrative Brokerage',statementAccountMasked:'••••7788',receivingAccountMasked:'••••2267',accountType:'Traditional IRA',transferType:'FULL',direction:'INCOMING',status:'SUBMITTED',acatDate:'2026-09-24',amountCents:18000000,unavailableReason:null};
          export async function loadTransferAcatCandidates(id) {
            window.pickerTest.reads++;
            if (window.pickerTest.loadMode === 'reject') throw new Error('Synthetic network interruption');
            if (window.pickerTest.loadMode === 'error') return {ok:false,message:'Tracker unavailable. Retry loading the records.'};
            return {ok:true,destination:{id,clientName:'Adah Example',householdName:'Example Household',confirmationKey:'destination-key'},candidates:window.pickerTest.loadMode === 'empty' ? [] : [
              {...base,recordId:'record-alpha',confirmationKey:'key-alpha'},
              {...base,recordId:'record-beta',statementAccountMasked:'••••3275',confirmationKey:'key-beta'},
              {...base,recordId:'record-linked',clientName:'Morgan Sample',transferringCustodian:'Other Brokerage',confirmationKey:'key-linked',unavailableReason:'Already linked to another transfer.'}
            ]};
          }
          export async function linkAcatRecordToTransfer(transferId,input) {
            window.pickerTest.writes.push({transferId,input});
            if (window.pickerTest.saveMode === 'reject') throw new Error('Synthetic interrupted save');
            if (window.pickerTest.saveMode === 'error') return {ok:false,message:'This ACAT is already linked to a transfer.'};
            if (window.pickerTest.saveMode === 'defer') return await new Promise(resolve => {window.finishPickerSave=resolve;});
            return {ok:true};
          }
        ` : args.path === "navigation" ? `
          const router={refresh:()=>{window.pickerTest.refreshes++;}};
          export const useRouter=()=>router;
        ` : `import {createElement} from 'react'; export default function Link({children,...props}){return createElement('a',props,children);}`,
      }));
    } }],
  });
  await page.setContent('<html><body><main id="root"></main></body></html>');
  await page.addStyleTag({ content: readFileSync("app/globals.css", "utf8") });
  await page.addStyleTag({ content: ':root{--font-sans:sans-serif;--font-serif:Georgia;--font-mono:monospace}#root{max-width:1200px;margin:auto;padding:24px;display:grid;gap:24px}h1{font-size:26px}' });
  for (const file of bundle.outputFiles) {
    if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text });
    if (file.path.endsWith(".js")) await page.addScriptTag({ content: file.text });
  }
  await expect(page.getByRole("heading", { name: "Example Client · Asset Transfer" })).toBeVisible();
  return { errors, requests };
}

type FixtureState = { loadMode: string; saveMode: string; reads: number; writes: unknown[]; refreshes: number };
const state = (page: Page) => page.evaluate(() => (window as unknown as { pickerTest: FixtureState }).pickerTest);
const change = (page: Page, next: Partial<FixtureState>) => page.evaluate((value) => Object.assign((window as unknown as { pickerTest: FixtureState }).pickerTest, value), next);
const launch = (page: Page) => page.getByRole("region", { name: "Status entry" }).getByRole("button", { name: "Find and link ACAT", exact: true });
const dialog = (page: Page) => page.getByRole("dialog");

test("both entry points open the same contextual picker without navigation or saves", async ({ page }) => {
  const observed = await setup(page);
  const buttons = page.getByRole("button", { name: "Find and link ACAT", exact: true });
  await expect(buttons).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    await buttons.nth(i).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole("radio")).toHaveCount(3);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).not.toBeVisible();
    await expect(buttons.nth(i)).toBeFocused();
  }
  expect((await state(page)).writes).toEqual([]);
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
});

const search = (page: Page) => dialog(page).getByRole("searchbox", { name: "Search ACAT records" });
const alpha = (page: Page) => dialog(page).getByRole("radio", { name: /Select Adah Example.*7788/ });
const confirm = (page: Page) => dialog(page).getByRole("checkbox", { name: "I confirmed this ACAT belongs to this transfer", exact: true });
const submit = (page: Page) => dialog(page).getByRole("button", { name: "Link ACAT to this transfer", exact: true });

test("search disambiguates accounts; review and confirmation are required; success refreshes only once", async ({ page }) => {
  const observed = await setup(page);
  await launch(page).click();
  await expect(dialog(page).getByRole("radio")).toHaveCount(3);
  await expect(submit(page)).toBeDisabled();
  await expect(dialog(page).getByRole("radio", { name: /Morgan Sample/ })).toBeDisabled();
  await search(page).fill("illustrative 2266");
  await expect(dialog(page).getByRole("radio")).toHaveCount(1);
  await dialog(page).getByRole("radio").check();
  await expect(dialog(page).getByRole("heading", { name: "Review this link" })).toBeVisible();
  await expect(dialog(page).getByText("Example Household", { exact: true })).toBeVisible();
  await expect(submit(page)).toBeDisabled();
  expect((await state(page)).writes).toEqual([]);
  await confirm(page).check();
  await search(page).fill("7788");
  await alpha(page).check();
  await expect(confirm(page)).not.toBeChecked();
  await expect(submit(page)).toBeDisabled();
  await confirm(page).check();
  await submit(page).click();
  await expect(dialog(page)).not.toBeVisible();
  expect((await state(page)).writes).toEqual([{ transferId: "synthetic-transfer", input: {
    recordId: "record-alpha", confirmationKey: "key-alpha", destinationConfirmationKey: "destination-key", confirmed: true,
  } }]);
  expect((await state(page)).refreshes).toBe(1);
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
});

test("load failures are visible and retryable; empty and no-match states are distinct", async ({ page }) => {
  const observed = await setup(page, "reject");
  await launch(page).click();
  await expect(dialog(page).getByRole("alert")).toContainText("could not be loaded");
  await change(page, { loadMode: "error" });
  await dialog(page).getByRole("button", { name: "Try again", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Tracker unavailable");
  await change(page, { loadMode: "empty" });
  await dialog(page).getByRole("button", { name: "Try again", exact: true }).click();
  await expect(dialog(page).getByText(/No in-flight ACAT records are available to link/)).toBeVisible();
  await change(page, { loadMode: "ok" });
  await dialog(page).getByRole("button", { name: "Refresh records" }).click();
  await search(page).fill("not-a-matching-record");
  await expect(dialog(page).getByText(/No records match this search/)).toBeVisible();
  expect((await state(page)).writes).toEqual([]);
  expect(observed.errors).toEqual([]);
});

test("changing search clears a confirmed selection even when no records match", async ({ page }) => {
  const observed = await setup(page);
  await launch(page).click();
  await alpha(page).check();
  await confirm(page).check();
  await expect(submit(page)).toBeEnabled();
  await search(page).fill("not-a-matching-record");
  await expect(dialog(page).getByText(/No records match this search/)).toBeVisible();
  await expect(dialog(page).getByRole("heading", { name: "Review this link" })).toHaveCount(0);
  await expect(submit(page)).toBeDisabled();
  await search(page).fill("7788");
  await expect(alpha(page)).not.toBeChecked();
  await alpha(page).check();
  await expect(confirm(page)).not.toBeChecked();
  await expect(submit(page)).toBeDisabled();
  expect((await state(page)).writes).toEqual([]);
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
});

test("returned and thrown save errors stay inside the dialog and allow a fresh confirmed retry", async ({ page }) => {
  const observed = await setup(page);
  await launch(page).click();
  await alpha(page).check();
  await confirm(page).check();
  await change(page, { saveMode: "error" });
  await submit(page).click();
  await expect(dialog(page).getByRole("alert")).toContainText("already linked");
  await expect(confirm(page)).not.toBeChecked();
  await expect(submit(page)).toBeDisabled();
  await change(page, { saveMode: "reject" });
  await confirm(page).check();
  await submit(page).click();
  await expect(dialog(page).getByRole("alert")).toContainText("could not be confirmed");
  await expect(confirm(page)).not.toBeChecked();
  await dialog(page).getByRole("button", { name: "Refresh records" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Review this link" })).toHaveCount(0);
  await alpha(page).check();
  await confirm(page).check();
  await change(page, { saveMode: "ok" });
  await submit(page).click();
  await expect(dialog(page)).not.toBeVisible();
  expect((await state(page)).writes).toHaveLength(3);
  expect((await state(page)).refreshes).toBe(1);
  expect(observed.errors).toEqual([]);
});

test("pending confirmation cannot double-submit, close or select a different source", async ({ page }) => {
  const observed = await setup(page);
  await launch(page).click();
  await alpha(page).check();
  await confirm(page).check();
  await change(page, { saveMode: "defer" });
  await submit(page).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(dialog(page).getByRole("button", { name: "Linking…", exact: true })).toBeDisabled();
  await expect(dialog(page).getByRole("button", { name: "Close ACAT picker" })).toBeDisabled();
  await expect(alpha(page)).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeVisible();
  expect((await state(page)).writes).toHaveLength(1);
  await page.evaluate(() => (window as unknown as { finishPickerSave: (result: { ok: boolean }) => void }).finishPickerSave({ ok: true }));
  await expect(dialog(page)).not.toBeVisible();
  expect((await state(page)).refreshes).toBe(1);
  expect(observed.errors).toEqual([]);
});

test("keyboard focus stays in the picker, manual ID is secondary, and narrow layout remains usable", async ({ page }, testInfo) => {
  const observed = await setup(page);
  await launch(page).click();
  await alpha(page).check();
  await expect(dialog(page).getByRole("link", { name: "Enter an ID manually (advanced)" })).toHaveAttribute("href", "/asset-transfer/synthetic-transfer/edit?focus=acat#acat");
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("picker-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(confirm(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(await dialog(page).evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
  const box = await dialog(page).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await expect(submit(page)).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("picker-mobile.png") });
  await page.keyboard.press("Escape");
  await expect(launch(page)).toBeFocused();
  expect((await state(page)).writes).toEqual([]);
  expect(observed.errors).toEqual([]);
  expect(observed.requests).toEqual([]);
});
