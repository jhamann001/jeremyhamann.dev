import { expect, test, type Page } from "@playwright/test";
import { NO_PERMISSION, signInAs, type Persona } from "./trade-requests-browser-helpers";
import { BRENNAN, CARVER, SYNTHETIC_CLIENTS, TRW11_PORTS, byName } from "./trade-requests-new-synthetic";

test.describe.configure({ mode: "serial" });

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const NEW = "/trade-requests/new";
const STUB = `http://127.0.0.1:${TRW11_PORTS.warehouse}`;
const ALEX = byName("Maeve Brennan (synthetic)");
const BLAIR = byName("Lucille Howell (synthetic)");
const MORGAN = byName("Esta Barrows (synthetic)");
const WIDE = byName("Wide Portfolio Trust (synthetic)");
const FILLERS = SYNTHETIC_CLIENTS.filter((client) => client.id.startsWith("trw11-filler-"));

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}
const clientButton = (page: Page) => page.getByRole("button", { name: /^Client \/ Household/ });
const submit = (page: Page) => page.getByRole("button", { name: "Generate Plan & Submit" });
const accounts = (page: Page) => page.getByRole("group", { name: "Select Accounts" });
const household = (page: Page) => page.getByRole("region", { name: "Household sidecar" });

async function openForm(page: Page, role: Persona) {
  await signInAs(page, role, NEW);
  await expect(page.getByRole("heading", { level: 2, name: "New Trade Request" })).toBeVisible();
}
async function pick(page: Page, names: string[]) {
  if (!(await page.getByRole("listbox", { name: "Client list" }).isVisible())) await clientButton(page).click();
  const list = page.getByRole("listbox", { name: "Client list" });
  for (const name of names) await list.getByRole("option", { name: new RegExp(`^${name.replace(/[()]/g, "\\$&")}`) }).click();
  await page.keyboard.press("Escape");
}
async function check(page: Page, numbers: string[]) {
  for (const number of numbers) await accounts(page).getByRole("checkbox", { name: new RegExp(number) }).check();
}
/** The Initial Funding allocation inputs, so these checks isolate the selection gates. */
async function allocate(page: Page) {
  await page.getByLabel("Liquidation Approval").selectOption("Yes");
  await page.getByLabel("Client Risk Score").selectOption("12");
  await page.getByLabel(/^Strategy Rationale/).fill("Synthetic rationale");
}

test("client list failure shows the AC-82 message", async ({ page, request }) => {
  await request.post(`${STUB}/__control/fail`);
  try {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, "ADVISOR", NEW);
    const failure = page.getByTestId("new-request-load-failed");
    await expect(failure.getByText("Failed to load client data", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(failure.getByText("Account data source is temporarily unavailable. Please try again.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "New Trade Request" })).toHaveCount(0);
    await shoot(page, "load-failure-ADVISOR");
  } finally {
    await request.post(`${STUB}/__control/ok`);
  }
});

test("ADMIN selects clients, sees every account, and includes the household (AC-39, AC-122, AC-123, AC-142)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADMIN");
  await expect(page.getByText("Connected to Warehouse", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3 }).first()).toHaveText("1. Client & Account Context");
  await expect(page.getByRole("navigation", { name: "Trade Requests workspace" }).getByRole("link", { name: "New Request" }))
    .toHaveAttribute("aria-current", "page");
  await expect(submit(page)).toBeDisabled();

  await pick(page, [ALEX.name, BLAIR.name]);
  await expect(page.getByText("Client / Household (2)")).toBeVisible();
  await expect(page.getByRole("button", { name: `Remove ${ALEX.name}` })).toBeVisible();
  await expect(accounts(page).getByRole("checkbox")).toHaveCount(3);
  for (const client of [ALEX, BLAIR]) await expect(accounts(page).getByText(client.name, { exact: true })).toBeVisible();
  await shoot(page, "accounts-two-clients-ADMIN");

  await page.getByRole("button", { name: `Remove ${BLAIR.name}` }).click();
  await check(page, ALEX.accounts.map((a) => a.number));
  await expect(accounts(page).getByText("Total: $192,000")).toBeVisible();
  const prompt = household(page);
  await expect(prompt).toContainText(`1 sibling account in 1 other client — part of household ${BRENNAN.name}`);
  await expect(prompt).toContainText("Include them in this trade?");
  await expect(prompt.getByRole("button", { name: "Dismiss household sidecar" })).toBeVisible();
  await expect(prompt.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
  await prompt.getByRole("button", { name: "Choose…" }).click();
  await expect(prompt.getByRole("checkbox", { name: `${BLAIR.accounts[0].title} · ${BLAIR.accounts[0].number}` })).toBeChecked();
  await expect(prompt.getByRole("button", { name: "Include selected (1)" })).toBeEnabled();
  await shoot(page, "household-prompt-ADMIN");
  await prompt.getByRole("button", { name: "Include all" }).click();

  await expect(page.getByText("Client / Household (2)")).toBeVisible();
  await expect(accounts(page).getByRole("checkbox", { name: new RegExp(BLAIR.accounts[0].number) })).toBeChecked();
  await page.waitForTimeout(1_000);
  await expect(household(page)).toHaveCount(0);
  await page.getByLabel(/^Priority/).selectOption("Standard");
  await allocate(page);
  await expect(submit(page)).toBeEnabled();
  await shoot(page, "household-included-ADMIN");
});

test("OPERATIONS sees the multi-household warning, Continue adds nothing, and dismissal holds until households change (AC-124, AC-125)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "OPERATIONS");
  await pick(page, [ALEX.name, MORGAN.name]);
  const warning = household(page);
  await expect(warning).toContainText("Selection spans 2 firm households");
  await expect(warning).toContainText(`${BRENNAN.name} — 3 sibling accounts not in this trade`);
  await expect(warning).toContainText(`${CARVER.name} — 3 sibling accounts not in this trade`);
  await expect(warning).toContainText("The trade will not be tagged to a single household.");
  await shoot(page, "household-warning-OPERATIONS");
  await warning.getByRole("button", { name: "Continue" }).click();
  await expect(household(page)).toHaveCount(0);
  await expect(accounts(page).getByRole("checkbox", { checked: true })).toHaveCount(0);

  await check(page, [ALEX.accounts[0].number]);
  await page.waitForTimeout(1_000);
  await expect(household(page)).toHaveCount(0);

  await page.getByRole("button", { name: `Remove ${MORGAN.name}` }).click();
  await expect(household(page)).toContainText(`part of household ${BRENNAN.name}`);
  await household(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(household(page)).toHaveCount(0);
  await check(page, [ALEX.accounts[0].number]);
  await page.waitForTimeout(1_000);
  await expect(household(page)).toHaveCount(0);
});

test("ADVISOR hits the 50-client and 50-account caps; the accounts message wins (AC-40, AC-109)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  await pick(page, [WIDE.name, ...FILLERS.slice(0, 50).map((client) => client.name)]);
  const cap = page.getByRole("alert").filter({ hasText: "Please reduce to 50 or fewer to submit." });
  await expect(cap).toHaveText("You have selected 51 clients. Please reduce to 50 or fewer to submit.");
  await expect(submit(page)).toBeDisabled();
  await shoot(page, "cap-clients-ADVISOR");

  await check(page, WIDE.accounts.slice(0, 51).map((a) => a.number));
  await expect(cap).toHaveText("You have selected 51 accounts. Please reduce to 50 or fewer to submit.");
  await expect(submit(page)).toBeDisabled();
  await shoot(page, "cap-accounts-ADVISOR");

  await accounts(page).getByRole("checkbox", { name: new RegExp(WIDE.accounts[0].number) }).uncheck();
  await expect(cap).toHaveText("You have selected 51 clients. Please reduce to 50 or fewer to submit.");
  await page.getByRole("button", { name: `Remove ${FILLERS[0].name}` }).click();
  await expect(cap).toHaveCount(0);
});

test("ADVISOR enters a client manually; Submit needs a balance above zero (AC-41)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  await page.getByRole("button", { name: "Enter manually" }).click();
  await page.getByLabel("Client Name (Manual)").fill("Sam Synthetic");
  await page.getByLabel(/^Priority/).selectOption("Standard");
  await allocate(page);
  await page.getByRole("button", { name: "Add Account" }).click();
  await expect(page.getByRole("combobox", { name: "Account type" })).toHaveValue("Taxable");
  await page.getByRole("checkbox", { name: "Select manual account 1" }).check();
  await page.getByRole("textbox", { name: "Account #" }).fill("MAN-0001");
  await page.getByRole("combobox", { name: "Account type" }).selectOption("Roth IRA");
  await page.getByRole("textbox", { name: "Account value ($)" }).fill("0");
  await expect(submit(page)).toBeDisabled();
  await page.getByRole("textbox", { name: "Account value ($)" }).fill("25,000");
  await expect(page.getByText("Total: $25,000")).toBeVisible();
  await expect(submit(page)).toBeEnabled();
  await shoot(page, "manual-entry-ADVISOR");
  await page.getByRole("button", { name: "Use Warehouse list" }).click();
  await expect(clientButton(page)).toBeVisible();
});

test("the draft survives switching to Home and back", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  await pick(page, [ALEX.name]);
  await check(page, [ALEX.accounts[0].number]);
  const sub = page.getByRole("navigation", { name: "Trade Requests workspace" });
  await sub.getByRole("link", { name: "Home" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await sub.getByRole("link", { name: "New Request" }).click();
  await expect(clientButton(page)).toContainText(ALEX.name);
  await expect(accounts(page).getByRole("checkbox", { name: new RegExp(ALEX.accounts[0].number) })).toBeChecked();
});

test("mobile layout keeps the form's columns and offers selection, household and manual actions (AC-153)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await openForm(page, "ADVISOR");
  const columns = await page.locator("form [class*='grid3']").first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  expect(columns).toBe(3);
  await pick(page, [ALEX.name]);
  await check(page, ALEX.accounts.map((a) => a.number));
  await expect(household(page).getByRole("button", { name: "Include all" })).toBeVisible();
  await expect(household(page).getByRole("button", { name: "Choose…" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shoot(page, "mobile-household-ADVISOR");
  await page.getByRole("button", { name: "Enter manually" }).click();
  await page.getByLabel("Client Name (Manual)").fill("Sam Synthetic");
  await page.getByRole("button", { name: "Add Account" }).click();
  await expect(page.getByRole("textbox", { name: "Account value ($)" })).toBeVisible();
  await shoot(page, "mobile-manual-ADVISOR");
});

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} gets the permission screen on the New Request address`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    await page.goto(NEW);
    await expect(page.getByText(NO_PERMISSION, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "New Trade Request" })).toHaveCount(0);
    await shoot(page, `permission-${role}`);
  });
}
