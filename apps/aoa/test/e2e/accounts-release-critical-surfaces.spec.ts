import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { toDateStr } from "../../lib/market-calendar";

const SYNTHETIC_OPERATIONS_PERSONA =
  "Riley Ops · OPERATIONS (sees all)";

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

test("released account components and final-column dates match Household without exposing a full Schwab number", async ({ page }) => {
  const owner = syntheticDatabaseOwner();
  const household = "001INQTTLM62816AAA", client = "003INQTTLM62816AAA";
  const run = "account-release-browser-synthetic";
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
        VALUES ('account-release-apex', 'SYNTHETIC-REL-APEX', ${client}, ${household}, 'Synthetic IRA',
          'OPEN', 50.02, 0, 50.02, true, true, ${today}::date, ${run})`;
      await tx.$executeRaw`INSERT INTO mirror.schwab_account_balance
        (account_id, account_number, account_number_last4, account_name, client_sf_id, household_sf_id,
         account_scope, account_type, account_status, account_aum, account_cash, account_securities, balance_as_of,
         balance_current, source_present, resolution_method, resolution_state, reviewed_mapping_version,
         source_key, source_sha256, snapshot_run_id, expected_snapshot_rows)
        VALUES ('schw_cccccccccccccccccccccccccccccccc', '88004567', '4567', 'Invented Custodian Account',
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
    const schwabRow = page.getByRole("row").filter({ hasText: "••••4567" });
    await expect(schwabRow).toContainText("Schwab");
    await expect(schwabRow).toContainText(today);
    const apexRow = page.getByRole("row").filter({ hasText: "SYNTHETIC-REL-APEX" });
    await expect(apexRow).toContainText("Apex");
    const portraitBalances = new Map<string, string[]>();
    for (const [number, row, expected] of [
      ["••••4567", schwabRow, ["$10.00", "$90.01", "$100.01"]],
      ["SYNTHETIC-REL-APEX", apexRow, ["$0.00", "$50.02", "$50.02"]],
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
    expect(await page.content()).not.toContain("88004567");
    await page.goto(`/households/${household}`);
    await expect(page.getByRole("heading", { name: "Combined accounts", exact: true })).toBeVisible();
    await page.locator("summary").filter({ hasText: "Combined accounts" }).click();
    await expect(page.getByText("Current AUM $150.03", { exact: true })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "••••4567" })).toContainText("$100.01");
    for (const [number, expected] of portraitBalances) {
      const row = page.getByRole("row").filter({ hasText: number });
      expect((await row.getByRole("cell").allTextContents()).slice(5, 8)).toEqual(expected);
    }
    expect(await page.content()).not.toContain("88004567");
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

test("Household keeps every account once while each Portrait keeps only its direct accounts", async ({ page }) => {
  const owner = syntheticDatabaseOwner();
  const household = "001TBSNJRQ38137AAA";
  const memberA = "003TBSNJRQ38137AAA";
  const memberB = "003EPQLOLF94882AAA";
  const memberC = "003UGDMZXI56125AAA";
  const run = "account-release-wiring-synthetic";
  const today = toDateStr(new Date());
  let inserted = false;
  try {
    await owner.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
        VALUES (${household}, 'Invented Account Wiring Household', 'Client', 'avery@example.com')`;
      await tx.$executeRaw`INSERT INTO mirror.client
        (sf_id, household_id, first_name, last_name, lead_advisor_email) VALUES
        (${memberA}, ${household}, 'Invented', 'Apex Owner', 'avery@example.com'),
        (${memberB}, ${household}, 'Invented', 'Schwab Owner', 'avery@example.com'),
        (${memberC}, ${household}, 'Invented', 'No Accounts', 'avery@example.com')`;
      await tx.$executeRaw`INSERT INTO mirror.client_account_aum
        (custodian_account_id, apex_account_number, client_sf_id, household_sf_id, account_type,
         account_status, account_aum, account_cash, account_securities, balance_current, source_present,
         balance_as_of, snapshot_run_id)
        VALUES ('account-release-member-a-apex', 'SYNTHETIC-MEMBER-A', ${memberA}, ${household},
          'Synthetic IRA', 'OPEN', 60.06, 10.01, 50.05, true, true, ${today}::date, ${run})`;
      await tx.$executeRaw`INSERT INTO mirror.schwab_account_balance
        (account_id, account_number, account_number_last4, account_name, client_sf_id, household_sf_id,
         account_scope, account_type, account_status, account_aum, account_cash, account_securities,
         balance_as_of, balance_current, source_present, resolution_method, resolution_state,
         reviewed_mapping_version, source_key, source_sha256, snapshot_run_id, expected_snapshot_rows) VALUES
        ('schw_dddddddddddddddddddddddddddddddd', '88007890', '7890', 'Invented Member B Account',
          ${memberB}, ${household}, 'CLIENT', 'Synthetic Brokerage', 'OPEN', 80.08, 20.02, 60.06,
          ${today}::date, true, true, 'OPERATIONS_REVIEWED', 'CONFIRMED', 1,
          'synthetic/wiring-browser.RPS', ${'b'.repeat(64)}, ${run}, 2),
        ('schw_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '88006789', '6789', 'Invented Household Account',
          NULL, ${household}, 'CLIENT', 'Synthetic Joint', 'OPEN', 40.04, 5.01, 35.03,
          ${today}::date, true, true, 'OPERATIONS_REVIEWED', 'CONFIRMED', 1,
          'synthetic/wiring-browser.RPS', ${'c'.repeat(64)}, ${run}, 2)`;
    });
    inserted = true;
    await signInOperations(page);

    await page.goto(`/client-portrait/${memberA}?portraitTab=financial`);
    const memberATable = page.getByRole("table", { name: "Investment account balances" });
    await expect(memberATable.getByRole("row").filter({ hasText: "SYNTHETIC-MEMBER-A" })).toHaveCount(1);
    await expect(memberATable.getByRole("row").filter({ hasText: "••••7890" })).toHaveCount(0);
    await expect(memberATable.getByRole("row").filter({ hasText: "••••6789" })).toHaveCount(0);
    await expect(memberATable.getByRole("row").filter({ hasText: "Current investment total" }))
      .toContainText("$60.06");

    await page.goto(`/client-portrait/${memberB}?portraitTab=financial`);
    const memberBTable = page.getByRole("table", { name: "Investment account balances" });
    await expect(memberBTable.getByRole("row").filter({ hasText: "••••7890" })).toHaveCount(1);
    await expect(memberBTable.getByRole("row").filter({ hasText: "SYNTHETIC-MEMBER-A" })).toHaveCount(0);
    await expect(memberBTable.getByRole("row").filter({ hasText: "••••6789" })).toHaveCount(0);
    await expect(memberBTable.getByRole("row").filter({ hasText: "Current investment total" }))
      .toContainText("$80.08");

    await page.goto(`/client-portrait/${memberC}?portraitTab=financial`);
    await expect(page.getByText("No confirmed investment accounts on file.", { exact: true })).toBeVisible();
    await expect(page.getByRole("table", { name: "Investment account balances" })).toHaveCount(0);

    await page.goto(`/households/${household}`);
    await expect(page.getByRole("heading", { name: "Combined accounts", exact: true })).toBeVisible();
    await page.locator("summary").filter({ hasText: "Combined accounts" }).click();
    await expect(page.getByText("Current AUM $180.18", { exact: true })).toBeVisible();
    for (const number of ["SYNTHETIC-MEMBER-A", "••••7890", "••••6789"]) {
      await expect(page.getByRole("row").filter({ hasText: number })).toHaveCount(1);
    }
    expect(await page.content()).not.toContain("88007890");
    expect(await page.content()).not.toContain("88006789");
  } finally {
    if (inserted) {
      await owner.$executeRaw`DELETE FROM mirror.schwab_account_balance WHERE snapshot_run_id = ${run}`;
      await owner.$executeRaw`DELETE FROM mirror.client_account_aum WHERE snapshot_run_id = ${run}`;
      await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id IN (${memberA}, ${memberB}, ${memberC})`;
      await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${household}`;
    }
    await owner.$disconnect();
  }
});

test("Combined accounts starts collapsed and hides only confirmed empty accounts across filters and navigation", async ({ page }) => {
  const owner = syntheticDatabaseOwner();
  const household = "001RELEMPTY001AAA", client = "003RELEMPTY001AAA";
  const run = "account-empty-browser-synthetic";
  const today = toDateStr(new Date());
  let inserted = false;
  try {
    await owner.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
        VALUES (${household}, 'Invented Empty Account Household', 'Client', 'avery@example.com')`;
      await tx.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
        VALUES (${client}, ${household}, 'Invented', 'Empty Account Owner', 'avery@example.com')`;
      for (const [suffix, type, status, total, cash, securities, current] of [
        ["EMPTY", "Synthetic IRA", "OPEN", 0, 0, 0, true],
        ["CASH", "Synthetic IRA", "OPEN", 10, 10, 0, true],
        ["SECURITIES", "Synthetic IRA", "OPEN", 20, 0, 20, true],
        ["OFFSETTING", "Synthetic Brokerage", "OPEN", 0, -5, 5, true],
        ["NEGATIVE", "Synthetic Brokerage", "OPEN", -1, -1, 0, true],
        ["UNKNOWN", "Synthetic Review", "OPEN", 0, null, 0, true],
        ["STALE", "Synthetic Review", "OPEN", 0, 0, 0, false],
        ["CLOSED", "Synthetic IRA", "CLOSED", 0, 0, 0, false],
      ] as const) {
        await tx.$executeRaw`INSERT INTO mirror.client_account_aum
          (custodian_account_id, apex_account_number, client_sf_id, household_sf_id, account_type,
           account_status, account_aum, account_cash, account_securities, balance_current, source_present,
           balance_as_of, snapshot_run_id)
          VALUES (${`account-empty-${suffix}`}, ${`SYNTHETIC-${suffix}`}, ${client}, ${household}, ${type},
            ${status}, ${total}, ${cash}, ${securities}, ${current}, true, ${today}::date, ${run})`;
      }
      await tx.$executeRaw`INSERT INTO mirror.schwab_account_balance
        (account_id, account_number, account_number_last4, account_name, client_sf_id, household_sf_id,
         account_scope, account_type, account_status, account_aum, account_cash, account_securities, balance_as_of,
         balance_current, source_present, resolution_method, resolution_state, reviewed_mapping_version,
         source_key, source_sha256, snapshot_run_id, expected_snapshot_rows)
        VALUES ('schw_ffffffffffffffffffffffffffffffff', '88009876', '9876', 'Invented Empty Schwab Account',
          ${client}, ${household}, 'CLIENT', 'Synthetic Schwab Empty', 'OPEN', 0, 0, 0, ${today}::date,
          true, true, 'OPERATIONS_REVIEWED', 'CONFIRMED', 1, 'synthetic/empty-browser.RPS', ${'d'.repeat(64)}, ${run}, 1)`;
    });
    inserted = true;
    await signInOperations(page);
    await page.goto(`/households/${household}?list=tasks&tasksCompleted=1`);

    const accounts = page.locator("details").filter({
      has: page.getByRole("heading", { name: "Combined accounts", exact: true }),
    });
    const summary = accounts.locator("summary");
    const showEmpty = accounts.getByRole("checkbox", { name: "Show empty accounts" });
    const accountType = accounts.getByRole("combobox", { name: "Filter combined accounts by account type" });
    const row = (number: string) => accounts.getByRole("row").filter({ hasText: number });
    const fullPending = "Current AUM — · Balance refresh pending";
    const assertOtherSectionParams = () => {
      const params = new URL(page.url()).searchParams;
      expect(params.get("list")).toBe("tasks");
      expect(params.get("tasksCompleted")).toBe("1");
    };

    await expect(summary).toBeVisible();
    await expect(summary).toContainText("9 accounts total");
    await expect(summary).toContainText(fullPending);
    await expect(accounts).not.toHaveAttribute("open", "");
    await expect(accounts.getByRole("table")).not.toBeVisible();
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(accounts).toHaveAttribute("open", "");
    await expect(showEmpty).not.toBeChecked();
    await expect(accounts.getByText("6 of 9 shown · Visible current AUM — · Balance refresh pending", { exact: true })).toBeVisible();
    for (const number of ["SYNTHETIC-CASH", "SYNTHETIC-SECURITIES", "SYNTHETIC-OFFSETTING", "SYNTHETIC-NEGATIVE", "SYNTHETIC-UNKNOWN", "SYNTHETIC-STALE"]) {
      await expect(row(number)).toBeVisible();
    }
    for (const number of ["SYNTHETIC-EMPTY", "••••9876", "SYNTHETIC-CLOSED"]) {
      await expect(row(number)).toHaveCount(0);
    }
    await expect(row("SYNTHETIC-OFFSETTING")).toContainText("-$5.00");
    await expect(row("SYNTHETIC-NEGATIVE")).toContainText("-$1.00");
    await expect(row("SYNTHETIC-STALE")).toContainText("Balance refresh pending");

    await showEmpty.check();
    await expect(page).toHaveURL(/showEmptyAccounts=1/);
    await expect(accounts.getByText("8 of 9 shown · Visible current AUM — · Balance refresh pending", { exact: true })).toBeVisible();
    await expect(row("SYNTHETIC-EMPTY")).toBeVisible();
    await expect(row("••••9876")).toBeVisible();
    assertOtherSectionParams();

    await accountType.selectOption("synthetic ira");
    await expect(page).toHaveURL(/accountType=synthetic\+ira/);
    await expect(accounts.getByText("3 of 9 shown · Visible current AUM $30.00", { exact: true })).toBeVisible();
    await expect(summary).toContainText(fullPending);
    await accounts.getByRole("button", { name: "Closed", exact: true }).click();
    await expect(page).toHaveURL(/accountStatus=closed/);
    await expect(row("SYNTHETIC-CLOSED")).toBeVisible();
    await expect(accounts.getByText("1 of 9 shown · Visible current AUM $0.00", { exact: true })).toBeVisible();
    await accounts.getByRole("button", { name: "All", exact: true }).click();
    await showEmpty.uncheck();
    await expect(page).not.toHaveURL(/showEmptyAccounts=/);
    await expect(accounts.getByText("3 of 9 shown · Visible current AUM $30.00", { exact: true })).toBeVisible();
    await expect(row("SYNTHETIC-EMPTY")).toHaveCount(0);
    await expect(row("SYNTHETIC-CLOSED")).toBeVisible();
    await accountType.selectOption("synthetic schwab empty");
    await expect(accounts.getByText("No accounts match these filters.", { exact: true })).toBeVisible();
    await expect(accounts.getByText("0 of 9 shown · Visible current AUM $0.00", { exact: true })).toBeVisible();
    await expect(summary).toContainText("9 accounts total");
    await expect(summary).toContainText(fullPending);

    await accounts.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(accounts.getByRole("button", { name: "Open", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(accountType).toHaveValue("");
    await expect(showEmpty).not.toBeChecked();
    await expect(accounts.getByText("6 of 9 shown · Visible current AUM — · Balance refresh pending", { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/accountStatus=|accountType=|showEmptyAccounts=/);
    assertOtherSectionParams();

    // A shared filter URL survives a reload, while the disclosure starts closed.
    await accountType.selectOption("synthetic ira");
    await showEmpty.check();
    await expect(page).toHaveURL(/showEmptyAccounts=1/);
    const filteredUrl = page.url();
    await page.reload();
    await expect(accounts).not.toHaveAttribute("open", "");
    await summary.click();
    await expect(showEmpty).toBeChecked();
    await expect(accountType).toHaveValue("synthetic ira");
    await expect(accounts.getByText("3 of 9 shown · Visible current AUM $30.00", { exact: true })).toBeVisible();

    // Back/Forward returns to the saved account filters without erasing task filters.
    await page.getByRole("link", { name: /Invented Empty Account Owner/ }).click();
    await expect(page).toHaveURL(new RegExp(`/client-portrait/${client}`));
    await page.goBack();
    await expect(page).toHaveURL(filteredUrl);
    if (!await accounts.evaluate(element => (element as HTMLDetailsElement).open)) await summary.click();
    await expect(showEmpty).toBeChecked();
    await expect(accountType).toHaveValue("synthetic ira");
    assertOtherSectionParams();
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/client-portrait/${client}`));
    await page.goBack();
    await expect(page).toHaveURL(filteredUrl);

    await page.setViewportSize({ width: 390, height: 844 });
    if (await accounts.evaluate(element => (element as HTMLDetailsElement).open)) await summary.click();
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(fullPending);
    await summary.focus();
    await page.keyboard.press("Space");
    await expect(accounts).toHaveAttribute("open", "");
    await expect(row("SYNTHETIC-EMPTY")).toBeVisible();
    const bounds = await summary.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: test.info().outputPath("household-empty-account-filters-mobile.png"), fullPage: true });
    await page.keyboard.press("Space");
    await expect(accounts).not.toHaveAttribute("open", "");
    await expect(accounts.getByRole("table")).not.toBeVisible();
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
