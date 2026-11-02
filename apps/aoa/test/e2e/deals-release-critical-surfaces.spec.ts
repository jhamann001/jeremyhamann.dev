import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { toDateStr } from "../../lib/market-calendar";

const SYNTHETIC_OPERATIONS_PERSONA = "Riley Ops · OPERATIONS (sees all)";

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

test("release deal close-date warnings agree across Household and Portrait in both themes", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("pageerror", error => hydrationErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /hydrat|server rendered|did not match/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  const owner = syntheticDatabaseOwner();
  const household = "001JAUCHRS86784AAA", client = "003JAUCHRS86784AAA";
  const dealIds = ["tkt-release-deal-open", "tkt-release-deal-funded"];
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
