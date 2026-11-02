import { expect, test } from "@playwright/test";
import { FORM_FIXTURE } from "./forms-fixture";
import { blockExternalRequests, openFormLibrary, portrait } from "./mapped-form-browser-helpers";
import { signInOperations } from "./operations-browser-helpers";
import { getEligibleFormDefinitions } from "../../lib/forms/registry";

test.beforeEach(async ({ context }) => blockExternalRequests(context));

const canonicalFormNames: Record<string, string> = {
  ira_beneficiary_designation: "IRA Beneficiary Designation",
  "apex-acat-generic": "ACAT Transfer",
  "apex-ach-agreement": "ACH Agreement",
  direct_conversion_request: "Direct Conversion Request",
  ira_distribution_request: "Traditional IRA Distribution Request",
  roth_ira_distribution_request: "Roth IRA Distribution Request",
  "apex-transfer-on-death": "Transfer on Death",
  "apex-domestic-wire": "Domestic Wire Request",
};
const ownerForms = getEligibleFormDefinitions([
  FORM_FIXTURE.firstAccount.type,
  FORM_FIXTURE.secondAccount.type,
]);

for (const viewport of [
  { width: 1440, height: 1100, columns: 2, name: "desktop" },
  { width: 390, height: 844, columns: 1, name: "mobile" },
]) {
  // Gallery column behavior; the portrait hierarchy suite also exercises the
  // shared phone menu and verifies the available navigation/content width.
  test(`form gallery has consistent accessible actions and ${viewport.columns}-column ${viewport.name} layout`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signInOperations(page, portrait(FORM_FIXTURE.owner.id));
    await page.getByRole("link", { name: "Core Financial", exact: true }).click();
    const gallery = page.getByRole("region", { name: "Form Library", exact: true });
    await expect(gallery).toBeVisible();
    const disclosure = gallery.locator("details");
    const summary = disclosure.locator(":scope > summary");
    await expect(disclosure).toHaveJSProperty("open", false);
    await expect(summary).toContainText(`${ownerForms.length} Forms Available`);
    await expect(summary.getByText("Internal Pilot", { exact: true })).toBeVisible();
    await expect(gallery.getByTestId("form-library-grid")).toBeHidden();
    await expect(gallery.getByRole("link")).toHaveCount(0);
    await expect(gallery.getByText("Choose a form and enter the details you know. Leave the rest for completion.", { exact: true })).toBeHidden();
    if (viewport.name === "desktop") {
      const bounds = await gallery.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeLessThan(100);
      await gallery.screenshot({ path: testInfo.outputPath("form-library-desktop-collapsed.png") });
    }
    await openFormLibrary(page);
    await expect(gallery).not.toContainText(/\bdraft\b/i);
    await expect(gallery.getByText("Review and complete all required information before sending. Forms are not signed or submitted automatically.", { exact: true })).toBeVisible();
    await expect(gallery.getByRole("link", { name: "Prepare Form: Transfer on Death", exact: true })).toHaveCount(0);
    for (const definition of ownerForms) {
      const name = canonicalFormNames[definition.id];
      expect(name, `Canonical name is defined for ${definition.id}`).toBeDefined();
      expect(definition.name, definition.id).toBe(name);
      await expect(gallery.getByRole("heading", { name, exact: true })).toBeVisible();
      const link = gallery.getByRole("link", { name: `Prepare Form: ${name}`, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveText(/Prepare Form/);
    }
    await expect(gallery.getByRole("link")).toHaveCount(ownerForms.length);
    const grid = gallery.getByTestId("form-library-grid");
    const geometry = await grid.evaluate(element => ({
      columns: getComputedStyle(element).gridTemplateColumns.split(/\s+/).length,
      cards: Array.from(element.children).map(card => {
        const bounds = card.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, right: bounds.right, width: bounds.width };
      }),
    }));
    expect(geometry.columns).toBe(viewport.columns);
    expect(geometry.cards.length).toBe(ownerForms.length);
    if (viewport.columns === 2) {
      expect(Math.abs(geometry.cards[0].y - geometry.cards[1].y)).toBeLessThan(1);
      expect(geometry.cards[1].x).toBeGreaterThan(geometry.cards[0].x);
    } else {
      expect(Math.abs(geometry.cards[0].x - geometry.cards[1].x)).toBeLessThan(1);
      expect(geometry.cards[1].y).toBeGreaterThan(geometry.cards[0].y);
      for (const card of geometry.cards) {
        expect(card.x).toBeGreaterThanOrEqual(0);
        expect(card.right).toBeLessThanOrEqual(viewport.width);
      }
    }
    await gallery.screenshot({ path: testInfo.outputPath(`form-library-${viewport.name}.png`) });

    // Identical visual actions must retain unique screen-reader names and
    // ordinary keyboard navigation without triggering a generation request.
    const first = gallery.getByRole("link", { name: "Prepare Form: IRA Beneficiary Designation", exact: true });
    const second = gallery.getByRole("link", { name: "Prepare Form: ACAT Transfer", exact: true });
    await first.focus();
    await expect(first).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(second).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/client-portrait/${FORM_FIXTURE.owner.id}/forms/acat$`));
    await expect(page.getByRole("heading", { name: "ACAT Transfer", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate PDF", exact: true })).toBeVisible();
  });
}

test("empty form gallery starts closed with its status and expands the explanation without a preparation action", async ({ page }) => {
  await signInOperations(page, portrait(FORM_FIXTURE.empty.id));
  await page.getByRole("link", { name: "Core Financial", exact: true }).click();
  const gallery = page.getByRole("region", { name: "Form Library", exact: true });
  await expect(gallery).toBeVisible();
  await expect(gallery.locator("details")).toHaveJSProperty("open", false);
  await expect(gallery.locator("summary")).toContainText("No Eligible Forms");
  const explanation = gallery.getByText("No accounts with a confirmed Apex account number available. Select or link an account before preparing a form.", { exact: true });
  await expect(explanation).toBeHidden();
  await openFormLibrary(page);
  await expect(explanation).toBeVisible();
  await expect(gallery.getByText("Review and complete all required information before sending. Forms are not signed or submitted automatically.", { exact: true })).toBeVisible();
  await expect(gallery.getByRole("link")).toHaveCount(0);
  await expect(gallery).not.toContainText(/\bdraft\b/i);
});

test("the whole library toggles with mouse, Enter and Space while hidden actions stay out of tab order", async ({ page }) => {
  await signInOperations(page, portrait(FORM_FIXTURE.owner.id));
  await page.getByRole("link", { name: "Core Financial", exact: true }).click();
  const gallery = page.getByRole("region", { name: "Form Library", exact: true });
  const disclosure = gallery.locator("details");
  const summary = disclosure.locator(":scope > summary");
  const generateRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/forms/generate") generateRequests.push(request.method());
  });
  const portraitUrl = page.url();

  await expect(disclosure).toHaveJSProperty("open", false);
  await expect(summary.locator("a, button, input")).toHaveCount(0);
  await expect(summary).not.toHaveAttribute("aria-expanded");
  await summary.focus();
  await page.keyboard.press("Tab");
  expect(await gallery.evaluate(element => element.contains(document.activeElement))).toBe(false);
  await page.keyboard.press("Shift+Tab");
  await expect(summary).toBeFocused();
  const outline = await summary.evaluate(element => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");

  for (const key of ["Enter", "Space"]) {
    await summary.press(key);
    await expect(disclosure).toHaveJSProperty("open", true);
    await expect(gallery.getByRole("link")).toHaveCount(ownerForms.length);
    await summary.press(key);
    await expect(disclosure).toHaveJSProperty("open", false);
    await expect(gallery.getByRole("link")).toHaveCount(0);
  }
  await summary.click();
  await expect(disclosure).toHaveJSProperty("open", true);
  await summary.click();
  await expect(disclosure).toHaveJSProperty("open", false);
  expect(page.url()).toBe(portraitUrl);
  expect(generateRequests).toEqual([]);
});

test("same-portrait tabs preserve expansion but a fresh load starts closed", async ({ page }) => {
  await signInOperations(page, portrait(FORM_FIXTURE.owner.id));
  await page.getByRole("link", { name: "Core Financial", exact: true }).click();
  const gallery = await openFormLibrary(page);
  const disclosure = gallery.locator("details");
  await page.getByRole("navigation", { name: "Client hub", exact: true }).getByRole("link", { name: "Portrait", exact: true }).click();
  await page.getByRole("tab", { name: "Communications", exact: true }).click();
  await expect(gallery).toBeHidden();
  await page.getByRole("link", { name: "Core Financial", exact: true }).click();
  await expect(disclosure).toHaveJSProperty("open", true);
  await expect(gallery.getByRole("link")).toHaveCount(ownerForms.length);

  await page.reload();
  await expect(page.getByRole("link", { name: "Core Financial", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(disclosure).toHaveJSProperty("open", false);
  await expect(gallery.getByRole("link")).toHaveCount(0);
});

test("browser Back keeps the library usable and a different client gets its own closed library", async ({ page }, testInfo) => {
  await signInOperations(page, portrait(FORM_FIXTURE.owner.id));
  await page.getByRole("link", { name: "Core Financial", exact: true }).click();
  let gallery = await openFormLibrary(page);
  await gallery.getByRole("link", { name: "Prepare Form: ACAT Transfer", exact: true }).click();
  // The gallery itself has an ACAT Transfer h3. Wait for the destination URL
  // and h1 before going Back, rather than matching the still-visible card.
  await expect(page).toHaveURL(new RegExp(`/client-portrait/${FORM_FIXTURE.owner.id}/forms/acat$`));
  await expect(page.getByRole("heading", { name: "ACAT Transfer", exact: true, level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/client-portrait/${FORM_FIXTURE.owner.id}\\?portraitTab=financial$`));
  gallery = page.getByRole("region", { name: "Form Library", exact: true });
  await expect(gallery).toBeVisible();
  // Native disclosure restoration is browser-dependent. Record it rather than
  // adding storage or asserting that Back must discard the existing page state.
  const restoredOpen = await gallery.locator("details").evaluate(element => (element as HTMLDetailsElement).open);
  testInfo.annotations.push({ type: "browser-back-disclosure", description: restoredOpen ? "expanded" : "collapsed" });
  await openFormLibrary(page);
  await expect(gallery.getByRole("link")).toHaveCount(ownerForms.length);

  // Use the real in-app directory links instead of rewriting the current URL or
  // dispatching a synthetic disclosure event.
  await page.getByRole("link", { name: /^Client Portrait/ }).click();
  await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Morgan Example", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/client-portrait/${FORM_FIXTURE.other.id}$`));
  await page.getByRole("link", { name: "Core Financial", exact: true }).click();
  gallery = page.getByRole("region", { name: "Form Library", exact: true });
  await expect(gallery.locator("details")).toHaveJSProperty("open", false);
  await expect(gallery.getByRole("link")).toHaveCount(0);
  await openFormLibrary(page);
  await expect(gallery.getByRole("link", { name: "Prepare Form: Transfer on Death", exact: true })).toBeVisible();
  await expect(gallery.getByRole("link", { name: "Prepare Form: Roth IRA Distribution Request", exact: true })).toHaveCount(0);

  await page.goto(`${portrait(FORM_FIXTURE.owner.id)}/forms/ira-beneficiary`);
  await expect(page.getByRole("heading", { name: "IRA Beneficiary Designation", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate PDF", exact: true })).toBeVisible();
});
