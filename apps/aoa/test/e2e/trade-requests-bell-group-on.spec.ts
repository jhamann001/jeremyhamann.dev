import { expect, test, type Page } from "@playwright/test";
import { PERSONAS, signInAs, type Persona } from "./trade-requests-browser-helpers";
import { bell, expectTodaysBell } from "./trade-requests-bell-cases";
import {
  disconnectServiceDb, insertBellNotification, readState, resetBellNotifications, serviceNeverSaw, withoutNotifications,
} from "./trade-requests-bell-group-fixture";

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const LIST_ROUTE = "**/api/trade-requests/notifications";
const ADMIN_NEWEST = /^New trade request REQ-[0-9A-F]+ submitted for Emory & Chaim Aufderhar$/;
const ADMIN_OLDEST = /^New trade request REQ-[0-9A-F]+ submitted for The Richardson Family$/;
const ADVISOR_STATUS = /^Trade request REQ-[0-9A-F]+ status updated to: Needs Info$/;

// Seeded state (fixture): ADMIN and OPERATIONS have the due roster reminder and
// two notifications, the older read; ADVISOR has no reminder and one unread.
const EXPECTED: Record<"ADMIN" | "OPERATIONS" | "ADVISOR", { open: number; messages: RegExp[]; unread: boolean[] }> = {
  ADMIN: { open: 2, messages: [ADMIN_NEWEST, ADMIN_OLDEST], unread: [true, false] },
  OPERATIONS: { open: 2, messages: [ADMIN_NEWEST, ADMIN_OLDEST], unread: [true, false] },
  ADVISOR: { open: 1, messages: [ADVISOR_STATUS], unread: [true] },
};

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

function group(page: Page) {
  const section = bell(page).panel.locator('section[aria-label="Trade Requests"]');
  return { section, items: section.locator("button:has(time)"), markAll: section.getByRole("button", { name: "Mark all read", exact: true }) };
}

const texts = (page: Page) => group(page).items.locator("span").allTextContents();
const weights = (page: Page) => group(page).items.evaluateAll((rows) => rows.map((row) => getComputedStyle(row).fontWeight));

async function openBell(page: Page) {
  const { summary, menu } = bell(page);
  if ((await menu.getAttribute("open")) === null) await summary.click();
  await expect(menu).toHaveAttribute("open", "");
}

// The writers (TRW-09, TRW-10) are not built yet; this raises a session
// message through the mounted store exactly as a writer's add() would.
async function raiseSessionMessage(page: Page, message: string) {
  await page.evaluate((text) => {
    const element = document.querySelector('summary[aria-label^="Notifications"]') as unknown as Record<string, unknown>;
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
    let fiber = key ? (element[key] as { memoizedProps?: { value?: Record<string, unknown> }; return?: unknown } | null) : null;
    while (fiber) {
      const value = fiber.memoizedProps?.value;
      if (value && typeof value.add === "function" && typeof value.clear === "function" && Array.isArray(value.messages)) {
        (value.add as (message: string) => string)(text);
        return;
      }
      fiber = fiber.return as typeof fiber;
    }
    throw new Error("session_message_store_not_found");
  }, message);
}

async function expectSeededGroup(page: Page, role: keyof typeof EXPECTED) {
  const expected = EXPECTED[role];
  const { summary, panel } = bell(page);
  await expect(summary).toHaveAttribute("aria-label", `Notifications, ${expected.open} open`);
  await expect(summary.locator("span")).toHaveText([String(expected.open)]);
  await openBell(page);
  await expect(panel.getByText(`${expected.open} open`, { exact: true })).toBeVisible();
  expect(await panel.locator("section").evaluateAll((sections) => sections.map((section) => section.getAttribute("aria-label")))).toEqual(["Operations", "Trade Requests"]);
  await expect(panel.locator('section[aria-label="Operations"]').getByText("Operations", { exact: true })).toBeVisible();
  await expect(group(page).section.getByText("Trade Requests", { exact: true })).toBeVisible();
  await expect(group(page).markAll).toBeVisible();
  await expect(group(page).items).toHaveCount(expected.messages.length);
  const shown = await texts(page);
  expected.messages.forEach((pattern, index) => expect(shown[index]).toMatch(pattern));
  for (const time of await group(page).items.locator("time").all()) await expect(time).toHaveText(/\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}/);
  expect(await weights(page)).toEqual(expected.unread.map((unread) => (unread ? "600" : "400")));
  expect(await group(page).items.evaluateAll((rows) => rows.map((row) => row.querySelector("em")?.textContent ?? null)))
    .toEqual(expected.unread.map((unread) => (unread ? "Unread" : null)));
  await expect(group(page).section.getByText("No notifications")).toHaveCount(0);
  await expect(group(page).section.getByRole("status")).toHaveCount(0);
}

test.beforeEach(async () => { await resetBellNotifications(); });
test.afterAll(async () => { await disconnectServiceDb(); });

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"] as const) {
  test(`${role} desktop bell lists the roster section, then the Trade Request group with service notifications`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    await expectSeededGroup(page, role);
    const roster = bell(page).panel.locator('section[aria-label="Operations"]');
    if (role === "ADVISOR") await expect(roster.getByText("No operational actions need attention.", { exact: true })).toBeVisible();
    else await expect(roster.getByRole("link", { name: /Open workflow →/ })).toHaveAttribute("href", "/crm/employees");
    await shoot(page, `desktop-grouped-${role}`);
  });

  test(`${role} mobile bell panel fits, scrolls below the header and keeps 44px targets`, async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await signInAs(page, role);
    await expectSeededGroup(page, role);
    const box = await bell(page).panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width);
    const body = bell(page).panel.locator("> div").nth(1);
    expect(await body.evaluate((element) => [getComputedStyle(element).overflowY, getComputedStyle(element).maxHeight])).toEqual(["auto", "560px"]);
    for (const target of [...await group(page).items.all(), group(page).markAll]) {
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await group(page).items.first().click();
    await expect.poll(() => weights(page)).toEqual(EXPECTED[role].unread.map(() => "400"));
    await shoot(page, `mobile-grouped-${role}`);
  });
}

const SHORT_PHONE = { width: 390, height: 568 };

for (const [label, viewport] of [["desktop", DESKTOP], ["phone", SHORT_PHONE]] as const) test.describe(`${label} overflow`, () => {
  test.use({ hasTouch: label === "phone" });
  test(`${label} bell longer than the screen scrolls inside the panel to its last item while the page stays put`, async ({ page }) => {
    for (let index = 1; index <= 30; index += 1) {
      await insertBellNotification("ADMIN", `Trade request REQ-OVERFLOW${String(index).padStart(2, "0")} status updated to: Approved`);
    }
    await page.setViewportSize(viewport);
    await signInAs(page, "ADMIN");
    await openBell(page);
    await expect(group(page).items).toHaveCount(32);
    const { panel } = bell(page);
    const header = panel.locator("> div").first();
    const body = panel.locator("> div").nth(1);
    await expect.poll(async () => { const box = (await panel.boundingBox())!; return box.y + box.height; }).toBeLessThanOrEqual(viewport.height - 15);
    expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight + 100)).toBe(true);
    const behind = () => page.evaluate(() => [
      document.scrollingElement!.scrollTop,
      document.querySelector("[data-list-scroll-container]")!.scrollTop,
    ]);
    const before = await behind();
    await expect(group(page).items.last()).not.toBeInViewport();

    const area = (await body.boundingBox())!;
    const x = area.x + area.width / 2;
    const y = area.y + Math.min(area.height / 2, 200);
    const atEnd = () => body.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight <= 2);
    if (label === "desktop") {
      await page.mouse.move(x, y);
      for (let turn = 0; turn < 20 && !(await atEnd()); turn += 1) await page.mouse.wheel(0, 600);
    } else {
      const cdp = await page.context().newCDPSession(page);
      for (let turn = 0; turn < 5 && !(await atEnd()); turn += 1) {
        await cdp.send("Input.synthesizeScrollGesture", { x, y, yDistance: -3000, speed: 4000, gestureSourceType: "touch" });
      }
    }
    await expect.poll(atEnd).toBe(true);
    await expect(group(page).items.last()).toBeInViewport();
    await expect(group(page).items.last().locator("span")).toHaveText(ADMIN_OLDEST);
    expect(await behind()).toEqual(before);
    await expect(header).toBeInViewport();
    await expect(panel.getByText("32 open", { exact: true })).toBeInViewport();
    await expect(group(page).markAll).toBeInViewport();
    await shoot(page, `${label}-overflow-scrolled`);

    const done = page.waitForResponse((response) => response.url().endsWith("/api/trade-requests/notifications/read-all") && response.request().method() === "POST");
    await group(page).markAll.click();
    expect((await done).status()).toBe(200);
    await expect(panel.getByText("1 open", { exact: true })).toBeVisible();
  });
});

test("session messages come first, newest first, and survive in-shell navigation until selected (AC-60, AC-165, AC-77, AC-154)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADMIN");
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications, 2 open");
  await raiseSessionMessage(page, "Export failed: synthetic reason");
  await raiseSessionMessage(page, "Status update failed: synthetic reason");
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications, 4 open");
  await page.evaluate(() => { (window as unknown as { trw16Marker: number }).trw16Marker = 16; });

  await page.locator('nav[aria-label="Main navigation"] a[href="/trade-requests"]').click();
  await expect(page).toHaveURL(/\/trade-requests$/);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { trw16Marker?: number }).trw16Marker)).toBe(16);

  await openBell(page);
  await expect(bell(page).panel.getByText("4 open", { exact: true })).toBeVisible();
  const shown = await texts(page);
  expect(shown.slice(0, 2)).toEqual(["Status update failed: synthetic reason", "Export failed: synthetic reason"]);
  expect(shown[2]).toMatch(ADMIN_NEWEST);
  expect(shown[3]).toMatch(ADMIN_OLDEST);
  expect((await weights(page)).slice(0, 2)).toEqual(["600", "600"]);
  await shoot(page, "session-messages-after-navigation");

  await group(page).section.getByText("Export failed: synthetic reason").click();
  await expect(group(page).section.getByText("Export failed: synthetic reason")).toHaveCount(0);
  await expect(page).toHaveURL(/\/trade-requests$/);
  await expect(bell(page).menu).toHaveAttribute("open", "");
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications, 3 open");

  await page.reload();
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications, 2 open");
  await openBell(page);
  await expect(group(page).section.getByText("Status update failed: synthetic reason")).toHaveCount(0);
});

test("selecting a service notification marks it read in the service and keeps the user on the page (AC-62, AC-154, AC-61)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADMIN", "/households");
  await expectSeededGroup(page, "ADMIN");
  const marked = page.waitForResponse((response) => /\/api\/trade-requests\/notifications\/[0-9a-f-]+\/read$/.test(response.url()) && response.request().method() === "PATCH");
  await group(page).items.first().click();
  expect((await marked).status()).toBe(200);
  await expect.poll(() => weights(page)).toEqual(["400", "400"]);
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications, 1 open");
  await expect(bell(page).panel.getByText("1 open", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/households$/);
  await expect(bell(page).menu).toHaveAttribute("open", "");
  expect((await readState("ADMIN")).map((row) => row.read)).toEqual([true, true]);
  await shoot(page, "notification-marked-read");
});

test("Mark all read removes session messages and marks every notification read, leaving the roster reminder (AC-78, AC-164, AC-63)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "OPERATIONS");
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications, 2 open");
  await raiseSessionMessage(page, "Export capped at 5,000 requests. The file may be incomplete — contact ops for a full report if needed.");
  await openBell(page);
  await expect(bell(page).panel.getByText("3 open", { exact: true })).toBeVisible();
  const done = page.waitForResponse((response) => response.url().endsWith("/api/trade-requests/notifications/read-all") && response.request().method() === "POST");
  await group(page).markAll.click();
  expect((await done).status()).toBe(200);
  await expect(group(page).section.getByText(/^Export capped/)).toHaveCount(0);
  await expect.poll(() => weights(page)).toEqual(["400", "400"]);
  await expect(bell(page).panel.locator('section[aria-label="Operations"]').getByRole("link", { name: /Open workflow →/ })).toHaveAttribute("href", "/crm/employees");
  await expect(bell(page).panel.getByText("1 open", { exact: true })).toBeVisible();
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications, 1 open");
  expect((await readState("OPERATIONS")).every((row) => row.read)).toBe(true);
  await shoot(page, "mark-all-read");
});

test("shows No notifications after a successful load with nothing to show (AC-65)", async ({ page }) => {
  await withoutNotifications("ADVISOR");
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADVISOR");
  await openBell(page);
  await expect(group(page).section.getByText("No notifications", { exact: true })).toBeVisible();
  await expect(bell(page).panel.getByText("0 open", { exact: true })).toBeVisible();
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications");
  await expect(bell(page).summary.locator("span")).toHaveCount(0);
  await shoot(page, "empty-group");
  await raiseSessionMessage(page, "Status update failed: synthetic reason");
  await expect(group(page).section.getByText("No notifications")).toHaveCount(0);
});

test("shows the checking line during the first load (AC-173)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(LIST_ROUTE, async (route) => { await held; await route.continue(); });
  await signInAs(page, "ADVISOR");
  await openBell(page);
  await expect(group(page).section.getByRole("status")).toHaveText("Checking Trade Request notifications…");
  await expect(group(page).section.getByText("No notifications")).toHaveCount(0);
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications");
  await shoot(page, "checking");
  release();
  await expect(group(page).items).toHaveCount(1);
  await expect(group(page).section.getByRole("status")).toHaveCount(0);
});

test("a failed first load shows the could-not-be-checked line below session messages and keeps the roster reminder (AC-156, AC-162, AC-61)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.route(LIST_ROUTE, (route) => route.fulfill({ status: 502, contentType: "application/json", body: '{"ok":false}' }));
  await signInAs(page, "ADMIN");
  await openBell(page);
  await expect(group(page).section.getByRole("status")).toHaveText("Trade Request notifications could not be checked.");
  await raiseSessionMessage(page, "Export failed: synthetic reason");
  const order = await group(page).section.evaluate((section) => [...section.querySelectorAll("button:has(time), [role=status]")].map((node) => node.textContent));
  expect(order[0]).toContain("Export failed: synthetic reason");
  expect(order[1]).toBe("Trade Request notifications could not be checked.");
  await expect(group(page).section.getByText("No notifications")).toHaveCount(0);
  await expect(bell(page).panel.locator('section[aria-label="Operations"]').getByRole("link", { name: /Open workflow →/ })).toBeVisible();
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications, 2 open");
  await shoot(page, "unavailable");
});

test("loads on a full page load, refreshes every 30 seconds, and keeps the list when a refresh fails (AC-155, AC-64, AC-66)", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADVISOR");
  const first = page.waitForResponse((response) => response.url().endsWith("/api/trade-requests/notifications"), { timeout: 10_000 }).catch(() => null);
  const loadedAt = Date.now();
  await page.reload();
  expect(await first).not.toBeNull();
  expect(Date.now() - loadedAt).toBeLessThan(10_000);
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications, 1 open");

  await page.route(LIST_ROUTE, (route) => route.fulfill({ status: 502, contentType: "application/json", body: '{"ok":false}' }));
  const failed = await page.waitForResponse((response) => response.url().endsWith("/api/trade-requests/notifications") && response.status() === 502, { timeout: 40_000 });
  expect(failed.status()).toBe(502);
  await openBell(page);
  await expect(group(page).items).toHaveCount(1);
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications, 1 open");
  await expect(group(page).section.getByRole("status")).toHaveCount(0);

  await page.unroute(LIST_ROUTE);
  await insertBellNotification("ADVISOR", "Trade request REQ-SYNTH status updated to: Approved");
  await expect(group(page).items.first().locator("span")).toHaveText(/status updated to: Approved/, { timeout: 40_000 });
  await expect(group(page).items).toHaveCount(2);
  await expect(bell(page).summary).toHaveAttribute("aria-label", "Notifications, 2 open");
  await shoot(page, "refreshed");
});

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} keeps today's bell and makes no Trade Request request with the flag on (AC-158)`, async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/api/trade-requests/")) calls.push(request.url()); });
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    await expectTodaysBell(page, role);
    await page.goto("/households");
    await page.waitForTimeout(3_000);
    expect(calls).toEqual([]);
    expect(await serviceNeverSaw(PERSONAS[role])).toBe(true);
    await shoot(page, `no-request-${role}`);
  });
}
