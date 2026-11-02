import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { toDateStr } from "../../lib/market-calendar";

const SYNTHETIC_OPERATIONS_PERSONA =
  "Riley Ops · OPERATIONS (sees all)";

type Surface = {
  path: string;
  heading: string;
  evidence?: string;
};

const CRITICAL_SURFACES: Surface[] = [
  { path: "/households", heading: "Households", evidence: "Stone Family Trust" },
  { path: "/households/HH-1001", heading: "Stone Family Trust" },
  { path: "/client-portrait", heading: "Clients", evidence: "Sam Stone" },
  { path: "/client-portrait/C-1", heading: "Sam Stone" },
  { path: "/reporting", heading: "Reporting" },
  { path: "/data-health", heading: "Data health" },
];

async function expectHealthySurface(page: Page, surface: Surface) {
  const startedAt = Date.now();
  const response = await page.goto(surface.path, { waitUntil: "domcontentloaded" });

  expect(response, `${surface.path} did not return an HTTP response`).not.toBeNull();
  expect(response?.status(), `${surface.path} returned a server error`).toBe(200);
  await expect(page.getByRole("heading", { name: surface.heading, exact: true })).toBeVisible();
  if (surface.evidence) {
    // Directory rows include a navigation chevron in the link's accessible
    // text, so match the stable synthetic label without requiring byte-exact
    // cell text.
    await expect(page.getByText(surface.evidence).first()).toBeVisible();
  }
  await expect(page.getByText(/Application error|Internal Server Error/i)).toHaveCount(0);

  // This is deliberately generous for shared CI runners. It catches stalled or
  // accidentally unbounded synthetic reads without turning normal runner noise
  // into a flaky release gate.
  expect(Date.now() - startedAt, `${surface.path} exceeded the smoke budget`).toBeLessThan(15_000);
}

async function signInOperations(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dev sign-in" })).toBeVisible();
  await page.getByRole("button", { name: SYNTHETIC_OPERATIONS_PERSONA }).click();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
}

function syntheticDatabaseOwner() {
  // This fixture can run only in the isolated synthetic CI/local database used
  // by the critical-smoke harness. Never inherit a deployed database target.
  const direct = new URL(process.env.DIRECT_DATABASE_URL ?? "");
  const runtime = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE ||
      ["prod", "dev"].includes(process.env.APP_ENV ?? "") ||
      !["localhost", "127.0.0.1"].includes(direct.hostname) || direct.pathname !== "/aoa" ||
      direct.username !== "aoa" || runtime.username !== "app_rw" ||
      direct.host !== runtime.host || direct.pathname !== runtime.pathname ||
      [direct, runtime].some(url => ["host", "hostaddr", "service", "servicefile"].some(key => url.searchParams.has(key)))) {
    throw new Error("Browser fixtures require the isolated loopback aoa database");
  }
  return new PrismaClient({ datasourceUrl: direct.toString() });
}

test("confirmed Schwab balances render beside Apex without exposing a full Schwab number", async ({ page }) => {
  const owner = syntheticDatabaseOwner();
  const household = "001LUZHBGE61149AAA", client = "003LUZHBGE61149AAA";
  const run = "schwab-display-browser-synthetic";
  const today = toDateStr(new Date());
  let inserted = false;
  try {
    await owner.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
        VALUES (${household}, 'Invented Custodian Household', 'Client', 'avery@example.com')`;
      await tx.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
        VALUES (${client}, ${household}, 'Invented', 'Custodian Person', 'avery@example.com')`;
      await tx.$executeRaw`INSERT INTO mirror.client_account_aum
        (custodian_account_id, apex_account_number, client_sf_id, household_sf_id, account_type,
         account_status, account_aum, account_cash, account_securities, balance_current, source_present, balance_as_of, snapshot_run_id)
        VALUES ('schwab-browser-apex', 'SYNTHETIC-APEX', ${client}, ${household}, 'Synthetic IRA',
          'OPEN', 50.02, 0, 50.02, true, true, ${today}::date, ${run})`;
      await tx.$executeRaw`INSERT INTO mirror.schwab_account_balance
        (account_id, account_number, account_number_last4, account_name, client_sf_id, household_sf_id,
         account_scope, account_type, account_status, account_aum, account_cash, account_securities, balance_as_of,
         balance_current, source_present, resolution_method, resolution_state, reviewed_mapping_version,
         source_key, source_sha256, snapshot_run_id, expected_snapshot_rows)
        VALUES ('schw_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '99001234', '1234', 'Invented Custodian Account',
          ${client}, ${household}, 'CLIENT', 'Synthetic Trust', 'OPEN', 100.01, 10, 90.01, ${today}::date,
          true, true, 'OPERATIONS_REVIEWED', 'CONFIRMED', 1, 'synthetic/browser.RPS', ${'a'.repeat(64)}, ${run}, 1)`;
    });
    inserted = true;
    await signInOperations(page);
    await page.goto(`/client-portrait/${client}?portraitTab=financial`);
    await expect(page.getByRole("heading", { name: "Investment accounts", exact: true })).toBeVisible();
    const portraitTable = page.getByRole("table", { name: "Investment account balances" });
    await expect(portraitTable.getByRole("columnheader")).toHaveText([
      "Account type", "Custodian", "Account #", "Status", "Cash", "Securities", "Total", "Balance date",
    ]);
    const schwabRow = page.getByRole("row").filter({ hasText: "••••1234" });
    await expect(schwabRow).toContainText("Schwab");
    await expect(schwabRow).toContainText(today);
    const apexRow = page.getByRole("row").filter({ hasText: "SYNTHETIC-APEX" });
    await expect(apexRow).toContainText("Apex");
    const portraitBalances = new Map<string, string[]>();
    for (const [number, row, expected] of [
      ["••••1234", schwabRow, ["$10.00", "$90.01", "$100.01"]],
      ["SYNTHETIC-APEX", apexRow, ["$0.00", "$50.02", "$50.02"]],
    ] as const) {
      const values = (await row.getByRole("cell").allTextContents()).slice(4, 7);
      expect(values).toEqual(expected);
      await expect(row.getByRole("cell").last()).toHaveText(today);
      portraitBalances.set(number, values);
    }
    const totalRow = portraitTable.getByRole("row").filter({ hasText: "Current investment total" });
    await expect(totalRow.getByRole("cell").first()).toHaveAttribute("colspan", "6");
    await expect(totalRow.getByRole("cell").nth(1)).toHaveText("$150.03");
    await expect(totalRow.getByRole("cell").last()).toBeEmpty();
    await page.screenshot({ path: test.info().outputPath("portrait-account-components-desktop.png"), fullPage: true });
    const desktopViewport = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    const accountRegion = page.getByRole("region", { name: "Investment account balances" });
    const dimensions = await accountRegion.evaluate((element) => ({
      viewport: element.clientWidth, content: element.scrollWidth,
    }));
    expect(dimensions.viewport).toBeGreaterThan(0);
    expect(dimensions.viewport).toBeLessThanOrEqual(390);
    expect(dimensions.content).toBeGreaterThan(dimensions.viewport);
    await expect(accountRegion).toHaveCSS("overflow-x", "auto");
    await expect(schwabRow.getByRole("cell").nth(4)).toHaveCSS("white-space", "nowrap");
    await accountRegion.focus();
    await expect(accountRegion).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => accountRegion.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await page.screenshot({ path: test.info().outputPath("portrait-account-components-mobile.png"), fullPage: true });
    await page.setViewportSize(desktopViewport);
    expect(await page.content()).not.toContain("99001234");
    await page.goto(`/households/${household}`);
    await expect(page.getByRole("heading", { name: "Combined accounts", exact: true })).toBeVisible();
    await expect(page.getByText("Current AUM $150.03", { exact: true })).toBeVisible();
    await page.locator("summary").filter({ hasText: "Combined accounts" }).click();
    await expect(page.getByRole("row").filter({ hasText: "••••1234" })).toContainText("$100.01");
    for (const [number, expected] of portraitBalances) {
      const row = page.getByRole("row").filter({ hasText: number });
      expect((await row.getByRole("cell").allTextContents()).slice(5, 8)).toEqual(expected);
    }
    expect(await page.content()).not.toContain("99001234");
    await page.screenshot({ path: test.info().outputPath("mixed-custodian-household.png"), fullPage: true });
  } finally {
    if (inserted) {
      await owner.$executeRaw`DELETE FROM mirror.schwab_account_balance WHERE snapshot_run_id = ${run}`;
      await owner.$executeRaw`DELETE FROM mirror.client_account_aum WHERE snapshot_run_id = ${run}`;
      await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ${client}`;
      await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${household}`;
    }
    await owner.$disconnect();
  }
});

test("an Operations user can load the critical AOA surfaces", async ({ page }) => {
  await signInOperations(page);
  for (const surface of CRITICAL_SURFACES) {
    await test.step(surface.path, () => expectHealthySurface(page, surface));
  }
});

test("deal close-date warnings agree across Household and Portrait in both themes", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("pageerror", error => hydrationErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /hydrat|server rendered|did not match/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  const owner = syntheticDatabaseOwner();
  const household = "001ZDUDIL539296AAA", client = "003ZDUDIL539296AAA";
  const dealIds = ["tkt-ui-deal-open", "tkt-ui-deal-funded"];
  let inserted = false;
  try {
    // The standard seed has no direct client_sf_id on deals. Use a self-contained
    // linked fixture instead of changing source linkage or depending on names.
    await owner.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
        VALUES (${household}, 'Invented Deal Household', 'Client', 'avery@example.com')`;
      await tx.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
        VALUES (${client}, ${household}, 'Invented', 'Deal Person', 'avery@example.com')`;
      for (const [index, stage, close] of [[0, "POTENTIAL", "2026-08-15"], [1, "WON", "2026-02-28"]] as const) {
        await tx.deal.create({ data: {
          id: dealIds[index], source: "APP", name: `Invented ${stage} deal`,
          client_first_name: "Invented", client_last_name: "Deal Person", client_sf_id: client,
          household_name: "Invented Deal Household", household_sf_id: household,
          amount: 100, stage, created_date: new Date("2026-01-01T00:00:00Z"),
          close_date: new Date(`${close}T00:00:00Z`), statements: false,
          account_type: "Synthetic IRA", transferring_firm: "Invented firm",
        } });
      }
    });
    inserted = true;
    await signInOperations(page);
    // Fixed-clock unit tests cover due-today and Eastern-midnight boundaries.
    const shouldBeOverdue = "2026-08-15" < toDateStr(new Date());
    for (const [surface, path] of [
      ["household", `/households/${household}`],
      ["portrait", `/client-portrait/${client}`],
    ] as const) {
      await page.goto(path);
      if (surface === "portrait") {
        await page.getByRole("link", { name: "Core Financial", exact: true }).click();
      }
      const card = page.locator("details").filter({ has: page.getByRole("heading", { name: "Deals", exact: true }) });
      await expect(card).not.toHaveAttribute("open", "");
      await card.locator("summary").click();
      const openDate = card.locator('time[datetime="2026-08-15"]').locator("..");
      const fundedDate = card.locator('time[datetime="2026-02-28"]').locator("..");
      await expect(openDate).toContainText("Aug 15, 2026");
      await expect(fundedDate).toContainText("Feb 28, 2026");
      await expect(fundedDate).not.toContainText("Overdue");
      if (shouldBeOverdue) await expect(openDate).toContainText("Overdue");
      else await expect(openDate).not.toContainText("Overdue");
      for (const dark of [false, true]) {
        if (await page.locator("html").evaluate(element => element.classList.contains("dark")) !== dark) {
          await page.getByRole("button", { name: "Toggle color theme", exact: true }).click();
        }
        if (shouldBeOverdue) await expect(openDate).toHaveCSS("color", dark ? "rgb(252, 129, 129)" : "rgb(197, 48, 48)");
        await card.screenshot({ path: test.info().outputPath(`${surface}-deals-${dark ? "dark" : "light"}.png`) });
      }
      await page.setViewportSize({ width: 900, height: 900 });
      await expect(openDate).toBeVisible();
      await card.screenshot({ path: test.info().outputPath(`${surface}-deals-narrow.png`) });
      await page.setViewportSize({ width: 1280, height: 720 });
      await card.locator("summary").click();
      await expect(card).not.toHaveAttribute("open", "");
    }
    expect(hydrationErrors).toEqual([]);
  } finally {
    if (inserted) {
      await owner.deal.deleteMany({ where: { id: { in: dealIds } } });
      await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ${client}`;
      await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${household}`;
    }
    await owner.$disconnect();
  }
});

test("Smart Nudges entry points are hidden while the authenticated direct route stays available", async ({ page }) => {
  await signInOperations(page);
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 900 });
    const sidebar = page.getByRole("complementary");
    await expect(sidebar.locator('a[href="/smart-nudges"]')).toHaveCount(0);
    await expect(sidebar.locator('a[href="/decision-center"]')).toHaveCount(0);
    await expect(sidebar.locator('a[href="/tasks"]')).toBeVisible();
  }
  await page.goto("/client-portrait/C-1/reminders");
  await expect(page.getByText(/Application error|Internal Server Error/i)).toHaveCount(0);
  await expect(page.locator('a[href="/smart-nudges"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Client-facing reminders", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Advisor lens", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("reminders-without-smart-nudges-shortcut.png"), fullPage: true });
  await page.goto("/smart-nudges");
  await expect(page.getByRole("heading", { name: "Smart Nudges", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nudge Queue", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Template Library", exact: true })).toBeVisible();
});

test("Client Portrait subtabs switch locally and survive refresh and browser traversal", async ({ page }) => {
  await signInOperations(page);
  await page.goto("/client-portrait");
  await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
  await page.goto("/client-portrait/C-1?tabSmoke=synthetic#portrait-tabs");
  const comms = page.getByRole("tab", { name: "Communications", exact: true });
  const financial = page.getByRole("link", { name: "Core Financial", exact: true });
  await expect(financial).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Core Financial", exact: true })).toBeVisible();

  // Exercise the real Next history wrapper, including the opaque navigation
  // metadata that must survive its controlled-tab notification.
  const initialHistoryLength = await page.evaluate(() => {
    window.history.replaceState({ ...window.history.state, __aoaListNavigationEntryV1: "synthetic-tab-entry" }, "", window.location.href);
    return window.history.length;
  });
  const serverNavigations: string[] = [];
  const trackNavigation = (request: import("@playwright/test").Request) => {
    const url = new URL(request.url());
    if (request.isNavigationRequest() || (request.headers().rsc === "1" && url.pathname.startsWith("/client-portrait/"))) {
      serverNavigations.push(url.pathname);
    }
  };
  page.on("request", trackNavigation);
  await page.getByRole("navigation", { name: "Client hub", exact: true }).getByRole("link", { name: "Portrait", exact: true }).click();
  await expect(comms).toHaveAttribute("aria-selected", "true");
  const queryByTab: Record<string, string | null> = {
    Communications: "comms", Insights: "portrait",
    Relationships: "relationships", Documents: "documents",
  };
  const names = await page.getByRole("tab").allTextContents();
  expect(names).toEqual(expect.arrayContaining(["Communications", "Insights"]));
  const timings: Record<string, number> = {};
  for (const name of names) {
    await test.step(name, async () => {
      expect(queryByTab).toHaveProperty(name);
      const startedAt = Date.now();
      const tab = page.getByRole("tab", { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel", { name, exact: true })).toBeVisible();
      timings[name] = Date.now() - startedAt;
      const url = new URL(page.url());
      expect(url.searchParams.get("portraitTab")).toBe(queryByTab[name]);
      expect(url.searchParams.get("tabSmoke")).toBe("synthetic");
      expect(url.hash).toBe("#portrait-tabs");
    });
  }
  const insights = page.getByRole("tab", { name: "Insights", exact: true });
  await insights.press("Home");
  await expect(comms).toHaveAttribute("aria-selected", "true");
  await comms.press("ArrowRight");
  await expect(insights).toHaveAttribute("aria-selected", "true");
  await financial.focus();
  await financial.press("Enter");
  await expect(financial).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Core Financial", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Investment accounts", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.history.length)).toBe(initialHistoryLength);
  expect(await page.evaluate(() => window.history.state.__aoaListNavigationEntryV1)).toBe("synthetic-tab-entry");
  expect(serverNavigations).toEqual([]);
  page.off("request", trackNavigation);
  await test.info().attach("subtab-selection-timings-ms", { body: JSON.stringify(timings), contentType: "application/json" });

  await page.reload();
  await expect(financial).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Investment accounts", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
  await page.goForward();
  await expect(financial).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Core Financial", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("portraitTab")).toBe("financial");
});
