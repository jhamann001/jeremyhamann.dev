import { expect, test } from "@playwright/test";
import { signInAs, type Persona } from "./trade-requests-browser-helpers";

// ticket with the Drift view switch off (Trade Requests still AOA-served in the shared synthetic database).
for (const role of ["ADMIN", "ADVISOR"] as Persona[]) {
  test(`${role}: switch off shows no Drift or Roster pill and both addresses are not found`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 950 });
    await signInAs(page, role, "/trade-requests");
    const sub = page.getByRole("navigation", { name: "Trade Requests workspace" });
    await expect(sub.getByRole("link")).toHaveCount(3);
    await expect(sub.getByRole("link", { name: "Drift" })).toHaveCount(0);
    for (const path of ["/trade-requests/drift", "/trade-requests/roster"]) {
      await page.goto(path);
      await expect(page.getByText("This page could not be found.")).toBeVisible();
      await expect(page.locator("tr[data-drift-row], tr[data-roster-member]")).toHaveCount(0);
    }
    await page.screenshot({ path: test.info().outputPath(`switch-off-${role}.png`), fullPage: true });
  });
}
