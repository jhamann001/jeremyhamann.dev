import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ConfirmReceivingTitle, GenerateTransferForm, UpdateTransferScope } from "../../lib/transfers/transfer-form-contract";

declare global {
  interface Window {
    formTest: {
      loads: string[];
      detailLoads: string[];
      preparationLoads: string[];
      nextDetail: string;
      confirmations: ConfirmReceivingTitle[];
      generations: GenerateTransferForm[];
      scopeUpdates: UpdateTransferScope[];
      nextScope: string;
      scopeNotifications: number;
      scopeCallbackThrows: boolean;
      unlinks: { transferId: string; recordId: string }[];
      nextConfirm: string;
      nextGenerate: string;
      nextLoad: string;
      deferred: (() => void)[];
    };
  }
}

test.beforeEach(async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) => new URL(route.request().url()).hostname === "transfer-form.test"
    ? route.fulfill({ contentType: "text/html", body: '<html><body><main id="root" style="padding:16px;max-width:560px;margin:auto"></main></body></html>' })
    : route.abort());
  await page.goto("http://transfer-form.test");
  // The test origin is intentionally synthetic and contains no secrets. A
  // deterministic UUID shim replaces the secure-context-only browser method.
  await page.evaluate(() => {
    let nextId = 0;
    Object.defineProperty(crypto, "randomUUID", { value: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}` });
  });
  const bundle = await build({
    stdin: { contents: `
      import { createElement, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { TransferFormPanel } from './components/transfers/TransferFormPanel';
      import { AcatTrackingList } from './components/transfers/AcatTrackingList';
      import { resolveTransferPreparation } from './lib/transfers/transfer-preparation';
      import { libraryFixture } from './test/fixtures/custodian-library';
      const now = '2026-09-25T12:00:00.000Z';
      function fixture(mode) {
        const confirmation = { id: 'confirmation-one', title: 'Morgan Example IRA', registration: 'Traditional IRA', confirmedBy: 'operator@example.test', confirmedAt: now, valid: true, source: 'AOA' };
        return {
          schemaVersion: 1, recordId: mode + '-record', sourceRevision: 'a'.repeat(64), checkedAt: now,
          transferMethod: mode === 'manual' ? 'MANUAL' : mode === 'unknown' || mode === 'unclassified' ? 'UNCLASSIFIED' : 'ACAT',
          direction: mode === 'outgoing' ? 'OUTGOING' : 'INCOMING', scope: mode.startsWith('partial') ? 'PARTIAL' : 'FULL',
          custodian: mode === 'unknown' ? null : { id: 'example-custodian', name: 'Example Brokerage' },
          accounts: { receivingMasked: '****1234', deliveringMasked: '****5678', receivingTitleSuggestion: 'Morgan Example IRA', deliveringTitleSuggestion: 'Morgan Example Traditional IRA', registrationSuggestion: mode === 'no-registration' ? null : 'Traditional IRA' },
          confirmation: mode === 'no-registration' || mode === 'unconfirmed' ? null : mode === 'unknown-registration' ? { ...confirmation, registration: 'Indivdual' } : mode === 'alias-registration' ? { ...confirmation, registration: 'Brokerage / Individual' } : mode === 'legacy' ? { ...confirmation, id: null, valid: false, source: 'TRACKER_LEGACY' } : mode === 'changed' ? { ...confirmation, valid: false } : confirmation,
          workflows: mode === 'unknown' ? [] : mode === 'manual' ? [
            { id: 'automated', name: 'Example via carrying firm', automated: true, requiresReceivingAccountNumber: false, handling: { mode: 'CLIENT_DIRECTED', options: ['IN_KIND', 'LIQUIDATE'] }, note: null },
            { id: 'manual', name: 'Example direct rollover', automated: false, requiresReceivingAccountNumber: false, handling: { mode: 'CLIENT_DIRECTED', options: ['IN_KIND', 'LIQUIDATE'] }, note: 'Synthetic manual route' },
          ] : [{ id: 'brokerage', name: 'Example brokerage transfer', automated: true, requiresReceivingAccountNumber: mode === 'house', handling: { mode: mode === 'house' ? 'FIXED' : 'CLIENT_DIRECTED', options: mode === 'house' ? ['LIQUIDATE'] : ['IN_KIND', 'LIQUIDATE'] }, note: null }],
          positions: [...(mode === 'partial-mixed' ? [{ id: 'position-excluded', symbol: 'EXCLUDED', description: 'Excluded example holding', quantity: 30, include: false }] : []), { id: 'position-one', symbol: 'DEMO', description: 'Synthetic holding', quantity: 10, include: true }, { id: 'position-two', symbol: 'SAMPLE', description: 'Another synthetic holding', quantity: 20, include: mode === 'partial-undecided' || mode === 'full-undecided' ? null : mode === 'partial-selected' || mode === 'full-stale-flags' ? false : true }],
          inheritedTitleReview: mode === 'inherited',
          requirements: [{ label: 'Signature', value: 'Synthetic instruction: review the current form' }], notices: ['Synthetic example only'],
          blockers: mode === 'blocked' ? [{ code: 'missing-source', message: 'Verify the source custodian record.' }] : [],
          documents: [{ id: 'document-old', filename: 'Prior synthetic transfer.pdf', createdBy: 'operator@example.test', createdAt: now, sha256: 'c'.repeat(64) }], ruleVersion: 'synthetic-rules-v1',
        };
      }
      let current = fixture('full');
      const confirmations = new Map(); const documents = new Map(); const scopes = new Map();
      window.formTest = {
        loads: [], detailLoads: [], preparationLoads: [], nextDetail: '', confirmations: [], generations: [], scopeUpdates: [], nextScope: '', scopeNotifications: 0, scopeCallbackThrows: false, unlinks: [], nextConfirm: '', nextGenerate: '', nextLoad: '', deferred: [],
        async unlink(transferId, input) {
          this.unlinks.push({ transferId, recordId: input.recordId });
          return { ok: true };
        },
        async load(recordId) {
          this.loads.push(recordId);
          const mode = recordId.replace(/-record$/, '');
          if (mode === 'disabled' || mode === 'forbidden') return { ok: false, reason: mode };
          if (current.recordId !== recordId) current = fixture(mode);
          const result = { ok: true, data: structuredClone(current) };
          const next = this.nextLoad; this.nextLoad = '';
          if (next === 'defer') return new Promise(resolve => this.deferred.push(() => resolve(result)));
          if (next) return { ok: false, reason: next };
          return result;
        },
        async detail(recordId) {
          this.detailLoads.push(recordId);
          if (current.recordId !== recordId) current = fixture(recordId.replace(/-record$/, ''));
          const next = this.nextDetail; this.nextDetail = '';
          const result = { ok: true, status: { acatTransferId: recordId, controlNumber: 'SYNTHETIC', direction: 'Incoming', type: current.scope, accountType: 'IRA', status: 'SUBMITTED', transferringContra: 'Example Brokerage', statementAmount: 10000, methodRequested: 'ACAT', feeCharged: false, feeAmount: 0, acatDate: '2026-09-25', apexAccountId: '****1234', statementAccountNumber: '****5678', dtccNumber: null, assets: [] } };
          if (next === 'defer') return new Promise(resolve => this.deferred.push(() => resolve(result)));
          if (next === 'error') return { ok: false, reason: 'error' };
          return result;
        },
        async preparation(recordId) {
          this.preparationLoads.push(recordId);
          const library = { ...libraryFixture, custodians: [{ ...libraryFixture.custodians[0], name: 'Example Brokerage', transferType: 'ACAT_API' }] };
          const context = { recordId, library, record: { direction: 'IN', type: current.scope, accountType: 'IRA', transferringContra: 'Example Brokerage' } };
          return { ok: true, context, preparation: resolveTransferPreparation(context), checkedAt: now };
        },
        async confirm(recordId, input) {
          this.confirmations.push(structuredClone(input));
          if (confirmations.has(input.operationId)) return confirmations.get(input.operationId);
          const next = this.nextConfirm; this.nextConfirm = '';
          if (next && next !== 'lost') return { ok: false, reason: next };
          current = { ...current, sourceRevision: 'b'.repeat(64), confirmation: { id: 'saved-confirmation', title: input.title, registration: input.registration, confirmedBy: 'reviewer@example.test', confirmedAt: now, valid: true, source: 'AOA' } };
          const result = { ok: true, data: structuredClone(current) };
          confirmations.set(input.operationId, result);
          if (next === 'lost') throw new Error('Synthetic lost confirmation response');
          return result;
        },
        async scope(recordId, input) {
          this.scopeUpdates.push(structuredClone(input));
          if (scopes.has(input.operationId)) return scopes.get(input.operationId);
          const next = this.nextScope; this.nextScope = '';
          if (next && next !== 'lost' && next !== 'defer') return { ok: false, reason: next };
          current = { ...current, scope: input.scope, sourceRevision: (12 + scopes.size).toString(16).padStart(64, '0') };
          const result = { ok: true, data: structuredClone(current) };
          scopes.set(input.operationId, result);
          if (next === 'lost') throw new Error('Synthetic lost scope response');
          if (next === 'defer') return new Promise(resolve => this.deferred.push(() => resolve(result)));
          return result;
        },
        async generate(recordId, input) {
          this.generations.push(structuredClone(input));
          if (documents.has(input.operationId)) return documents.get(input.operationId);
          const next = this.nextGenerate; this.nextGenerate = '';
          if (next && next !== 'lost') return { ok: false, reason: next };
          const documentId = 'generated-' + (documents.size + 1);
          const result = { ok: true, data: { documentId } };
          documents.set(input.operationId, result);
          current.documents.push({ id: documentId, filename: 'Generated synthetic transfer.pdf', createdBy: 'reviewer@example.test', createdAt: now, sha256: 'd'.repeat(64) });
          if (next === 'lost') throw new Error('Synthetic lost archive response');
          return result;
        },
      };
      function Fixture() {
        const [recordId, setRecordId] = useState('full-record');
        const [showTracking, setShowTracking] = useState(false);
        const [sourceCheckedAt, setSourceCheckedAt] = useState(1);
        const [groups, setGroups] = useState([{ label: 'Submitted', order: 1, tone: 'submitted', phase: 'ACTIVE', count: 1, rows: [{ id: 'full-record', acatTransferId: 'full-record', clientName: 'Synthetic Client', controlNumber: 'SYNTHETIC', direction: 'IN', type: 'FULL', accountType: 'IRA', status: 'SUBMITTED', transferringContra: 'Example Brokerage', statementAmount: 10000, acatDate: '2026-09-25', lastActivityAt: null, apexAccountId: '****1234', statementAccountNumber: '****5678', dtccNumber: null, assetMap: {}, linked: true, transferId: 'transfer-demo', needsAttention: false }] }]);
        return createElement('div', null,
          createElement('h1', null, 'Synthetic form preparation'),
          createElement('button', { onClick: () => setShowTracking(true) }, 'Show tracking list'),
          showTracking && createElement('button', { onClick: () => { setSourceCheckedAt(previous => previous + 1); setGroups(previous => previous.map(group => ({ ...group, rows: group.rows.map(row => ({ ...row, type: 'EXTERNAL UPDATE' })) }))); } }, 'Apply fresh group snapshot'),
          createElement('label', null, 'Example record', createElement('select', { value: recordId, onChange: event => setRecordId(event.target.value) },
            ['full', 'partial-undecided', 'partial-selected', 'manual', 'unknown', 'unconfirmed', 'legacy', 'changed', 'disabled', 'forbidden', 'house', 'outgoing', 'blocked', 'inherited', 'full-stale-flags', 'no-registration', 'unknown-registration', 'alias-registration', 'partial-mixed', 'unclassified', 'full-undecided'].map(mode => createElement('option', { key: mode, value: mode + '-record' }, mode)))),
          showTracking ? createElement(AcatTrackingList, { groups, sourceCheckedAt, onUnlinked: () => setGroups(previous => previous.map(group => ({ ...group, rows: group.rows.map(row => ({ ...row, linked: false, transferId: null })) }))) }) : createElement(TransferFormPanel, { recordId, onScopeChanged: () => { window.formTest.scopeNotifications += 1; if (window.formTest.scopeCallbackThrows) throw new Error("Synthetic surrounding refresh failure"); } }));
      }
      createRoot(document.getElementById('root')).render(createElement(Fixture));
    `, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, outdir: "unused-transfer-form-output", format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" }, alias: { "@": process.cwd() },
    plugins: [{ name: "synthetic-form-actions", setup(bundler) {
      bundler.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture-link" }));
      bundler.onLoad({ filter: /.*/, namespace: "fixture-link" }, () => ({ loader: "js", resolveDir: process.cwd(), contents: `import { createElement } from 'react'; export default function Link({ children, ...props }) { return createElement('a', props, children); }` }));
      bundler.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture-navigation" }));
      bundler.onLoad({ filter: /.*/, namespace: "fixture-navigation" }, () => ({ loader: "js", contents: `export function useRouter() { return { refresh() { throw new Error('Unexpected route refresh during form preparation'); } }; }` }));
      bundler.onResolve({ filter: /acat-tracking\/actions$/ }, () => ({ path: "unlink-actions", namespace: "fixture-unlink" }));
      bundler.onLoad({ filter: /.*/, namespace: "fixture-unlink" }, () => ({ loader: "js", contents: `export const unlinkAcatFromExistingTransfer = (id, input) => window.formTest.unlink(id, input);` }));
      bundler.onResolve({ filter: /AcatLinkPicker$/ }, () => ({ path: "link-picker", namespace: "fixture-picker" }));
      bundler.onLoad({ filter: /.*/, namespace: "fixture-picker" }, () => ({ loader: "js", contents: `export function AcatLinkPicker() { return null; }` }));
      bundler.onResolve({ filter: /acat-lane-actions$/ }, () => ({ path: "detail-actions", namespace: "fixture-detail" }));
      bundler.onLoad({ filter: /.*/, namespace: "fixture-detail" }, () => ({ loader: "js", contents: `export const loadUnlinkedAcatDetail = id => window.formTest.detail(id);` }));
      bundler.onResolve({ filter: /preparation-actions$/ }, () => ({ path: "preparation-actions", namespace: "fixture-preparation" }));
      bundler.onLoad({ filter: /.*/, namespace: "fixture-preparation" }, () => ({ loader: "js", contents: `export const loadTransferPreparation = id => window.formTest.preparation(id);` }));
      bundler.onResolve({ filter: /\/form-actions$/ }, () => ({ path: "form-actions", namespace: "fixture" }));
      bundler.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: `
        export const loadTransferForm = recordId => window.formTest.load(recordId);
        export const confirmReceivingTitle = (recordId, input) => window.formTest.confirm(recordId, input);
        export const generateTransferForm = (recordId, input) => window.formTest.generate(recordId, input);
        export const updateTransferScope = (recordId, input) => window.formTest.scope(recordId, input);
      ` }));
    } }],
  });
  await page.addStyleTag({ content: readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8") });
  await page.addStyleTag({ content: ':root { --font-sans: sans-serif; --font-serif: Georgia; --font-mono: monospace; }' });
  for (const file of bundle.outputFiles) {
    if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text });
    if (file.path.endsWith(".js")) await page.addScriptTag({ content: file.text });
  }
  await expect.poll(async () => errors.length ? errors.join("; ") : await page.getByText("Prepare transfer form", { exact: true }).count()).toBe(1);
});

async function open(page: Page, mode?: string) {
  if (mode) await page.getByLabel("Example record").selectOption(`${mode}-record`);
  const count = await page.evaluate(() => window.formTest.loads.length);
  await page.getByText("Prepare transfer form", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.formTest.loads.length)).toBe(count + 1);
  await expect(page.getByText("Loading current form details…")).toHaveCount(0);
}

const reviewLabel = "I verified the delivering title and reviewed both accounts, selected holdings and transfer instructions.";

async function toReview(page: Page) {
  await page.getByRole("radio", { name: /Transfer in kind/ }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Review & generate/ })).toBeFocused();
}

async function review(page: Page) {
  await toReview(page);
  await page.getByLabel(reviewLabel, { exact: true }).check();
}

test("saved receiver skips ahead; each decision opens the next question and cancel preserves the saved title", async ({ page }, testInfo) => {
  expect(await page.evaluate(() => window.formTest.loads)).toEqual([]);
  await open(page);
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer scope:Full transfer");
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer method:ACAT (API)");
  await expect(page.getByText("Morgan Example IRA", { exact: true })).toBeVisible();
  await expect(page.getByText(/Confirmed by operator@example.test/)).toBeVisible();
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).not.toBeChecked();
  await expect(page.getByLabel(reviewLabel)).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Form route" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("transfer-form-guided.png"), fullPage: true });
  await page.getByRole("button", { name: "Edit receiving account" }).click();
  await page.getByLabel("Exact receiving account title", { exact: true }).fill("Changed draft only");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Morgan Example IRA", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).toBeVisible();
  expect(await page.evaluate(() => window.formTest.confirmations.length)).toBe(0);
  await review(page);
  await expect(page.getByRole("checkbox")).toHaveCount(1); // Only the final attestation is visible; optional LOA stays collapsed.
  await expect(page.getByRole("button", { name: "Generate form", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Change asset handling" }).click();
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).toBeChecked();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel(reviewLabel)).not.toBeChecked();
  await page.getByText("Prepare transfer form", { exact: true }).click();
  await open(page);
  await expect(page.getByRole("button", { name: "Edit receiving account" })).toBeVisible();
  expect(await page.evaluate(() => window.formTest.loads.length)).toBe(2);
});

test("explicit save advances immediately, preserves attribution on reopen and safely retries a lost response", async ({ page }) => {
  await open(page, "unconfirmed");
  const save = page.getByRole("button", { name: "Confirm and save", exact: true });
  await expect(save).toBeEnabled();
  await expect(page.getByText(/By selecting Confirm and save/)).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.evaluate(() => { window.formTest.nextConfirm = "lost"; });
  await save.click();
  await expect(page.getByRole("alert")).toContainText("Retry without changing your entries");
  await save.click();
  await expect(page.getByText("Receiving account confirmed and saved.")).toBeVisible();
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).not.toBeChecked();
  await expect(page.getByRole("heading", { name: /Asset handling/ })).toBeFocused();
  const saved = page.getByRole("region", { name: /Receiving account/ });
  await expect(saved).toContainText("Confirmed by reviewer@example.test");
  await expect(saved).toContainText("Confirmed at");
  const savedTime = await saved.locator("time").getAttribute("datetime");
  const inputs = await page.evaluate(() => window.formTest.confirmations);
  expect(inputs).toHaveLength(2);
  expect(inputs[0].operationId).toBe(inputs[1].operationId);
  expect(inputs[0]).toMatchObject({ confirmed: true, title: "Morgan Example IRA", registration: "Traditional IRA" });
  await page.getByText("Prepare transfer form", { exact: true }).click();
  await open(page);
  await expect(saved.locator("time")).toHaveAttribute("datetime", savedTime!);
  await expect(saved).toContainText("Confirmed by reviewer@example.test");
  await page.getByRole("button", { name: "Edit receiving account" }).click();
  await page.getByLabel("Exact receiving account title", { exact: true }).fill("Morgan Example Roth IRA");
  await save.click();
  const updated = await page.evaluate(() => window.formTest.confirmations);
  expect(updated[2].operationId).not.toBe(inputs[0].operationId);
});

test("full packet retries one archive operation and ends in a clear completed view", async ({ page }, testInfo) => {
  await open(page); await toReview(page);
  await page.getByText("Additional requirements", { exact: true }).click();
  await page.getByLabel("A separate Letter of Authorization is required for this packet.").check();
  await page.getByLabel(reviewLabel).check();
  await page.evaluate(() => { window.formTest.nextGenerate = "lost"; });
  const generate = page.getByRole("button", { name: "Generate form", exact: true });
  await generate.click();
  await expect(page.getByRole("alert")).toContainText("Retry without changing");
  await generate.click();
  const inputs = await page.evaluate(() => window.formTest.generations);
  expect(inputs).toHaveLength(2);
  expect(inputs[0].operationId).toBe(inputs[1].operationId);
  expect(inputs[0]).toMatchObject({ confirmationId: "confirmation-one", assetInstruction: "IN_KIND", deliveringTitleConfirmed: true, accountsReviewed: true, instructionsReviewed: true, letterOfAuthorizationRequired: true });
  await expect(page.getByRole("link", { name: "Open PDF ↗" })).toHaveAttribute("href", "/api/transfers/full-record/forms/generated-1");
  await expect(generate).toHaveCount(0);
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer scope:Full transfer");
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer method:ACAT (API)");
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.getByText("Previous forms · 2", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Generated synthetic transfer.pdf" })).toHaveAttribute("href", "/api/transfers/full-record/forms/generated-1");
  await page.screenshot({ path: testInfo.outputPath("transfer-form-generated.png"), fullPage: true });
  await page.getByRole("button", { name: "Prepare another form" }).click();
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).not.toBeChecked();
  await expect(page.getByRole("link", { name: "Open PDF ↗" })).toHaveCount(0);
});

test("partial undecided holdings are visible before any decision and included/excluded holdings are read only", async ({ page }) => {
  await open(page, "partial-undecided");
  await expect(page.getByText("Undecided holdings: 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("SAMPLE");
  await review(page);
  await expect(page.getByRole("cell", { name: "Undecided", exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Undecided", exact: true }) })).toContainText("SAMPLE");
  await expect(page.getByRole("button", { name: "Generate form" })).toBeDisabled();
  await open(page, "partial-selected"); await review(page);
  await expect(page.getByRole("cell", { name: "Excluded", exact: true })).toBeVisible();
  await expect(page.getByRole("table").getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Generate form" }).click();
  await expect(page.getByRole("link", { name: "Open PDF ↗" })).toHaveAttribute("href", "/api/transfers/partial-selected-record/forms/generated-1");
});

test("manual and unknown routes never expose an automated generation fallback", async ({ page }) => {
  await open(page, "manual");
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer method:Manual");
  await expect(page.getByRole("combobox", { name: "Form route", exact: true })).toHaveValue("");
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Form route", exact: true }).selectOption("manual");
  await expect(page.getByText("This route requires manual form preparation. Continue in Transfer Tracker.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate form" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Form route", exact: true }).selectOption("automated");
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer method:Manual");
  await expect(page.getByText("Manual processing; this form can still be generated here.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).not.toBeChecked();
  await open(page, "unknown");
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer method:Not yet classified");
  await expect(page.getByText("No supported route is available.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate form" })).toHaveCount(0);
  expect(await page.evaluate(() => window.formTest.generations.length)).toBe(0);
  await open(page, "unclassified");
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).toBeVisible();
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer method:Not yet classified");
});

test("stale responses require fresh decisions and keep prior archived forms accessible", async ({ page }) => {
  await open(page); await review(page);
  await page.evaluate(() => { window.formTest.nextGenerate = "stale"; });
  await page.getByRole("button", { name: "Generate form" }).click();
  await expect(page.getByRole("alert")).toContainText("The transfer changed.");
  await expect(page.getByRole("button", { name: "Generate form" })).toBeDisabled();
  await page.getByText("Previous forms · 1", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Prior synthetic transfer.pdf" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh details" }).click();
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).not.toBeChecked();
  await expect(page.getByLabel(reviewLabel)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit receiving account" })).toBeVisible();
});

test("history refresh failure preserves completed view without another generation", async ({ page }) => {
  await open(page); await review(page);
  await page.evaluate(() => { window.formTest.nextLoad = "unavailable"; });
  await page.getByRole("button", { name: "Generate form" }).click();
  await expect(page.getByRole("link", { name: "Open PDF ↗" })).toHaveAttribute("href", "/api/transfers/full-record/forms/generated-1");
  await expect(page.getByRole("status")).toContainText("PDF was generated and archived");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => window.formTest.generations.length)).toBe(1);
  await expect(page.getByRole("button", { name: "Generate form" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Prepare another form" })).toBeVisible();
});

test("outgoing transfers and source blockers cannot generate after final review", async ({ page }) => {
  for (const mode of ["outgoing", "blocked"]) {
    await open(page, mode); await review(page);
    await expect(page.getByRole("button", { name: "Generate form" })).toBeDisabled();
  }
  await expect(page.getByText("Verify the source custodian record.", { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => window.formTest.generations.length)).toBe(0);
});

test("legacy and changed receiving details require explicit save and preserve prior attribution", async ({ page }) => {
  for (const mode of ["legacy", "changed"]) {
    await open(page, mode);
    await expect(page.getByText(mode === "legacy" ? "Earlier Tracker confirmation — reconfirm" : "Receiving details changed — reconfirm", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm and save" })).toBeVisible();
    await expect(page.getByText(/Previous confirmation by operator@example.test/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate form" })).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0);
  }
  expect(await page.evaluate(() => window.formTest.confirmations.length)).toBe(0);
});

test("disabled and unauthorized integrations expose no writable controls", async ({ page }) => {
  await open(page, "disabled");
  await expect(page.getByRole("status")).toContainText("not connected in this environment");
  await expect(page.getByRole("button", { name: /Confirm and save|Generate form/ })).toHaveCount(0);
  await open(page, "forbidden");
  await expect(page.getByRole("alert")).toContainText("don't have access");
  await expect(page.getByRole("button", { name: /Confirm and save|Generate form/ })).toHaveCount(0);
  await expect(page.getByText(/Previous forms/)).toHaveCount(0);
});

test("a late source read cannot restore another record's information", async ({ page }) => {
  await page.evaluate(() => { window.formTest.nextLoad = "defer"; });
  await page.getByText("Prepare transfer form", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.formTest.loads.length)).toBe(1);
  await open(page, "forbidden");
  await page.evaluate(() => window.formTest.deferred[0]());
  await expect(page.getByRole("alert")).toContainText("don't have access");
  await expect(page.getByText("Morgan Example IRA", { exact: true })).toHaveCount(0);
});

test("fixed route asks only for house verification before final review and fits narrow screens", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "house");
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByLabel(reviewLabel)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.getByLabel("Receiving / house account number", { exact: true }).fill("DEMO-HOUSE");
  await page.getByLabel("I verified this number with Apex MF Ops.").check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText(/This route uses liquidation/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate form" })).toBeDisabled();
  await page.getByLabel(reviewLabel).check();
  await expect(page.getByRole("button", { name: "Generate form" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("transfer-form-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Generate form" }).click();
  const inputs = await page.evaluate(() => window.formTest.generations);
  expect(inputs[0]).toMatchObject({ assetInstruction: "LIQUIDATE", receivingAccountNumber: "DEMO-HOUSE", receivingAccountNumberVerified: true });
});

test("delivering title changes invalidate final review and inherited mismatch requires visible authorization", async ({ page }) => {
  await open(page, "inherited"); await review(page);
  const generate = page.getByRole("button", { name: "Generate form" });
  await expect(generate).toBeDisabled();
  await expect(page.getByText("Separate authorization required", { exact: true })).toBeVisible();
  await page.getByLabel("A separate Letter of Authorization is required for this packet.").check();
  await expect(page.getByLabel(reviewLabel)).not.toBeChecked();
  await page.getByLabel(reviewLabel).check();
  await expect(generate).toBeEnabled();
  await page.getByRole("button", { name: "Edit delivering title" }).click();
  await expect(page.getByLabel(reviewLabel)).not.toBeChecked();
  await page.getByLabel("Exact delivering account title", { exact: true }).fill("Morgan Example IRA");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Separate authorization required", { exact: true })).toHaveCount(0);
  await expect(generate).toBeDisabled();
  await page.getByLabel(reviewLabel).check();
  await generate.click();
  expect(await page.evaluate(() => window.formTest.generations[0].deliveringTitle)).toBe("Morgan Example IRA");
});

test("full transfer includes all holdings despite old partial flags", async ({ page }) => {
  await open(page, "full-stale-flags"); await toReview(page);
  await page.getByText("All assets in the delivering account", { exact: true }).click();
  await expect(page.getByRole("cell", { name: "Included", exact: true })).toHaveCount(2);
  await expect(page.getByRole("cell", { name: "Excluded", exact: true })).toHaveCount(0);
});


test("registration dropdown has no default, blocks unlisted types and sends a canonical selection", async ({ page }) => {
  await open(page, "no-registration");
  const registration = page.getByRole("combobox", { name: "Receiving registration", exact: true });
  const save = page.getByRole("button", { name: "Confirm and save", exact: true });
  await expect(registration).toHaveValue("");
  await expect(registration.locator("option:checked")).toHaveText("Choose a registration");
  await expect(save).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Receiving registration", exact: true })).toHaveCount(0);
  await registration.selectOption({ label: "Not listed — needs review" });
  await expect(save).toBeDisabled();
  await expect(page.getByText(/No change will be saved until a supported registration/)).toBeVisible();
  expect(await page.evaluate(() => window.formTest.confirmations)).toHaveLength(0);
  await registration.selectOption("Individual");
  await expect(save).toBeEnabled();
  await save.click();
  expect(await page.evaluate(() => window.formTest.confirmations[0])).toMatchObject({ registration: "Individual", confirmed: true, title: "Morgan Example IRA" });
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /Receiving account/ })).toContainText("Individual");
});

test("unknown saved registration cannot skip review even if old source says valid and is preserved until explicit save", async ({ page }) => {
  await open(page, "unknown-registration");
  const registration = page.getByRole("combobox", { name: "Receiving registration", exact: true });
  const save = page.getByRole("button", { name: "Confirm and save", exact: true });
  await expect(registration).toHaveValue("");
  await expect(page.getByText(/Previously saved: Morgan Example IRA · Indivdual/)).toBeVisible();
  await expect(page.getByText(/The saved registration needs review/)).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate form" })).toHaveCount(0);
  await expect(save).toBeDisabled();
  await registration.selectOption("Individual");
  await page.getByText("Prepare transfer form", { exact: true }).click();
  await open(page);
  await expect(page.getByText(/Previously saved: Morgan Example IRA · Indivdual/)).toBeVisible();
  await expect(registration).toHaveValue("");
  expect(await page.evaluate(() => window.formTest.confirmations)).toHaveLength(0);
  await registration.selectOption("Individual");
  await save.click();
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).toBeVisible();
  expect(await page.evaluate(() => window.formTest.confirmations[0].registration)).toBe("Individual");
});


test("approved saved registration aliases retain confirmation evidence and canonicalize only on explicit save", async ({ page }) => {
  await open(page, "alias-registration");
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /Receiving account/ })).toContainText("Brokerage / Individual");
  await page.getByRole("button", { name: "Edit receiving account" }).click();
  await expect(page.getByRole("combobox", { name: "Receiving registration", exact: true })).toHaveValue("Individual");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("region", { name: /Receiving account/ })).toContainText("Brokerage / Individual");
  expect(await page.evaluate(() => window.formTest.confirmations)).toHaveLength(0);
  await page.getByRole("button", { name: "Edit receiving account" }).click();
  await page.getByRole("button", { name: "Confirm and save", exact: true }).click();
  expect(await page.evaluate(() => window.formTest.confirmations[0].registration)).toBe("Individual");
});


async function chooseMixed(page: Page) {
  await page.getByRole("radio", { name: /Mix of in-kind and cash/ }).check();
  await page.getByRole("combobox", { name: "Instruction for DEMO", exact: true }).selectOption("IN_KIND");
  await page.getByRole("combobox", { name: "Instruction for SAMPLE", exact: true }).selectOption("LIQUIDATE");
}

test("mixed handling requires every included holding and reviews only their explicit instructions", async ({ page }, testInfo) => {
  await open(page, "partial-mixed");
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer scope:Partial transfer");
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer method:ACAT (API)");
  await page.getByRole("radio", { name: /Mix of in-kind and cash/ }).check();
  const demo = page.getByRole("combobox", { name: "Instruction for DEMO", exact: true });
  const sample = page.getByRole("combobox", { name: "Instruction for SAMPLE", exact: true });
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await expect(demo).toHaveValue("");
  await expect(sample).toHaveValue("");
  await expect(page.getByRole("combobox", { name: /Instruction for EXCLUDED/ })).toHaveCount(0);
  await expect(page.getByText(/Each choice applies to all shares of that selected holding/)).toBeVisible();
  await expect(page.getByText("Recorded quantity: 10", { exact: true })).toBeVisible();
  await expect(next).toBeDisabled();
  await demo.selectOption("IN_KIND");
  await expect(next).toBeDisabled();
  await sample.selectOption("IN_KIND");
  await expect(next).toBeDisabled();
  await expect(page.getByText(/A mix needs at least one holding in kind and one liquidated/)).toBeVisible();
  await sample.selectOption("LIQUIDATE");
  await next.click();
  await expect(page.getByText("1 in kind · 1 liquidated", { exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ has: page.getByRole("cell", { name: "In kind", exact: true }) })).toContainText("DEMO");
  await expect(page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Liquidate to cash", exact: true }) })).toContainText("SAMPLE");
  await expect(page.getByText("All shares of each included holding.", { exact: true })).toBeVisible();
  await page.getByLabel(reviewLabel).check();
  await page.screenshot({ path: testInfo.outputPath("transfer-form-mixed-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Generate form", exact: true }).click();
  const input = await page.evaluate(() => window.formTest.generations[0]);
  expect(input.assetInstruction).toBe("MIXED");
  expect(input.positionInstructions).toEqual([{ positionId: "position-one", assetInstruction: "IN_KIND" }, { positionId: "position-two", assetInstruction: "LIQUIDATE" }]);
});

test("mixed instruction edits clear final review and retry identity while unchanged retry remains safe", async ({ page }) => {
  await open(page, "partial-mixed"); await chooseMixed(page);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel(reviewLabel).check();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.evaluate(() => { window.formTest.nextGenerate = "unavailable"; });
    await page.getByRole("button", { name: "Generate form", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Retry without changing");
  }
  const earlier = await page.evaluate(() => window.formTest.generations);
  expect(earlier[0].operationId).toBe(earlier[1].operationId);
  await page.getByRole("button", { name: "Change asset handling" }).click();
  await expect(page.getByRole("combobox", { name: "Instruction for DEMO", exact: true })).toHaveValue("IN_KIND");
  await page.getByRole("combobox", { name: "Instruction for DEMO", exact: true }).selectOption("LIQUIDATE");
  await page.getByRole("combobox", { name: "Instruction for SAMPLE", exact: true }).selectOption("IN_KIND");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel(reviewLabel)).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Generate form", exact: true })).toBeDisabled();
  await page.getByLabel(reviewLabel).check();
  await page.getByRole("button", { name: "Generate form", exact: true }).click();
  const updated = await page.evaluate(() => window.formTest.generations);
  expect(updated[2].operationId).not.toBe(earlier[0].operationId);
  expect(updated[2].positionInstructions).toEqual([{ positionId: "position-one", assetInstruction: "LIQUIDATE" }, { positionId: "position-two", assetInstruction: "IN_KIND" }]);
});

test("mixed choice stays partial and client-directed; single holding is explained and refresh clears assignments", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("radio", { name: /Mix of in-kind and cash/ })).toHaveCount(0);
  await open(page, "house");
  await expect(page.getByRole("radio", { name: /Mix of in-kind and cash/ })).toHaveCount(0);
  await open(page, "partial-selected");
  await page.getByRole("radio", { name: /Mix of in-kind and cash/ }).check();
  await expect(page.getByText(/A mix needs at least two included holdings/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await open(page, "partial-undecided");
  await page.getByRole("radio", { name: /Mix of in-kind and cash/ }).check();
  await expect(page.getByRole("combobox", { name: "Instruction for SAMPLE", exact: true })).toHaveCount(0);
  await expect(page.getByText("Undecided holdings: 1", { exact: true })).toBeVisible();
  await open(page, "partial-mixed"); await chooseMixed(page);
  await page.getByRole("button", { name: "Refresh details", exact: true }).click();
  await expect(page.getByRole("radio", { name: /Mix of in-kind and cash/ })).not.toBeChecked();
  await page.getByRole("radio", { name: /Mix of in-kind and cash/ }).check();
  await expect(page.getByRole("combobox", { name: "Instruction for DEMO", exact: true })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Instruction for SAMPLE", exact: true })).toHaveValue("");
});


async function scopeChoice(page: Page, scope: "FULL" | "PARTIAL") {
  await page.getByRole("button", { name: "Change transfer scope", exact: true }).click();
  await page.getByRole("combobox", { name: "New transfer scope", exact: true }).selectOption(scope);
}

test("scope change cancels without saving and partial-to-full resets mixed decisions while retaining evidence", async ({ page }) => {
  await open(page, "partial-mixed"); await chooseMixed(page);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel(reviewLabel).check();
  const receivingTime = await page.getByRole("region", { name: /Receiving account/ }).locator("time").getAttribute("datetime");
  await scopeChoice(page, "FULL");
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer scope:Partial transfer");
  await expect(page.getByRole("button", { name: "Generate form", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh details", exact: true })).toBeDisabled();
  await expect(page.getByText(/including holdings previously excluded/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel scope change", exact: true }).click();
  expect(await page.evaluate(() => window.formTest.scopeUpdates)).toHaveLength(0);
  expect(await page.evaluate(() => window.formTest.scopeNotifications)).toBe(0);
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer scope:Partial transfer");
  await expect(page.getByText("1 in kind · 1 liquidated", { exact: true })).toBeVisible();
  await expect(page.getByLabel(reviewLabel)).not.toBeChecked();
  await scopeChoice(page, "FULL");
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer scope:Full transfer");
  await expect(page.getByRole("heading", { name: /Asset handling/ })).toBeFocused();
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).not.toBeChecked();
  await expect(page.getByRole("radio", { name: /Mix of in-kind and cash/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: /Receiving account/ }).locator("time")).toHaveAttribute("datetime", receivingTime!);
  expect(await page.evaluate(() => window.formTest.confirmations)).toHaveLength(0);
  await toReview(page);
  await page.getByText("All assets in the delivering account", { exact: true }).click();
  await expect(page.getByRole("cell", { name: "Included", exact: true })).toHaveCount(3);
  await expect(page.getByRole("cell", { name: "Excluded", exact: true })).toHaveCount(0);
  await scopeChoice(page, "PARTIAL");
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  await page.getByRole("radio", { name: /Mix of in-kind and cash/ }).check();
  await expect(page.getByRole("combobox", { name: "Instruction for DEMO", exact: true })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Instruction for SAMPLE", exact: true })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: /Instruction for EXCLUDED/ })).toHaveCount(0);
});

test("full-to-partial scope change restores undecided holdings and prevents generation", async ({ page }) => {
  await open(page, "full-undecided");
  await expect(page.getByText("Undecided holdings: 1", { exact: true })).toHaveCount(0);
  await scopeChoice(page, "PARTIAL");
  await expect(page.getByText(/uses the current holding selections in Tracker/)).toBeVisible();
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  await expect(page.getByText("Undecided holdings: 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("SAMPLE");
  await review(page);
  await expect(page.getByRole("button", { name: "Generate form", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.formTest.scopeUpdates[0])).toMatchObject({ scope: "PARTIAL", confirmed: true, expectedRevision: "a".repeat(64) });
});

test("scope change after generation retains the old archived form and receiving attribution", async ({ page }) => {
  await open(page); await review(page);
  await page.getByRole("button", { name: "Generate form", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open PDF ↗" })).toBeVisible();
  await scopeChoice(page, "PARTIAL");
  await expect(page.getByText(/Earlier PDFs keep their original scope/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare another form", exact: true })).toBeDisabled();
  await page.evaluate(() => { window.formTest.scopeCallbackThrows = true; });
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open PDF ↗" })).toHaveCount(0);
  expect(await page.evaluate(() => window.formTest.scopeNotifications)).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).not.toBeChecked();
  await expect(page.getByRole("region", { name: /Receiving account/ })).toContainText("Confirmed by operator@example.test");
  await page.getByText("Previous forms · 2", { exact: true }).click();
  const archive = page.getByRole("link", { name: "Generated synthetic transfer.pdf" });
  await expect(archive).toHaveAttribute("href", "/api/transfers/full-record/forms/generated-1");
  await expect(archive.locator("..")).toContainText("reviewer@example.test");
  await expect(page.getByRole("link", { name: "Prior synthetic transfer.pdf" })).toHaveAttribute("href", "/api/transfers/full-record/forms/document-old");
});

test("scope retries keep one operation until choices change and stale errors never update scope optimistically", async ({ page }) => {
  await open(page); await scopeChoice(page, "PARTIAL");
  await page.evaluate(() => { window.formTest.nextScope = "lost"; });
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Retry without changing");
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer scope:Full transfer");
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer scope:Partial transfer");
  const retries = await page.evaluate(() => window.formTest.scopeUpdates);
  expect(retries[0].operationId).toBe(retries[1].operationId);
  expect(await page.evaluate(() => window.formTest.scopeNotifications)).toBe(1);
  await scopeChoice(page, "FULL");
  await page.evaluate(() => { window.formTest.nextScope = "unavailable"; });
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  await page.getByRole("combobox", { name: "New transfer scope", exact: true }).selectOption("PARTIAL");
  await expect(page.getByRole("button", { name: "Save scope", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "New transfer scope", exact: true }).selectOption("FULL");
  await page.evaluate(() => { window.formTest.nextScope = "stale"; });
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The transfer changed.");
  await expect(page.getByLabel("Transfer scope and method")).toContainText("Transfer scope:Partial transfer");
  await expect(page.getByRole("button", { name: "Change transfer scope", exact: true })).toBeDisabled();
  const changed = await page.evaluate(() => window.formTest.scopeUpdates);
  expect(changed[2].operationId).not.toBe(changed[3].operationId);
  await page.getByRole("button", { name: "Refresh details", exact: true }).click();
  await expect(page.getByRole("button", { name: "Change transfer scope", exact: true })).toBeEnabled();
});

test("late scope responses cannot reveal another record and scope writes respect permissions", async ({ page }) => {
  await open(page); await scopeChoice(page, "PARTIAL");
  await page.evaluate(() => { window.formTest.nextScope = "defer"; });
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saving scope…", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel scope change", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.formTest.scopeUpdates)).toHaveLength(1);
  await open(page, "forbidden");
  await page.evaluate(() => window.formTest.deferred[0]());
  await expect(page.getByRole("alert")).toContainText("don't have access");
  await expect(page.getByLabel("Transfer scope and method")).toHaveCount(0);
  await open(page, "full-stale-flags"); await scopeChoice(page, "PARTIAL");
  await page.evaluate(() => { window.formTest.nextScope = "forbidden"; });
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("don't have access");
  await expect(page.getByLabel("Transfer scope and method")).toHaveCount(0);
  await expect(page.getByText(/Previous forms/)).toHaveCount(0);
});


test("scope save refreshes drawer and optional preview without remounting the guide or waiting on cached list rows", async ({ page }) => {
  await page.getByRole("button", { name: "Show tracking list", exact: true }).click();
  await page.getByRole("button", { name: /Synthetic Client/ }).click();
  await expect(page.getByRole("heading", { name: "Incoming · FULL", exact: true })).toBeVisible();
  await open(page);
  const formLoads = await page.evaluate(() => window.formTest.loads.length);
  await page.getByText("Review transfer requirements", { exact: true }).click();
  await expect(page.getByText("Full", { exact: true })).toBeVisible();
  await scopeChoice(page, "PARTIAL");
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Incoming · PARTIAL", exact: true })).toBeVisible();
  await expect(page.getByText(/^PARTIAL in/)).toBeVisible();
  await expect(page.getByText("Scope saved. Review the transfer instructions before generating a new form.", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Transfer in kind/ })).toBeVisible();
  expect(await page.evaluate(() => window.formTest.loads.length)).toBe(formLoads);
  expect(await page.evaluate(() => window.formTest.detailLoads.length)).toBe(2);
  await expect(page.getByText("Review transfer requirements", { exact: true }).locator("..")).toHaveJSProperty("open", false);
  await page.getByText("Review transfer requirements", { exact: true }).click();
  await expect(page.getByText("Partial", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.formTest.preparationLoads.length)).toBe(2);
  await page.getByRole("button", { name: "‹ Close", exact: true }).click();
  await expect(page.getByRole("button", { name: /Synthetic Client/ })).toContainText("PARTIAL");
  await page.evaluate(() => { window.formTest.nextDetail = "defer"; });
  await page.getByRole("button", { name: /Synthetic Client/ }).click();
  await expect(page.getByText(/^PARTIAL in/)).toBeVisible();
  await page.evaluate(() => window.formTest.deferred[0]());
  await expect(page.getByRole("heading", { name: "Incoming · PARTIAL", exact: true })).toBeVisible();
  // Unlink changes linkage, but reuses the same cached Tracker rows. Keep the
  // authoritative scope until a genuinely fresh source snapshot arrives.
  await page.getByRole("button", { name: "Unlink transfer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Unlink transfer", exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.formTest.unlinks)).toHaveLength(0);
  await page.getByRole("button", { name: "Unlink transfer", exact: true }).click();
  await page.getByRole("button", { name: "Unlink transfer", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Synthetic Client/ })).toContainText("PARTIAL");
  await expect(page.getByRole("button", { name: /Synthetic Client/ })).toContainText("Un-linked");
  expect(await page.evaluate(() => window.formTest.unlinks)).toEqual([{ transferId: "transfer-demo", recordId: "full-record" }]);
  await page.getByRole("button", { name: "Apply fresh group snapshot", exact: true }).click();
  await expect(page.getByRole("button", { name: /Synthetic Client/ })).toContainText("EXTERNAL UPDATE");
  await page.getByRole("button", { name: /Synthetic Client/ }).click();
  await expect(page.getByRole("heading", { name: "Incoming · PARTIAL", exact: true })).toBeVisible();
  await open(page);
  await scopeChoice(page, "FULL");
  await page.evaluate(() => { window.formTest.nextDetail = "error"; });
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  await expect(page.getByText(/^Full transfer in/)).toBeVisible();
  await expect(page.getByText("ACAT detail unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByText("Scope saved. Review the transfer instructions before generating a new form.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "‹ Close", exact: true }).click();
  await expect(page.getByRole("button", { name: /Synthetic Client/ })).toContainText("Full transfer");
});
