import { expect, test } from "@playwright/test";
import { signInAs, type Persona } from "./trade-requests-browser-helpers";
import { expectTodaysBell } from "./trade-requests-bell-cases";

// Flag off: every role gets TRW-05's (today's) bell and no Trade Request request.
for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} bell is today's bell and makes no Trade Request request with the flag off`, async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/api/trade-requests/")) calls.push(request.url()); });
    await page.setViewportSize({ width: 1440, height: 950 });
    await signInAs(page, role);
    await expectTodaysBell(page, role);
    await page.goto("/households");
    await page.waitForTimeout(3_000);
    expect(calls).toEqual([]);
    expect((await page.request.get("/api/trade-requests/notifications")).status()).toBe(404);
    await page.screenshot({ path: test.info().outputPath(`flag-off-${role}.png`), fullPage: true });
  });
}
