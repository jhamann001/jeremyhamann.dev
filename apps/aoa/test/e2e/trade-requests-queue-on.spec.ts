import { expect, test, type Page } from "@playwright/test";
import { NO_PERMISSION, signInAs, type Persona } from "./trade-requests-browser-helpers";
import { NOT_SET_UP_EMAIL, ownerClient } from "./trade-requests-queue-fixture";
import { SEED_TOTAL } from "./trade-requests-queue-seed";

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const REVIEWER_HEADERS = ["Request ID", "Household", "Trade Type", "Date", "Advisor", "Submitted by", "Status"];
const ADVISOR_HEADERS = ["Request ID", "Household", "Trade Type", "Date", "Status"];
const CATALOG_LABELS = ["Pending Review", "Needs Info", "Pending Liquidation", "Approved", "Rejected", "Completed"];
const STATUS_SEQUENCE = ["Pending Review", "Needs Info", "Pending Liquidation", "Approved", "Rejected", "Completed"];

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

const rows = (page: Page) => page.getByRole("row", { name: /^View request / });
const queueTable = (page: Page) => page.getByRole("table", { name: "All trade requests across advisors" });

async function openQueue(page: Page) {
  await page.getByRole("navigation", { name: "Trade Requests workspace" }).getByRole("link", { name: "Trading Queue" }).click();
  await expect(page).toHaveURL(/\/trade-requests\/queue$/);
  await expect(page.getByRole("heading", { level: 1, name: "Global Trading Queue" })).toBeVisible();
  await expect(rows(page)).toHaveCount(50);
}

async function headerTexts(page: Page) {
  return (await queueTable(page).locator("thead th").allTextContents()).map((text) => text.replace(/[↑↓↕]/g, "").trim());
}

async function statusColumn(page: Page) {
  return rows(page).locator("td:last-child").allInnerTexts();
}

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"] as Persona[]) {
  const reviewer = role !== "ADVISOR";

  test(`${role} desktop Home shows firm-wide counts and the role's queue card`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role, "/trade-requests");
    await expect(page.getByRole("heading", { level: 1, name: /^Welcome back, \S+$/ })).toBeVisible();
    await expect(page.getByText("Here's a snapshot of your trade activity.")).toBeVisible();
    const tile = (key: string) => page.locator(`[data-count="${key}"]`);
    await expect(tile("total")).toContainText("Total Requests");
    await expect(tile("total")).toContainText(String(SEED_TOTAL));
    await expect(tile("pendingReview")).toContainText("Pending Review");
    await expect(tile("needsInfo")).toContainText("Needs Info");
    await expect(tile("approved")).toContainText("Approved / Done");
    await expect(tile("approved")).toHaveAttribute("title", "Approved or completed requests");
    const value = async (key: string) => Number((await tile(key).locator("div > div").nth(1).innerText()).trim());
    const counts = { total: await value("total"), pendingReview: await value("pendingReview"), needsInfo: await value("needsInfo"), approved: await value("approved") };
    expect(counts.total).toBe(SEED_TOTAL);
    test.info().annotations.push({ type: "counts", description: JSON.stringify(counts) });
    await expect(page.getByText("Quick Actions")).toBeVisible();
    const queueCard = page.getByRole("link", { name: /Trading Queue/ }).filter({ hasText: "trade requests" });
    await expect(queueCard).toContainText(reviewer ? "Review and manage all pending trade requests." : "View all trade requests and their status.");
    await expect(page.getByRole("link", { name: /New Trade Request/ })).toHaveAttribute("href", "/trade-requests/new");
    await shoot(page, `home-desktop-${role}`);
    await queueCard.click();
    await expect(page).toHaveURL(/\/trade-requests\/queue$/);
    await expect(rows(page)).toHaveCount(50);
  });

  test(`${role} desktop Trading Queue lists, sorts, loads more and opens a request`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role, "/trade-requests");
    await openQueue(page);
    expect(await headerTexts(page)).toEqual(reviewer ? REVIEWER_HEADERS : ADVISOR_HEADERS);
    const dateHeader = queueTable(page).locator("thead th").filter({ hasText: "Date" });
    await expect(dateHeader).toHaveAttribute("aria-sort", "descending");
    const firstId = await rows(page).first().locator("td").first().innerText();
    await expect(page.getByRole("button", { name: "Load More" })).toBeVisible();
    await shoot(page, `queue-desktop-${role}`);

    await page.getByRole("button", { name: "Load More" }).click();
    await expect(rows(page)).toHaveCount(100);
    await page.getByRole("button", { name: "Load More" }).click();
    await expect(rows(page)).toHaveCount(SEED_TOTAL);
    await expect(page.getByRole("button", { name: "Load More" })).toHaveCount(0);
    for (const label of CATALOG_LABELS) await expect(rows(page).getByText(label, { exact: true }).first()).toBeVisible();
    await expect(rows(page).getByText("Pending Current Asset Liquidation", { exact: true })).toHaveCount(0);

    const statusHeader = queueTable(page).locator("thead th").filter({ hasText: "Status" });
    await statusHeader.getByRole("button").click();
    await expect(statusHeader).toHaveAttribute("aria-sort", "ascending");
    await expect(dateHeader).toHaveAttribute("aria-sort", "none");
    const ascending = await statusColumn(page);
    expect(ascending).toHaveLength(SEED_TOTAL);
    const ranks = ascending.map((label) => STATUS_SEQUENCE.indexOf(label.trim()));
    expect(ranks.every((rank, i) => rank >= 0 && (i === 0 || rank >= ranks[i - 1]))).toBe(true);
    await statusHeader.getByRole("button").click();
    await expect(statusHeader).toHaveAttribute("aria-sort", "descending");
    const descending = (await statusColumn(page)).map((label) => STATUS_SEQUENCE.indexOf(label.trim()));
    expect(descending.every((rank, i) => i === 0 || rank <= descending[i - 1])).toBe(true);

    const idHeader = queueTable(page).locator("thead th").filter({ hasText: "Request ID" });
    await idHeader.getByRole("button").click();
    await expect(idHeader).toHaveAttribute("aria-sort", "ascending");
    const ids = await rows(page).locator("td:first-child").allInnerTexts();
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(ids).toHaveLength(SEED_TOTAL);
    await shoot(page, `queue-sorted-${role}`);

    await page.getByRole("row", { name: `View request ${firstId}` }).click();
    await expect(page).toHaveURL(new RegExp(`/trade-requests/queue/${firstId}$`));
  });
}

test("ADVISOR search applies after typing stops and shows the no-match line", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADVISOR", "/trade-requests");
  await openQueue(page);
  const search = page.getByRole("searchbox", { name: "Search trade requests" });
  await expect(search).toHaveAttribute("placeholder", "Search all requests (ID, client, type, advisor, submitter, status)…");
  const requests: Array<{ url: string; search: string | undefined }> = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/trade-requests/requests")) requests.push({ url: request.url(), search: request.headers()["x-trade-requests-search"] });
  });
  await search.pressSequentially("aufderhar", { delay: 40 });
  await expect(rows(page).first()).toContainText("Emory & Chaim Aufderhar");
  await expect(async () => {
    const households = await rows(page).locator("td:nth-child(2)").allInnerTexts();
    expect(households.length).toBeGreaterThan(0);
    expect(households.every((name) => name.includes("Aufderhar"))).toBe(true);
  }).toPass();
  expect(requests.filter((r) => r.search).map((r) => r.search)).toEqual(["aufderhar"]);
  expect(requests.every((r) => new URL(r.url).search === "")).toBe(true);
  await shoot(page, "queue-search-ADVISOR");

  await search.fill("Pending Current Asset Liquidation");
  await expect(async () => {
    const statuses = await statusColumn(page);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((label) => label.trim() === "Pending Liquidation")).toBe(true);
  }).toPass();

  await search.fill("zz-no-such-request");
  await expect(page.getByText("No requests match your search.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load More" })).toHaveCount(0);
  await shoot(page, "queue-no-match-ADVISOR");
});

test("OPERATIONS refresh and Load more failures keep the listed requests behind the banner", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "OPERATIONS", "/trade-requests");
  await openQueue(page);
  await page.route("**/api/trade-requests/requests**", (route) =>
    route.fulfill({ json: { ok: false, outcome: "failed", message: "Request failed with status code 503" } }));
  await page.getByRole("button", { name: "Load More" }).click();
  const banner = page.getByRole("alert").filter({ hasText: "Unable to refresh — showing last loaded data." });
  await expect(banner).toBeVisible();
  await expect(rows(page)).toHaveCount(50);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(rows(page)).toHaveCount(50);
  await banner.scrollIntoViewIfNeeded();
  await shoot(page, "queue-refresh-failed-OPERATIONS");
  await page.unroute("**/api/trade-requests/requests**");
  await banner.getByRole("button", { name: "Retry" }).click();
  await expect(banner).toHaveCount(0);
  await expect(rows(page)).toHaveCount(50);
});

test("OPERATIONS refresh on becoming visible replaces added pages with the newest 50", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "OPERATIONS", "/trade-requests");
  await openQueue(page);
  await page.getByRole("button", { name: "Load More" }).click();
  await expect(rows(page)).toHaveCount(100);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(rows(page)).toHaveCount(50);
});

test("ADMIN initial queue failure shows the message with Retry; Home counts failure shows Retry", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADMIN", "/command-center");
  await page.route("**/api/trade-requests/requests**", (route) =>
    route.fulfill({ json: { ok: false, outcome: "failed", message: "timeout of 30000ms exceeded" } }));
  await page.route("**/api/trade-requests/counts", (route) => route.fulfill({ status: 503, json: { ok: false } }));
  await page.goto("/trade-requests/queue");
  const failed = page.getByTestId("trade-requests-queue-failed");
  await expect(failed.getByRole("alert")).toHaveText("timeout of 30000ms exceeded");
  await expect(queueTable(page)).toHaveCount(0);
  await shoot(page, "queue-initial-failed-ADMIN");
  await page.unroute("**/api/trade-requests/requests**");
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(rows(page)).toHaveCount(50);

  await page.goto("/trade-requests");
  const stats = page.getByTestId("trade-requests-stats-failed");
  await expect(stats).toContainText("Unable to load stats.");
  await shoot(page, "home-stats-failed-ADMIN");
  await page.unroute("**/api/trade-requests/counts");
  await stats.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator('[data-count="total"]')).toContainText(String(SEED_TOTAL));
});

test("a person the service cannot confirm sees the not-set-up card on Home and the queue", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const db = ownerClient();
  try {
    await page.goto("/?callbackUrl=%2Fcommand-center");
    await page.getByRole("button", { name: "Gwen Kuhlman · ADVISOR (own book)", exact: true }).click();
    await expect(page).toHaveURL(/\/command-center$/);
    await db.user.update({ where: { email: NOT_SET_UP_EMAIL }, data: { role: "VIEWER" } });
    for (const path of ["/trade-requests", "/trade-requests/queue"]) {
      await page.goto(path);
      await expect(page.getByTestId("trade-requests-not-set-up")).toContainText("Your account is not set up for Trade Requests — contact Operations.");
      await expect(rows(page)).toHaveCount(0);
    }
    await shoot(page, "queue-not-set-up");
  } finally {
    await db.user.update({ where: { email: NOT_SET_UP_EMAIL }, data: { role: "ADVISOR" } });
    await db.$disconnect();
  }
});

for (const role of ["ADMIN", "ADVISOR"] as Persona[]) {
  test(`${role} mobile Home and Trading Queue`, async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await signInAs(page, role, "/trade-requests");
    const tiles = page.locator("[data-count]");
    await expect(tiles).toHaveCount(4);
    await expect(page.locator('[data-count="total"]')).toContainText(String(SEED_TOTAL));
    const boxes = await Promise.all([0, 1, 2].map(async (i) => (await tiles.nth(i).boundingBox())!));
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(2);
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y + 10);
    const cards = page.locator('a[href="/trade-requests/new"], a[href="/trade-requests/queue"]').filter({ hasText: "." });
    const [a, b] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()]);
    expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
    await shoot(page, `home-mobile-${role}`);

    await openQueue(page);
    const scroller = queueTable(page).locator("xpath=..");
    await expect(scroller).toHaveCSS("overflow-x", "auto");
    expect((await queueTable(page).boundingBox())!.width).toBeGreaterThanOrEqual(720);
    const search = page.getByRole("searchbox", { name: "Search trade requests" });
    expect((await search.boundingBox())!.width).toBeGreaterThan(MOBILE.width - 60);
    await expect(page.getByRole("button", { name: "Load More" })).toBeVisible();
    await page.getByRole("button", { name: "Load More" }).click();
    await expect(rows(page)).toHaveCount(100);
    await shoot(page, `queue-mobile-${role}`);
  });
}

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} gets the permission screen on the queue address and no queue data`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    await page.goto("/trade-requests/queue");
    await expect(page.getByText(NO_PERMISSION, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Global Trading Queue" })).toHaveCount(0);
    await expect(rows(page)).toHaveCount(0);
    expect((await page.request.get("/api/trade-requests/requests")).status()).toBe(403);
    expect((await page.request.get("/api/trade-requests/counts")).status()).toBe(403);
    await shoot(page, `queue-permission-${role}`);
  });
}

test("ADMIN session expiry clears the queue and stops refreshing instead of showing stale rows", async ({ page, context }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADMIN", "/trade-requests");
  await openQueue(page);
  await context.clearCookies();
  const unauthenticated = await page.request.get("/api/trade-requests/requests", { maxRedirects: 0 });
  expect(unauthenticated.status()).toBe(401);
  expect(unauthenticated.headers()["cache-control"]).toBe("private, no-store");
  expect(await unauthenticated.json()).toEqual({ error: "unauthorized" });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("heading", { name: "Dev sign-in" })).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(page).toHaveURL(/callbackUrl=%2Ftrade-requests%2Fqueue/);
  await shoot(page, "queue-session-ended-ADMIN");
});

const detailDialog = (page: Page) => page.getByTestId("trade-request-detail");
const listedRows = (page: Page) => page.locator("tr[data-request-id]");

test("OPERATIONS opens a request over the queue from the loaded list, with no load of its own; every close returns to the queue (P2-111, AC-9)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "OPERATIONS", "/trade-requests");
  await openQueue(page);
  const detailLoads: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const path = new URL(request.url()).pathname;
    if (/^\/trade-requests\/(?!queue$|new$)[^/]+$/.test(path) || /^\/api\/trade-requests\/requests\/.+/.test(path)) detailLoads.push(request.url());
  });
  const id = (await rows(page).nth(2).getAttribute("data-request-id"))!;
  const closes: Array<[string, () => Promise<void>]> = [
    ["×", () => detailDialog(page).getByRole("button", { name: "Close" }).first().click()],
    ["footer Close", () => detailDialog(page).getByRole("button", { name: "Close" }).last().click()],
    ["Esc", () => page.keyboard.press("Escape")],
    ["backdrop", () => page.mouse.click(4, 4)],
    ["Back", async () => { await page.goBack(); }],
  ];
  for (const [label, closeIt] of closes) {
    await page.getByRole("row", { name: `View request ${id}` }).click();
    await expect(page).toHaveURL(new RegExp(`/trade-requests/queue/${id}$`));
    await expect(detailDialog(page).getByRole("heading", { level: 2 })).toContainText(`(${id})`);
    await expect(detailDialog(page).getByRole("tab", { name: "Request Details" })).toBeVisible();
    await expect(detailDialog(page).getByRole("tab", { name: /^Pre-approval Checklist/ })).toBeVisible();
    await expect(listedRows(page)).toHaveCount(50);
    if (label === "×") await shoot(page, "queue-detail-over-queue-OPERATIONS");
    await closeIt();
    await expect(page, `close by ${label}`).toHaveURL(/\/trade-requests\/queue$/);
    await expect(detailDialog(page)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(50);
  }
  expect(detailLoads).toEqual([]);
});

test("ADVISOR following a request link sees the queue with the request over it; Close returns to the queue (P2-111, AC-9)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADVISOR", "/trade-requests");
  await openQueue(page);
  const id = (await rows(page).nth(4).getAttribute("data-request-id"))!;
  await page.goto(`/trade-requests/${id}`);
  await expect(detailDialog(page).getByRole("heading", { level: 2 })).toContainText(`(${id})`);
  await expect(page.locator("h1", { hasText: "Global Trading Queue" })).toBeAttached();
  await detailDialog(page).getByRole("tab", { name: /^Pre-approval Checklist/ }).click();
  await expect(detailDialog(page).getByTestId("trade-request-checklist")).toBeVisible();
  await expect(listedRows(page)).toHaveCount(50);
  await shoot(page, "queue-direct-link-ADVISOR");
  await detailDialog(page).getByRole("button", { name: "Close" }).last().click();
  await expect(page).toHaveURL(/\/trade-requests\/queue$/);
  await expect(detailDialog(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(50);
});

test("OPERATIONS closing while a checklist save is in flight keeps the queue mounted and loads nothing; the change is saved (P2-111, TRW-08)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "OPERATIONS", "/trade-requests");
  await openQueue(page);
  const detailLoads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && /^\/trade-requests\/(?!queue$|new$)[^/]+$/.test(new URL(request.url()).pathname)) detailLoads.push(request.url());
  });
  await page.evaluate(() => { (window as unknown as { queueHeading?: Element | null }).queueHeading = document.querySelector("h1"); });
  const row = rows(page).filter({ hasText: "Pending Review" }).first();
  const id = (await row.getAttribute("data-request-id"))!;
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/trade-requests/queue/${id}$`));
  await detailDialog(page).getByRole("tab", { name: /^Pre-approval Checklist/ }).click();
  const item = detailDialog(page).getByRole("button", { name: "Residual cash trades placed" });
  await expect(item).toBeEnabled();
  const pressed = await item.getAttribute("aria-pressed");
  await item.click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/trade-requests\/queue$/);
  await expect(detailDialog(page)).toHaveCount(0);
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/trade-requests\/queue$/);
  await expect(detailDialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { queueHeading?: Element | null }).queueHeading === document.querySelector("h1"))).toBe(true);
  await rows(page).filter({ has: page.locator(`td:text-is("${id}")`) }).click();
  await detailDialog(page).getByRole("tab", { name: /^Pre-approval Checklist/ }).click();
  await expect(detailDialog(page).getByRole("button", { name: "Residual cash trades placed" })).toHaveAttribute("aria-pressed", pressed === "true" ? "false" : "true");
  await page.keyboard.press("Escape");
  expect(detailLoads).toEqual([]);
});
