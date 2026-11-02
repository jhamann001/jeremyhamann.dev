import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { NO_PERMISSION, signInAs, type Persona } from "./trade-requests-browser-helpers";
import { reseedDrift, setServingSource } from "./trade-requests-drift-fixture";

// ticket Drift and Roster screens against the real drift and roster routes on a synthetic database
// (drift view, roster and exclusion-overlap switches on). The expected values were rendered by the standalone
// Drift view for the same synthetic run (test/fixtures/trade-request-drift-view-parity.json).
const PARITY = JSON.parse(readFileSync("test/fixtures/trade-request-drift-view-parity.json", "utf8")) as {
  standalone: { advisorRows: string[][]; traderOverrideCells: string[]; tiles: Array<{ label: string; value: string }>; banner: string; overlapDialog: string };
};
const S = PARITY.standalone;
const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const SHADOW_ID = "SYNTH0000000000000SHADOW001";
const NOT_FOUND = "This page could not be found.";
const anyRunDate = (text: string) => text.replace(/\s+/g, " ").trim().replace(/Run date: \d{4}-\d{2}-\d{2}/, "Run date: <date>");

test.describe.configure({ mode: "serial" });
test.beforeEach(async () => {
  await reseedDrift();
});

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

async function driftRows(page: Page): Promise<string[][]> {
  await expect(page.locator("tr[data-drift-row]").first()).toBeVisible();
  return page.$$eval("tr[data-drift-row]", (trs) => trs.map((tr) =>
    Array.from(tr.querySelectorAll(":scope > td[data-col]")).map((td) => (td.textContent ?? "").replace(/\s+/g, " ").trim())));
}

async function rosterRows(page: Page): Promise<string[][]> {
  await expect(page.locator("tr[data-roster-member]").first()).toBeVisible();
  return page.$$eval("tr[data-roster-member]", (trs) => trs.map((tr) =>
    Array.from(tr.querySelectorAll(":scope > td")).map((td) => (td.textContent ?? "").replace(/\s+/g, " ").trim())));
}

/** The pill lies inside the visible part of the workspace pill bar (which scrolls sideways at phone width). */
async function expectPillInBar(page: Page, name: string) {
  const nav = page.getByRole("navigation", { name: "Trade Requests workspace" });
  await expect.poll(async () => {
    const bar = (await nav.boundingBox())!;
    const pill = (await nav.getByRole("link", { name }).boundingBox())!;
    return pill.x >= bar.x - 1 && pill.x + pill.width <= bar.x + bar.width + 1;
  }).toBe(true);
}

/** No horizontal overflow: the document, and every element of the screen, stay inside the viewport. */
async function expectNoHorizontalOverflow(page: Page, root: string) {
  const metrics = await page.evaluate((selector) => {
    const view = document.querySelector(selector)!;
    const elements = [view, ...Array.from(view.querySelectorAll("*"))];
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      right: Math.max(...elements.map((e) => Math.ceil(e.getBoundingClientRect().right))),
      scrollers: elements.filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== "visible").length,
    };
  }, root);
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.scrollers).toBe(0);
}

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"] as Persona[]) {
  test(`${role} sees the latest live run with the standalone values and no shadow result`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role, "/trade-requests/drift");
    const sub = page.getByRole("navigation", { name: "Trade Requests workspace" });
    await expect(sub.getByRole("link", { name: "Drift" })).toHaveAttribute("aria-current", "page");
    await expect(sub.getByRole("link", { name: "Roster" })).toHaveCount(role === "ADMIN" ? 1 : 0);
    const rows = await driftRows(page);
    expect(rows.map((r) => r.slice(0, 9))).toEqual(S.advisorRows.map((r) => r.slice(0, 9)));
    expect(rows.map((r) => r[9])).toEqual(role === "ADVISOR" ? S.advisorRows.map((r) => r[9]) : S.traderOverrideCells);
    const tiles = await page.$$eval("[data-drift-stat]", (els) => els.map((t) => ({
      value: (t.querySelector("[data-stat-value]")?.textContent ?? "").trim(),
      label: (t.querySelector("[data-stat-label]")?.textContent ?? "").trim(),
    })));
    expect(tiles).toEqual(S.tiles);
    await expect(page.locator("[data-drift-banner]")).toHaveText(S.banner);
    await expect(page.getByText("Synthetic Shadow Only")).toHaveCount(0);
    await expect(page.getByText(SHADOW_ID)).toHaveCount(0);
    const history = await (await page.request.get("/api/trade-requests/drift/history?days=30")).json() as { runs: Array<{ accountId: string }> };
    expect(history.runs.length).toBe(9);
    expect(history.runs.some((r) => r.accountId === SHADOW_ID)).toBe(false);
    await expect(page.getByRole("button", { name: "Check exclusion overlap" })).toHaveCount(1);
    if (role === "ADVISOR") {
      for (const name of ["Set override", "Accept", "Set…", "Edit", "Clear override"]) await expect(page.getByRole("button", { name })).toHaveCount(0);
    }
    await page.locator('tr[data-drift-row="SYNTH00000000000000ALPHA001"]').click();
    await expect(page.locator("[data-drift-detail]")).toContainText("Tax & cost basis");
    await shoot(page, `drift-desktop-${role}`);
  });
}

for (const role of ["ADMIN", "ADVISOR"] as Persona[]) {
  test(`${role} opens the exclusion overlap diagnostic through the real route with the standalone values`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role, "/trade-requests/drift");
    await expect(page.locator("tr[data-drift-row]").first()).toBeVisible();
    await page.getByRole("button", { name: "Check exclusion overlap" }).click();
    const dialog = page.getByRole("dialog", { name: "Exclusion overlap diagnostic" });
    await expect(dialog.getByText("Lock classification")).toBeVisible();
    expect(anyRunDate(await dialog.textContent() ?? "")).toBe(anyRunDate(S.overlapDialog));
    await shoot(page, `overlap-desktop-${role}`);
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(dialog).toHaveCount(0);
  });
}

test("ADMIN saves and clears an override through the override route", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADMIN", "/trade-requests/drift");
  const charlie = page.locator('tr[data-drift-row="SYNTH0000000000000CHARLIE01"]');
  await charlie.getByRole("button", { name: "Set override" }).click();
  const dialog = page.getByRole("dialog", { name: "Set drift status override" });
  await dialog.getByLabel("Override reason").selectOption("intentional_cash");
  await dialog.getByLabel("Override note").fill("Synthetic cash hold");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(charlie.locator('td[data-col="override"]')).toHaveText("✓ Intentional cashEdit");
  await charlie.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Clear override" }).click();
  await expect(charlie.locator('td[data-col="override"]')).toHaveText("Set override");
});

for (const role of ["ADMIN", "ADVISOR"] as Persona[]) {
  test(`${role} at 390 pixels sees the same Drift and Roster content as desktop with no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role, "/trade-requests/drift");
    const desktopDrift = await driftRows(page);
    let desktopRoster: string[][] = [];
    if (role === "ADMIN") {
      await page.goto("/trade-requests/roster");
      desktopRoster = await rosterRows(page);
    }
    await page.setViewportSize(MOBILE);
    if (role === "ADMIN") {
      await page.goto("/trade-requests/roster");
      await expectPillInBar(page, "Roster");
      const drift = page.getByRole("navigation", { name: "Trade Requests workspace" }).getByRole("link", { name: "Drift" });
      await drift.scrollIntoViewIfNeeded();
      await drift.click();
      await expect(page).toHaveURL(/\/trade-requests\/drift$/);
    } else {
      await page.goto("/trade-requests/drift");
    }
    await expectPillInBar(page, "Drift");
    expect(await driftRows(page)).toEqual(desktopDrift);
    await page.locator('tr[data-drift-row="SYNTH00000000000000ALPHA001"]').click();
    await expect(page.locator("[data-drift-detail]")).toContainText("Equity holdings (rolled up to bucket)");
    await expectNoHorizontalOverflow(page, '[data-testid="trade-requests-drift"]');
    await shoot(page, `drift-mobile-${role}`);
    if (role === "ADMIN") {
      await page.goto("/trade-requests/roster");
      expect(await rosterRows(page)).toEqual(desktopRoster);
      await expectNoHorizontalOverflow(page, '[data-testid="trade-requests-roster"]');
      await shoot(page, "roster-mobile-ADMIN");
    }
  });
}

test("ADMIN administers the roster with each member's eligibility", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADMIN", "/trade-requests/roster");
  const rows = await rosterRows(page);
  expect(rows.map((r) => [r[0], r[2], r[3]])).toEqual([
    ["Dana Admin", "ADMIN", "Eligible"],
    ["Former Trader (synthetic)", "—", "Not eligible"],
    ["Riley Ops", "OPERATIONS", "Eligible"],
  ]);
  await page.getByLabel("Add a trader by email").fill("avery@example.com");
  await page.getByRole("button", { name: "Add to roster" }).click();
  await expect(page.getByTestId("trade-requests-roster").getByRole("alert")).toContainText("Only a person with an ADMIN or OPERATIONS account in AOA can be added");
  const riley = page.locator("tr[data-roster-member]").filter({ hasText: "Riley Ops" });
  await riley.getByRole("button", { name: "Not linked" }).click();
  await page.getByLabel("Slack member ID for Riley Ops").fill("U0SYNTH01");
  await page.getByLabel("Slack member ID for Riley Ops").press("Enter");
  await expect(riley.getByRole("button", { name: "U0SYNTH01" })).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Remove Former Trader (synthetic)" }).click();
  await expect(page.locator("tr[data-roster-member]")).toHaveCount(2);
  await shoot(page, "roster-desktop-ADMIN");
});

for (const role of ["OPERATIONS", "ADVISOR"] as Persona[]) {
  test(`${role} gets no roster content`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role, "/trade-requests/roster");
    await expect(page.getByText(NO_PERMISSION, { exact: true })).toBeVisible();
    await expect(page.locator("[data-roster-table], tr[data-roster-member]")).toHaveCount(0);
    await expect(page.getByText("Former Trader (synthetic)")).toHaveCount(0);
    expect((await page.request.get("/api/trade-requests/roster")).status()).toBe(403);
  });
}

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} gets no Trade Request content on Drift or Roster`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    for (const path of ["/trade-requests/drift", "/trade-requests/roster"]) {
      await page.goto(path);
      await expect(page.getByText(NO_PERMISSION, { exact: true })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Trade Requests workspace" })).toHaveCount(0);
      await expect(page.locator("tr[data-drift-row], tr[data-roster-member], [data-drift-stat]")).toHaveCount(0);
      await expect(page.getByText("Synthetic Alpha")).toHaveCount(0);
    }
    expect((await page.request.get("/api/trade-requests/drift/history")).status()).toBe(403);
    expect((await page.request.get("/api/trade-requests/roster")).status()).toBe(403);
  });
}

test("while standalone-served there is no Drift or Roster pill and both addresses are not found", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADMIN", "/trade-requests");
  await expect(page.getByRole("navigation", { name: "Trade Requests workspace" }).getByRole("link", { name: "Drift" })).toBeVisible();
  await setServingSource("standalone");
  try {
    await page.goto("/trade-requests");
    const sub = page.getByRole("navigation", { name: "Trade Requests workspace" });
    await expect(sub.getByRole("link")).toHaveCount(3);
    await expect(sub.getByRole("link", { name: "Drift" })).toHaveCount(0);
    await expect(sub.getByRole("link", { name: "Roster" })).toHaveCount(0);
    for (const path of ["/trade-requests/drift", "/trade-requests/roster"]) {
      await page.goto(path);
      await expect(page.getByText(NOT_FOUND)).toBeVisible();
      await expect(page.locator("tr[data-drift-row], tr[data-roster-member]")).toHaveCount(0);
    }
    await shoot(page, "standalone-served-ADMIN");
  } finally {
    await setServingSource("aoa");
  }
});
