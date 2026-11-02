import { expect, test, type Page } from "@playwright/test";
import { PORTRAIT_DEALS as dealFixture } from "./portrait-deals-fixture";

// Uses only the isolated loopback fixture in progressive-fixture.ts.
const QUERY = "PN Fixture";
const LIST = `/client-portrait?q=${encodeURIComponent(QUERY)}`;
const ROWS = '[data-list-row-id^="PN-CLIENT-"]';
const SCROLLER = "[data-list-scroll-container]";

async function openList(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true });
  });
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await expect(page.getByRole("heading", { name: "Dev sign-in" })).toBeVisible();
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  await page.goto(LIST);
  await expect(page.getByRole("searchbox", { name: "Search clients", exact: true })).toHaveValue(QUERY);
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await expect(page.getByText("Showing 1–100 of 350", { exact: true })).toBeVisible();
}

async function loadMore(page: Page, count: number) {
  await page.getByRole("button", { name: "Load more clients", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(count);
  await expect(page.getByText(`Showing 1–${count} of 350`, { exact: true })).toBeVisible();
}

async function offset(page: Page, id: string) {
  return page.locator(`[data-list-row-id="${id}"]`).evaluate(row => {
    const container = document.querySelector("[data-list-scroll-container]");
    if (!container) throw new Error("missing_scroll_container");
    return row.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
}

test("Client Portrait pages are bounded, preserve total, and persist no row payloads", async ({ page }) => {
  await openList(page);
  const historyLength = await page.evaluate(() => history.length);
  const url = page.url();
  for (const count of [200, 300, 350]) await loadMore(page, count);
  await expect(page.getByRole("button", { name: "Load more clients", exact: true })).toHaveCount(0);
  await expect(page.getByText("End of results", { exact: true })).toBeVisible();
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  const ids = await page.locator(ROWS).evaluateAll(rows => rows.map(row => row.getAttribute("data-list-row-id")));
  expect(new Set(ids).size).toBe(350);
  // Force a position capture before checking the browser's metadata stores.
  await page.locator(SCROLLER).evaluate(container => { container.scrollTop = 0; });
  await page.locator('[data-list-row-id="PN-CLIENT-0001"] a[href^="/client-portrait/"]').click();
  await expect(page.getByRole("link", { name: "‹ Back to client results", exact: true })).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({
    session: Object.entries(sessionStorage), local: Object.entries(localStorage), state: history.state,
  }));
  expect(stored).not.toContain("PN Fixture Person");
  expect(stored).not.toContain("PN Fixture Household");
  expect(stored).not.toContain("synthetic-person-");
});

test("Client Portrait inner tab selection survives refresh and keeps explicit directory return", async ({ page }) => {
  await openList(page);
  await page.locator('[data-list-row-id="PN-CLIENT-0001"] a[href^="/client-portrait/"]').click();
  const back = page.getByRole("link", { name: "‹ Back to client results", exact: true });
  await expect(back).toBeVisible();
  await page.getByRole("link", { name: "Core Financial", exact: true }).click();
  await expect(page).toHaveURL(/portraitTab=financial/);
  await page.reload();
  await expect(page.getByRole("link", { name: "Core Financial", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(back).toHaveAttribute("href", /\/client-portrait\?q=PN\+Fixture/);
  await back.click();
  await expect(page.locator(ROWS)).toHaveCount(100);
});

function dealsCard(page: Page) {
  // Include hidden panes when counting so an accidental duplicate above tabs fails.
  return page.locator("details").filter({ has: page.locator("h2").filter({ hasText: /^Deals$/ }) });
}

test("Portrait Deals appears once, below Accounts only in Core Financial, with an empty disclosure", async ({ page }) => {
  await openList(page);
  await page.locator('[data-list-row-id="PN-CLIENT-0001"] a[href^="/client-portrait/"]').click();
  const card = dealsCard(page);
  await expect(card).toHaveCount(1);
  await expect(card).toBeVisible();
  await expect(page.getByRole("link", { name: "Core Financial", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("navigation", { name: "Client hub", exact: true }).getByRole("link", { name: "Portrait", exact: true }).click();
  await expect(page).toHaveURL(/portraitTab=comms/);
  await expect(card).toBeHidden();
  await page.getByRole("link", { name: "Core Financial", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "Core Financial", exact: true })).toBeFocused();
  await expect(page).toHaveURL(/portraitTab=financial/);
  const pane = page.getByRole("region", { name: "Core Financial", exact: true });
  await expect(pane.locator(":scope > *").nth(0).getByRole("heading", { name: "Investment accounts", exact: true })).toBeVisible();
  await expect(pane.locator(":scope > *").nth(1).getByRole("heading", { name: "Deals", exact: true })).toBeVisible();
  await expect(card).not.toHaveAttribute("open", "");
  await expect(card.locator("summary")).toContainText("0 outstanding");
  await expect(card.locator("summary")).toContainText("0 funded");
  await card.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(card.getByText("No deals on file.", { exact: true })).toBeVisible();
  await expect(card.getByRole("table")).toHaveCount(0);
  await page.keyboard.press("Space");
  await expect(card).not.toHaveAttribute("open", "");
  await page.reload();
  await expect(card).toBeVisible();
  await expect(card).not.toHaveAttribute("open", "");
  await page.getByRole("navigation", { name: "Client hub", exact: true }).getByRole("link", { name: "Portrait", exact: true }).click();
  await page.getByRole("tab", { name: "Insights", exact: true }).click();
  await expect(card).toBeHidden();
  await page.getByRole("tab", { name: "Communications", exact: true }).click();
  await expect(card).toBeHidden();
  await page.getByRole("link", { name: "Core Financial", exact: true }).click();
  // Browser history restores the financial URL. The explicit return link below
  // deliberately replaces that entry, preventing a detail/list Back-button loop.
  await page.goBack();
  await expect(page.locator(ROWS)).toHaveCount(100);
  await page.goForward();
  await expect(page.getByRole("link", { name: "Core Financial", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(dealsCard(page)).toBeVisible();
  await page.getByRole("link", { name: "‹ Back to client results", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(100);
});

test("Portrait and Household share deal columns while preserving direct-person scope, ordering and rollups", async ({ page }) => {
  await openList(page);
  const f = dealFixture;
  const expected = [
    { path: `/client-portrait/${f.memberA}?portraitTab=financial`, ids: [f.first, f.future, f.missing, f.funded, f.lost], outstanding: "3 outstanding · $6,000", funded: "1 funded · $4,000", person: true },
    { path: `/client-portrait/${f.memberB}?portraitTab=financial`, ids: [f.sibling, f.siblingFunded], outstanding: "1 outstanding · $7,000", funded: "1 funded · $8,000", person: true },
    { path: `/households/${f.household}`, ids: [f.first, f.sibling, f.future, f.missing, f.funded, f.siblingFunded, f.lost], outstanding: "4 outstanding · $13,000", funded: "2 funded · $12,000", person: false },
  ];
  for (const surface of expected) {
    await page.goto(surface.path);
    const card = dealsCard(page);
    await expect(card).toHaveCount(1);
    await expect(card).not.toHaveAttribute("open", "");
    await expect(card.locator("summary")).toContainText(surface.outstanding);
    await expect(card.locator("summary")).toContainText(surface.funded);
    await card.locator("summary").click();
    await expect(card.getByRole("columnheader")).toHaveText([
      "Deal / Client", "Account type", "Transferring firm", "Stage", "Amount", "Exp. close",
    ]);
    const links = card.locator('tbody a[href^="/deals/"]');
    await expect(links).toHaveCount(surface.ids.length);
    expect(await links.evaluateAll(elements => elements.map(element => element.getAttribute("href"))))
      .toEqual(surface.ids.map(id => `/deals/${id}`));
    await expect(card.locator(`a[href="/deals/${f.archived}"]`)).toHaveCount(0);
    await expect(links.first()).toHaveText(surface.person
      ? `Portrait Table Fixture ${surface.ids[0]}` : "Portrait Table Fixture Member A");
    await expect(card.getByRole("link", { name: "View all deals →", exact: true })).toHaveAttribute("href", "/deals");
    const fundedRow = card.locator("tr").filter({ has: page.locator(`a[href="/deals/${surface.person && surface.ids.length === 2 ? f.siblingFunded : f.funded}"]`) });
    await expect(fundedRow).not.toContainText("Overdue");
    if (surface.ids.includes(f.first)) {
      const overdue = card.locator("tr").filter({ has: page.locator(`a[href="/deals/${f.first}"]`) });
      await expect(overdue).toContainText("Jan 1, 2020 · Overdue");
      const missing = card.locator("tr").filter({ has: page.locator(`a[href="/deals/${f.missing}"]`) });
      await expect(missing.getByRole("cell").nth(1)).toHaveText("—");
      await expect(missing.getByRole("cell").nth(2)).toHaveText("—");
      await expect(missing.getByRole("cell").nth(5)).toHaveText("—");
    }
  }
  await page.goto(`/client-portrait/${f.memberA}?portraitTab=financial`);
  await dealsCard(page).locator("summary").click();
  await dealsCard(page).locator(`a[href="/deals/${f.first}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/deals/${f.first}$`));
  await expect(page.getByRole("heading", { name: `Portrait Table Fixture ${f.first}`, exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("link", { name: "Core Financial", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(dealsCard(page)).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/deals/${f.first}$`));
});

test("Portrait Deals keeps all six columns reachable with keyboard scrolling on a narrow viewport", async ({ page }) => {
  await openList(page);
  await page.goto(`/client-portrait/${dealFixture.memberA}?portraitTab=financial`);
  const card = dealsCard(page);
  await card.locator("summary").click();
  await card.screenshot({ path: test.info().outputPath("portrait-deals-table-desktop.png") });
  await page.getByRole("region", { name: "Core Financial", exact: true })
    .screenshot({ path: test.info().outputPath("portrait-deals-financial-placement-desktop.png") });
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(card.getByRole("heading", { name: "Deals", exact: true })).toBeVisible();
  await card.screenshot({ path: test.info().outputPath("portrait-deals-table-narrow-768.png") });
  // The wide deal table retains keyboard scrolling inside the phone layout.
  await page.setViewportSize({ width: 390, height: 844 });
  const region = card.getByRole("region");
  await expect(region).toHaveCount(1);
  await expect(region).toHaveCSS("overflow-x", "auto");
  const dimensions = await region.evaluate(element => ({ viewport: element.clientWidth, content: element.scrollWidth }));
  expect(dimensions.viewport).toBeGreaterThan(0);
  expect(dimensions.viewport).toBeLessThanOrEqual(390);
  expect(dimensions.content).toBeGreaterThan(dimensions.viewport);
  await region.focus();
  await expect(region).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await region.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect(card.getByRole("columnheader", { name: "Exp. close", exact: true })).toBeInViewport();
  await card.screenshot({ path: test.info().outputPath("portrait-deals-table-keyboard-390.png") });
});

test("a transient auth failure recovers from fresh server props even with an unchanged snapshot", async ({ page }) => {
  await openList(page);
  let failures = 0;
  await page.route("**/api/navigation/clients?**", async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("page") === "2" && failures === 0) {
      failures += 1;
      await route.fulfill({ status: 503, contentType: "application/json",
        headers: { "Cache-Control": "private, no-store", "X-AOA-Navigation-Scope": "" },
        body: JSON.stringify({ error: "client_directory_unavailable" }),
      });
    } else await route.continue();
  });
  const refreshed = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/client-portrait" && response.request().headers().rsc === "1");
  await page.getByRole("button", { name: "Load more clients", exact: true }).click();
  expect((await refreshed).status()).toBe(200);
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(page.getByRole("button", { name: "Load more clients", exact: true })).toBeEnabled();
  await loadMore(page, 200);
  expect(failures).toBe(1);
  await expect(page.getByText("No clients match.", { exact: true })).toHaveCount(0);
});

test("Client Portrait browser Back and explicit result return restore range, search, and anchor", async ({ page }) => {
  await openList(page);
  await loadMore(page, 200);
  const id = "PN-CLIENT-0180";
  const row = page.locator(`[data-list-row-id="${id}"]`);
  await row.scrollIntoViewIfNeeded();
  const saved = await offset(page, id);
  await row.locator('a[href^="/client-portrait/"]').click();
  const back = page.getByRole("link", { name: "‹ Back to client results", exact: true });
  await expect(back).toHaveAttribute("href", /\/client-portrait\?q=PN\+Fixture/);
  await page.goBack();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect(page.getByRole("searchbox", { name: "Search clients", exact: true })).toHaveValue(QUERY);
  await expect.poll(async () => Math.abs(await offset(page, id) - saved)).toBeLessThan(8);
  await row.locator('a[href^="/client-portrait/"]').click();
  await expect(back).toBeVisible();
  await back.click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect.poll(async () => Math.abs(await offset(page, id) - saved)).toBeLessThan(8);
});
