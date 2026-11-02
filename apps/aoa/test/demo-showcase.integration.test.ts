// The showcase clients' Client Portraits on a freshly seeded demo database, read through the app's own loaders as the
// signed-in admin persona: every section a visitor opens is filled (accounts and AUM, beneficiaries, held-away
// accounts, the tax budget, Insights, meeting prep, reminders, the approved investment profile on the accounts that
// have one), and the second members' own accounts carry their AUM. Opt-in: DEMO_SEED_TEST_OWNER_URL is the owner login
// of a freshly migrated loopback database. It seeds and writes that database, so point it at a throwaway copy.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const OWNER_URL = process.env.DEMO_SEED_TEST_OWNER_URL;
const RUN = OWNER_URL ? describe : describe.skip;

const DEMO_CONFIG = JSON.parse(readFileSync(new URL("../demo-config.json", import.meta.url), "utf8")) as Record<string, string>;
const LOGIN_KEYS = ["DATABASE_URL", "INGEST_DATABASE_URL", "CRM_RECONCILER_DATABASE_URL"];
const savedEnv: Record<string, string | undefined> = {};
const PRIYA = { role: "ADMIN", email: "priya.nair@example.com" };
const SHOWCASE = ["okafor-kofi", "okafor-ada", "lindqvist-erik", "brennan-maeve"] as const;

function loopback(raw: string): string {
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username !== "aoa") throw new Error("loopback_demo_showcase_database_required");
  return raw;
}

RUN("demo showcase clients", () => {
  let owner: PrismaClient;
  let ingest: PrismaClient;
  let sf: Map<string, string>;
  let cedar: (personId: string) => string;
  let portrait: typeof import("@/lib/data/portrait").clientPortraitDetail;
  let reminders: typeof import("@/lib/data/client-reminders").clientReminders;
  let tradeProfile: (personId: string) => Promise<import("@/lib/data/trade-request-profile").TradeRequestProfile>;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(DEMO_CONFIG)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    const { demoLoginUrls, ensureDemoLogins } = await import("@/lib/demo/logins");
    const logins = demoLoginUrls(loopback(OWNER_URL!));
    for (const key of LOGIN_KEYS) {
      savedEnv[key] = process.env[key];
      process.env[key] = logins[key as keyof typeof logins];
    }
    owner = new PrismaClient({ datasourceUrl: OWNER_URL });
    ingest = new PrismaClient({ datasourceUrl: logins.INGEST_DATABASE_URL });
    const [{ held }] = await owner.$queryRaw<Array<{ held: bigint }>>`SELECT count(*) AS held FROM app.transfer`;
    if (held > 0n) throw new Error("DEMO_SEED_TEST_OWNER_URL must be a freshly migrated database");
    await ensureDemoLogins(owner, OWNER_URL!);

    const { seedDemo } = await import("@/lib/demo/seed");
    const universeModule = await import("@/lib/demo/seed/universe");
    const universe = universeModule.loadUniverse();
    await seedDemo(universe, owner, ingest);
    sf = universeModule.personIds(universe);
    cedar = universeModule.cedarRidgeUserId;

    portrait = (await import("@/lib/data/portrait")).clientPortraitDetail;
    reminders = (await import("@/lib/data/client-reminders")).clientReminders;
    const { getTradeRequestsForUser } = await import("@/lib/data/trade-requests");
    const { apexAccountsForClient } = await import("@/lib/data/account-aum");
    const { deriveAccountScopedTradeRequestProfileFromSummaries } = await import("@/lib/data/trade-request-profile");
    tradeProfile = async (personId) => {
      const [requests, accounts] = await Promise.all([
        getTradeRequestsForUser(cedar(personId)),
        apexAccountsForClient(PRIYA, sf.get(personId)!),
      ]);
      return deriveAccountScopedTradeRequestProfileFromSummaries(cedar(personId), requests, accounts.map((a) => ({
        accountId: a.custodianAccountId, accountNumber: a.apexAccountNumber ?? a.custodianAccountId, accountType: a.accountType, status: a.accountStatus,
      })));
    };
  }, 180_000);

  afterAll(async () => {
    await owner?.$disconnect();
    await ingest?.$disconnect();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("fills every Client Portrait section for each showcase client", async () => {
    for (const person of SHOWCASE) {
      const detail = await portrait(PRIYA, sf.get(person)!);
      expect(detail, person).not.toBeNull();
      expect(detail!.accounts.investment?.length, person).toBeGreaterThan(0);
      expect(detail!.clientAum, person).toBeGreaterThan(0);
      expect(detail!.accounts.bene.length, person).toBeGreaterThan(0);
      expect(detail!.accounts.ext.length, person).toBeGreaterThan(0);
      expect(detail!.taxBudget.current, person).not.toBeNull();
      expect(detail!.prep?.recentSignals.length, person).toBeGreaterThan(1);
      expect(detail!.portrait.Family, person).not.toBe("Married, two adult children");
      const r = await reminders(PRIYA, sf.get(person)!);
      expect(r!.decisions.length + r!.nudges.length, person).toBeGreaterThan(1);
    }
  });

  it("gives Ada her own SEP IRA and her Edward Jones Roth IRA as a held-away account", async () => {
    const ada = (await portrait(PRIYA, sf.get("okafor-ada")!))!;
    expect(ada.accounts.investment?.map((a) => a.type)).toEqual(["SEP IRA"]);
    expect(ada.clientAum).toBe(88_340);
    expect(ada.accounts.ext).toEqual([expect.objectContaining({ inst: "Edward Jones", num: "••••7790", holdingsTotal: 100_122.5 })]);
    expect(ada.taxBudget.prior).toEqual({ year: ada.taxBudget.year - 1, budget: 3_000 });
    const kofi = (await portrait(PRIYA, sf.get("okafor-kofi")!))!;
    expect(kofi.accounts.ext).toEqual([expect.objectContaining({ inst: "Edward Jones", num: "••••7802" })]);
    expect(kofi.householdAum).toBe(412_880 + 88_340);
  });

  it("derives the investment profile from the older funding requests, and leaves the accounts still transferring in review", async () => {
    const ada = await tradeProfile("okafor-ada");
    expect(ada.accountReview?.accounts.map((a) => [a.accountType, a.state, a.risk?.profile.score, a.risk?.sourceRequestId])).toEqual([["SEP IRA", "ready", 19, "REQ-00000901"]]);
    const erik = await tradeProfile("lindqvist-erik");
    expect(erik.accountReview?.accounts.map((a) => [a.accountType, a.state])).toEqual(expect.arrayContaining([
      ["Traditional IRA", "ready"], ["Individual", "missing"],
    ]));
    const maeve = await tradeProfile("brennan-maeve");
    expect(maeve.accountReview?.accounts.map((a) => [a.accountType, a.state])).toEqual(expect.arrayContaining([
      ["Rollover IRA", "ready"], ["Individual", "missing"],
    ]));
    // Kofi's joint account waits on the rebalance in review (REQ-00001045), as the Okafor story tells it.
    const kofi = await tradeProfile("okafor-kofi");
    expect(kofi.accountReview?.accounts.map((a) => [a.accountType, a.state])).toEqual([["Joint", "missing"]]);
    expect(kofi.excludedRequestCount).toBeGreaterThan(0);
  });

  it("gives every client accounts of their own and a budget, so no Client Portrait is empty", async () => {
    const empty = await owner.$queryRaw<Array<{ sf_id: string }>>`
      SELECT c.sf_id FROM mirror.client c
       WHERE NOT EXISTS (SELECT 1 FROM mirror.client_account_aum a WHERE a.client_sf_id = c.sf_id)
          OR NOT EXISTS (SELECT 1 FROM app.tax_budget t WHERE t.client_sf_id = c.sf_id)`;
    expect(empty).toEqual([]);
  });
});
