import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { globalSearch } from "@/lib/data/search";
import type { Identity } from "@/lib/data/types";

// DB-gated seam test for global search. globalSearch runs ILIKE queries against
// a live RLS-scoped Postgres, so the only faithful test drives the real query.
// Gate on INGEST_DATABASE_URL — the same switch the ingest + board suites use —
// so it stays dormant in a plain local `npm run test`; database CI opts in.
//
// SEEDING NOTE: there is NO Prisma model for mirror.household / mirror.client
// (the schema maps only app.* + auth), so those are seeded with raw INSERTs via
// the BYPASSRLS superuser client. app.deal / app.transfer ARE models → .create.
// All ids namespaced ZZTEST-SEARCH-* for exact teardown. Reads run under the
// OPERATIONS identity, which the mirror *_ops_all policies grant full-firm
// SELECT — so seeded rows are visible regardless of lead_advisor_email.

const RUN = process.env.INGEST_DATABASE_URL ? describe : describe.skip;

function makeSudoClient(): PrismaClient {
  const url =
    process.env.INGEST_TEST_CLEANUP_URL ??
    `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`;
  return new PrismaClient({ datasources: { db: { url } } });
}

const OPS: Identity = { role: "OPERATIONS", email: "ops@example.com" };
const ADVISOR = "zztest-advisor@example.com";

const IDS = {
  household: "ZZTEST-SEARCH-HH",
  householdPct: "ZZTEST-SEARCH-HH-PCT", // name literally contains "50%"
  client: "ZZTEST-SEARCH-CL",
  clientPlaceholder: "ZZTEST-SEARCH-HH", // placeholder row: sf_id = household_id
  deal: "ZZTEST-SEARCH-DEAL",
  dealArchived: "ZZTEST-SEARCH-DEAL-ARCH",
  transfer: "ZZTEST-SEARCH-XFER",
  transferArchived: "ZZTEST-SEARCH-XFER-ARCH",
} as const;

const sudo = makeSudoClient();

async function seed() {
  // mirror.household — NOT-NULL: sf_id, name, lead_advisor_email (stage/status/
  // aum nullable). Two households; the second's name carries a literal "50%".
  await sudo.$executeRaw`
    INSERT INTO mirror.household (sf_id, name, lead_advisor_email, stage)
    VALUES (${IDS.household}, 'ZZTEST Aurora Household', ${ADVISOR}, 'Client'),
           (${IDS.householdPct}, 'ZZTEST 50% Club', ${ADVISOR}, 'Prospect')`;

  // mirror.client — NOT-NULL: sf_id, household_id (FK), lead_advisor_email.
  // A REAL client (sf_id <> household_id) and a PLACEHOLDER (sf_id = household_id)
  // that global search must exclude even though its name matches the token.
  await sudo.$executeRaw`
    INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
    VALUES (${IDS.client}, ${IDS.household}, 'ZztestClient', 'Nimbus', ${ADVISOR}),
           (${IDS.clientPlaceholder}, ${IDS.household}, 'Zztestplaceholder', 'Ghost', ${ADVISOR})`;

  // app.deal — a live deal + an ARCHIVED deal (must not surface).
  const dealBase = {
    source: "APP" as const,
    amount: "1000.00",
    stage: "COMMITTED" as const,
    created_date: new Date("2026-07-01"),
    statements: true,
    asset_mapped: false,
  };
  await sudo.deal.create({
    data: {
      ...dealBase,
      id: IDS.deal,
      name: "ZZTEST Rollover Deal",
      client_first_name: "Zztest",
      client_last_name: "Nimbus",
    },
  });
  await sudo.deal.create({
    data: {
      ...dealBase,
      id: IDS.dealArchived,
      name: "ZZTEST Archived Deal",
      client_first_name: "Zztest",
      client_last_name: "Gone",
      archived_at: new Date("2026-07-05"),
    },
  });

  // app.transfer — a live transfer + an ARCHIVED transfer (must not surface).
  const xferBase = {
    source: "APP" as const,
    client_first_name: "Zztest",
    value: "2000.00",
    owner_kind: "OPERATIONS" as const,
    stage: "DECISION" as const,
  };
  await sudo.transfer.create({
    data: { ...xferBase, id: IDS.transfer, client_last_name: "Transferperson" },
  });
  await sudo.transfer.create({
    data: {
      ...xferBase,
      id: IDS.transferArchived,
      client_last_name: "Archivedxfer",
      archived_at: new Date("2026-07-05"),
    },
  });
}

async function teardown() {
  await sudo.$executeRaw`DELETE FROM app.transfer WHERE id LIKE 'ZZTEST-SEARCH-%'`;
  await sudo.$executeRaw`DELETE FROM app.deal WHERE id LIKE 'ZZTEST-SEARCH-%'`;
  await sudo.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE 'ZZTEST-SEARCH-%'`;
  await sudo.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE 'ZZTEST-SEARCH-%'`;
  // app.deal / app.transfer INSERT+DELETE fire the row_change audit trigger.
  await sudo.$executeRaw`
    DELETE FROM audit.row_change
    WHERE table_name IN ('transfer', 'deal') AND row_pk LIKE 'ZZTEST-SEARCH-%'`;
}

RUN("globalSearch — cross-entity, RLS-scoped", () => {
  beforeAll(async () => {
    await teardown(); // clean any stray rows from a partial prior run
    await seed();
  });
  afterAll(async () => {
    await teardown();
    await sudo.$disconnect();
  });

  it("returns one of each type with the correct href + type", async () => {
    const rows = await globalSearch(OPS, "Zztest");
    const byType = (t: string) => rows.filter((r) => r.type === t);

    const hh = byType("household").find((r) => r.id === IDS.household);
    expect(hh).toBeDefined();
    expect(hh?.href).toBe(`/households/${IDS.household}`);

    const cl = byType("client").find((r) => r.id === IDS.client);
    expect(cl).toBeDefined();
    expect(cl?.href).toBe(`/client-portrait/${IDS.client}`);
    expect(cl?.label).toBe("ZztestClient Nimbus");

    const dl = byType("deal").find((r) => r.id === IDS.deal);
    expect(dl).toBeDefined();
    expect(dl?.href).toBe(`/deals/${IDS.deal}`);

    const xf = byType("transfer").find((r) => r.id === IDS.transfer);
    expect(xf).toBeDefined();
    expect(xf?.href).toBe(`/asset-transfer/${IDS.transfer}`);
  });

  it("excludes archived deals and transfers", async () => {
    const ids = (await globalSearch(OPS, "Zztest")).map((r) => r.id);
    expect(ids).not.toContain(IDS.dealArchived);
    expect(ids).not.toContain(IDS.transferArchived);
  });

  it("excludes placeholder clients (sf_id = household_id)", async () => {
    const clientIds = (await globalSearch(OPS, "Zztest"))
      .filter((r) => r.type === "client")
      .map((r) => r.id);
    // The placeholder shares the household sf_id; no client result may carry it.
    expect(clientIds).not.toContain(IDS.clientPlaceholder);
  });

  it("returns [] for a 1-char query", async () => {
    await expect(globalSearch(OPS, "z")).resolves.toEqual([]);
  });

  it("treats % as a literal, not a wildcard", async () => {
    const households = (await globalSearch(OPS, "50%")).filter(
      (r) => r.type === "household",
    );
    // Matches the literal "50%" household...
    expect(households.some((r) => r.id === IDS.householdPct)).toBe(true);
    // ...and NOT the other seeded household (proves % is escaped, not a wildcard).
    expect(households.some((r) => r.id === IDS.household)).toBe(false);
  });

  // Asymmetric RLS scoping (owner decision "match the app", 2026-07-21). The
  // seeded rows carry lead_advisor_email = ADVISOR; this identity is a DIFFERENT
  // advisor, so its book does not include them.
  const OTHER_ADVISOR: Identity = {
    role: "ADVISOR",
    email: "other-advisor@example.com",
  };

  it("book-scopes households/clients away from an out-of-book advisor", async () => {
    const rows = await globalSearch(OTHER_ADVISOR, "Zztest");
    const hhIds = rows.filter((r) => r.type === "household").map((r) => r.id);
    const clIds = rows.filter((r) => r.type === "client").map((r) => r.id);
    // household_own_book / client_own_book hide rows led by another advisor.
    expect(hhIds).not.toContain(IDS.household);
    expect(hhIds).not.toContain(IDS.householdPct);
    expect(clIds).not.toContain(IDS.client);
  });

  it("finds every household and client for client service, whoever leads them", async () => {
    const rows = await globalSearch({ role: "CLIENT_SERVICE", email: "zztest-cs@example.com" }, "Zztest");
    const hhIds = rows.filter((r) => r.type === "household").map((r) => r.id);
    const clIds = rows.filter((r) => r.type === "client").map((r) => r.id);
    // household_client_service_all / client_client_service_all: client service works the whole firm.
    expect(hhIds).toContain(IDS.household);
    expect(hhIds).toContain(IDS.householdPct);
    expect(clIds).toContain(IDS.client);
  });

  it("still returns firm-wide deals/transfers to an out-of-book advisor (ADR-4)", async () => {
    const rows = await globalSearch(OTHER_ADVISOR, "Zztest");
    const dealIds = rows.filter((r) => r.type === "deal").map((r) => r.id);
    const xferIds = rows.filter((r) => r.type === "transfer").map((r) => r.id);
    // deal_read_all_roles / transfer_read_all_roles are firm-wide for every role
    // — the same visibility the /deals and /asset-transfer pages already give.
    expect(dealIds).toContain(IDS.deal);
    expect(xferIds).toContain(IDS.transfer);
  });
});
