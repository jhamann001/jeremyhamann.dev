import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { libraryFixture } from "../fixtures/custodian-library";

// Real workspace/controller/cards/grouped-list, synthetic read endpoint only.
// Detail server actions are outside this change and replaced in this isolated
// browser bundle; authenticated routing is separately exercised by critical smoke.
const tracking = { groups: [], summary: { total: 0, inFlight: 0, attention: 0, completed: 0, needsAttention: 0, linked: 0, unlinked: 0 } };
type Mode = "ok" | "failed" | "denied" | "other-scope" | "malformed" | "slow";
async function setup(page: Page, authScope = "test-login", layout = false) {
  const calls: string[] = [];
  let mode: Mode = "ok";
  let revision = 0;
  let release: (() => void) | undefined;
  const scriptErrors: string[] = [];
  page.on("pageerror", (error) => scriptErrors.push(error.message));
  const bundle = await build({
    stdin: { contents: `
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { AcatWorkspace } from './components/custodians/AcatWorkspace';
      import styles from './components/custodians/AcatWorkspace.module.css';
      import { libraryFixture } from './test/fixtures/custodian-library';
      const layout = ${layout};
      const library = layout ? { ...libraryFixture, custodians: Array.from({ length: 8 }, (_, i) => ({
        ...libraryFixture.custodians[0], id: 'synthetic-' + i,
        name: i === 0 ? 'Example Custodian' : i === 1 ? 'Illustrative Brokerage With A Long Custodian Name' : 'Example Clearing ' + (i + 1),
      })) } : libraryFixture;
      const now = Date.now();
      const root = createRoot(document.getElementById('root'));
      const initial = { scope: 'test-login', serverNow: now, sessionExpiresAt: now + 3600000,
        snapshot: { view: 'library', data: library, checkedAt: now, expiresAt: now + 300000 } };
      root.render(createElement('div', { className: styles.page },
        layout && createElement('header', null,
          createElement('p', { style: { color: 'var(--muted)', fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', margin: 0 } }, 'Operations · Transfers & custodians'),
          createElement('h1', { style: { marginTop: 4 } }, 'ACAT Tracking'),
          createElement('p', { style: { color: 'var(--muted)', marginTop: 6, fontSize: 13 } }, 'Track transfers and look up custodian playbooks and fees in one place.')),
        createElement(AcatWorkspace, { key: 'test-login', scope: 'test-login', initialView: 'library', initial })));
      window.unmountWorkspace = () => root.unmount();
    `, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, outdir: "unused-acat-cache-browser-output",
    format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    alias: { "@": process.cwd() },
    plugins: [{ name: "isolate-unchanged-detail-actions", setup(build) {
      build.onResolve({ filter: /AcatUnlinkedDrawer$/ }, () => ({ path: "detail", namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export function AcatUnlinkedDrawer() { return null; }", loader: "js" }));
    } }],
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/acat-tracking") {
      await route.fulfill({ contentType: "text/html", body: `<html><body><main id="root" style="${layout ? "padding:26px 32px 60px" : "padding:20px;max-width:1440px;margin:auto"}"></main></body></html>` }); return;
    }
    if (url.pathname === "/api/auth/session") {
      const now = await page.evaluate(() => Date.now());
      await route.fulfill({ json: { user: { role: "OPERATIONS" }, navigationScope: authScope, expires: new Date(now + 3600000).toISOString() } }); return;
    }
    if (url.pathname !== "/api/acat-workspace") { await route.abort(); return; }
    calls.push(url.search);
    if (mode === "slow") await new Promise<void>((r) => { release = r; });
    if (mode === "failed" || mode === "denied") { await route.fulfill({ status: mode === "denied" ? 401 : 503, json: { error: "unavailable" } }); return; }
    const view = url.searchParams.get("view");
    const now = await page.evaluate(() => Date.now());
    await route.fulfill({ json: mode === "malformed" ? { unexpected: true } : {
      scope: mode === "other-scope" ? "another-login" : "test-login", serverNow: now, sessionExpiresAt: now + 3600000,
      snapshot: { view, checkedAt: now, expiresAt: now + (view === "library" ? 300000 : 30000),
        data: view === "library" ? { ...libraryFixture, custodians: libraryFixture.custodians.map((c) => ({ ...c, name: revision ? `Example Custodian v${revision}` : c.name })) } : tracking },
    } });
  });
  await page.goto("https://ops-portal.synthetic.test/acat-tracking?view=library");
  await page.addStyleTag({ content: readFileSync("app/globals.css", "utf8") });
  await page.addStyleTag({ content: ':root { --font-sans: sans-serif; --font-serif: Georgia; --font-mono: monospace; }' });
  // Match the desktop shell's 248px sidebar and content padding. On narrow
  // screens isolate the workspace; this does not certify the shared mobile shell.
  if (layout) await page.addStyleTag({ content: '@media(min-width:900px) { #root { margin-left:248px; } } @media(max-width:619px) { #root { padding:20px !important; } }' });
  for (const file of bundle.outputFiles) {
    if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text });
    if (file.path.endsWith(".js")) await page.addScriptTag({ content: file.text });
  }
  if (authScope === "test-login") await expect(page.getByRole("button", { name: "View Example Custodian playbook and fees" })).toBeVisible();
  else await expect(page.getByText(/Your session or access changed/)).toBeVisible();
  return { calls, mode: (value: Mode) => { mode = value; }, revision: (value: number) => { revision = value; }, release: () => release?.(), scriptErrors };
}
const pill = (page: Page, label: string) => page.getByRole("navigation", { name: "ACAT workspace" }).getByRole("link", { name: label, exact: true });
async function openTrackedBook(page: Page) {
  await page.evaluate(() => {
    history.pushState(null, "", "/acat-tracking");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

test("history-restored initial props cannot display another login's retained payload", async ({ page }) => {
  const fixture = await setup(page, "new-login");
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(page.getByText("Example Custodian", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
  expect(fixture.calls).toHaveLength(0);
});

test("switches cached views and history without another read or a blank loading state", async ({ page }, info) => {
  const fixture = await setup(page);
  await openTrackedBook(page);
  await expect(page.getByText("No ACAT records to show right now.")).toBeVisible();
  expect(fixture.calls).toEqual(["?view=tracking"]);
  await pill(page, "Custodian Library").click();
  await expect(page.getByRole("searchbox", { name: "Find a custodian" })).toBeVisible();
  await page.goBack();
  await expect(page.getByText("No ACAT records to show right now.")).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("searchbox", { name: "Find a custodian" })).toBeVisible();
  expect(fixture.calls).toHaveLength(1);
  await expect(page.getByText(/Last checked/)).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(fixture.scriptErrors).toEqual([]);
  await page.screenshot({ path: info.outputPath("cached-library-desktop.png") });
});

test("manual Refresh bypasses the cache and replaces the snapshot", async ({ page }) => {
  const fixture = await setup(page); fixture.revision(2);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "View Example Custodian v2 playbook and fees" })).toBeVisible();
  expect(fixture.calls).toEqual(["?view=library&refresh=1"]);
});

test("Refresh preserves its DOM node and keyboard focus while hiding the pending snapshot", async ({ page }) => {
  const fixture = await setup(page); fixture.mode("slow");
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await refresh.focus();
  await refresh.evaluate((button) => button.setAttribute("data-refresh-before", "true"));
  await page.keyboard.press("Enter");
  await expect.poll(() => fixture.calls.length).toBe(1);
  const pending = page.getByRole("button", { name: "Refreshing…", exact: true });
  await expect(pending).toHaveAttribute("data-refresh-before", "true");
  await expect(pending).toBeDisabled();
  await expect(pending).toBeFocused();
  await page.keyboard.press("Enter");
  expect(fixture.calls).toHaveLength(1);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(page.getByText(/Source snapshot/)).toHaveCount(0);
  fixture.mode("ok"); fixture.release();
  await expect(refresh).toBeEnabled();
  await expect(refresh).toBeFocused();
});

for (const mode of ["failed", "malformed"] as const) {
  test(`${mode} refresh removes old data rather than silently reusing it`, async ({ page }) => {
    const fixture = await setup(page); fixture.mode(mode);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText(/No fee or playbook data could be verified/)).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    fixture.mode("ok");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("searchbox")).toBeVisible();
    expect(fixture.calls).toHaveLength(2);
  });
}

test("uses separate TTLs, drops expired data, and performs no idle polling", async ({ page }) => {
  await page.clock.install();
  const fixture = await setup(page);
  await openTrackedBook(page);
  await expect(page.getByText("No ACAT records to show right now.")).toBeVisible();
  await page.clock.fastForward(30_001);
  await expect(page.getByText(/Snapshot expired/)).toBeVisible();
  expect(fixture.calls).toHaveLength(1);
  await pill(page, "Custodian Library").click();
  await expect(page.getByRole("searchbox")).toBeVisible();
  expect(fixture.calls).toHaveLength(1);
  await page.clock.fastForward(270_000);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(page.getByText(/Snapshot expired/)).toBeVisible();
  expect(fixture.calls).toHaveLength(1);
});

for (const mode of ["denied", "other-scope"] as const) {
  test(`${mode} response clears every retained view`, async ({ page }) => {
    const fixture = await setup(page); fixture.mode(mode);
    await openTrackedBook(page);
    await expect(page.getByText(/Your session or access changed/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
    await pill(page, "Custodian Library").click();
    await expect(page.getByRole("searchbox")).toHaveCount(0);
  });
}

test("sign-out broadcast invalidates in-flight work and cached reference data", async ({ page }) => {
  const fixture = await setup(page); fixture.mode("slow");
  await openTrackedBook(page);
  await expect.poll(() => fixture.calls.length).toBe(1);
  await page.evaluate(() => { const channel = new BroadcastChannel("next-auth"); channel.postMessage({ event: "session" }); channel.close(); });
  await expect(page.getByText(/Your session changed/)).toBeVisible();
  fixture.mode("ok"); fixture.release();
  await expect(page.getByText("No ACAT records to show right now.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
});

test("clears on hiding the page and reauthenticates the read on return", async ({ page }) => {
  const fixture = await setup(page);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  fixture.mode("denied");
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.getByText(/Your session or access changed/)).toBeVisible();
});

test("freshness controls fit a narrow screen and preserve keyboard operation", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await setup(page);
  await expect(pill(page, "Tracked ACATs")).toHaveCount(0);
  await pill(page, "Custodian Library").focus();
  await expect(pill(page, "Custodian Library")).toBeFocused();
  await openTrackedBook(page);
  await expect(page.getByText("No ACAT records to show right now.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("cached-workspace-mobile.png") });
});

for (const theme of ["light", "dark"]) {
  for (const [width, columns] of [[2560, 4], [1440, 3], [1000, 2], [390, 1]]) {
    test(`aligned ${columns}-column library at ${width}px in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await setup(page, "test-login", true);
      if (theme === "dark") await page.evaluate(() => document.documentElement.classList.add("dark"));
      const cards = page.getByRole("button", { name: /^View .+ playbook and fees$/ });
      await expect(cards).toHaveCount(8);
      const boxes = await cards.evaluateAll((elements) => elements.map((el) => {
        const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, width: b.width };
      }));
      expect(boxes.filter((b) => b.y === boxes[0].y)).toHaveLength(columns);
      const heading = (await page.getByRole("heading", { name: "ACAT Tracking", exact: true }).boundingBox())!;
      const search = (await page.getByRole("searchbox", { name: "Find a custodian" }).boundingBox())!;
      const refresh = (await page.getByRole("button", { name: "Refresh", exact: true }).boundingBox())!;
      expect(Math.abs(heading.x - boxes[0].x)).toBeLessThan(1);
      expect(Math.abs(search.x - boxes[0].x)).toBeLessThan(1);
      expect(Math.abs(refresh.x + refresh.width - boxes[columns - 1].right)).toBeLessThan(1);
      expect(refresh.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width >= 1440) {
        expect(boxes[0].width).toBeGreaterThanOrEqual(340);
        expect(boxes[0].y).toBeLessThan(400);
        const availableLeft = 248 + 32;
        expect(Math.abs((boxes[0].x - availableLeft) - (width - 32 - boxes[columns - 1].right))).toBeLessThan(1);
      }
      await expect(page.getByText(/Last checked/)).toBeVisible();
      await expect(page.getByText(/Source snapshot/)).toBeVisible();
      await expect(page.getByText("8 of 8 custodians")).toBeVisible();
      await page.screenshot({ path: info.outputPath(`library-${width}-${theme}.png`), fullPage: true });
      await page.getByRole("searchbox").fill("Illustrative");
      await expect(cards).toHaveCount(1);
      await cards.first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(Math.min(width, 1140));
      await expect(dialog.getByText("Amount qualification", { exact: true }).first()).toBeAttached();
      await page.keyboard.press("Escape");
      await expect(cards.first()).toBeFocused();
    });
  }
}
