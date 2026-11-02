import { expect, test, type Page } from "@playwright/test";

const personas = [
  { label: "Riley Ops · OPERATIONS (sees all)", reminders: true },
  { label: "Dana Admin · ADMIN (sees all)", reminders: true },
  { label: "Avery Stone · ADVISOR (own book)", reminders: true },
  { label: "Val Viewer · VIEWER (sees none)", reminders: false },
];

function requireSyntheticTarget() {
  const direct = new URL(process.env.DIRECT_DATABASE_URL ?? "");
  const runtime = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE ||
      ["prod", "dev"].includes(process.env.APP_ENV ?? "") ||
      !["localhost", "127.0.0.1"].includes(direct.hostname) || direct.pathname !== "/aoa" ||
      direct.username !== "aoa" || runtime.username !== "app_rw" ||
      direct.host !== runtime.host || direct.pathname !== runtime.pathname ||
      [direct, runtime].some(url => ["host", "hostaddr", "service", "servicefile"].some(key => url.searchParams.has(key)))) {
    throw new Error("Browser smoke requires the isolated loopback aoa database");
  }
}

async function signIn(page: Page, label: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dev sign-in" })).toBeVisible();
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Command Center", exact: true })).toBeVisible();
}

test.beforeEach(() => { requireSyntheticTarget(); });

for (const persona of personas) {
  test(`Smart Nudges stays hidden while the authenticated route remains available for ${persona.label}`, async ({ page }) => {
    const browserErrors: string[] = [];
    page.on("pageerror", error => browserErrors.push(error.message));
    await signIn(page, persona.label);
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await page.getByRole("button", { name: "Toggle color theme", exact: true }).click();
      for (const width of [1280, 900]) {
        await page.setViewportSize({ width, height: 900 });
        const sidebar = page.getByRole("complementary");
        await expect(sidebar.locator('a[href="/smart-nudges"]')).toHaveCount(0);
        await expect(sidebar.locator('a[href="/decision-center"]')).toHaveCount(0);
        await expect(sidebar.locator('a[href="/tasks"]')).toBeVisible();
      }
    }
    if (persona.reminders) {
      await page.goto("/client-portrait/C-1/reminders");
      await expect(page.getByRole("heading", { name: "Client-facing reminders", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Advisor lens", exact: true })).toBeVisible();
      await expect(page.locator('a[href="/smart-nudges"]')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("reminders-without-smart-nudges.png"), fullPage: true });
    }
    await page.goto("/smart-nudges");
    for (const heading of ["Smart Nudges", "Nudge Queue", "Template Library"]) {
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("complementary").locator('a[href="/smart-nudges"]')).toHaveCount(0);
    expect(browserErrors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("preserved-smart-nudges-direct-route.png"), fullPage: true });
  });
}

test("Smart Nudges direct route still requires authentication", async ({ page }) => {
  await page.goto("/smart-nudges");
  await expect(page.getByRole("heading", { name: "Dev sign-in", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nudge Queue", exact: true })).toHaveCount(0);
});
