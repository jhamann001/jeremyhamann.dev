import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signInAs, type Persona } from "./trade-requests-browser-helpers";
import { SUBMIT_SEED_FILE, type SubmitSeed } from "./trade-requests-submit-fixture";

const seed = (): SubmitSeed => JSON.parse(readFileSync(SUBMIT_SEED_FILE, "utf8"));

for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} gets not found on the New Request, edit and clone addresses with the flag off`, async ({ page }) => {
    const { editId, rejectedId } = seed();
    await page.setViewportSize({ width: 1440, height: 950 });
    await signInAs(page, role);
    for (const path of ["/trade-requests/new", `/trade-requests/new/edit/${editId}`, `/trade-requests/new/clone/${rejectedId}`]) {
      await page.goto(path);
      await expect(page.getByText("This page could not be found.")).toBeVisible();
      await expect(page.getByRole("button", { name: /Resubmit to Trader|Submit Trade Request|Generate Plan & Submit/ })).toHaveCount(0);
    }
    await page.screenshot({ path: test.info().outputPath(`flag-off-${role}.png`), fullPage: true });
  });
}
