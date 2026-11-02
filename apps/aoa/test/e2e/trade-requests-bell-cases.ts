import { expect, test, type Page } from "@playwright/test";
import { signInAs, type Persona } from "./trade-requests-browser-helpers";

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const ROSTER_ROLES: Persona[] = ["ADMIN", "OPERATIONS"];
const WORKSPACE_ROLES: Persona[] = ["ADMIN", "OPERATIONS", "ADVISOR"];

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

export function bell(page: Page) {
  const summary = page.locator('summary[aria-label^="Notifications"]');
  const menu = page.locator("details", { has: summary });
  return { summary, menu, panel: menu.locator("> div") };
}

/** Today's roster-only bell: the seeded database has no applied roster, so ADMIN and OPERATIONS have the due reminder. */
export async function expectTodaysBell(page: Page, role: Persona) {
  const { summary, menu, panel } = bell(page);
  const hasReminder = ROSTER_ROLES.includes(role);
  await expect(summary).toHaveAttribute("aria-label", hasReminder ? "Notifications, 1 action needed" : "Notifications");
  await expect(summary.locator("span")).toHaveText(hasReminder ? ["1"] : []);
  await summary.click();
  await expect(menu).toHaveAttribute("open", "");
  await expect(panel.locator("strong").first()).toHaveText("Operations notifications");
  await expect(panel.getByText(hasReminder ? "1 open" : "0 open", { exact: true })).toBeVisible();
  if (hasReminder) {
    await expect(panel.getByRole("link", { name: /Open workflow →/ })).toHaveAttribute("href", "/crm/employees");
    await expect(panel.getByText("No operational actions need attention.")).toHaveCount(0);
  } else {
    await expect(panel.getByText("No operational actions need attention.", { exact: true })).toBeVisible();
    await expect(panel.getByRole("link")).toHaveCount(0);
  }
  await expect(panel.locator("section")).toHaveCount(0);
  await expect(panel.getByText("Trade Requests")).toHaveCount(0);
  await expect(panel.getByRole("status")).toHaveCount(0);
}

/** Workspace roles with the flag on: today's roster content under "Operations", then the Trade Request group. */
async function expectGroupedBell(page: Page, role: Persona) {
  const { summary, menu, panel } = bell(page);
  const hasReminder = ROSTER_ROLES.includes(role);
  await expect(summary).toHaveAttribute("aria-label", /^Notifications(, \d+ open)?$/);
  await summary.click();
  await expect(menu).toHaveAttribute("open", "");
  await expect(panel.locator("strong").first()).toHaveText("Operations notifications");
  await expect(panel.getByText(/^\d+ open$/)).toBeVisible();
  await expect(panel.locator("section")).toHaveCount(2);
  expect(await panel.locator("section").evaluateAll((sections) => sections.map((section) => section.getAttribute("aria-label")))).toEqual(["Operations", "Trade Requests"]);
  const roster = panel.locator('section[aria-label="Operations"]');
  if (hasReminder) {
    await expect(roster.getByRole("link", { name: /Open workflow →/ })).toHaveAttribute("href", "/crm/employees");
    await expect(roster.getByText("No operational actions need attention.")).toHaveCount(0);
  } else {
    await expect(roster.getByText("No operational actions need attention.", { exact: true })).toBeVisible();
    await expect(roster.getByRole("link")).toHaveCount(0);
  }
}

const expectBell = (flag: "on" | "off", page: Page, role: Persona) =>
  flag === "on" && WORKSPACE_ROLES.includes(role) ? expectGroupedBell(page, role) : expectTodaysBell(page, role);

export function bellCases(flag: "on" | "off") {
  for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"] as Persona[]) {
    test(`${role} desktop bell keeps today's roster content with the flag ${flag}`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await signInAs(page, role);
      await expectBell(flag, page, role);
      await shoot(page, `desktop-${role}-flag-${flag}`);
    });

    test(`${role} mobile bell panel fits the screen with the flag ${flag}`, async ({ page }) => {
      await page.setViewportSize(MOBILE);
      await signInAs(page, role);
      await expectBell(flag, page, role);
      const box = await bell(page).panel.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width);
      await shoot(page, `mobile-${role}-flag-${flag}`);
    });
  }

  for (const role of ROSTER_ROLES) {
    test(`${role} selecting the roster reminder opens its workflow with the flag ${flag}`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      await signInAs(page, role);
      await bell(page).summary.click();
      await bell(page).panel.getByRole("link", { name: /Open workflow →/ }).click();
      await expect(page).toHaveURL(/\/crm\/employees$/);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await shoot(page, `roster-workflow-${role}-flag-${flag}`);
    });
  }
}
