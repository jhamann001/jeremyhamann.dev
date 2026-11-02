import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { validateProgressiveDatabaseEnvironment } from "./progressive-fixture";
const ROWS = '[data-list-row-id^="-8000"]';
async function signIn(page: Page) {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
  await page.goto("/?callbackUrl=%2Fhouseholds");
  await page.getByRole("button", { name: "Riley Ops · OPERATIONS (sees all)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
}
test("Audit appends100/100/5 and restores each view's own range, filters and expansions", async ({ page }) => {
  await signIn(page);
  await page.goto("/audit-log?action=pn.navigation");
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Load more audit events", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  const event = page.locator(ROWS).nth(150);
  const id = await event.getAttribute("data-list-row-id");
  await event.getByRole("button", { name: /Expand detail/ }).click();
  await expect(event.getByRole("button", { name: /Collapse detail/ })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("link", { name: "Field changes", exact: true }).click();
  await page.getByRole("combobox", { name: "Filter by table" }).fill("pn_navigation_fixture");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(100);
  await page.getByRole("button", { name: "Load more field changes", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await page.getByRole("link", { name: "Events", exact: true }).click();
  await expect(page).toHaveURL(/action=pn.navigation/);
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect(page.locator(`[data-list-row-id="${id}"] button[aria-expanded="true"]`)).toHaveCount(1);
  await page.getByRole("button", { name: "Load more audit events", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(205);
  await page.reload();
  await expect(page.locator(ROWS)).toHaveCount(205);
  await page.getByRole("link", { name: "Field changes", exact: true }).click();
  await expect(page).toHaveURL(/table=pn_navigation_fixture/);
  await expect(page.locator(ROWS)).toHaveCount(200);
  const storage = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));
  expect(storage).not.toContain("Synthetic navigation payload");
  expect(storage).not.toContain("Synthetic field payload");
});

// Exercise actual PostgreSQL lock cancellation, not an intercepted API response.
// The harness rejects every non-loopback/non-synthetic database before connecting.
async function whileTableLocked(table: "audit.row_change" | "audit.AuditLog" | "app.employee_roster_upload", run: () => Promise<void>) {
  const { directUrl } = validateProgressiveDatabaseEnvironment();
  const owner = new PrismaClient({ datasourceUrl: directUrl.toString(), log: [] });
  let unlock!: () => void;
  let acquired!: () => void;
  let failed!: (error: unknown) => void;
  const locked = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
  const held = new Promise<void>((resolve) => { unlock = resolve; });
  const transaction = owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('lock_timeout', '2000', true), set_config('statement_timeout', '5000', true)`;
    // Static, finite table allowlist: never accept an identifier from the UI.
    if (table === "audit.row_change") await tx.$executeRaw`LOCK TABLE audit.row_change IN ACCESS EXCLUSIVE MODE`;
    else if (table === "audit.AuditLog") await tx.$executeRaw`LOCK TABLE audit."AuditLog" IN ACCESS EXCLUSIVE MODE`;
    else await tx.$executeRaw`LOCK TABLE app.employee_roster_upload IN ACCESS EXCLUSIVE MODE`;
    acquired();
    await held;
  }, { timeout: 30_000 });
  const observed = transaction.catch((error: unknown) => { failed(error); throw error; });
  // Observe early failures even while the page assertion is still running.
  void observed.catch(() => {});
  try { await locked; await run(); }
  finally { unlock(); try { await observed; } finally { await owner.$disconnect(); } }
}

test("a locked optional roster read does not block page content or claim notifications are clear", async ({ page }) => {
  await signIn(page);
  await whileTableLocked("app.employee_roster_upload", async () => {
    await page.goto("/households", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Households", exact: true })).toBeVisible();
    await page.getByLabel("Notifications, unavailable", { exact: true }).click();
    await expect(page.getByText("Notifications could not be checked.", { exact: false })).toBeVisible();
    await expect(page.getByText("No operational actions need attention.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "This page could not load", exact: true })).toHaveCount(0);
  });
  await page.reload();
  await expect(page.getByLabel("Notifications, unavailable", { exact: true })).toHaveCount(0);
});

test("locked Audit Events keep navigation and filters, then recover by explicit retry", async ({ page }) => {
  await signIn(page);
  await whileTableLocked("audit.AuditLog", async () => {
    await page.goto("/audit-log?action=pn.navigation", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Audit events could not be loaded. No data was changed.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry audit events", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "This page could not load", exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/action=pn.navigation/);
    await expect(page.getByRole("link", { name: "Field changes", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Client Portrait/ }).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Invalid `prisma");
    await expect(page.locator("body")).not.toContainText("canceling statement due to lock timeout");
  });
  await page.getByRole("button", { name: "Retry audit events", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(page).toHaveURL(/action=pn.navigation/);
});

test("a locked Audit row read cancels, preserves the shell and URL, and recovers with explicit retry", async ({ page }) => {
  await signIn(page);
  await whileTableLocked("audit.row_change", async () => {
    await page.goto("/audit-log?view=changes&table=pn_navigation_fixture", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Field changes could not be loaded. No data was changed.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "This page could not load", exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/view=changes&table=pn_navigation_fixture/);
    await expect(page.getByRole("link", { name: /Client Portrait/ }).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Invalid `prisma");
    await expect(page.locator("body")).not.toContainText("canceling statement due to lock timeout");
  });
  await page.getByRole("button", { name: "Retry field changes", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(page).toHaveURL(/view=changes&table=pn_navigation_fixture/);
});

test("Audit shows recent rows and loaded-only filter suggestions without requesting historical totals", async ({ page }) => {
  await signIn(page);
  let attempts = 0;
  await page.route("**/api/navigation/audit/metadata?**", async route => {
    attempts += 1;
    await route.fulfill({ status: 503, json: { error: "must_not_request" } });
  });
  await page.goto("/audit-log?view=changes");
  await expect(page.getByText("100 most recent changes", { exact: true })).toBeVisible();
  await expect(page.locator('[data-list-row-id]')).toHaveCount(100);
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toBeDisabled();
  await expect(page.getByText(/Suggestions come only from loaded rows, not the full history/)).toBeVisible();
  await page.getByRole("combobox", { name: "Filter by table" }).fill("pn_navigation_fixture");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(100);
  await expect(page.getByText("100 loaded matching changes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more field changes", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect(page.getByText("Showing 1–200", { exact: true })).toBeVisible();
  await expect(page.getByText(/Total loading|Total unavailable|Retry total/)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(ROWS)).toHaveCount(200);
  expect(attempts).toBe(0);
});

test("Audit inclusive dates reset rows, survive Back, reject inverted ranges and clear back to all history", async ({ page }) => {
  await signIn(page);
  let attempts = 0;
  await page.route("**/api/navigation/audit/metadata?**", async route => {
    attempts += 1;
    await route.fulfill({ status: 503, json: { error: "must_not_request" } });
  });
  await page.goto("/audit-log?view=changes&table=pn_navigation_fixture");
  await expect(page.locator(ROWS)).toHaveCount(100);
  await page.getByLabel("From date (UTC)", { exact: true }).fill("2026-09-01");
  await page.getByLabel("Through date (UTC)", { exact: true }).fill("2026-09-01");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page).toHaveURL(/from=2026-09-01.*to=2026-09-01/);
  await expect(page.locator(ROWS)).toHaveCount(100);
  await page.getByRole("button", { name: "Load more field changes", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await page.getByRole("link", { name: /Client Portrait/ }).first().click();
  await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await expect(page.getByLabel("From date (UTC)", { exact: true })).toHaveValue("2026-09-01");
  await expect(page.getByLabel("Through date (UTC)", { exact: true })).toHaveValue("2026-09-01");
  await page.getByLabel("From date (UTC)", { exact: true }).fill("2026-09-02");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Choose valid UTC dates" })).toBeVisible();
  await expect(page.locator(ROWS)).toHaveCount(200);
  await page.getByLabel("Through date (UTC)", { exact: true }).fill("2026-09-02");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(0);
  await expect(page.getByText("No changes match the current filters.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear dates", exact: true }).click();
  await expect(page).not.toHaveURL(/from=|to=/);
  await expect(page.getByRole("combobox", { name: "Filter by table" })).toHaveValue("pn_navigation_fixture");
  await expect(page.locator(ROWS)).toHaveCount(100);
  const stored = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));
  expect(stored).not.toContain("Synthetic field payload");
  expect(attempts).toBe(0);
});
