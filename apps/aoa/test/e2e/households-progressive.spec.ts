import { expect, test, type Page } from "@playwright/test";

const QUERY = "PN Fixture";
const LIST_PATH = `/households?q=${encodeURIComponent(QUERY)}`;
const ROWS = '[data-household-id^="PN-HH-"]';
const SCROLLER = "[data-list-scroll-container]";
const OPS_PERSONA = "Riley Ops · OPERATIONS (sees all)";
const ADVISOR_PERSONA = "Avery Stone · ADVISOR (own book)";

test.afterEach(async () => {
  const measurements = test.info().annotations.filter(({ type }) => type.startsWith("local-"));
  if (measurements.length) {
    await test.info().attach("local-navigation-measurements", {
      body: JSON.stringify(measurements, null, 2), contentType: "application/json",
    });
    // Only local synthetic timing values, never URLs, queries, rows or sessions.
    console.info("Local navigation measurements:", JSON.stringify(measurements));
  }
});

async function signIn(page: Page, persona = OPS_PERSONA) {
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await expect(page.getByRole("heading", { name: "Dev sign-in" })).toBeVisible();
  await page.getByRole("button", { name: persona, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
}

async function manualLoading(page: Page) {
  // Exercise the accessible fallback in browsers where IntersectionObserver is
  // unavailable. Separate test below exercises the real observer path.
  await page.addInitScript(() => {
    Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true });
  });
}

async function openList(page: Page) {
  const started = Date.now();
  const response = await page.goto(LIST_PATH, { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  await expect(page.locator(ROWS)).toHaveCount(100);
  // SSR text alone is not usable navigation: wait for handlers and the shell's
  // initial scroll setup, rather than clicking an unhydrated enabled button.
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await expect(page.getByText("Showing 1–100 of 350", { exact: true })).toBeVisible();
  test.info().annotations.push({ type: "local-first-100-ms", description: String(Date.now() - started) });
}

async function loadMore(page: Page, expected: number) {
  const started = Date.now();
  await page.getByRole("button", { name: /^Load more/i }).click();
  await expect(page.locator(ROWS)).toHaveCount(expected);
  await expect(page.getByText(new RegExp(`^Showing 1–${expected} of \\d+$`))).toBeVisible();
  test.info().annotations.push({ type: "local-append-ms", description: `${expected}: ${Date.now() - started}` });
}

async function rowOffset(page: Page, id: string) {
  return page.locator(`[data-household-id="${id}"]`).evaluate((row) => {
    const container = document.querySelector("[data-list-scroll-container]");
    if (!container) throw new Error("missing_scroll_container");
    return row.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
}

test("the fast directory preview is visible without JavaScript in the initial HTML shell", async ({ page, browser, baseURL }) => {
  test.skip(process.env.HOUSEHOLD_DIRECTORY_FAST_PATH !== "1", "Requires the flag-on initial-shell path");
  await signIn(page);
  const noScripts = await browser.newContext({
    baseURL, javaScriptEnabled: false, storageState: await page.context().storageState(),
  });
  try {
    const direct = await noScripts.newPage();
    const started = Date.now();
    const response = await direct.goto("/households", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const preview = direct.locator("[data-households-preview]");
    const rows = preview.locator("tbody tr");
    await expect(rows).toHaveCount(100);
    // A streamed hidden Suspense segment needs JavaScript to reveal it. These
    // rows must already be visible when none of those scripts can execute.
    await expect(rows.first()).toBeVisible();
    await expect(rows.last()).toBeVisible();
    await expect(preview.locator('tbody a[href^="/households/"]')).toHaveCount(100);
    expect(await preview.getAttribute("data-first-rows-rendered-ms")).toBeNull();
    test.info().annotations.push({ type: "local-initial-shell-no-js-ms", description: String(Date.now() - started) });
  } finally { await noScripts.close(); }
});

test("bounded manual pages append without adding browser history or persisting records", async ({ page }) => {
  await manualLoading(page);
  await signIn(page);
  await openList(page);
  const initialHistory = await page.evaluate(() => history.length);
  const initialUrl = page.url();
  await loadMore(page, 200);
  await page.locator(SCROLLER).evaluate((container) => { container.scrollTop = 0; });
  const screenshot = test.info().outputPath("households-progressive-200.png");
  await page.screenshot({ path: screenshot });
  await test.info().attach("synthetic-households-200", { path: screenshot, contentType: "image/png" });
  for (const count of [300, 350]) await loadMore(page, count);
  await expect(page.getByRole("button", { name: /^Load more/i })).toHaveCount(0);
  expect(await page.evaluate(() => history.length)).toBe(initialHistory);
  expect(page.url()).toBe(initialUrl);
  const ids = await page.locator(ROWS).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-household-id")));
  expect(new Set(ids).size).toBe(350);
  const persisted = await page.evaluate(() => JSON.stringify({
    local: Object.entries(localStorage), session: Object.entries(sessionStorage), state: history.state,
  }));
  expect(persisted).not.toContain("PN Fixture Household");
  expect(persisted).not.toContain("synthetic-person-");
});

test("scrolling near the end requests only the next bounded page", async ({ page }) => {
  await signIn(page);
  const requested: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/households") requested.push(request.url());
  });
  await openList(page);
  const before = requested.length;
  await page.locator('[data-household-id="PN-HH-0001"] a').first().focus();
  const focused = await page.evaluateHandle(() => document.activeElement);
  const scrollBefore = await page.locator(SCROLLER).evaluate((container) => {
    container.scrollTop = container.scrollHeight;
    return container.scrollTop;
  });
  await expect(page.locator(ROWS)).toHaveCount(200);
  expect(requested.slice(before).map((url) => new URL(url).searchParams.get("page"))).toEqual(["2"]);
  await expect(page.locator('[data-household-id="PN-HH-0001"]')).toHaveCount(1);
  const scrollAfter = await page.locator(SCROLLER).evaluate((container) => container.scrollTop);
  expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(2);
  expect(await page.evaluate((element) => document.activeElement === element, focused)).toBe(true);
  await focused.dispose();
});

test("browser Back restores loaded pages, query and the shell scroll anchor", async ({ page }) => {
  await manualLoading(page);
  await signIn(page);
  await openList(page);
  await loadMore(page, 200);
  const selectedId = "PN-HH-0180";
  const selected = page.locator(`[data-household-id="${selectedId}"]`);
  await selected.scrollIntoViewIfNeeded();
  const savedOffset = await rowOffset(page, selectedId);
  await selected.getByRole("link", { name: /PN Fixture Household 0180/ }).click();
  await expect(page.getByRole("heading", { name: "PN Fixture Household 0180", exact: true })).toBeVisible();
  const started = Date.now();
  await page.goBack();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect(page.getByRole("searchbox", { name: "Search households", exact: true })).toHaveValue(QUERY);
  await expect.poll(async () => Math.abs(await rowOffset(page, selectedId) - savedOffset)).toBeLessThan(8);
  test.info().annotations.push({ type: "local-back-restore-ms", description: String(Date.now() - started) });
  await page.goForward();
  await expect(page.getByRole("heading", { name: "PN Fixture Household 0180", exact: true })).toBeVisible();
});

test("separate browser history entries for the same query retain different positions", async ({ page }) => {
  await manualLoading(page);
  await signIn(page);
  await openList(page);
  await loadMore(page, 200);
  await page.locator(SCROLLER).evaluate((container) => { container.scrollTop = 0; });
  const originalOffset = await rowOffset(page, "PN-HH-0001");

  // Push an intervening filter entry, then return to the same query as a NEW
  // entry. A route-key-only memory cache would overwrite the first position.
  const search = page.getByRole("searchbox", { name: "Search households", exact: true });
  await search.fill("PN Fixture Household 0001");
  await expect(page.locator(ROWS)).toHaveCount(1);
  await search.fill(QUERY);
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await loadMore(page, 200);
  await loadMore(page, 300);
  const later = page.locator('[data-household-id="PN-HH-0280"]');
  await later.scrollIntoViewIfNeeded();
  const laterOffset = await rowOffset(page, "PN-HH-0280");
  await later.getByRole("link", { name: /PN Fixture Household 0280/ }).click();
  await expect(page.getByRole("heading", { name: "PN Fixture Household 0280", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.locator(ROWS)).toHaveCount(300);
  await expect.poll(async () => Math.abs(await rowOffset(page, "PN-HH-0280") - laterOffset)).toBeLessThan(8);
  await page.goBack();
  await expect(page.locator(ROWS)).toHaveCount(1);
  await expect(search).toHaveValue("PN Fixture Household 0001");
  await page.goBack();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect(search).toHaveValue(QUERY);
  await expect.poll(async () => Math.abs(await rowOffset(page, "PN-HH-0001") - originalOffset)).toBeLessThan(8);
});

test("the in-app return restores its list while a direct detail has a safe fallback", async ({ page, browser, baseURL }) => {
  await manualLoading(page);
  await signIn(page);
  await openList(page);
  await loadMore(page, 200);
  const selected = page.locator('[data-household-id="PN-HH-0150"]');
  await selected.scrollIntoViewIfNeeded();
  const savedOffset = await rowOffset(page, "PN-HH-0150");
  await selected.getByRole("link", { name: /PN Fixture Household 0150/ }).click();
  await expect(page.getByRole("heading", { name: "PN Fixture Household 0150", exact: true })).toBeVisible();
  const back = page.getByRole("link", { name: /‹ Back to results/i });
  await expect(back).toHaveAttribute("href", /\/households\?q=PN\+Fixture/);
  await back.click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect.poll(async () => Math.abs(await rowOffset(page, "PN-HH-0150") - savedOffset)).toBeLessThan(8);

  const separate = await browser.newContext({ baseURL });
  try {
    const direct = await separate.newPage();
    await signIn(direct);
    await direct.goto("/households/PN-HH-0150");
    const fallback = direct.getByRole("link", { name: /‹ Back to results/i });
    await expect(fallback).toHaveAttribute("href", "/households");
    // Crossing from a direct detail into the list's separate route group must
    // mount an authorized, usable directory as well as expose the right URL.
    await fallback.click();
    await expect(direct).toHaveURL(/\/households$/);
    await expect(direct.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
    await expect(direct.locator('[data-list-ready="true"]')).toHaveCount(1);
    await expect(direct.locator("[data-household-id]")).toHaveCount(100);
    await expect(direct.getByRole("searchbox", { name: "Search households", exact: true })).toBeEnabled();
  } finally { await separate.close(); }
});

test("the same household opened from different lists keeps each detail entry's return target", async ({ page }) => {
  await manualLoading(page);
  await signIn(page);
  await openList(page);
  await loadMore(page, 200);
  const id = "PN-HH-0150";
  const row = () => page.locator(`[data-household-id="${id}"]`);
  await row().scrollIntoViewIfNeeded();
  const firstOffset = await rowOffset(page, id);
  await row().getByRole("link", { name: /PN Fixture Household 0150/ }).click();
  await expect(page.getByRole("heading", { name: "PN Fixture Household 0150", exact: true })).toBeVisible();
  const back = () => page.getByRole("link", { name: /‹ Back to results/i });
  await expect(back()).toHaveAttribute("href", "/households?q=PN+Fixture");

  // A normal sidebar navigation keeps the first detail entry in browser history.
  await page.locator('aside a[href="/households"]').click();
  const search = page.getByRole("searchbox", { name: "Search households", exact: true });
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await search.fill("PN Fixture Household 01");
  await expect(page).toHaveURL(/q=PN\+Fixture\+Household\+01$/);
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(page.locator(ROWS).first()).toHaveAttribute("data-household-id", "PN-HH-0100");
  await row().scrollIntoViewIfNeeded();
  const secondOffset = await rowOffset(page, id);
  await row().getByRole("link", { name: /PN Fixture Household 0150/ }).click();
  await expect(page.getByRole("heading", { name: "PN Fixture Household 0150", exact: true })).toBeVisible();
  await expect(back()).toHaveAttribute("href", "/households?q=PN+Fixture+Household+01");

  // Registry persistence must retain BOTH historical origins after refresh.
  await page.reload();
  await expect(back()).toHaveAttribute("href", "/households?q=PN+Fixture+Household+01");

  await page.goBack(); // second filtered list
  await expect(search).toHaveValue("PN Fixture Household 01");
  await page.goBack(); // unfiltered sidebar destination
  await expect(search).toHaveValue("");
  await page.goBack(); // first visit to the same household
  await expect(back()).toHaveAttribute("href", "/households?q=PN+Fixture");

  await page.goForward();
  await expect(search).toHaveValue("");
  await page.goForward();
  await expect(search).toHaveValue("PN Fixture Household 01");
  await page.goForward();
  await expect(back()).toHaveAttribute("href", "/households?q=PN+Fixture+Household+01");
  await back().click();
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(search).toHaveValue("PN Fixture Household 01");
  await expect.poll(async () => Math.abs(await rowOffset(page, id) - secondOffset)).toBeLessThan(8);

  await page.goBack(); // prior second filtered-list entry
  await expect(search).toHaveValue("PN Fixture Household 01");
  await page.goBack();
  await expect(search).toHaveValue("");
  await page.goBack();
  await expect(back()).toBeVisible();
  await expect(back()).toHaveAttribute("href", "/households?q=PN+Fixture");
  await back().click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect(search).toHaveValue(QUERY);
  await expect.poll(async () => Math.abs(await rowOffset(page, id) - firstOffset)).toBeLessThan(8);
});

test("changing the query resets appended pages", async ({ page }) => {
  await manualLoading(page);
  await signIn(page);
  await openList(page);
  await loadMore(page, 200);
  await page.getByRole("searchbox", { name: "Search households", exact: true }).fill("PN Fixture Household 0350");
  await expect(page.locator(ROWS)).toHaveCount(1);
  await expect(page.locator('[data-household-id="PN-HH-0350"]')).toBeVisible();
  expect(new URL(page.url()).searchParams.get("q")).toBe("PN Fixture Household 0350");
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search households", exact: true })).toHaveValue("");
  await expect(page.locator("[data-household-id]")).toHaveCount(100);

  const invalidPage = await page.goto(`${LIST_PATH}&page=99999999999999999999999999999999999`);
  expect(invalidPage?.status()).toBe(200);
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(page.locator(ROWS).first()).toHaveAttribute("data-household-id", "PN-HH-0001");
  await expect(page.getByRole("searchbox", { name: "Search households", exact: true })).toHaveValue(QUERY);
  await expect(page.getByText("Showing 1–100 of 350", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
});

test("a pending append cannot overwrite a newer query", async ({ page }) => {
  await manualLoading(page);
  await signIn(page);
  await openList(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let pageTwoRequested = false;
  await page.route("**/api/households?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("page") === "2") {
      pageTwoRequested = true;
      await held;
    }
    await route.continue().catch(() => {}); // Filter reset can intentionally abort it.
  });
  try {
    await page.getByRole("button", { name: /^Load more/i }).click();
    await expect.poll(() => pageTwoRequested).toBe(true);
    await page.getByRole("searchbox", { name: "Search households", exact: true }).fill("PN Fixture Household 0350");
    await expect(page.locator(ROWS)).toHaveCount(1);
  } finally { release(); }
  await expect(page.locator('[data-household-id="PN-HH-0350"]')).toBeVisible();
  await expect(page.locator('[data-household-id="PN-HH-0101"]')).toHaveCount(0);
});

test("advisor and sort filters remain coherent when loading another page", async ({ page }) => {
  await manualLoading(page);
  await signIn(page);
  await openList(page);
  await page.getByRole("combobox", { name: "Filter households by advisor", exact: true })
    .selectOption("avery@example.com");
  await expect(page).toHaveURL(/advisor=avery%40example.com/);
  await expect.poll(async () => {
    const ids = await page.locator(ROWS).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-household-id") ?? ""));
    return ids.filter((id) => Number(id.slice(-4)) % 2 === 0).length;
  }).toBe(0);
  await loadMore(page, 175);
  await page.getByRole("button", { name: /^Household ▲$/ }).click();
  await expect(page).toHaveURL(/dir=desc/);
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(page.locator(ROWS).first()).toHaveAttribute("data-household-id", "PN-HH-0349");
  await loadMore(page, 175);
  await expect(page.locator(ROWS).last()).toHaveAttribute("data-household-id", "PN-HH-0001");
});

test("a failed append keeps existing rows and can be retried without duplicates", async ({ page }) => {
  await manualLoading(page);
  await signIn(page);
  await openList(page);
  let failOnce = true;
  await page.route("**/api/households?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("page") === "2" && failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"household_directory_unavailable"}' });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: /^Load more/i }).click();
  await expect(page.getByRole("button", { name: "Retry loading households", exact: true })).toBeVisible();
  await expect(page.locator(ROWS)).toHaveCount(100);
  await page.getByRole("button", { name: "Retry loading households", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect(page.locator('[data-household-id="PN-HH-0100"]')).toHaveCount(1);
});

test("a failed Back restoration retries its saved range and anchor despite retained rows", async ({ page }) => {
  await manualLoading(page);
  await signIn(page);
  await openList(page);
  await loadMore(page, 200);
  await loadMore(page, 300);
  const selectedId = "PN-HH-0280";
  const selected = page.locator(`[data-household-id="${selectedId}"]`);
  await selected.scrollIntoViewIfNeeded();
  const savedOffset = await rowOffset(page, selectedId);
  await selected.getByRole("link", { name: /PN Fixture Household 0280/ }).click();
  await expect(page.getByRole("heading", { name: "PN Fixture Household 0280", exact: true })).toBeVisible();
  let failOnce = true;
  await page.route("**/api/households?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("page") === "1" && failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"household_directory_unavailable"}' });
      return;
    }
    await route.continue();
  });
  await page.goBack();
  await expect(page.getByRole("button", { name: "Retry loading households", exact: true })).toBeVisible();
  await expect(page.locator(ROWS)).toHaveCount(100);
  // A failed restore must not replace the remembered three-page position with
  // the fallback first page when scroll/pagehide persists the current view.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  expect(await page.evaluate(() => {
    const raw = sessionStorage.getItem("aoa.navigation.positions.v1");
    return raw ? JSON.parse(raw).payload.entries.some((entry: { lastPage: number }) => entry.lastPage === 3) : false;
  })).toBe(true);
  await page.getByRole("button", { name: "Retry loading households", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(300);
  await expect.poll(async () => Math.abs(await rowOffset(page, selectedId) - savedOffset)).toBeLessThan(8);
  await expect(page.getByRole("button", { name: "Retry loading households", exact: true })).toHaveCount(0);
});

test("a failed final numbered-page restoration can retry when no next page exists", async ({ page }) => {
  await manualLoading(page);
  await signIn(page);
  await page.goto(`${LIST_PATH}&page=4`);
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await expect(page.locator(ROWS)).toHaveCount(50);
  const selectedId = "PN-HH-0340";
  const selected = page.locator(`[data-household-id="${selectedId}"]`);
  await selected.scrollIntoViewIfNeeded();
  const savedOffset = await rowOffset(page, selectedId);
  await selected.getByRole("link", { name: /PN Fixture Household 0340/ }).click();
  await expect(page.getByRole("heading", { name: "PN Fixture Household 0340", exact: true })).toBeVisible();
  let failOnce = true;
  const requestedPages: string[] = [];
  await page.route("**/api/households?**", async (route) => {
    const requestedPage = new URL(route.request().url()).searchParams.get("page") ?? "";
    requestedPages.push(requestedPage);
    if (requestedPage === "1" && failOnce) {
      failOnce = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"household_directory_unavailable"}' });
      return;
    }
    await route.continue();
  });
  await page.goBack();
  await expect(page.getByRole("button", { name: "Retry loading households", exact: true })).toBeVisible();
  await expect(page.locator(ROWS)).toHaveCount(50);
  await page.getByRole("button", { name: "Retry loading households", exact: true }).click();
  await expect.poll(() => requestedPages).toEqual(["1", "1", "4"]);
  await expect(page.getByRole("button", { name: "Retry loading households", exact: true })).toHaveCount(0);
  await expect(page.locator(ROWS)).toHaveCount(50);
  await expect(page.getByText("Showing 301–350 of 350", { exact: true })).toBeVisible();
  await expect.poll(async () => Math.abs(await rowOffset(page, selectedId) - savedOffset)).toBeLessThan(8);
});

test("a changed snapshot clears the old sequence and refreshes from its first page", async ({ page }) => {
  await manualLoading(page);
  await signIn(page);
  await openList(page);
  const aumTile = page.getByText(/^(Total|Client) AUM$/).locator("..");
  const advisorOptions = page.getByRole("combobox", { name: "Filter households by advisor" }).locator("option");
  const statusOptions = page.getByRole("combobox", { name: "Filter households by status" }).locator("option");
  expect(await advisorOptions.count()).toBeGreaterThan(1);
  expect(await statusOptions.count()).toBeGreaterThan(1);
  let seedAvailableAum = true;
  let changedResponses = 0;
  await page.route("**/api/households?**", async (route) => {
    const requestedPage = new URL(route.request().url()).searchParams.get("page");
    if (requestedPage === "1" && seedAvailableAum) {
      seedAvailableAum = false;
      const response = await route.fetch();
      const payload = await response.json();
      // Invented balance metadata tests its removal; every row still comes from
      // the actual local/RLS API, and no production source is involved.
      await route.fulfill({ response, json: { ...payload, aumSplit: { available: true, total: 123456.78, firm: 12.34, employee: 20000 } } });
      return;
    }
    if (requestedPage === "2" && changedResponses < 2) {
      changedResponses += 1;
      await route.fulfill({ status: 409, contentType: "application/json", body: '{"error":"household_directory_changed"}' });
      return;
    }
    await route.continue();
  });
  // An explicit first-page refresh updates the summary atomically. Ordinary
  // append pages deliberately keep the first page's same-snapshot metadata.
  await page.getByRole("button", { name: /^Load more/i }).click();
  await page.getByRole("button", { name: "Refresh household list", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(aumTile).toContainText("$123,444.44");
  const employeeToggle = page.getByRole("switch", { name: "Exclude employee accounts" });
  await employeeToggle.check();
  await expect(aumTile).toContainText("Client AUM");
  await expect(aumTile).toContainText("$103,444.44");
  await expect(page.locator(ROWS)).toHaveCount(100);
  await employeeToggle.uncheck();
  await expect(aumTile).toContainText("$123,444.44");
  await page.getByRole("button", { name: /^Load more/i }).click();
  await expect(page.getByRole("button", { name: "Refresh household list", exact: true })).toBeVisible();
  await expect(page.locator(ROWS)).toHaveCount(0);
  await expect(advisorOptions).toHaveCount(1);
  await expect(statusOptions).toHaveCount(1);
  for (const name of ["All 0", "Clients 0", "Lost Clients 0"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  for (const label of ["Clients", "Prospects", "Lost"]) {
    await expect(page.getByText(label, { exact: true }).locator("..")).toHaveText(`${label}0`);
  }
  await expect(aumTile).toContainText("—");
  await expect(aumTile).not.toContainText("$123,444.44");
  await expect(employeeToggle).toBeDisabled();
  await expect(page.getByText("Showing 0–0 of 0", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh household list", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(100);
  expect(await advisorOptions.count()).toBeGreaterThan(1);
  await loadMore(page, 200);
});

test("the live paging API denies anonymous access and preserves advisor RLS on every page", async ({ page, request, browser, baseURL }) => {
  const anonymous = await request.get(`/api/households?q=${encodeURIComponent(QUERY)}`, { maxRedirects: 0 });
  expect(anonymous.status()).toBe(401);
  expect(await anonymous.json()).toEqual({ error: "unauthorized" });
  expect(anonymous.headers()["cache-control"]).toContain("no-store");
  await signIn(page);
  const all = await page.request.get(`/api/households?q=${encodeURIComponent(QUERY)}`);
  expect(all.status()).toBe(200);
  const allRows = await all.json();
  expect(allRows.total).toBe(350);
  expect(allRows.rows).toHaveLength(100);
  const changedSnapshot = `${allRows.snapshot[0] === "0" ? "1" : "0"}${allRows.snapshot.slice(1)}`;
  const changed = await page.request.get(`/api/households?q=${encodeURIComponent(QUERY)}&page=2&snapshot=${changedSnapshot}`);
  expect(changed.status()).toBe(409);
  expect(await changed.json()).toEqual({ error: "household_directory_changed" });
  const beyondEnd = await page.request.get(`/api/households?q=${encodeURIComponent(QUERY)}&page=999&snapshot=${allRows.snapshot}`);
  expect(beyondEnd.status()).toBe(416);
  expect(await beyondEnd.json()).toEqual({ error: "household_page_out_of_range" });
  const advisorContext = await browser.newContext({ baseURL });
  try {
    const advisor = await advisorContext.newPage();
    await signIn(advisor, ADVISOR_PERSONA);
    const first = await advisor.request.get(`/api/households?q=${encodeURIComponent(QUERY)}`);
    expect(first.status()).toBe(200);
    const payload = await first.json();
    expect(payload.total).toBe(175);
    expect(payload.rows).toHaveLength(100);
    const second = await advisor.request.get(`/api/households?q=${encodeURIComponent(QUERY)}&page=2&snapshot=${payload.snapshot}`);
    expect(second.status()).toBe(200);
    const next = await second.json();
    expect(next.rows).toHaveLength(75);
    for (const row of [...payload.rows, ...next.rows]) {
      expect(row.lead_advisor_email).toBe("avery@example.com");
      expect(Number(row.sf_id.slice(-4)) % 2).toBe(1);
    }
  } finally { await advisorContext.close(); }
});

test("an expired session cannot append or keep the former authenticated list", async ({ page }) => {
  await manualLoading(page);
  await signIn(page);
  await openList(page);
  await page.context().clearCookies();
  await page.getByRole("button", { name: /^Load more/i }).click();
  await expect(page.getByRole("heading", { name: "Dev sign-in", exact: true })).toBeVisible();
  await expect(page.locator(ROWS)).toHaveCount(0);
});

test("refresh retains the signed-in tab's loaded range and anchor beyond 15 minutes", async ({ page }) => {
  await manualLoading(page); await signIn(page); await openList(page);
  await loadMore(page, 200); await loadMore(page, 300);
  const selectedId = "PN-HH-0280";
  await page.locator(`[data-household-id="${selectedId}"]`).scrollIntoViewIfNeeded();
  const offset = await rowOffset(page, selectedId);
  await expect.poll(async () => page.evaluate(() => {
    const raw = sessionStorage.getItem("aoa.navigation.positions.v1");
    return raw ? JSON.parse(raw).payload.entries.some((entry: { lastPage: number; anchorId: string | null }) =>
      entry.lastPage === 3 && entry.anchorId !== null) : false;
  })).toBe(true);
  // Move only browser time forward; authentication policy/server time is intact.
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date); Date.now = () => realNow() + 20 * 60_000;
  });
  let freshReads = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/households") freshReads++; });
  await page.reload();
  await expect(page.locator(ROWS)).toHaveCount(300);
  await expect.poll(async () => Math.abs(await rowOffset(page, selectedId) - offset)).toBeLessThan(8);
  expect(freshReads).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole("searchbox", { name: "Search households", exact: true })).toHaveValue(QUERY);
});

test("a refreshed detail retains its exact return origin and restores freshly authorized pages", async ({ page }) => {
  await manualLoading(page); await signIn(page); await openList(page); await loadMore(page, 200);
  const selectedId = "PN-HH-0180";
  const selected = page.locator(`[data-household-id="${selectedId}"]`);
  await selected.scrollIntoViewIfNeeded();
  const offset = await rowOffset(page, selectedId);
  await selected.getByRole("link", { name: /PN Fixture Household 0180/ }).click();
  await expect(page.getByRole("heading", { name: "PN Fixture Household 0180", exact: true })).toBeVisible();
  await page.reload();
  const back = page.getByRole("link", { name: /‹ Back to results/i });
  await expect(back).toHaveAttribute("href", "/households?q=PN+Fixture");
  await back.click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect.poll(async () => Math.abs(await rowOffset(page, selectedId) - offset)).toBeLessThan(8);
});

test("logout and refresh after expiry clear tab memory before the same or another user signs in", async ({ page }) => {
  await manualLoading(page); await signIn(page); await openList(page); await loadMore(page, 200);
  const firstLoginScope = await page.evaluate(async () => (await (await fetch("/api/auth/session")).json()).navigationScope);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dev sign-in", exact: true })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("aoa.navigation.")))).toEqual([]);
  await signIn(page); await openList(page); await loadMore(page, 200);
  const secondLoginScope = await page.evaluate(async () => (await (await fetch("/api/auth/session")).json()).navigationScope);
  expect(secondLoginScope).toMatch(/^[a-f0-9]{64}$/);
  expect(secondLoginScope).not.toBe(firstLoginScope);
  await page.context().clearCookies();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Dev sign-in", exact: true })).toBeVisible();
  await expect(page.locator(ROWS)).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("aoa.navigation.")))).toEqual([]);
  await signIn(page, ADVISOR_PERSONA); await page.goto(LIST_PATH);
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(page.getByText("Showing 1–100 of 175", { exact: true })).toBeVisible();
  expect(await page.locator(ROWS).evaluateAll((rows) => rows.every((row) =>
    Number(row.getAttribute("data-household-id")!.slice(-4)) % 2 === 1))).toBe(true);
});

test("corrupt or blocked tab storage falls back to a fresh usable list", async ({ page }) => {
  await manualLoading(page); await signIn(page); await openList(page); await loadMore(page, 200);
  await page.addInitScript(() => {
    sessionStorage.setItem("aoa.navigation.positions.v1", "x".repeat(256_001));
    sessionStorage.setItem("aoa.navigation.history.v1", "{broken");
  });
  await page.reload();
  await expect(page.locator(ROWS)).toHaveCount(100);
  await loadMore(page, 200);
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", { get() { throw new Error("storage_blocked_for_test"); } });
  });
  await page.reload();
  await expect(page.locator(ROWS)).toHaveCount(100);
  await loadMore(page, 200);
});

test("two tabs sharing one login retain independent ranges across refresh", async ({ page }) => {
  await manualLoading(page); await signIn(page); await openList(page); await loadMore(page, 200);
  const second = await page.context().newPage();
  try {
    await manualLoading(second); await openList(second);
    await loadMore(second, 200); await loadMore(second, 300);
    await page.reload();
    await expect(page.locator(ROWS)).toHaveCount(200);
    await second.reload();
    await expect(second.locator(ROWS)).toHaveCount(300);
    await expect(page.locator(ROWS)).toHaveCount(200);
  } finally { await second.close(); }
});

test("reversing a pending sort supersedes its delayed response", async ({ page }) => {
  await manualLoading(page); await signIn(page); await openList(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let descendingRequested = false;
  let descendingReleased = false;
  await page.route((url) => url.pathname === "/households" &&
    url.searchParams.get("dir") === "desc" && url.searchParams.has("_rsc"), async (route) => {
    const response = await route.fetch();
    descendingRequested = true;
    await held;
    await route.fulfill({ response }).catch(() => {}); // The superseded request may be cancelled.
    descendingReleased = true;
  });
  try {
    await page.getByRole("button", { name: /^Household ▲$/ }).click();
    await expect.poll(() => descendingRequested).toBe(true);
    await page.getByRole("button", { name: /^Household ▼$/ }).click();
    release();
    await expect.poll(() => descendingReleased).toBe(true);
    await loadMore(page, 200);
    await expect(page.getByRole("button", { name: /^Household ▲$/ })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("dir")).toBeNull();
    await expect(page.locator(ROWS).first()).toHaveAttribute("data-household-id", "PN-HH-0001");
    await expect(page.locator(ROWS).last()).toHaveAttribute("data-household-id", "PN-HH-0200");
  } finally { release(); }
});

for (const [label, persona] of [
  ["same user", OPS_PERSONA],
  ["different role with the same visible book", "Dana Admin · ADMIN (sees all)"],
] as const) {
  test(`paging discards prior login memory after another tab signs in as ${label}`, async ({ page }) => {
    await manualLoading(page); await signIn(page); await openList(page); await loadMore(page, 200);
    const oldScope = (await (await page.request.get("/api/auth/session")).json()).navigationScope;
    expect(oldScope).toMatch(/^[a-f0-9]{64}$/);
    await expect.poll(() => page.evaluate((scope) =>
      (sessionStorage.getItem("aoa.navigation.positions.v1") ?? "").includes(scope), oldScope)).toBe(true);
    const other = await page.context().newPage();
    try {
      await manualLoading(other);
      await other.goto("/households");
      await other.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(other.getByRole("heading", { name: "Dev sign-in", exact: true })).toBeVisible();
      await signIn(other, persona);
      const newScope = (await (await other.request.get("/api/auth/session")).json()).navigationScope;
      expect(newScope).toMatch(/^[a-f0-9]{64}$/);
      expect(newScope).not.toBe(oldScope);

      // Tab A still has its old React scope. A fresh API read must detect the
      // changed shared login even though both sessions see exactly the same rows.
      await page.getByRole("button", { name: /^Load more/i }).click();
      await expect(page.locator(ROWS)).toHaveCount(100);
      await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
      await expect.poll(() => page.evaluate((scope) => Object.keys(sessionStorage)
        .filter((key) => key.startsWith("aoa.navigation."))
        .some((key) => (sessionStorage.getItem(key) ?? "").includes(scope)), oldScope)).toBe(false);
      await loadMore(page, 200);
      await expect.poll(() => page.evaluate((scope) =>
        (sessionStorage.getItem("aoa.navigation.positions.v1") ?? "").includes(scope), newScope)).toBe(true);
    } finally { await other.close(); }
  });
}

test("ticket finds a household by member name across directory, global search and Relationships", async ({ page }) => {
  // Existing guarded PN fixtures include this member and the active
  // hld_pncrm0180 household mapping. No extra fixture writes are needed.
  const memberName = "PN Fixture Person 0180";
  const householdName = "PN Fixture Household 0180";
  const householdPath = "/households/PN-HH-0180";
  await manualLoading(page);
  await signIn(page);
  await openList(page);

  const search = page.getByRole("searchbox", { name: "Search households", exact: true });
  await search.fill(memberName);
  await expect(page.locator(ROWS)).toHaveCount(1);
  const household = page.locator('[data-household-id="PN-HH-0180"]');
  await expect(household.getByRole("link", { name: householdName, exact: true })).toBeVisible();
  await household.getByRole("link", { name: householdName, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${householdPath}$`));
  await expect(page.getByRole("heading", { name: householdName, exact: true })).toBeVisible();
  await page.goBack();
  await expect(search).toHaveValue(memberName);
  await expect(page.locator(ROWS)).toHaveCount(1);
  await page.goForward();
  await expect(page.getByRole("heading", { name: householdName, exact: true })).toBeVisible();
  await page.goBack();
  await expect(search).toHaveValue(memberName);

  await page.getByRole("combobox", { name: "Search households, clients, deals and transfers", exact: true })
    .fill(memberName);
  const globalHousehold = page.getByRole("option", { name: /^PN Fixture Household 0180(?: |$)/ });
  await expect(globalHousehold).toHaveCount(1);
  await expect(globalHousehold).toBeVisible();
  await globalHousehold.click();
  await expect(page).toHaveURL(new RegExp(`${householdPath}$`));
  await expect(page.getByRole("heading", { name: householdName, exact: true })).toBeVisible();

  await page.goto("/relationships");
  await page.getByRole("textbox", { name: "Household or member name", exact: true }).fill(memberName);
  await page.getByRole("button", { name: "Search households", exact: true }).click();
  await expect(page.locator("li").filter({ hasText: "CRM ID PN-HH-0180" }))
    .toContainText(householdName);
  const openMap = page.getByRole("link", { name: "Open map →", exact: true });
  await expect(openMap).toHaveCount(1);
  await expect(openMap).toHaveAttribute("href", "/relationships?root=hld_pncrm0180");
  await openMap.click();
  await expect(page.getByRole("group", { name: "Live CRM parent and child relationship map", exact: true })
    .getByRole("button", { name: /^PN Fixture Household 0180 Household/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open AOA record →", exact: true }))
    .toHaveAttribute("href", householdPath);
});
