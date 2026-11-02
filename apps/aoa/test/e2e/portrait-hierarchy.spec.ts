import { expect, test, type Page, type Request } from "@playwright/test";
import { PORTRAIT_DEALS as fixture } from "./portrait-deals-fixture";

const variant = process.env.PORTRAIT_HIERARCHY_VARIANT ?? "all";
const relationships = variant === "relationships" || variant === "all";
const documents = variant === "documents" || variant === "all";
const contact = (process.env.PORTRAIT_HIERARCHY_CONTACT ?? "1") === "1";
const base = `/client-portrait/${fixture.memberA}`;
const submenu = ["Communications", "Insights", ...(relationships ? ["Relationships"] : []), ...(documents ? ["Documents"] : [])];
const queryByTab: Record<string, string | null> = {
  Communications: "comms", Insights: "portrait", Relationships: "relationships", Documents: "documents",
};
const hub = (page: Page) => page.getByRole("navigation", { name: "Client hub", exact: true });
const financial = (page: Page) => hub(page).getByRole("link", { name: "Core Financial", exact: true });
const portrait = (page: Page) => hub(page).getByRole("link", { name: "Portrait", exact: true });
const deals = (page: Page) => page.locator("details").filter({ has: page.locator("h2").filter({ hasText: /^Deals$/ }) });
const financialSection = (page: Page) => page.getByRole("region", { name: "Core Financial", exact: true });

async function signIn(page: Page, path = base, role = "Riley Ops · OPERATIONS (sees all)") {
  await page.goto(`/?callbackUrl=${encodeURIComponent(path)}`);
  await page.getByRole("button", { name: role, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(path.split("?")[0]));
  if (path.split("?")[0] !== "/client-portrait") await expect(hub(page)).toBeVisible();
}

test.beforeEach(async ({ context }) => {
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(url.hostname) || url.protocol === "data:") await route.continue();
    else await route.abort("blockedbyclient");
  });
});

test("the flag-dependent hierarchy binds every pane correctly and removes Illustration", async ({ page }) => {
  await signIn(page);
  await expect(hub(page).getByRole("link")).toHaveText(["Core Financial", "Portrait", ...(contact ? ["Contact"] : []), "Dual-View", "Reminders"]);
  await expect(financial(page)).toHaveAttribute("aria-current", "page");
  await expect(financialSection(page)).toBeVisible();
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await portrait(page).click();
  await expect(portrait(page)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tab")).toHaveText(submenu);
  await expect(page.getByRole("link", { name: "Illustration", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Illustration", exact: true })).toHaveCount(0);
  await expect(page.locator('a[href$="/illustration"]')).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Core Financial", exact: true })).toHaveCount(0);
  const relationshipRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/crm/relationships") relationshipRequests.push(request.url());
  });
  for (const name of submenu) {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const pane = page.getByRole("tabpanel", { name, exact: true });
    await expect(pane).toBeVisible();
    await expect(pane.getByRole("heading", { name: "Investment accounts", exact: true })).toHaveCount(0);
    if (name === "Communications") await expect(pane.getByRole("link", { name: "View household activity →", exact: true })).toBeVisible();
    if (name === "Insights") {
      await expect(pane.getByRole("heading", { name: "Client insights", exact: true })).toBeVisible();
      expect(relationshipRequests).toEqual([]);
    }
    if (name === "Relationships") {
      await pane.scrollIntoViewIfNeeded();
      await expect.poll(() => relationshipRequests.length).toBe(1);
      await expect(pane).not.toContainText("could not be loaded");
    }
    if (name === "Documents") await expect(pane).toContainText("These are example document pointers only.");
  }
  await financial(page).click();
  await expect(financial(page)).toHaveAttribute("aria-current", "page");
  await expect(portrait(page)).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(financialSection(page)).toBeVisible();
  await expect(deals(page)).toHaveCount(1);
  await expect(financialSection(page).locator(":scope > *").nth(0).getByRole("heading", { name: "Investment accounts", exact: true })).toBeVisible();
  await expect(financialSection(page).locator(":scope > *").nth(1).getByRole("heading", { name: "Deals", exact: true })).toBeVisible();
  await deals(page).locator("summary").press("Enter");
  await expect(deals(page).locator('tbody a[href^="/deals/"]')).toHaveCount(5);
  await expect(deals(page).locator(`a[href="/deals/${fixture.sibling}"]`)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("core-financial.png"), fullPage: true, animations: "disabled" });
  await portrait(page).click();
  await expect(portrait(page)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tab")).toHaveText(submenu);
  await expect(deals(page)).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("portrait-navigation.png"), fullPage: true, animations: "disabled" });
});

test("Contact is available only when the layout opts into its existing route", async ({ page }) => {
  await signIn(page);
  const contactLink = hub(page).getByRole("link", { name: "Contact", exact: true });
  if (!contact) {
    await expect(contactLink).toHaveCount(0);
    return;
  }
  await expect(contactLink).toHaveAttribute("href", `${base}/contact`);
  await contactLink.click();
  await expect(page).toHaveURL(new RegExp(`${base}/contact$`));
  await expect(contactLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Awaiting an approved contact data source", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How to reach Portrait Table Fixture Member A", exact: true })).toBeVisible();
  await financial(page).click();
  await expect(financial(page)).toHaveAttribute("aria-current", "page");
  await expect(financialSection(page)).toBeVisible();
});

test("tab selection stays local, preserves history metadata and query/hash, and supports the keyboard", async ({ page }) => {
  await signIn(page);
  await page.goto(`${base}?tabSmoke=synthetic#portrait-tabs`);
  const initialHistoryLength = await page.evaluate(() => {
    window.history.replaceState({ ...window.history.state, __aoaListNavigationEntryV1: "synthetic-tab-entry" }, "", window.location.href);
    return window.history.length;
  });
  const serverNavigations: string[] = [];
  const track = (request: Request) => {
    const url = new URL(request.url());
    if (request.isNavigationRequest() || (request.headers().rsc === "1" && url.pathname.startsWith("/client-portrait/"))) serverNavigations.push(url.pathname);
  };
  page.on("request", track);
  await portrait(page).click();
  await expect(page).toHaveURL(/portraitTab=comms/);
  for (const name of submenu) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(page.getByRole("tabpanel", { name, exact: true })).toBeVisible();
    const url = new URL(page.url());
    expect(url.searchParams.get("portraitTab")).toBe(queryByTab[name]);
    expect(url.searchParams.get("tabSmoke")).toBe("synthetic");
    expect(url.hash).toBe("#portrait-tabs");
  }
  const first = page.getByRole("tab", { name: "Communications", exact: true });
  const insights = page.getByRole("tab", { name: "Insights", exact: true });
  await page.getByRole("tab").last().press("Home");
  await expect(first).toBeFocused();
  await first.press("ArrowRight");
  await expect(insights).toBeFocused();
  await expect(insights).toHaveAttribute("aria-selected", "true");
  await insights.press("End");
  await expect(page.getByRole("tab").last()).toBeFocused();
  await page.getByRole("tab").last().press("ArrowRight");
  await expect(first).toBeFocused();
  await financial(page).focus();
  await financial(page).press("Enter");
  await expect(financial(page)).toHaveAttribute("aria-current", "page");
  await portrait(page).focus();
  await portrait(page).press("Enter");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(portrait(page)).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => window.history.length)).toBe(initialHistoryLength);
  expect(await page.evaluate(() => window.history.state.__aoaListNavigationEntryV1)).toBe("synthetic-tab-entry");
  expect(new URL(page.url()).searchParams.get("tabSmoke")).toBe("synthetic");
  expect(new URL(page.url()).hash).toBe("#portrait-tabs");
  expect(serverNavigations).toEqual([]);
  page.off("request", track);
});

test("bare entry and financial bookmarks retain the first selected section through reload, Back, Forward and Forms", async ({ page }) => {
  await signIn(page, "/client-portrait");
  await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
  // Exercise a real directory link, without a query parameter or an extra click.
  await page.getByRole("searchbox", { name: "Search clients", exact: true }).fill("Portrait Table Fixture Member A");
  await expect(page).toHaveURL(/q=Portrait\+Table\+Fixture\+Member\+A/);
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  const directoryLink = page.locator(`a[href="${base}"]`);
  await expect(directoryLink).toHaveCount(1);
  await directoryLink.click();
  expect(new URL(page.url()).searchParams.has("portraitTab")).toBe(false);
  for (let visit = 0; visit < 2; visit++) {
    if (visit) await page.reload();
    await expect(financial(page)).toHaveAttribute("aria-current", "page");
    await expect(portrait(page)).not.toHaveAttribute("aria-current", "page");
    await expect(hub(page).getByRole("link").first()).toHaveText("Core Financial");
    await expect(financialSection(page)).toBeVisible();
    await expect(deals(page)).toBeVisible();
    await expect(page.getByRole("tablist")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("portraitTab")).toBe(false);
  }
  await page.screenshot({ path: test.info().outputPath("core-financial-default.png"), fullPage: true, animations: "disabled" });
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
  // The heading can appear before the progressive directory restores its
  // history entry. Traverse Forward only after that visible list is ready.
  await expect(page.locator('[data-list-ready="true"]')).toHaveCount(1);
  await expect(page.locator('[data-list-ready="true"] > [aria-busy="false"]')).toHaveCount(1);
  await expect(directoryLink).toBeVisible();
  await page.goForward();
  await expect(financial(page)).toHaveAttribute("aria-current", "page");
  await expect(financialSection(page)).toBeVisible();
  await page.getByRole("link", { name: "‹ Back to client results", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search clients", exact: true })).toHaveValue("Portrait Table Fixture Member A");
  await page.goto(`${base}?portraitTab=financial&source=synthetic`);
  for (let visit = 0; visit < 2; visit++) {
    if (visit) await page.reload();
    await expect(financial(page)).toHaveAttribute("aria-current", "page");
    await expect(financialSection(page)).toBeVisible();
    await expect(deals(page)).toBeVisible();
    await expect(page.getByRole("tablist")).toHaveCount(0);
  }
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
  await page.goForward();
  await expect(financial(page)).toHaveAttribute("aria-current", "page");
  await deals(page).locator("summary").click();
  await deals(page).locator(`a[href="/deals/${fixture.first}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/deals/${fixture.first}$`));
  await expect(page.getByRole("heading", { name: `Portrait Table Fixture ${fixture.first}`, exact: true })).toBeVisible();
  await page.goBack();
  await expect(financial(page)).toHaveAttribute("aria-current", "page");
  await expect(deals(page)).toBeVisible();
  await page.goto(`${base}/forms/acat`);
  await expect(financial(page)).toHaveAttribute("aria-current", "page");
  const returnLink = page.getByRole("link", { name: "← Portrait Table Fixture Member A", exact: true });
  await expect(returnLink).toHaveAttribute("href", `${base}?portraitTab=financial`);
  await returnLink.click();
  await expect(financial(page)).toHaveAttribute("aria-current", "page");
  await expect(financialSection(page)).toBeVisible();
});

test("Insights accepts the legacy and readable aliases, and unknown or gated values fall back safely", async ({ page }) => {
  await signIn(page);
  for (const key of ["portrait", "insights"]) {
    await page.goto(`${base}?portraitTab=${key}&source=synthetic`);
    await expect(portrait(page)).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("tab", { name: "Insights", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Client insights", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("tab", { name: "Insights", exact: true })).toHaveAttribute("aria-selected", "true");
  }
  for (const key of ["unknown", "illustration"]) {
    await page.goto(`${base}?portraitTab=${key}`);
    await expect(financial(page)).toHaveAttribute("aria-current", "page");
    await expect(portrait(page)).not.toHaveAttribute("aria-current", "page");
    await expect(financialSection(page)).toBeVisible();
    await expect(deals(page)).toBeVisible();
    await expect(page.getByRole("tablist")).toHaveCount(0);
  }
  const unavailable = [...(!relationships ? ["relationships"] : []), ...(!documents ? ["documents"] : [])];
  for (const key of unavailable) {
    await page.goto(`${base}?portraitTab=${key}`);
    await expect(portrait(page)).toHaveAttribute("aria-current", "page");
    await expect(financial(page)).not.toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("tab", { name: "Communications", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(deals(page)).toBeHidden();
  }
  // A permitted role still needs a contact identity before Relationships exists.
  await page.goto(`/client-portrait/${fixture.memberB}?portraitTab=relationships`);
  await expect(page.getByRole("tab", { name: "Relationships", exact: true })).toHaveCount(0);
  await expect(portrait(page)).toHaveAttribute("aria-current", "page");
  await expect(financial(page)).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tab", { name: "Communications", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("old Illustration bookmarks redirect to Portrait with repeated unrelated metadata preserved", async ({ page }) => {
  await signIn(page);
  await page.goto(`${base}/illustration?portraitTab=financial&source=synthetic&source=second&returnTo=%2Fclient-portrait%3Fq%3Dsynthetic`);
  await expect(page).toHaveURL(new RegExp(`${base}\\?`));
  const url = new URL(page.url());
  expect(url.pathname).toBe(base);
  expect(url.searchParams.get("portraitTab")).toBe("comms");
  expect(url.searchParams.getAll("source")).toEqual(["synthetic", "second"]);
  expect(url.searchParams.get("returnTo")).toBe("/client-portrait?q=synthetic");
  await expect(portrait(page)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tab", { name: "Communications", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Client Illustration & Presentation", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Illustration", exact: true })).toHaveCount(0);
});

test("the phone menu supports keyboard dismissal and gives the portrait navigation usable width", async ({ page }) => {
  await signIn(page);
  const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
  if ((page.viewportSize()?.width ?? 1440) > 640) {
    await expect(navigation).toBeVisible();
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeHidden();
    return;
  }
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  await expect(navigation).toBeHidden();
  await menu.focus();
  await menu.press("Enter");
  const closeMenu = page.getByRole("button", { name: "Close menu", exact: true });
  await expect(closeMenu).toHaveAttribute("aria-expanded", "true");
  await expect(navigation).toBeVisible();
  const households = navigation.getByRole("link", { name: /^Households/ });
  await households.focus();
  await households.press("Escape");
  await expect(menu).toBeFocused();
  await expect(navigation).toBeHidden();
  await menu.press("Enter");
  await households.click();
  await expect(page).toHaveURL(/\/households$/);
  await expect(navigation).toBeHidden();
  await page.goBack();
  await expect(hub(page)).toBeVisible();
  await expect(financial(page)).toHaveAttribute("aria-current", "page");
  await expect(financialSection(page)).toBeVisible();
  const bounds = await hub(page).boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(340);
  for (const link of await hub(page).getByRole("link").all()) {
    const box = await link.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(await link.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await portrait(page).click();
  await expect(portrait(page)).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("tab", { name: "Communications", exact: true })).toHaveAttribute("aria-selected", "true");
  for (const tab of await page.getByRole("tab").all()) {
    await tab.focus();
    await expect(tab).toBeInViewport();
    expect(await tab.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("portrait-mobile-menu-closed.png"), fullPage: true, animations: "disabled" });
});
