import { expect, test, type Page } from "@playwright/test";

// Real authenticated routes on the guarded loopback fixture. Keep the browser's
// IntersectionObserver enabled: the earlier navigation suite deliberately
// disabled it and did not exercise concurrent directory tabs.
const CLIENTS = '[data-list-row-id^="PN-CLIENT-"]';
const IDENTITIES = '[data-list-row-id^="hld_pncrm"]';
const CHANGES = '[data-list-row-id^="-8000"]';

async function healthy(page: Page, rows: string, count: number) {
  await expect(page.locator(rows)).toHaveCount(count);
  await expect(page.getByRole("heading", { name: "This page could not load", exact: true })).toHaveCount(0);
  await expect(page.getByText("Your results could not be restored. Retry to load the current list.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("The CRM registry did not respond in time. No data was changed.", { exact: true })).toHaveCount(0);
}

test("simultaneous Client, CRM and Audit tabs retain healthy continuation and browser Back", async ({ page, context }) => {
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  const crm = await context.newPage();
  const audit = await context.newPage();
  const failures: string[] = [];
  for (const tab of [page, crm, audit]) {
    tab.on("response", response => {
      const path = new URL(response.url()).pathname;
      // The synthetic harness deliberately disconnects the external tracker;
      // its independent optional badge is expected to report unavailable.
      if (path.startsWith("/api/navigation/") && response.status() >= 400) {
        failures.push(`${path}:${response.status()}`);
      }
    });
  }
  try {
    await Promise.all([
      page.goto("/client-portrait?q=PN+Fixture"),
      crm.goto("/crm?q=hld_pncrm&type=HOUSEHOLD"),
      audit.goto("/audit-log?view=changes&table=pn_navigation_fixture"),
    ]);
    await Promise.all([
      healthy(page, CLIENTS, 100), healthy(crm, IDENTITIES, 100), healthy(audit, CHANGES, 100),
    ]);
    for (const tab of [page, crm, audit]) {
      await expect(tab.locator('[data-list-ready="true"]')).toHaveCount(1);
    }
    await Promise.all([
      page.getByRole("button", { name: "Load more clients", exact: true }).click(),
      crm.getByRole("button", { name: "Load more crm identities", exact: true }).click(),
      audit.getByRole("button", { name: "Load more field changes", exact: true }).click(),
    ]);
    // Clicking the bottom buttons may also activate real scroll continuation.
    // Whatever range is loaded must survive return; no fixed fake observer.
    await expect.poll(() => page.locator(CLIENTS).count()).toBeGreaterThanOrEqual(200);
    await expect.poll(() => crm.locator(IDENTITIES).count()).toBeGreaterThanOrEqual(200);
    await expect.poll(() => audit.locator(CHANGES).count()).toBeGreaterThanOrEqual(200);
    await page.locator('[data-list-scroll-container]').evaluate(element => { element.scrollTop = 0; });
    await crm.locator('[data-list-scroll-container]').evaluate(element => { element.scrollTop = 0; });
    for (const tab of [page, crm, audit]) {
      await expect(tab.getByRole("status").filter({ hasText: "Loading more…" })).toHaveCount(0);
    }
    const clientCount = await page.locator(CLIENTS).count();
    const crmCount = await crm.locator(IDENTITIES).count();
    await Promise.all([
      page.locator(CLIENTS).first().locator('a[href^="/client-portrait/"]').click(),
      crm.locator(IDENTITIES).first().getByRole("link", { name: "Inspect →", exact: true }).click(),
    ]);
    await expect(page.getByRole("link", { name: "‹ Back to client results", exact: true })).toBeVisible();
    await expect(crm.getByRole("link", { name: "← CRM Explorer", exact: true })).toBeVisible();
    const clientReauthorization = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/navigation/clients" && url.searchParams.get("page") === "1";
    });
    const crmReauthorization = crm.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/navigation/crm/window" && url.searchParams.get("loaded") === "0";
    });
    const restoredRequests: Array<{ loaded: string | null; restoreRows: string | null }> = [];
    crm.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === "/api/navigation/crm/window") restoredRequests.push({
        loaded: url.searchParams.get("loaded"), restoreRows: url.searchParams.get("restoreRows"),
      });
    });
    await Promise.all([page.goBack(), crm.goBack()]);
    expect((await clientReauthorization).status()).toBe(200);
    expect((await crmReauthorization).status()).toBe(200);
    await Promise.all([healthy(page, CLIENTS, clientCount), healthy(crm, IDENTITIES, crmCount)]);
    expect(restoredRequests).toEqual([{ loaded: "0", restoreRows: String(Math.ceil(crmCount / 100) * 100) }]);
    expect(failures).toEqual([]);
  } finally {
    await crm.close();
    await audit.close();
  }
});

test("sidebar GET reads do not queue each other, navigation, Back or a later refresh", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Set<string>();
  await page.route("**/api/navigation/badges", async route => {
    requested.add(new URL(route.request().url()).pathname);
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  const actionPosts: string[] = [];
  const navigations: string[] = [];
  page.on("request", request => {
    if (request.headers()["next-action"]) actionPosts.push(request.method());
    if (request.headers()["rsc"] === "1") navigations.push(new URL(request.url()).pathname);
  });
  try {
    await expect.poll(() => requested.size).toBe(1);
    await page.getByRole("link", { name: /Client Portrait/ }).first().click();
    await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
    const before = navigations.length;
    release();
    await expect(page.locator('aside [title="Count loading"]')).toHaveCount(0);
    expect(actionPosts).toEqual([]);
    // Give any queued refresh two browser paints and a bounded idle window.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.waitForTimeout(250);
    expect(navigations).toHaveLength(before);
  } finally { release(); }
});

for (const failure of ["503", "null", "wrong-scope"] as const) test(`sidebar ${failure} counts are unavailable, retry explicitly and never label unrelated links`, async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/navigation/badges", async route => {
    attempts += 1;
    if (attempts > 1) { await route.continue(); return; }
    if (failure === "503") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "navigation_counts_unavailable" }) });
    } else {
      const response = await route.fetch();
      await route.fulfill({ response, ...(failure === "null" ? { json: null }
        : { headers: { ...response.headers(), "x-aoa-navigation-scope": "0".repeat(64) } }) });
    }
  });
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  const householdLink = page.getByRole("link", { name: /Households/ }).first();
  await expect(householdLink.locator('[title="Count unavailable"]')).toBeVisible();
  await expect(page.getByRole("link", { name: /Audit Log/ }).locator('[title="Count unavailable"]')).toHaveCount(0);
  await expect(householdLink.locator('[title="Count loading"]')).toHaveCount(0);
  expect(attempts).toBe(1);
  await page.getByRole("button", { name: "Retry unavailable counts", exact: true }).click();
  await expect(householdLink.locator('[title="Count unavailable"]')).toHaveCount(0);
  await expect(householdLink.locator('[title="Count loading"]')).toHaveCount(0);
  expect(attempts).toBe(2);
});

test("a stalled sidebar read stops loading after its browser deadline and ignores a late reply", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  await page.route("**/api/navigation/badges", async route => {
    attempts += 1;
    const response = await route.fetch();
    if (attempts === 1) await held;
    try { await route.fulfill({ response }); } catch { /* expected when the browser aborted */ }
  });
  await page.clock.install();
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
  const householdLink = page.getByRole("link", { name: /Households/ }).first();
  try {
    await expect.poll(() => attempts).toBe(1);
    await page.clock.fastForward(20_001);
    await expect(householdLink.locator('[title="Count unavailable"]')).toBeVisible();
    release();
    await expect(householdLink.locator('[title="Count unavailable"]')).toBeVisible();
    expect(attempts).toBe(1);
    await page.getByRole("button", { name: "Retry unavailable counts", exact: true }).click();
    await expect(householdLink.locator('[title="Count unavailable"]')).toHaveCount(0);
    await expect(householdLink.locator('[title="Count loading"]')).toHaveCount(0);
    expect(attempts).toBe(2);
  } finally { release(); }
});
