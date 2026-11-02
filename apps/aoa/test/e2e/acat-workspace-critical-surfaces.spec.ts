import { expect, test, type Page } from "@playwright/test";

// Runs in the existing critical-surfaces harness: synthetic local users/data,
// with Tracker and cloud credentials disabled. The book stays unavailable.
// The custodian library is the local authority, so an empty database is a
// successful read. Populated card rendering has separate component coverage.
async function signIn(page: Page, persona: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dev sign-in" })).toBeVisible();
  await page.getByRole("button", { name: persona, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Command Center", exact: true })).toBeVisible();
}

test("ACAT pills switch one workspace and preserve history, reload and bookmarks", async ({ page }, testInfo) => {
  await signIn(page, "Riley Ops · OPERATIONS (sees all)");
  await page.goto("/acat-tracking");
  const sidebar = page.locator("aside");
  const sidebarAcat = sidebar.getByRole("link", { name: /^ACAT Tracking/ });
  const pills = page.getByRole("navigation", { name: "ACAT workspace" });
  const libraryPill = pills.getByRole("link", { name: "Custodian Library", exact: true });
  const tracked = page.getByRole("region", { name: "Tracked ACATs", exact: true });
  const library = page.getByRole("region", { name: "Custodian Library", exact: true });

  async function expectView(view: "tracking" | "library") {
    await expect(page.getByRole("heading", { name: "ACAT Tracking", exact: true })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: /Custodian Library/ })).toHaveCount(0);
    await expect(sidebarAcat).toHaveCount(1);
    await expect(sidebarAcat).toHaveClass(/active/);
    await expect(view === "library" ? library : tracked).toBeVisible();
    await expect(view === "library" ? tracked : library).toHaveCount(0);
    await expect(libraryPill).toBeVisible();
    await expect(pills.getByRole("link", { name: "Tracked ACATs", exact: true })).toHaveCount(0);
    if (view === "library") {
      await expect(libraryPill).toHaveAttribute("aria-current", "page");
      await expect(pills.locator('[aria-current="page"]')).toHaveCount(1);
    } else {
      await expect(libraryPill).not.toHaveAttribute("aria-current", "page");
      await expect(pills.locator('[aria-current="page"]')).toHaveCount(0);
    }
  }

  await expectView("tracking");
  await expect(tracked.getByText(/Live ACAT data is unavailable/)).toBeVisible();
  await libraryPill.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/acat-tracking\?view=library$/);
  await expectView("library");
  await expect(library.getByText("No custodians are configured in the Tracker.")).toBeVisible();
  await page.reload();
  await expectView("library");
  await sidebarAcat.click();
  await expect(page).toHaveURL(/\/acat-tracking$/);
  await expectView("tracking");
  await page.goBack();
  await expectView("library");
  await page.goForward();
  await expectView("tracking");
  await page.goto("/custodian-library");
  await expect(page).toHaveURL(/\/acat-tracking\?view=library$/);
  await expectView("library");
  await page.screenshot({ path: testInfo.outputPath("acat-library-workspace.png"), fullPage: true });
  await page.goto("/acat-tracking?view=library&view=tracking");
  await expectView("tracking");
});

test("advisor cannot reach either ACAT view or the old library bookmark", async ({ page }) => {
  await signIn(page, "Avery Stone · ADVISOR (own book)");
  const denied = await page.request.get("/api/acat-workspace?view=library");
  expect(denied.status()).toBe(403);
  expect(denied.headers()["cache-control"]).toBe("private, no-store");
  await expect(page.locator("aside").getByRole("link", { name: /ACAT Tracking|Custodian Library/ })).toHaveCount(0);
  for (const path of ["/acat-tracking", "/acat-tracking?view=library", "/custodian-library"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "ACAT workspace" })).toHaveCount(0);
  }
});

test("workspace read endpoint requires authentication and handles unavailable local sources honestly", async ({ page }) => {
  const anonymous = await page.request.get("/api/acat-workspace?view=library");
  expect(anonymous.status()).toBe(401);
  await signIn(page, "Riley Ops · OPERATIONS (sees all)");
  const libraryResponse = await page.request.get("/api/acat-workspace?view=library&refresh=1");
  expect(libraryResponse.status()).toBe(200);
  expect(libraryResponse.headers()["cache-control"]).toBe("private, no-store");
  const libraryBody = await libraryResponse.json();
  expect(libraryBody.snapshot.view).toBe("library");
  expect(Array.isArray(libraryBody.snapshot.data.custodians)).toBe(true);
  const tracking = await page.request.get("/api/acat-workspace?view=tracking&refresh=1");
  expect(tracking.status()).toBe(503);
  expect(tracking.headers()["cache-control"]).toBe("private, no-store");
  expect(await tracking.json()).toEqual({ error: "ACAT workspace unavailable" });
});
