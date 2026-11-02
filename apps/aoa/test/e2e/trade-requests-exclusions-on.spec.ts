import { expect, test, type Page } from "@playwright/test";
import { NO_PERMISSION, signInAs, type Persona } from "./trade-requests-browser-helpers";
import { seedStandingExclusions, serviceSql } from "./trade-requests-exclusions-fixture";
import { byName, type SyntheticClient } from "./trade-requests-new-synthetic";

test.describe.configure({ mode: "serial" });
test.beforeEach(() => seedStandingExclusions());

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const NEW = "/trade-requests/new";
const ALEX = byName("Maeve Brennan (synthetic)");
const BLAIR = byName("Lucille Howell (synthetic)");

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}
const advisorField = (page: Page) => page.getByRole("textbox", { name: "Advisor Specific Exclusions" });
const clientField = (page: Page) => page.getByRole("textbox", { name: "Client Requested Exclusions" });
const manage = (page: Page) => page.getByRole("button", { name: "Manage exclusions" });
const dialog = (page: Page) => page.getByTestId("manage-exclusions-dialog");
const panel = (page: Page) => page.getByTestId("account-exclusions");

async function openForm(page: Page, role: Persona) {
  await signInAs(page, role, NEW);
  await expect(page.getByRole("heading", { level: 2, name: "New Trade Request" })).toBeVisible();
}
async function toggleClient(page: Page, client: SyntheticClient) {
  await page.getByRole("button", { name: /^Client \/ Household/ }).click();
  await page.getByRole("listbox", { name: "Client list" })
    .getByRole("option", { name: new RegExp(`^${client.name.replace(/[()]/g, "\\$&")}`) }).click();
  await page.keyboard.press("Escape");
}
const tick = (page: Page, number: string) =>
  page.getByRole("group", { name: "Select Accounts" }).getByRole("checkbox", { name: new RegExp(number) }).check();

test("ADVISOR: selected clients fill the exclusion fields, attributed per client, keeping typed text (AC-90)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  await expect(manage(page)).toBeDisabled();
  await expect(manage(page)).toHaveAttribute("title", "Select a client first");
  await toggleClient(page, ALEX);
  await expect(advisorField(page)).toHaveValue("TSLA (DNB - Concentration risk (synthetic))");
  await expect(clientField(page)).toHaveValue("AAPL (DNB+DNS - Employer stock (synthetic))");
  await toggleClient(page, BLAIR);
  await expect(advisorField(page)).toHaveValue(
    "TSLA (DNB - Concentration risk (synthetic) – Maeve Brennan (synthetic)); XOM (DNS – Lucille Howell (synthetic))");
  await expect(clientField(page)).toHaveValue("AAPL (DNB+DNS - Employer stock (synthetic) – Maeve Brennan (synthetic))");
  await shoot(page, "fill-household-ADVISOR");
  await advisorField(page).fill("Typed by the advisor (synthetic)");
  await toggleClient(page, BLAIR);
  await expect(clientField(page)).toHaveValue("AAPL (DNB+DNS - Employer stock (synthetic))");
  await expect(advisorField(page)).toHaveValue("Typed by the advisor (synthetic)");
});

test("ADVISOR: Manage exclusions adds, removes and re-sides in one batch and replaces the fields on close (AC-118, AC-119)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  await toggleClient(page, ALEX);
  await expect(advisorField(page)).not.toHaveValue("");
  await advisorField(page).fill("Typed before the dialog (synthetic)");
  await expect(manage(page)).toHaveAttribute("title", "Add or remove standing exclusions for this client without submitting a trade request");
  await manage(page).click();
  const d = dialog(page);
  await expect(d.getByRole("heading", { name: "Manage Exclusions" })).toBeVisible();
  await expect(d.getByText("for Maeve Brennan (synthetic)")).toBeVisible();
  await expect(d.getByText("added by Seed Operator (synthetic),", { exact: false }).first()).toBeVisible();
  await d.getByLabel("TSLA: do not sell").check();
  await expect(d.getByText("Side change pending: DNB → DNB+DNS")).toBeVisible();
  await d.getByRole("button", { name: "Mark AAPL for removal" }).click();
  const clientSection = d.getByRole("region", { name: "Client Requested Exclusions" });
  await clientSection.getByRole("button", { name: /Add row/ }).click();
  await expect(clientSection.getByText("Pick at least one of DNB or DNS to enable Apply.")).toBeVisible();
  await expect(d.getByRole("button", { name: "Apply 3 changes" })).toBeDisabled();
  await clientSection.getByLabel("Ticker for new client exclusion").fill("nvda");
  await expect(clientSection.getByLabel("Ticker for new client exclusion")).toHaveValue("NVDA");
  await clientSection.getByLabel("Reason for new client exclusion").fill("Client request (synthetic)");
  await clientSection.getByLabel("New client exclusion: do not buy").check();
  await shoot(page, "dialog-staged-ADVISOR");
  await d.getByRole("button", { name: "Apply 3 changes" }).click();
  await expect(d.getByRole("status")).toHaveText("Saved. Added 1. Removed 1. Updated 1.");
  await expect(d.getByText("added by Avery Stone,", { exact: false })).toBeVisible();
  await shoot(page, "dialog-saved-ADVISOR");
  await d.getByRole("button", { name: "Close", exact: true }).click();
  await expect(d).toHaveCount(0);
  await expect(advisorField(page)).toHaveValue("TSLA (DNB+DNS - Concentration risk (synthetic))");
  await expect(clientField(page)).toHaveValue("NVDA (DNB - Client request (synthetic))");
  expect(serviceSql(`SELECT ticker || ':' || kind || ':' || no_buy || ':' || no_sell || ':' || created_by_name FROM client_exclusions WHERE client_id = '${ALEX.id}' ORDER BY ticker`).trim().split("\n"))
    .toEqual(["NVDA:client:true:false:Avery Stone", "TSLA:advisor:true:true:Seed Operator (synthetic)"]);
});

test("OPERATIONS: household clients each get a tab and batch; closing with unsaved changes asks first (AC-118, AC-119)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "OPERATIONS");
  await toggleClient(page, ALEX);
  await toggleClient(page, BLAIR);
  await expect(advisorField(page)).toHaveValue(/XOM \(DNS – Lucille Howell \(synthetic\)\)$/);
  await manage(page).click();
  const d = dialog(page);
  await expect(d.getByText("2 clients in this household — each tab is its own batch")).toBeVisible();
  const tabs = d.getByRole("tablist", { name: "Select client" });
  await d.getByRole("button", { name: "Mark TSLA for removal" }).click();
  await expect(tabs.getByRole("tab", { name: /Maeve Brennan/ })).toContainText("1");
  await tabs.getByRole("tab", { name: /Lucille Howell/ }).click();
  await expect(d.getByText("XOM", { exact: true })).toBeVisible();
  const advisorSection = d.getByRole("region", { name: "Advisor Specific Exclusions" });
  await advisorSection.getByRole("button", { name: /Add row/ }).click();
  await advisorSection.getByLabel("Ticker for new advisor exclusion").fill("META");
  await advisorSection.getByLabel("New advisor exclusion: do not sell").check();
  await d.getByRole("button", { name: "Apply 1 change" }).click();
  await expect(d.getByRole("status")).toHaveText("Saved. Added 1.");
  await shoot(page, "dialog-household-OPERATIONS");
  let message = "";
  page.once("dialog", async (confirm) => {
    message = confirm.message();
    await confirm.accept();
  });
  await d.getByRole("button", { name: "Close dialog" }).click();
  expect(message).toBe("Discard 1 unsaved change for Maeve Brennan (synthetic)?");
  await expect(d).toHaveCount(0);
  await expect(advisorField(page)).toHaveValue(
    "TSLA (DNB - Concentration risk (synthetic) – Maeve Brennan (synthetic)); META (DNS – Lucille Howell (synthetic)); XOM (DNS – Lucille Howell (synthetic))");
});

test("ADMIN: account-level exclusions show for the selected accounts; Manage Account Restrictions saves and refreshes them (AC-92, AC-121, AC-146)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADMIN");
  await toggleClient(page, ALEX);
  await expect(panel(page).getByText("No account-specific exclusions on selected accounts.")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /Manage Account Restrictions/ })).toHaveCount(0);
  await tick(page, ALEX.accounts[0].number);
  await tick(page, ALEX.accounts[1].number);
  await expect(panel(page)).toContainText("Account-Level Standing Exclusions (2 total)");
  await expect(panel(page).getByText(ALEX.accounts[0].number, { exact: true })).toBeVisible();
  await expect(panel(page).getByText("GME")).toBeVisible();
  await expect(panel(page).getByText("No reason provided")).toBeVisible();
  await expect(panel(page).getByText("Imported from Meridian restrictions file")).toBeVisible();
  await shoot(page, "account-panel-ADMIN");

  await panel(page).getByRole("button", { name: /Manage Account Restrictions/ }).click();
  const d = dialog(page);
  await expect(d.getByRole("heading", { name: "Manage Account Restrictions" })).toBeVisible();
  await expect(d.getByText("2 accounts selected — each tab is its own batch")).toBeVisible();
  const tabs = d.getByRole("tablist", { name: "Select account" });
  await expect(tabs.getByRole("tab")).toHaveText(ALEX.accounts.map((a) => `${a.number} — ${ALEX.name}`));
  await tabs.getByRole("tab", { name: new RegExp(ALEX.accounts[1].number) }).click();
  await expect(d.getByText("No standing exclusions.")).toHaveCount(2);
  const advisorSection = d.getByRole("region", { name: "Advisor Specific Exclusions" });
  await advisorSection.getByRole("button", { name: /Add row/ }).click();
  await advisorSection.getByLabel("Ticker for new advisor exclusion").fill("NVDA");
  await advisorSection.getByLabel("New advisor exclusion: do not buy").check();
  await d.getByRole("button", { name: "Apply 1 change" }).click();
  await expect(d.getByRole("status")).toHaveText("Saved. Added 1.");
  await shoot(page, "dialog-account-ADMIN");
  await d.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel(page)).toContainText("Account-Level Standing Exclusions (3 total)");
  await expect(panel(page).getByText(ALEX.accounts[1].number, { exact: true })).toBeVisible();
  await expect(panel(page).getByText("NVDA")).toBeVisible();
});

test("ADVISOR: the account panel says so when the account-level exclusions cannot be loaded (AC-111)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  await toggleClient(page, ALEX);
  await expect(advisorField(page)).not.toHaveValue("");
  await page.route("**/trade-requests/new", (route) =>
    route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue());
  await tick(page, ALEX.accounts[0].number);
  await expect(panel(page).getByRole("alert")).toHaveText("Unable to load account-level exclusions.");
  await shoot(page, "account-panel-failed-ADVISOR");
});

test("mobile layout keeps the account panel, fields and dialog within the screen (AC-153)", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await openForm(page, "ADVISOR");
  await toggleClient(page, ALEX);
  await tick(page, ALEX.accounts[0].number);
  await expect(panel(page).getByText("GME")).toBeVisible();
  await expect(advisorField(page)).not.toHaveValue("");
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(1);
  await shoot(page, "mobile-form-ADVISOR");
  await manage(page).click();
  await dialog(page).getByRole("region", { name: "Client Requested Exclusions" }).getByRole("button", { name: /Add row/ }).click();
  const box = await dialog(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE.width);
  await shoot(page, "mobile-dialog-ADVISOR");
});

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} gets the permission screen on the New Request address`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    await page.goto(NEW);
    await expect(page.getByText(NO_PERMISSION, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage exclusions" })).toHaveCount(0);
    await shoot(page, `permission-${role}`);
  });
}
