import { PrismaClient } from "@prisma/client";
import { validateProgressiveDatabaseEnvironment } from "./progressive-fixture";
import { expect, test, type Page } from "@playwright/test";
import { compactTaskBody, compactTaskId, compactTaskTitle } from "./household-history-progressive-fixture";

const card = (kind: string) => `[data-history-list="${kind}"]`;
const rows = (kind: string) => `${card(kind)} [data-list-row-id]`;
const tasksDisclosure = `${card("tasks")} > details`;
const tasksSummary = `${tasksDisclosure} > summary`;
const taskRow = (page: Page, id: string) => page.locator(`${card("tasks")} [data-list-row-id="${id}"]`);

test.beforeEach(async ({ page, baseURL }) => {
  // The synthetic server deliberately disconnects the external Transfer Tracker.
  // Stub only its unrelated sidebar count, preserving the endpoint's private
  // JSON contract and real login scope. Household history and console errors
  // stay unmodified so hydration failures still fail these tests.
  // Reuse the real sidebar response's scope instead of making an extra auth
  // request that could refresh the shared browser session during navigation.
  const badgesUrl = new URL("/api/navigation/badges", baseURL).toString();
  const navigationScope = page.waitForResponse(response => response.url() === badgesUrl && response.ok())
    .then(response => response.headers()["x-aoa-navigation-scope"]);
  await page.route(new URL("/api/navigation/acat-count", baseURL).toString(), async route => {
    const scope = await navigationScope;
    expect(scope).toMatch(/^[a-f0-9]{64}$/);
    await route.fulfill({ status: 200, json: { count: 0 }, headers: {
      "Cache-Control": "private, no-store", Vary: "Cookie",
      "X-AOA-Navigation-Scope": scope,
    } });
  });
});

for (const locale of ["en-US", "en-GB"]) {
  test.describe(`household hydration in ${locale}`, () => {
    test.use({ locale, timezoneId: "America/New_York" });
    test("direct load, reload and JSON continuation keep UTC dates without hydration recovery", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
      await page.goto("/?callbackUrl=%2Fhouseholds");
      await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
      await page.goto("/households/PN-HH-0350");
      for (let visit = 0; visit < 2; visit++) {
        if (visit) await page.reload();
        for (const kind of ["tasks", "email", "activity"]) {
          await expect(page.locator(`${card(kind)}[data-list-ready="true"]`)).toHaveCount(1);
          await expect(page.locator(rows(kind))).toHaveCount(100);
          await expect(page.locator(rows(kind)).first()).toContainText("9/1/2026");
        }
        await page.getByRole("heading", { name: "Zendesk tickets", exact: true }).click();
        const ticket = page.locator("details").filter({ has: page.getByRole("link", { name: /PN History Fixture Ticket.*open in Zendesk/ }) }).last();
        await expect(ticket).toContainText("9/1/2026");
        await expect(ticket).toContainText("2:30:00 AM UTC");
        expect(errors.filter(message => /hydration|hydrated|Minified React error #418|didn't match|did not match/i.test(message))).toEqual([]);
      }
      await page.locator(tasksSummary).click();
      for (const [kind, label] of [["tasks", "tasks"], ["email", "emails"], ["activity", "calls"]]) {
        await page.locator(card(kind)).getByRole("button", { name: `Load more ${label}`, exact: true }).click();
        await expect(page.locator(rows(kind))).toHaveCount(200);
        await expect(page.locator(rows(kind)).nth(150)).toContainText("9/1/2026");
      }
      expect(errors).toEqual([]);
    });
  });
}

async function offset(page: Page, kind: string, id: string) {
  return page.locator(`${card(kind)} [data-list-row-id="${id}"]`).evaluate(row =>
    row.getBoundingClientRect().top - row.closest('[data-history-scroll]')!.getBoundingClientRect().top);
}

async function expectTaskAssignments(page: Page, first: number) {
  const labels = ["Assigned to: PN Synthetic Avery · Person", "Assigned to: PN Synthetic Operations · Queue",
    "Unassigned", "Assignment unavailable", "Assignment unavailable"];
  for (const [index, label] of labels.entries()) {
    const id = `PN-TASK-${String(first + index).padStart(4, "0")}`;
    const row = page.locator(`${card("tasks")} [data-list-row-id="${id}"]`);
    await expect(row).toContainText(label);
    await expect(row).not.toContainText("005SYN");
    await expect(row).not.toContainText("00GSYN");
  }
}

test("Household histories independently append, retain scroll/disclosure/modal metadata, and keep the directory return", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  await page.goto("/households?q=PN+Fixture+Household+0350");
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await page.getByRole("link", { name: "PN Fixture Household 0350", exact: true }).click();
  await expect(page.locator(`${card("tasks")}[data-list-ready="true"]`)).toHaveCount(1);
  await page.locator(tasksSummary).click();
  await expect(page.getByText("205 open · 25 completed", { exact: true })).toBeVisible();
  await expectTaskAssignments(page, 1);
  for (const [kind, label] of [["tasks", "tasks"], ["email", "emails"], ["activity", "calls"]]) {
    await expect(page.locator(rows(kind))).toHaveCount(100);
    await page.locator(card(kind)).getByRole("button", { name: `Load more ${label}`, exact: true }).click();
    await expect(page.locator(rows(kind))).toHaveCount(200);
  }
  await expectTaskAssignments(page, 101);
  const anchors = { tasks: "PN-TASK-0175", email: "PN-EMAIL-0160", activity: "PN-CALL-0180" };
  const saved: Record<string, number> = {};
  for (const [kind, id] of Object.entries(anchors)) {
    await page.locator(`${card(kind)} [data-list-row-id="${id}"]`).scrollIntoViewIfNeeded();
    saved[kind] = await offset(page, kind, id);
  }
  await page.reload();
  await expect(page.locator(tasksDisclosure)).toHaveAttribute("open", "");
  for (const [kind, id] of Object.entries(anchors)) {
    await expect(page.locator(rows(kind))).toHaveCount(200);
    await expect.poll(async () => Math.abs(await offset(page, kind, id) - saved[kind])).toBeLessThan(8);
  }
  await expectTaskAssignments(page, 1);
  await expectTaskAssignments(page, 101);
  await page.locator('[data-list-row-id="PN-EMAIL-0160"] button').click();
  await expect(page.getByRole("dialog", { name: "PN History Fixture Email 160", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("dialog", { name: "PN History Fixture Email 160", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const back = page.getByRole("link", { name: "‹ Back to results", exact: true });
  await expect(back).toHaveAttribute("href", "/households?q=PN+Fixture+Household+0350");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  // The server heading can paint before the directory finishes restoring its
  // router/history binding. Traverse Forward only after that return is ready.
  await expect(page).toHaveURL("/households?q=PN+Fixture+Household+0350");
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await expect(page.getByRole("link", { name: "PN Fixture Household 0350", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL("/households/PN-HH-0350");
  for (const kind of Object.keys(anchors)) await expect(page.locator(rows(kind))).toHaveCount(200);
  await page.getByRole("button", { name: "Show completed (25)", exact: true }).click();
  await expect(page).toHaveURL(/tasksCompleted=1/);
  await expect(page.locator(rows("tasks"))).toHaveCount(100);
  await expect(page.locator(tasksDisclosure)).toHaveAttribute("open", "");
  for (const count of [200, 230]) {
    await page.locator(card("tasks")).getByRole("button", { name: "Load more tasks", exact: true }).click();
    await expect(page.locator(rows("tasks"))).toHaveCount(count);
  }
  await expectTaskAssignments(page, 226);
  await page.goBack();
  await expect(page).not.toHaveURL(/tasksCompleted=1/);
  await expect(page.locator(rows("tasks"))).toHaveCount(200);
  await expect(back).toHaveAttribute("href", "/households?q=PN+Fixture+Household+0350");
  await back.click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ session: Object.entries(sessionStorage), local: Object.entries(localStorage), state: history.state }));
  expect(stored).not.toContain("Synthetic confidential");
  expect(stored).not.toContain("PN History Fixture");
  expect(stored).not.toContain("PN Synthetic Avery");
  expect(stored).not.toContain("PN Synthetic Operations");
  expect(stored).not.toContain("005SYN");
  expect(stored).not.toContain("00GSYN");
});

test("a numbered household history window targets only its named card and refreshes its bounded range", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  await page.goto("/households/PN-HH-0350?list=email&page=2");
  await expect(page.locator(`${card("email")}[data-list-ready="true"]`)).toHaveCount(1);
  for (const kind of ["tasks", "email", "activity"]) await expect(page.locator(rows(kind))).toHaveCount(100);
  await expect(page.locator(rows("email")).first()).toHaveAttribute("data-list-row-id", "PN-EMAIL-0101");
  await expect(page.locator(rows("tasks")).first()).toHaveAttribute("data-list-row-id", "PN-TASK-0001");
  await expect(page.locator(rows("activity")).first()).toHaveAttribute("data-list-row-id", "PN-CALL-0001");
  await page.locator(card("email")).getByRole("button", { name: "Load more emails", exact: true }).click();
  await expect(page.locator(rows("email"))).toHaveCount(105);
  await expect(page.locator(card("email")).getByText("Showing 101–205 of 205", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(rows("email"))).toHaveCount(105);
  await expect(page.locator(rows("email")).first()).toHaveAttribute("data-list-row-id", "PN-EMAIL-0101");
});

async function openSyntheticTasks(page: Page) {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  await page.goto("/households/PN-HH-0350");
  await expect(page.locator(`${card("tasks")}[data-list-ready="true"]`)).toHaveCount(1);
  await page.locator(tasksSummary).click();
  await expect(page.locator(rows("tasks"))).toHaveCount(100);
}

async function expectPrivateTaskNavigation(page: Page) {
  const persisted = await page.evaluate(() => JSON.stringify({
    local: Object.entries(localStorage), session: Object.entries(sessionStorage), state: history.state,
  }));
  for (const sensitive of ["Synthetic confidential", "PN History Fixture", "PN Synthetic",
    "005SYN", "00GSYN", compactTaskTitle, compactTaskBody]) {
    expect(persisted).not.toContain(sensitive);
    expect(page.url()).not.toContain(sensitive);
  }
}

test("compact tasks show several collapsed rows, reveal full details independently and keep CRM links separate", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openSyntheticTasks(page);
  await expect(page.locator(`${rows("tasks")} details[open]`)).toHaveCount(0);
  const first = taskRow(page, "PN-TASK-0001");
  const second = taskRow(page, "PN-TASK-0002");
  const long = taskRow(page, compactTaskId);
  await expect(first.getByText("Synthetic confidential task body", { exact: true })).toBeHidden();
  await expect(first.locator("summary")).toContainText("PN Synthetic Avery");
  await expect(first.locator("summary")).toContainText("Updated");
  const visibleRows = await page.locator(rows("tasks")).evaluateAll(elements => {
    const viewport = elements[0].closest("[data-history-scroll]")!.getBoundingClientRect();
    return elements.filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
    }).length;
  });
  expect(visibleRows).toBeGreaterThanOrEqual(3);
  expect(await long.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(128);
  const desktopScreenshot = test.info().outputPath("tasks-compact-desktop.png");
  await page.locator(card("tasks")).screenshot({ path: desktopScreenshot });
  await test.info().attach("synthetic-compact-tasks-desktop", { path: desktopScreenshot, contentType: "image/png" });

  await first.getByText("View details", { exact: true }).click();
  await second.getByText("View details", { exact: true }).click();
  await expect(first.locator("details")).toHaveJSProperty("open", true);
  await expect(second.locator("details")).toHaveJSProperty("open", true);
  await expect(first.getByText("Synthetic confidential task body", { exact: true })).toBeVisible();
  await first.getByText("Hide details", { exact: true }).click();
  await expect(first.locator("details")).toHaveJSProperty("open", false);
  await expect(second.locator("details")).toHaveJSProperty("open", true);

  // The new tab is intercepted before any request can reach CRM. Only
  // native anchor/disclosure behavior is exercised against invented task data.
  await context.route(/https:\/\/[^/]+\/lightning\/r\/Task\/00TSYN000000006\/view$/, route =>
    route.fulfill({ contentType: "text/html", body: "<title>Synthetic CRM target</title>" }));
  const taskLink = long.locator("summary").getByRole("link");
  await expect(taskLink).toHaveAttribute("target", "_blank");
  await expect(taskLink).toHaveAttribute("rel", /noopener/);
  const [popup] = await Promise.all([page.waitForEvent("popup"), taskLink.click()]);
  await expect(popup).toHaveTitle("Synthetic CRM target");
  await popup.close();
  await expect(long.locator("details")).toHaveJSProperty("open", false);
  await long.getByText("View details", { exact: true }).click();
  await expect(long.getByText(compactTaskBody, { exact: true })).toBeVisible();
  await expect(long.getByText(compactTaskTitle, { exact: true }).last()).toBeVisible();
  await expect(long).toContainText("High");
  await expect(second.locator("details")).toHaveJSProperty("open", true);
  // More than the 19-row persistence budget can remain open during live use.
  // Evicting old remembered IDs must not close those rows or the outer card.
  for (let index = 0; index < 21; index++) {
    const row = page.locator(rows("tasks")).nth(index);
    if (!(await row.locator("details").evaluate(element => (element as HTMLDetailsElement).open))) {
      await row.getByText("View details", { exact: true }).click();
    }
  }
  await expect(page.locator(`${rows("tasks")} details[open]`)).toHaveCount(21);
  await expect(page.locator(tasksDisclosure)).toHaveJSProperty("open", true);
  await expect(second.locator("details")).toHaveJSProperty("open", true);
  await expect(long.locator("details")).toHaveJSProperty("open", true);
  await expectPrivateTaskNavigation(page);
});

test("compact task disclosure is keyboard-operable and contained at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSyntheticTasks(page);
  const long = taskRow(page, compactTaskId);
  const disclosure = long.locator("details");
  const summary = long.locator("summary");
  await summary.scrollIntoViewIfNeeded();
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveJSProperty("open", true);
  await expect(long.getByText(compactTaskBody, { exact: true })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(disclosure).toHaveJSProperty("open", false);
  await expect(long.getByText(compactTaskBody, { exact: true })).toBeHidden();
  const dimensions = await long.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const container = element.closest("[data-history-scroll]")!.getBoundingClientRect();
    return { left: rect.left - container.left, right: rect.right - container.right,
      overflow: element.scrollWidth - element.clientWidth, height: rect.height };
  });
  expect(dimensions.left).toBeGreaterThanOrEqual(-2);
  expect(dimensions.right).toBeLessThanOrEqual(2);
  expect(dimensions.overflow).toBeLessThanOrEqual(2);
  expect(dimensions.height).toBeLessThanOrEqual(200);
  const mobileScreenshot = test.info().outputPath("tasks-compact-mobile.png");
  await page.locator(card("tasks")).screenshot({ path: mobileScreenshot });
  await test.info().attach("synthetic-compact-tasks-mobile", { path: mobileScreenshot, contentType: "image/png" });
});

test("task assignment filters search later pages and completed tasks, retaining query, row disclosures and scroll on history traversal", async ({ page }) => {
  await openSyntheticTasks(page);
  const filter = page.getByRole("combobox", { name: "Assigned to", exact: true });
  await expect(filter).toHaveValue("");
  await expect(filter.locator('optgroup[label="Queues"]')).toContainText("PN Synthetic Later Queue");
  await expect(filter.locator('optgroup[label="People"]')).toContainText("PN Synthetic Completed Only");
  const laterToken = await filter.locator("option").filter({ hasText: "PN Synthetic Later Queue" }).getAttribute("value");
  expect(laterToken).toMatch(/^[a-f0-9]{64}$/);
  const personToken = await filter.locator("option").filter({ hasText: "PN Synthetic Avery" }).getAttribute("value");
  expect(personToken).toMatch(/^[a-f0-9]{64}$/);

  await page.locator(card("tasks")).getByRole("button", { name: "Load more tasks", exact: true }).click();
  await expect(page.locator(rows("tasks"))).toHaveCount(200);
  const anchor = taskRow(page, "PN-TASK-0175");
  await anchor.getByText("View details", { exact: true }).click();
  await anchor.scrollIntoViewIfNeeded();
  const savedOffset = await offset(page, "tasks", "PN-TASK-0175");
  await filter.selectOption(laterToken!);
  await expect(page).toHaveURL(new RegExp(`tasksAssignee=${laterToken}`));
  await expect(page.locator(rows("tasks"))).toHaveCount(1);
  await expect(page.locator(rows("tasks")).first()).toHaveAttribute("data-list-row-id", "PN-TASK-0151");
  await taskRow(page, "PN-TASK-0151").getByText("View details", { exact: true }).click();
  await page.getByRole("button", { name: /^Show completed/ }).click();
  await expect(page).toHaveURL(/tasksCompleted=1/);
  await expect(page.locator(rows("tasks"))).toHaveCount(2);
  await expect(taskRow(page, "PN-TASK-0211")).toContainText("Completed");

  await page.goBack();
  await expect(filter).toHaveValue(laterToken!);
  await expect(page.locator(rows("tasks"))).toHaveCount(1);
  await expect(taskRow(page, "PN-TASK-0151").locator("details")).toHaveJSProperty("open", true);
  await page.goBack();
  await expect(filter).toHaveValue("");
  await expect(page.locator(rows("tasks"))).toHaveCount(200);
  await expect(anchor.locator("details")).toHaveJSProperty("open", true);
  await expect.poll(async () => Math.abs(await offset(page, "tasks", "PN-TASK-0175") - savedOffset)).toBeLessThan(8);
  await page.reload();
  await expect(page.locator(rows("tasks"))).toHaveCount(200);
  await expect(anchor.locator("details")).toHaveJSProperty("open", true);
  await expect.poll(async () => Math.abs(await offset(page, "tasks", "PN-TASK-0175") - savedOffset)).toBeLessThan(8);
  await page.goForward();
  await expect(filter).toHaveValue(laterToken!);
  await expect(taskRow(page, "PN-TASK-0151").locator("details")).toHaveJSProperty("open", true);
  await page.goForward();
  await expect(page).toHaveURL(/tasksCompleted=1/);
  await expect(page.locator(rows("tasks"))).toHaveCount(2);

  await filter.selectOption(personToken!);
  await expect(page.locator(rows("tasks"))).toHaveCount(3);
  await expect(taskRow(page, "PN-TASK-0226")).toContainText("PN Synthetic Avery");
  await filter.selectOption({ label: "PN Synthetic Completed Only" });
  await expect(page.locator(rows("tasks"))).toHaveCount(1);
  await expect(taskRow(page, "PN-TASK-0212")).toContainText("Completed");
  await page.getByRole("button", { name: "Hide completed", exact: true }).click();
  await expect(page.locator(rows("tasks"))).toHaveCount(0);
  await expect(filter.locator("option").filter({ hasText: "PN Synthetic Completed Only" })).toHaveCount(1);
  await filter.selectOption("unassigned");
  await expect(page.locator(rows("tasks"))).toHaveCount(2);
  await expect(taskRow(page, "PN-TASK-0003")).toContainText("Unassigned");
  await expect(taskRow(page, "PN-TASK-0103")).toContainText("Unassigned");
  await filter.selectOption("unavailable");
  await expect(page.locator(rows("tasks"))).toHaveCount(100);
  await expect(taskRow(page, "PN-TASK-0004")).toContainText("Assignment unavailable");
  await expect(taskRow(page, "PN-TASK-0005")).toContainText("Assignment unavailable");
  await expect(taskRow(page, "PN-TASK-0003")).toHaveCount(0);
  await expectPrivateTaskNavigation(page);
});

test("ticket email search finds unloaded rows by POST, never stores the term, and restores the list", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
  const searchRequests: Array<{ method: string; url: string; body: string | null }> = [];
  page.on("request", request => {
    if (request.url().includes("/api/navigation/household-email/search")) {
      searchRequests.push({ method: request.method(), url: request.url(), body: request.postData() });
    }
  });
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  await page.goto("/households/PN-HH-0350");
  await expect(page.locator(`${card("email")}[data-list-ready="true"]`)).toHaveCount(1);
  await page.locator(card("email")).getByRole("button", { name: "Load more emails", exact: true }).click();
  await expect(page.locator(rows("email"))).toHaveCount(200);
  await page.locator(`${card("email")} [data-list-row-id="PN-EMAIL-0160"]`).scrollIntoViewIfNeeded();
  const before = await offset(page, "email", "PN-EMAIL-0160");
  const urlBefore = page.url();
  await expect(page.locator(`${card("email")} [data-list-row-id="PN-EMAIL-0205"]`)).toHaveCount(0);

  const input = page.locator(card("email")).getByRole("searchbox", { name: "Search email subjects, stored text, sender and recipients" });
  await input.fill("Fixture Email 1");
  await input.fill("Fixture Email 2");
  await expect(page.locator(card("email")).getByText("17 of 205 stored emails match.", { exact: true })).toBeVisible();
  await input.fill("email 205");
  await expect(page.locator(card("email")).getByText("1 of 205 stored emails match.", { exact: true })).toBeVisible();
  await expect(page.locator(`${card("email")} [data-email-list-hidden]`)).toBeHidden();
  const result = page.locator(`${card("email")} [data-email-search-row="PN-EMAIL-0205"]`);
  await expect(result.locator("mark")).toHaveText("Email 205");
  await expect(page.locator(`${card("email")} [data-email-search-coverage]`)).toContainText("January 1, 2026");

  expect(page.url()).toBe(urlBefore);
  expect(searchRequests.length).toBeGreaterThan(0);
  for (const request of searchRequests) {
    expect(request.method).toBe("POST");
    expect(new URL(request.url).search).toBe("");
  }
  expect(searchRequests.at(-1)?.body).toContain("email 205");
  const stored = await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage }, history: history.state }));
  for (const term of ["Fixture Email 1", "Fixture Email 2", "email 205"]) expect(stored).not.toContain(term);

  await result.getByRole("button").click();
  const dialog = page.getByRole("dialog", { name: "PN History Fixture Email 205", exact: true });
  await expect(dialog.locator("mark")).toHaveText("Email 205");
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(dialog).toHaveCount(0);

  await input.fill("50%");
  await expect(page.locator(card("email")).getByText("No stored email matches.", { exact: true })).toBeVisible();
  await expect(page.locator(card("email")).getByText(/can exist without appearing here/)).toBeVisible();

  await page.locator(card("email")).getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator(rows("email"))).toHaveCount(200);
  await expect(page.locator(`${card("email")} [data-email-search-results]`)).toHaveCount(0);
  await expect.poll(async () => Math.abs(await offset(page, "email", "PN-EMAIL-0160") - before)).toBeLessThan(8);
  expect(page.url()).toBe(urlBefore);
});


test("ticket source sender and To/Cc metadata is searchable, highlighted and disclosed", async ({ page }) => {
  const { directUrl } = validateProgressiveDatabaseEnvironment();
  const owner = new PrismaClient({ datasourceUrl: directUrl.toString(), log: [] });
  let created = false;
  const household = "001EFQ908808286", message = "00TEFQ908808286", legacy = "00TUHK400692175";
  const envelope = { version: 1, state: "MATCHED", task_sf_id: message, message_sf_id: "02sENV000000101",
    observed_at: "2026-10-16T00:00:00.000Z", source_modified_at: "2026-10-15T00:00:00.000Z",
    sender: { name: "Invented <b>Sender</b>", address: "senderbrowser@example.invalid" },
    to: [{ name: "Source Recipient", address: "recipientbrowser@example.invalid" }],
    cc: [{ name: "Source Copy", address: "copybrowser@example.invalid" }] };
  try {
    const [prior] = await owner.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM mirror.household WHERE sf_id = ${household}`;
    if (Number(prior.n)) throw new Error("synthetic_envelope_browser_fixture_collision");
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email) VALUES (${household}, 'Synthetic Envelope Browser', 'synthetic-browser@example.invalid')`;
    created = true;
    await owner.$executeRaw`INSERT INTO mirror.email (sf_id, household_sf_id, subject, body, sent_at, email_envelope)
      VALUES (${message}, ${household}, 'Synthetic recipient search', 'Synthetic message content', '2026-10-01', ${JSON.stringify(envelope)}::jsonb),
        (${legacy}, ${household}, 'Synthetic legacy email', 'Legacy synthetic content', '2026-09-01', NULL)`;
    await page.goto("/?callbackUrl=%2Fhouseholds");
    await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
    await page.goto(`/households/${household}`);
    const emailCard = page.locator(card("email"));
    await expect(emailCard.locator('[data-list-row-id]')).toHaveCount(2);
    const url = page.url();
    const input = emailCard.getByRole("searchbox", { name: "Search email subjects, stored text, sender and recipients" });
    for (const term of ["senderbrowser", "Source Recipient", "copybrowser"]) {
      await input.fill(term);
      await expect(emailCard.getByText("1 of 2 stored emails match.", { exact: true })).toBeVisible();
      const result = emailCard.locator(`[data-email-search-row="${message}"]`);
      await expect(result).toHaveCount(1); await expect(result.locator('mark')).toHaveCount(1);
      await expect(emailCard.locator('[data-email-search-coverage]')).toContainText('available for 1 of 2 stored emails');
    }
    const result = emailCard.locator(`[data-email-search-row="${message}"]`);
    await expect(result.locator('b')).toHaveCount(0);
    await expect(result).toContainText('Invented <b>Sender</b>');
    await result.getByRole('button').click();
    const dialog = page.getByRole('dialog', { name: 'Synthetic recipient search', exact: true });
    await expect(dialog).toContainText('copybrowser@example.invalid');
    await expect(dialog.locator('mark')).toHaveText('copybrowser');
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    const desktop = test.info().outputPath('email-metadata-desktop.png');
    await emailCard.screenshot({ path: desktop });
    await test.info().attach('synthetic-email-metadata-desktop', { path: desktop, contentType: 'image/png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(result).toBeVisible();
    expect(await result.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2);
    const mobile = test.info().outputPath('email-metadata-mobile.png');
    await emailCard.screenshot({ path: mobile });
    await test.info().attach('synthetic-email-metadata-mobile', { path: mobile, contentType: 'image/png' });
    expect(page.url()).toBe(url);
    const stored = await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage }, history: history.state }));
    expect(stored).not.toContain('copybrowser');
    await input.fill('legacy');
    await emailCard.locator(`[data-email-search-row="${legacy}"]`).getByRole('button').click();
    await expect(page.getByRole('dialog', { name: 'Synthetic legacy email', exact: true })).toContainText('details are unavailable for this email');
  } finally {
    if (created) {
      await owner.$executeRaw`DELETE FROM mirror.email WHERE sf_id IN (${message}, ${legacy}) AND household_sf_id = ${household}`;
      await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${household} AND name = 'Synthetic Envelope Browser'`;
    }
    await owner.$disconnect();
  }
});
