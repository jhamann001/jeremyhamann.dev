import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";
import { markCase } from "../acat-book-flywheel";

const actionsStub = path.join(process.cwd(), "test/e2e/stubs/custodian-admin-actions-stub.js");

async function bundleLibrary(contents: string) {
  return build({
    stdin: { contents, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, outdir: "unused-custodian-test-output",
    format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    alias: {
      "@": process.cwd(),
      "server-only": path.join(process.cwd(), "node_modules/next/dist/compiled/server-only/empty.js"),
      "@/app/(authenticated)/acat-tracking/custodian-admin-actions": actionsStub,
    },
  });
}

async function mountBundle(page: import("@playwright/test").Page, result: Awaited<ReturnType<typeof bundleLibrary>>) {
  await page.setContent('<html><body><main id="root" style="padding:20px;max-width:1440px;margin:auto"></main></body></html>');
  await page.addStyleTag({ content: readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8") });
  await page.addStyleTag({ content: ':root { --font-sans: sans-serif; --font-serif: Georgia; --font-mono: monospace; }' });
  for (const file of result.outputFiles) {
    if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text });
    if (file.path.endsWith(".js")) await page.addScriptTag({ content: file.text });
  }
}

test.describe("custodian library baseline", () => {
  // Synthetic component-only checks: real client code/CSS, no application server,
  // credentials, database or live Tracker reads.
  test.beforeEach(async ({ page, context }) => {
    const scriptErrors: string[] = [];
    page.on("pageerror", (error) => scriptErrors.push(error.message));
    await context.route("**/*", (route) => route.abort());
    const result = await bundleLibrary(`
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { CustodianLibrary } from './components/custodians/CustodianLibrary';
      import { AcatSectionNav } from './components/custodians/AcatSectionNav';
      import { libraryFixture } from './test/fixtures/custodian-library';
      const example = libraryFixture.custodians[0];
      const library = { ...libraryFixture, custodians: [
        example,
        { ...example, id: 'synthetic-two', name: 'Sample Trust & Clearing', transferType: 'MANUAL', fees: [] },
        { ...example, id: 'synthetic-three', name: 'Illustrative Brokerage With A Long Custodian Name', transferType: null, reviewStatus: 'NEEDS_SETUP', dtcNumber: null,
          watchouts: 'Synthetic instructions only. '.repeat(100) },
      ] };
      createRoot(document.getElementById('root')).render(createElement('div', null,
        createElement('h1', null, 'ACAT Tracking'),
        createElement(AcatSectionNav, { current: 'library' }),
        createElement('h2', null, 'Custodian Library'),
        createElement(CustodianLibrary, { library })));
    `);
    await mountBundle(page, result);
    await expect.poll(async () => scriptErrors.length ? scriptErrors.join("; ")
      : await page.getByRole("button", { name: "View Example Custodian playbook and fees" }).count()).toBe(1);
  });

  for (const width of [1440, 768, 390]) {
    test(`search, modal focus and overflow at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 950 });
      const search = page.getByRole("searchbox", { name: "Find a custodian" });
      const cards = page.getByRole("button", { name: /^View .+ playbook and fees$/ });
      await expect(cards).toHaveCount(3);
      const boxes = await cards.evaluateAll((elements) => elements.map((el) => {
        const b = el.getBoundingClientRect(); return { x: b.x, y: b.y };
      }));
      if (width >= 768) expect(boxes[0].y).toBe(boxes[1].y);
      else expect(boxes[0].y).toBeLessThan(boxes[1].y);
      const navLinks = await page.getByRole("navigation", { name: "ACAT workspace" }).getByRole("link").all();
      expect(navLinks).toHaveLength(1);
      for (const link of navLinks) {
        await expect(link).toHaveCSS("border-radius", "999px");
        expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      if (width === 1440) await page.screenshot({ path: testInfo.outputPath("custodian-grid-desktop.png"), fullPage: true });
      await search.fill("missing");
      await expect(page.getByText("No custodians match your search.")).toBeVisible();
      await expect(cards).toHaveCount(0);
      await search.fill("Example Custodian");
      await expect(cards).toHaveCount(1);
      const card = cards.first();
      await card.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Example Custodian" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("heading", { name: "Transfer playbook" })).toBeVisible();
      await expect(dialog.getByText("$0.00", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Varies", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Transfer into Apex", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Transfer out of Apex", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Close custodian details" })).toBeFocused();
      for (const key of ["Tab", "Tab", "Shift+Tab"]) {
        await page.keyboard.press(key);
        expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(card).toBeFocused();
      await expect.poll(() => page.locator("body").evaluate((el) => el.style.overflow)).toBe("");
      await card.click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Close custodian details" }).click();
      await expect(dialog).toHaveCount(0);
      await search.fill("");
      await expect(page.getByText("3 of 3 custodians")).toBeVisible();
      await expect(page.getByRole("button", { name: /save|edit|delete|submit/i })).toHaveCount(0);
    });
  }

  test("long notes stay inside the dialog on a narrow screen", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole("button", { name: /View Illustrative Brokerage/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    expect(box!.height).toBeLessThanOrEqual(780);
    await expect(dialog.getByRole("button", { name: "Close custodian details" })).toBeInViewport();
    await dialog.getByRole("heading", { name: "Custodian fees" }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("heading", { name: "Custodian fees" })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Close custodian details" })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("custodian-dialog-mobile.png") });
  });

  test("ACAT workspace header keeps Custodian Library and omits Tracked ACATs", async ({ page }) => {
    const nav = page.getByRole("navigation", { name: "ACAT workspace" });
    await expect(nav.getByRole("link", { name: "Tracked ACATs" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Custodian Library" })).toHaveAttribute("href", "/acat-tracking?view=library");
    await expect(nav.getByRole("link", { name: "Custodian Library" })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Custodian Library" }).focus();
    await expect(nav.getByRole("link", { name: "Custodian Library" })).toBeFocused();
    await expect(nav.getByRole("link", { name: "Custodian Library" })).toHaveCSS("outline-style", "solid");
  });

  test("no rules are not presented as a free transfer", async ({ page }) => {
    await page.getByRole("button", { name: "View Sample Trust & Clearing playbook and fees" }).click();
    await expect(page.getByRole("dialog").getByText("No fee rules recorded. This does not mean transfers are free.")).toBeVisible();
  });

  test("dark mode preserves readable native-dialog colors", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.getByRole("button", { name: "View Example Custodian playbook and fees" }).click();
    const colors = await page.getByRole("dialog").evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color,
    }));
    expect(colors).toEqual({ background: "rgb(29, 24, 18)", text: "rgb(236, 231, 223)" });
    await page.screenshot({ path: testInfo.outputPath("custodian-dialog-dark.png"), fullPage: true });
  });
});

test("unavailable timing keeps the profile and shows the fee-schedule file", async ({ page, context }) => {
  const scriptErrors: string[] = [];
  page.on("pageerror", (error) => scriptErrors.push(error.message));
  await context.route("**/*", (route) => route.abort());
  const result = await bundleLibrary(`
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { CustodianLibrary } from './components/custodians/CustodianLibrary';
      import { libraryFixture } from './test/fixtures/custodian-library';
      const example = {
        ...libraryFixture.custodians[0],
        name: 'Example Custodian',
        observedTimingAvailable: false,
        observedAvgProcessingBusinessDays: null,
        observedCompletedTransfers: 0,
        feeSchedules: [{
          id: 'doc-1',
          filename: 'schedule.pdf',
          contentType: 'application/pdf',
          byteSize: 12,
          sha256: ${JSON.stringify("ab".repeat(32))},
          createdAt: '2026-09-20T12:00:00.000Z',
        }],
      };
      createRoot(document.getElementById('root')).render(
        createElement(CustodianLibrary, {
          library: { ...libraryFixture, custodians: [example] },
          admin: true,
          authorityLibrary: true,
        }));
    `);
  await mountBundle(page, result);
  expect(scriptErrors).toEqual([]);
  await page.getByRole("button", { name: "View Example Custodian playbook and fees" }).click();
  const dialog = page.getByRole("dialog", { name: "Example Custodian" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("No observed timing")).toHaveCount(2);
  await expect(dialog.getByText("schedule.pdf")).toBeVisible();
  expect(await page.content()).not.toContain("%PDF");
  markCase("custodian-library-e2e", "unavailable timing keeps the profile and shows the fee-schedule file");
});

test("missing observed timing still shows the custodian profile", async ({ page }) => {
  const result = await build({
    stdin: {
      contents: `
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { CustodianLibrary } from './components/custodians/CustodianLibrary';
      import { libraryFixture } from './test/fixtures/custodian-library';
      const example = libraryFixture.custodians[0];
      const library = { ...libraryFixture, custodians: [{
        ...example,
        id: 'synthetic-timing-absent',
        name: 'Timing Absent Custodian',
        observedTimingAvailable: false,
        observedAvgProcessingBusinessDays: null,
        observedCompletedTransfers: 0,
      }] };
      createRoot(document.getElementById('root')).render(createElement(CustodianLibrary, { library, admin: true }));
    `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outdir: "unused-custodian-test-output",
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    alias: {
      "@": process.cwd(),
      "server-only": path.join(process.cwd(), "node_modules/next/dist/compiled/server-only/empty.js"),
      "@/app/(authenticated)/acat-tracking/custodian-admin-actions": path.join(process.cwd(), "test/fixtures/custodian-admin-actions-stub.ts"),
    },
  });
  await page.setContent('<html><body><main id="root"></main></body></html>');
  for (const file of result.outputFiles) {
    if (file.path.endsWith(".js")) await page.addScriptTag({ content: file.text });
  }
  await page.getByRole("button", { name: "View Timing Absent Custodian playbook and fees" }).click();
  const dialog = page.getByRole("dialog", { name: "Timing Absent Custodian" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Timing Absent Custodian" })).toBeVisible();
  await expect(dialog.getByText("No observed timing")).toHaveCount(2);
  markCase("custodian-library-e2e", "missing observed timing still shows the custodian profile");
});
