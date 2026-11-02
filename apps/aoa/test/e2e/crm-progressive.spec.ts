import { expect, test, type Page } from "@playwright/test";

const IDENTITY_ROWS = '[data-list-row-id^="hld_pncrm"]';
const CANDIDATE_ROWS = '[data-list-row-id^="dup_ccc02"]';
async function signIn(page: Page) {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
}
async function ready(page: Page, rows: string, count = 100) {
  await expect(page.getByRole("heading", { name: "CRM Explorer", exact: true })).toBeVisible();
  await expect(page.locator('[data-crm-progressive-list][data-list-ready="true"]')).toHaveCount(1);
  await expect(page.locator(rows)).toHaveCount(count);
}
async function offset(page: Page, id: string) {
  return page.locator(`[data-list-row-id="${id}"]`).evaluate(element => element.getBoundingClientRect().top -
    document.querySelector("[data-list-scroll-container]")!.getBoundingClientRect().top);
}

test("CRM identities append205, keep filters and disclosure on detail return, and persist no records", async ({ page }) => {
  await signIn(page); await page.goto("/crm?q=hld_pncrm&type=HOUSEHOLD"); await ready(page, IDENTITY_ROWS);
  const historyLength = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Load more crm identities", exact: true }).click();
  await expect(page.locator(IDENTITY_ROWS)).toHaveCount(200);
  const disclosure = page.locator('details[data-crm-disclosure="flag-household"]');
  await disclosure.locator("summary").click();
  await expect(disclosure).toHaveAttribute("open", "");
  const id = "hld_pncrm0180";
  const selected = page.locator(`[data-list-row-id="${id}"]`);
  await selected.scrollIntoViewIfNeeded();
  const saved = await offset(page, id);
  await selected.getByRole("link", { name: "Inspect →", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/crm/${id}$`));
  const back = page.getByRole("link", { name: "← CRM Explorer", exact: true });
  await expect(back).toHaveAttribute("href", /q=hld_pncrm/);
  await page.goBack(); await ready(page, IDENTITY_ROWS, 200);
  await expect(disclosure).toHaveAttribute("open", "");
  await expect.poll(async () => Math.abs(await offset(page, id) - saved)).toBeLessThan(8);
  await page.goForward(); await expect(back).toBeVisible(); await page.reload(); await back.click();
  await ready(page, IDENTITY_ROWS, 200);
  await expect.poll(async () => Math.abs(await offset(page, id) - saved)).toBeLessThan(8);
  await page.getByRole("button", { name: "Load more crm identities", exact: true }).click();
  await expect(page.locator(IDENTITY_ROWS)).toHaveCount(205);
  await expect(page.getByText("Showing 1–205 of 205", { exact: true })).toBeVisible();
  // Only explicit detail navigation increased history; appending did not.
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(historyLength + 1);
  await page.reload(); await ready(page, IDENTITY_ROWS, 205);
  const stored = await page.evaluate(() => JSON.stringify({ session: Object.entries(sessionStorage), local: Object.entries(localStorage), state: history.state }));
  expect(stored).not.toContain("PN Fixture Household");
  expect(stored).not.toContain("PN Fixture Person");
});

test("CRM duplicate review has its own205-row continuation and origin-aware return", async ({ page }) => {
  await signIn(page); await page.goto("/crm?duplicates=potential&type=HOUSEHOLD"); await ready(page, CANDIDATE_ROWS);
  const historyLength = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Load more duplicate reviews", exact: true }).click();
  await expect(page.locator(CANDIDATE_ROWS)).toHaveCount(200);
  await page.getByRole("button", { name: "Load more duplicate reviews", exact: true }).click();
  await expect(page.locator(CANDIDATE_ROWS)).toHaveCount(205);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await expect(page.getByRole("button", { name: "Load more duplicate reviews", exact: true })).toHaveCount(0);
  const selected = page.locator(CANDIDATE_ROWS).nth(175);
  const id = await selected.getAttribute("data-list-row-id");
  await selected.scrollIntoViewIfNeeded(); const saved = await offset(page, id!);
  await selected.getByRole("link", { name: "Compare →", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Compare source records", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "← Duplicate reviews", exact: true }).click();
  await ready(page, CANDIDATE_ROWS, 205);
  await expect(page).toHaveURL(/duplicates=potential/);
  await expect.poll(async () => Math.abs(await offset(page, id!) - saved)).toBeLessThan(8);
});

test("CRM reauthorizes after a scope mismatch and recovers from same-snapshot server props", async ({ page }) => {
  await signIn(page); await page.goto("/crm?q=hld_pncrm&type=HOUSEHOLD"); await ready(page, IDENTITY_ROWS);
  let failures = 0;
  await page.route("**/api/navigation/crm/window?**", async route => {
    if (new URL(route.request().url()).searchParams.get("loaded") !== "100" || failures > 0) {
      await route.continue(); return;
    }
    failures += 1;
    await route.fulfill({ status: 503, contentType: "application/json",
      headers: { "Cache-Control": "private, no-store", "X-AOA-Navigation-Scope": "" },
      body: JSON.stringify({ error: "crm_window_unavailable" }),
    });
  });
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/crm"
    && response.request().headers().rsc === "1");
  await page.getByRole("button", { name: "Load more crm identities", exact: true }).click();
  expect((await refreshed).status()).toBe(200);
  await ready(page, IDENTITY_ROWS);
  await page.getByRole("button", { name: "Load more crm identities", exact: true }).click();
  await expect(page.locator(IDENTITY_ROWS)).toHaveCount(200);
  expect(failures).toBe(1);
});

test("CRM changed-prefix response clears the displayed window before explicit refresh", async ({ page }) => {
  await signIn(page); await page.goto("/crm?q=hld_pncrm&type=HOUSEHOLD"); await ready(page, IDENTITY_ROWS);
  let failures = 0;
  await page.route("**/api/navigation/crm/window?**", async route => {
    if (new URL(route.request().url()).searchParams.get("loaded") !== "100" || failures > 0) {
      await route.continue(); return;
    }
    failures += 1;
    // A controlled failure of the response only; no live or fixture records change.
    await route.fulfill({ status: 409, contentType: "application/json",
      headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify({ error: "crm_window_changed" }),
    });
  });
  await page.getByRole("button", { name: "Load more crm identities", exact: true }).click();
  await expect(page.locator(IDENTITY_ROWS)).toHaveCount(0);
  await expect(page.getByText("These results changed. Refresh to load the current list.", { exact: true })).toBeVisible();
  await expect(page.getByText("Showing 1–100 of 205", { exact: true })).toHaveCount(0);
  await expect(page.getByText("0 matching", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Totals unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("No CRM identities match", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await ready(page, IDENTITY_ROWS);
  await page.getByRole("button", { name: "Load more crm identities", exact: true }).click();
  await expect(page.locator(IDENTITY_ROWS)).toHaveCount(200);
});
