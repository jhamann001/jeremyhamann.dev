import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { NO_PERMISSION, signInAs, type Persona } from "./trade-requests-browser-helpers";
import { byName, type SyntheticClient } from "./trade-requests-new-synthetic";
import { SUBMIT_MARKER, SUBMIT_SEED_FILE, changeStatusElsewhere, requestRow, type SubmitSeed } from "./trade-requests-submit-fixture";

test.describe.configure({ mode: "serial" });

const DESKTOP = { width: 1440, height: 950 };
const MOBILE = { width: 390, height: 844 };
const NEW = "/trade-requests/new";
const QUEUE = "/trade-requests/queue";
const STALE = "Request was modified by another user. Please refresh and try again.";
const DEFAULT_FAILURE = "Failed to submit request. Please try again.";
const ALEX = byName("Maeve Brennan (synthetic)");
const BLAIR = byName("Lucille Howell (synthetic)");
const MORGAN = byName("Esta Barrows (synthetic)");
const ABDULLAH = byName("Abdullah Beatty (synthetic)");
const seed = (): SubmitSeed => JSON.parse(readFileSync(SUBMIT_SEED_FILE, "utf8"));
const unique = () => String(Date.now()).slice(-7);

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}
const card = (page: Page) => page.locator("form[aria-labelledby='new-request-title']");
const submitError = (page: Page) => page.locator("#new-request-submit-error");
const clientSelect = (page: Page) => page.getByRole("button", { name: /^Client \/ Household/ });
const accounts = (page: Page) => page.getByRole("group", { name: "Select Accounts" });
const tick = (page: Page, number: string) => accounts(page).getByRole("checkbox", { name: new RegExp(number) }).check();

async function openForm(page: Page, role: Persona) {
  await signInAs(page, role, NEW);
  await expect(page.getByRole("heading", { level: 2, name: "New Trade Request" })).toBeVisible();
}
async function toggleClient(page: Page, client: SyntheticClient) {
  await clientSelect(page).click();
  await page.getByRole("listbox", { name: "Client list" })
    .getByRole("option", { name: new RegExp(`^${client.name.replace(/[()]/g, "\\$&")}`) }).click();
  await page.keyboard.press("Escape");
}
async function raiseCash(page: Page, client: SyntheticClient, number: string, amount: string, notes: string) {
  await page.getByLabel("Trade Type").selectOption("Raise Cash");
  await toggleClient(page, client);
  await tick(page, number);
  await page.getByLabel(/^Priority/).selectOption("Standard");
  await page.getByLabel(/^Cash Amount to Raise/).fill(amount);
  await page.getByLabel(/^Reason for Cash Raise/).fill("Synthetic distribution");
  await page.getByLabel("Advisor Compliance & Execution Notes").fill(notes);
}
/** The queue row of a request, once the queue's refresh has it. */
async function expectQueued(page: Page, id: string, status: string) {
  await expect(page).toHaveURL(new RegExp(`${QUEUE}$`));
  const row = page.getByRole("row", { name: `View request ${id}` });
  await expect(row).toBeVisible();
  await expect(row).toContainText(status);
  return row;
}
async function openDirect(page: Page, role: Persona, id: string) {
  await page.context().clearCookies();
  await signInAs(page, role, `/trade-requests/${encodeURIComponent(id)}`);
  const detail = page.getByTestId("trade-request-detail");
  await expect(detail).toBeVisible();
  return detail;
}
const slot = (page: Page) => page.getByTestId("trade-request-detail").locator('[data-slot="request-actions"]');
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test("ADVISOR submits a Raise Cash request for a whole firm household: Pending Review in the queue, household recorded (AC-6, AC-126)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  const notes = `${SUBMIT_MARKER} advisor household ${unique()}`;
  await raiseCash(page, ALEX, ALEX.accounts[0].number, `$4${unique()}`, notes);
  const prompt = page.getByRole("region", { name: "Household sidecar" });
  await prompt.getByRole("button", { name: "Include all" }).click();
  for (const account of [...ALEX.accounts, ...BLAIR.accounts]) await expect(accounts(page).getByRole("checkbox", { name: new RegExp(account.number) })).toBeChecked();
  await shoot(page, "advisor-household-before-submit");
  await page.getByRole("button", { name: "Submit Trade Request" }).click();
  await expect(page).toHaveURL(new RegExp(`${QUEUE}$`));
  const row = requestRow(notes)!;
  expect(row).toMatchObject({ status: "Pending Review", householdId: "7101", householdName: "Brennan Family Household (synthetic)" });
  await expectQueued(page, row.id, "Pending Review");
  await shoot(page, "advisor-queue-pending-review");
});

test("ADMIN submits a Rebalance with New Deposits filled: Pending Review, no deposit values recorded (AC-6, AC-152)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADMIN");
  const notes = `${SUBMIT_MARKER} admin rebalance ${unique()}`;
  await page.getByLabel("Trade Type").selectOption("Rebalance");
  await toggleClient(page, MORGAN);
  await tick(page, MORGAN.accounts[0].number);
  await expect(page.getByRole("region", { name: "Household sidecar" })).toContainText("Carver Household (synthetic)");
  await page.getByLabel(/^Priority/).selectOption("Urgent");
  await page.getByLabel("Deposit Amount").fill("$9,999");
  await page.getByLabel("Account Holding Deposit").selectOption(MORGAN.accounts[0].number);
  await page.getByLabel("Client Risk Score").selectOption("10");
  await page.getByLabel(/^Strategy Rationale/).fill("Synthetic rationale");
  await page.getByLabel("Liquidation Approval").selectOption("Yes");
  await page.getByLabel("Advisor Compliance & Execution Notes").fill(notes);
  await shoot(page, "admin-rebalance-new-deposits");
  await page.getByRole("button", { name: "Submit Trade Request" }).click();
  await expect(page).toHaveURL(new RegExp(`${QUEUE}$`));
  const row = requestRow(notes)!;
  expect(row).toMatchObject({ status: "Pending Review", tradeAmount: "", depositAccount: "", householdId: "7102" });
  await expectQueued(page, row.id, "Pending Review");
});

test("OPERATIONS submits a Liquidate request: Pending Review in the queue (AC-6)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "OPERATIONS");
  const notes = `${SUBMIT_MARKER} operations liquidate ${unique()}`;
  await page.getByLabel("Trade Type").selectOption("Liquidate");
  await toggleClient(page, ABDULLAH);
  await tick(page, ABDULLAH.accounts[1].number);
  await page.getByLabel(/^Priority/).selectOption("Low");
  await page.getByLabel(/^Liquidate Options/).selectOption("Entire Account");
  await page.getByLabel("Advisor Compliance & Execution Notes").fill(notes);
  await page.getByRole("button", { name: "Submit Trade Request" }).click();
  await expect(page).toHaveURL(new RegExp(`${QUEUE}$`));
  const row = requestRow(notes)!;
  expect(row.status).toBe("Pending Review");
  await expectQueued(page, row.id, "Pending Review");
  await shoot(page, "operations-queue-pending-review");
});

test("ADVISOR: notes over 5,000 characters show the service's message; a lost response shows the default; every value is kept (AC-138, AC-8, AC-144, AC-29)", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openForm(page, "ADVISOR");
  const amount = `$7${unique()}`;
  const long = `${SUBMIT_MARKER} ${"x".repeat(5_001)}`;
  await raiseCash(page, MORGAN, MORGAN.accounts[0].number, amount, long);
  await page.getByRole("button", { name: "Submit Trade Request" }).click();
  await expect(submitError(page)).toContainText("advisorNotes");
  await expect(submitError(page)).toContainText("5000");
  await expect(submitError(page)).toHaveAttribute("role", "alert");
  await expect(submitError(page)).toBeInViewport();
  await expect(page).toHaveURL(new RegExp(`${NEW}$`));
  await expect(page.getByLabel("Advisor Compliance & Execution Notes")).toHaveValue(long);
  await expect(page.getByLabel(/^Cash Amount to Raise/)).toHaveValue(amount);
  await expect(page.getByLabel(/^Reason for Cash Raise/)).toHaveValue("Synthetic distribution");
  await expect(page.getByLabel(/^Priority/)).toHaveValue("Standard");
  await expect(accounts(page).getByRole("checkbox", { name: new RegExp(MORGAN.accounts[0].number) })).toBeChecked();
  await shoot(page, "advisor-notes-too-long");

  const notes = `${SUBMIT_MARKER} abort ${unique()}`;
  await page.getByLabel("Advisor Compliance & Execution Notes").fill(notes);
  await page.route(`**${NEW}`, (route) => (
    route.request().method() === "POST" && route.request().headers()["next-action"] && (route.request().postData() ?? "").includes(notes)
      ? route.abort("connectionreset") : route.fallback()));
  await page.getByRole("button", { name: "Submit Trade Request" }).click();
  await expect(submitError(page)).toHaveText(DEFAULT_FAILURE);
  await expect(page.getByLabel("Advisor Compliance & Execution Notes")).toHaveValue(notes);
  await expect(page.getByLabel(/^Cash Amount to Raise/)).toHaveValue(amount);
  await shoot(page, "advisor-no-response");
  await page.unrouteAll();
  expect(requestRow(notes)).toBeNull();
});

test("Edit & Resubmit: offered to the ADVISOR on Needs Info; the form keeps the client and the recorded exclusions; the edits show on the request (AC-46, AC-107, AC-91, AC-120, AC-143, AC-17, AC-45)", async ({ page }) => {
  const { editId } = seed();
  await page.setViewportSize(DESKTOP);
  const detail = await openDirect(page, "ADVISOR", editId);
  const edit = slot(page).getByRole("button", { name: "Edit & Resubmit" });
  await expect(edit).toHaveAttribute("title", "Revise and resubmit this request for trader review");
  await expect(slot(page).getByRole("button", { name: "Clone to New Request" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Approve & Execute" })).toHaveCount(0);
  await shoot(page, "advisor-detail-edit-and-resubmit");
  await edit.click();

  await expect(page).toHaveURL(new RegExp(`${NEW}/edit/${editId}$`));
  await expect(page.getByRole("heading", { level: 2, name: `Resubmit: ${editId}` })).toBeVisible();
  await expect(clientSelect(page)).toBeDisabled();
  await expect(clientSelect(page)).toContainText(ALEX.name);
  await expect(page.getByRole("button", { name: "Enter manually" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Advisor Specific Exclusions" })).toHaveValue("NVDA (DNB - recorded on request)");
  await expect(page.getByRole("textbox", { name: "Client Requested Exclusions" })).toHaveValue("META (DNS - recorded on request)");
  const manage = page.getByRole("button", { name: "Manage exclusions" });
  await expect(manage).toBeDisabled();
  await expect(manage).toHaveAttribute("title", "Standing list is disabled in edit / clone mode");
  await expect(page.getByRole("button", { name: "Manage Account Restrictions" })).toHaveCount(0);
  await expect(page.getByText("This client has an existing allocation on file.")).toHaveCount(0);
  await expect(page.getByLabel("Trade Type")).toHaveValue("Rebalance");
  await expect(page.getByLabel(/^Priority/)).toHaveValue("Urgent");
  await expect(page.getByLabel("State Residence")).toHaveValue("NY");
  await expect(page.getByLabel("Client Risk Score")).toHaveValue("12");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.waitForTimeout(1_500);
  await expect(page.getByRole("textbox", { name: "Advisor Specific Exclusions" })).toHaveValue("NVDA (DNB - recorded on request)");
  await shoot(page, "advisor-edit-form");

  const edited = `${SUBMIT_MARKER} edit resubmitted ${unique()}`;
  await page.getByLabel("Advisor Compliance & Execution Notes").fill(edited);
  await page.getByLabel(/^Priority/).selectOption("Low");
  await page.getByRole("button", { name: "Resubmit to Trader" }).click();
  const row = await expectQueued(page, editId, "Pending Review");
  expect(requestRow(edited)).toMatchObject({ id: editId, status: "Pending Review" });
  await row.click();
  const reopened = page.getByTestId("trade-request-detail");
  await expect(reopened).toContainText(edited);
  await expect(reopened).toContainText("Low");
  await expect(slot(page).getByRole("button")).toHaveCount(0);
  await shoot(page, "advisor-resubmitted-detail");
});

test("Edit & Resubmit: a change made after the form opened is refused with the stale message and the edits stay (AC-8, AC-29)", async ({ page }) => {
  const { staleId } = seed();
  await page.setViewportSize(DESKTOP);
  await signInAs(page, "ADVISOR", `${NEW}/edit/${staleId}`);
  await expect(page.getByRole("heading", { level: 2, name: `Resubmit: ${staleId}` })).toBeVisible();
  await changeStatusElsewhere(staleId, "Needs Info");
  const edited = `${SUBMIT_MARKER} stale edit ${unique()}`;
  await page.getByLabel("Advisor Compliance & Execution Notes").fill(edited);
  await page.getByRole("button", { name: "Resubmit to Trader" }).click();
  await expect(submitError(page)).toHaveText(STALE);
  await expect(submitError(page)).toBeInViewport();
  await expect(page.getByLabel("Advisor Compliance & Execution Notes")).toHaveValue(edited);
  await expect(page).toHaveURL(new RegExp(`${NEW}/edit/${staleId}$`));
  expect(requestRow(edited)).toBeNull();
  await shoot(page, "advisor-stale-resubmit");
});

test("Edit & Resubmit on another advisor's request: the service refuses and its message is shown (AC-8)", async ({ page }) => {
  const { otherId } = seed();
  await page.setViewportSize(DESKTOP);
  await openDirect(page, "ADVISOR", otherId);
  await slot(page).getByRole("button", { name: "Edit & Resubmit" }).click();
  await expect(page.getByRole("heading", { level: 2, name: `Resubmit: ${otherId}` })).toBeVisible();
  await page.getByRole("button", { name: "Resubmit to Trader" }).click();
  await expect(submitError(page)).toHaveText("You do not have access to this request");
  await expect(submitError(page)).toBeInViewport();
  await shoot(page, "advisor-other-advisor-refused");
});

test("Clone to New Request: offered to the ADVISOR on Rejected; prefilled from the source; submits a new Pending Review request (AC-47, AC-18, AC-91, AC-120, AC-143, AC-6)", async ({ page }) => {
  const { rejectedId } = seed();
  await page.setViewportSize(DESKTOP);
  await openDirect(page, "ADVISOR", rejectedId);
  const clone = slot(page).getByRole("button", { name: "Clone to New Request" });
  await expect(clone).toHaveAttribute("title", "Create a new request pre-filled from this one");
  await expect(slot(page).getByRole("button", { name: "Edit & Resubmit" })).toHaveCount(0);
  await shoot(page, "advisor-detail-clone");
  await clone.click();

  await expect(page).toHaveURL(new RegExp(`${NEW}/clone/${rejectedId}$`));
  await expect(page.getByRole("heading", { level: 2, name: `Clone from ${rejectedId}` })).toBeVisible();
  await expect(clientSelect(page)).toBeEnabled();
  await expect(clientSelect(page)).toContainText("2 clients selected");
  for (const number of [ALEX.accounts[0].number, BLAIR.accounts[0].number]) await expect(accounts(page).getByRole("checkbox", { name: new RegExp(number) })).toBeChecked();
  await expect(accounts(page).getByRole("checkbox", { name: new RegExp(ALEX.accounts[1].number) })).not.toBeChecked();
  await expect(page.getByLabel("Trade Type")).toHaveValue("Initial Funding");
  await expect(page.getByLabel(/^Priority/)).toHaveValue("Low");
  await expect(page.getByLabel("State Residence")).toHaveValue("CA");
  await expect(page.getByLabel("Liquidation Approval")).toHaveValue("No");
  await expect(page.getByLabel("Client Risk Score")).toHaveValue("20");
  await expect(page.getByLabel(/^Strategy Rationale/).first()).toHaveValue("Synthetic core");
  await expect(page.getByLabel("Custom ESG filter")).toHaveValue("Synthetic palm oil");
  await expect(page.getByRole("textbox", { name: "Advisor Specific Exclusions" })).toHaveValue("AMZN (DNB - recorded on rejected request)");
  await expect(page.getByRole("textbox", { name: "Client Requested Exclusions" })).toHaveValue("");
  await expect(page.getByLabel("Advisor Compliance & Execution Notes")).toHaveValue(/TRW-15 synthetic rejected/);
  await expect(page.getByRole("button", { name: "Manage exclusions" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Manage Account Restrictions" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await shoot(page, "advisor-clone-form");

  const notes = `${SUBMIT_MARKER} cloned ${unique()}`;
  await page.getByLabel("Advisor Compliance & Execution Notes").fill(notes);
  await page.getByRole("button", { name: "Generate Plan & Submit" }).click();
  await expect(page).toHaveURL(new RegExp(`${QUEUE}$`));
  const created = requestRow(notes)!;
  expect(created.id).not.toBe(rejectedId);
  expect(created.status).toBe("Pending Review");
  await expectQueued(page, created.id, "Pending Review");
  await expectQueued(page, rejectedId, "Rejected");
});

test("reviewers see no Edit & Resubmit or Clone; an advisor sees neither on Pending Review; an edit address for a reviewer shows the request (AC-46, AC-47)", async ({ page }) => {
  const { editId, staleId, rejectedId, pendingId } = seed();
  await page.setViewportSize(DESKTOP);
  for (const role of ["ADMIN", "OPERATIONS"] as Persona[]) {
    await openDirect(page, role, staleId);
    await expect(slot(page).getByRole("button", { name: "Needs Info" })).toBeVisible();
    await expect(slot(page).getByRole("button", { name: "Edit & Resubmit" })).toHaveCount(0);
    await shoot(page, `${role}-needs-info-detail`);
    await page.goto(`/trade-requests/${rejectedId}`);
    await expect(page.getByTestId("trade-request-detail")).toBeVisible();
    await expect(slot(page).getByRole("button")).toHaveCount(0);
    await page.goto(`${NEW}/edit/${staleId}`);
    await expect(page).toHaveURL(new RegExp(`/trade-requests/${staleId}$`));
    await expect(page.getByTestId("trade-request-detail")).toBeVisible();
  }
  await openDirect(page, "ADVISOR", pendingId);
  await expect(slot(page).getByRole("button")).toHaveCount(0);
  await page.goto(`${NEW}/clone/${editId}`);
  await expect(page).toHaveURL(new RegExp(`/trade-requests/${editId}$`));
});

test("mobile: the ADVISOR's Edit & Resubmit action and edit form keep every control (AC-153)", async ({ page }) => {
  const { mobileId } = seed();
  await page.setViewportSize(MOBILE);
  await openDirect(page, "ADVISOR", mobileId);
  const edit = slot(page).getByRole("button", { name: "Edit & Resubmit" });
  await expect(edit).toBeVisible();
  await shoot(page, "mobile-advisor-detail");
  await edit.click();
  await expect(page.getByRole("heading", { level: 2, name: `Resubmit: ${mobileId}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resubmit to Trader" })).toBeVisible();
  await expect(clientSelect(page)).toBeDisabled();
  await noHorizontalOverflow(page);
  await shoot(page, "mobile-advisor-edit-form");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(new RegExp(`${QUEUE}$`));
});

for (const role of ["CLIENT_SERVICE", "VIEWER"] as Persona[]) {
  test(`${role} gets the permission screen on edit and clone addresses, with no request data`, async ({ page }) => {
    const { editId, rejectedId } = seed();
    await page.setViewportSize(DESKTOP);
    await signInAs(page, role);
    for (const path of [`${NEW}/edit/${editId}`, `${NEW}/clone/${rejectedId}`]) {
      await page.goto(path);
      await expect(page.getByText(NO_PERMISSION)).toBeVisible();
      await expect(page.getByText(ALEX.name)).toHaveCount(0);
      await expect(page.getByText(/recorded on/)).toHaveCount(0);
    }
    await shoot(page, `permission-${role}`);
  });
}
