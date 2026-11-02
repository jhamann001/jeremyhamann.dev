import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  queryWarehouseCard: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/warehouse/client", () => ({ queryWarehouseCard: mocks.queryWarehouseCard }));

import { previewLinkedHoldings } from "@/app/(authenticated)/client-portrait/[id]/actions";
import { linkedExternalSummariesForClient } from "@/lib/data/linked-external-account-summary";
import { prisma } from "@/lib/db";
import type { Identity } from "@/lib/rls";

// ticket: the role matrix, cross-book isolation, inactive/stale handling and
// preview no-persistence checks run the real summary read and the real server
// action against app_rw RLS. Only Warehouse (card 6899) and the session are mocked.

const ADVISOR_A = "plaz-advisor-a@example.invalid";
const CS_B = "plaz-cs-b@example.invalid";
const HH_A = "TPLAZHHA0000001";
const HH_B = "TPLAZHHB0000001";
const HH_MISSING = "TPLAZHHZ0000001";
const CLIENT_A = "TPLAZCLA0000001";
const CLIENT_B = "TPLAZCLB0000001";
const EXT_A_LIVE = "TEST-PLAZ-A-LIVE";
const EXT_A_INACTIVE = "TEST-PLAZ-A-INACTIVE";
const EXT_A_NO_HOUSEHOLD = "TEST-PLAZ-A-NOHH";
const EXT_B_LIVE = "TEST-PLAZ-B-LIVE";
const STALE_AS_OF = new Date("2025-01-15T00:00:00.000Z");
const FRESH_AS_OF = new Date("2026-10-01T00:00:00.000Z");
const PREVIEW_PARAM_ID = "fe1f5565-cc0f-4338-865c-bd1a66475f5c";

const CARD_ROWS = [
  {
    ticker: "VTI", security_id: "sec-1", security_name: "Vanguard Total", quantity: 2, market_value: 20,
    as_of: "2026-10-02", access_token: "access-sandbox-secret", isin: "US0000000001",
    cusip: "000000001", cost_basis: 15,
  },
  { ticker: null, security_id: "sec-cash", security_name: "Cash", quantity: 10, market_value: 10 },
];

const suite =
  process.env.INGEST_DATABASE_URL && process.env.DATABASE_URL && process.env.INGEST_TEST_CLEANUP_URL
    ? describe
    : describe.skip;

const ids = (rows: { externalAccountId: string }[]) => rows.map((r) => r.externalAccountId).sort();

function asSession(role: string | undefined, email: string | null) {
  mocks.auth.mockResolvedValue({ user: { role, email } });
}

suite("Plaid-linked holdings role, isolation, freshness and failure (ticket)", () => {
  let owner: PrismaClient | undefined;

  async function removeFixtures() {
    if (!owner) return;
    await owner.$executeRaw`
      DELETE FROM mirror.linked_external_account_summary WHERE external_account_id LIKE 'TEST-PLAZ-%'`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE 'TPLAZCL%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE 'TPLAZHH%'`;
  }

  async function summarySnapshot() {
    return owner!.$queryRaw<Record<string, unknown>[]>`
      SELECT external_account_id, client_sf_id, household_sf_id, cash_amount::text AS cash,
             securities_amount::text AS securities, holdings_total::text AS total,
             institution_balance::text AS balance, as_of, link_status, synced_at
      FROM mirror.linked_external_account_summary
      WHERE external_account_id LIKE 'TEST-PLAZ-%'
      ORDER BY external_account_id`;
  }

  async function fixtureAuditRows() {
    const [row] = await owner!.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit."AuditLog"
      WHERE "entityId" LIKE 'TEST-PLAZ-%' OR "entityId" LIKE 'TPLAZ%'
         OR detail::text LIKE '%TEST-PLAZ-%'`;
    return row.n;
  }

  beforeAll(async () => {
    const cleanupUrl = process.env.INGEST_TEST_CLEANUP_URL!;
    const target = new URL(cleanupUrl);
    for (const value of [cleanupUrl, process.env.DATABASE_URL!, process.env.INGEST_DATABASE_URL!]) {
      const url = new URL(value);
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.host !== target.host ||
        url.pathname !== target.pathname
      ) {
        throw new Error("ticket integration tests require one loopback synthetic database");
      }
    }
    if (new URL(process.env.DATABASE_URL!).username !== "app_rw") {
      throw new Error("RLS reads must run as app_rw");
    }
    owner = new PrismaClient({ datasourceUrl: cleanupUrl });
    await removeFixtures();
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email, status)
      VALUES (${HH_A}, 'Plaz Household A', ${ADVISOR_A}, 'Active'),
             (${HH_B}, 'Plaz Household B', ${CS_B}, 'Active')`;
    await owner.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, email, lead_advisor_email)
      VALUES (${CLIENT_A}, ${HH_A}, 'Ada', 'Alpha', 'plaz-ada@example.invalid', ${ADVISOR_A}),
             (${CLIENT_B}, ${HH_B}, 'Bea', 'Beta', 'plaz-bea@example.invalid', ${CS_B})`;
    await owner.$executeRaw`
      INSERT INTO mirror.linked_external_account_summary (
        external_account_id, client_sf_id, household_sf_id, institution_name, account_subtype,
        mask, cash_amount, securities_amount, holdings_total, institution_balance, as_of,
        link_status, lineage_key, prior_external_account_id
      ) VALUES
        (${EXT_A_LIVE}, ${CLIENT_A}, ${HH_A}, 'Bank A', 'brokerage', '1111',
         5, 25, 30, 29, ${STALE_AS_OF}, 'ACTIVE', 'plaz-a', NULL),
        (${EXT_A_INACTIVE}, ${CLIENT_A}, ${HH_A}, 'Bank A', 'brokerage', '2222',
         1, 1, 2, 2, ${FRESH_AS_OF}, 'inactive', 'plaz-a-old', NULL),
        (${EXT_A_NO_HOUSEHOLD}, ${CLIENT_A}, ${HH_MISSING}, 'Bank Z', 'ira', '3333',
         0, 7, 7, 7, ${FRESH_AS_OF}, 'ACTIVE', 'plaz-z', NULL),
        (${EXT_B_LIVE}, ${CLIENT_B}, ${HH_B}, 'Bank B', 'brokerage', '4444',
         10, 20, 30, 31, ${FRESH_AS_OF}, 'ACTIVE', 'plaz-b', NULL)`;
  });

  afterAll(async () => {
    try {
      await removeFixtures();
    } finally {
      await owner?.$disconnect();
      await prisma.$disconnect();
    }
  });

  describe("mirrored summary reads under RLS", () => {
    it.each(["ADMIN", "OPERATIONS"])("%s reads every active row firm-wide and no inactive row", async (role) => {
      const identity: Identity = { role, email: `plaz-${role.toLowerCase()}@example.invalid` };
      expect(ids(await linkedExternalSummariesForClient(identity, CLIENT_A))).toEqual(
        [EXT_A_NO_HOUSEHOLD, EXT_A_LIVE].sort(),
      );
      expect(ids(await linkedExternalSummariesForClient(identity, CLIENT_B))).toEqual([EXT_B_LIVE]);
    });

    it("Advisor reads only their own book (crossBookRows=0)", async () => {
      const advisor: Identity = { role: "ADVISOR", email: ADVISOR_A };
      expect(ids(await linkedExternalSummariesForClient(advisor, CLIENT_A))).toEqual([EXT_A_LIVE]);

      const crossBookRows = (await linkedExternalSummariesForClient(advisor, CLIENT_B)).length;
      expect(`crossBookRows=${crossBookRows}`).toBe("crossBookRows=0");
    });

    it("Client Service reads every household's active rows, whoever leads it", async () => {
      for (const email of [CS_B, ADVISOR_A]) {
        const clientService: Identity = { role: "CLIENT_SERVICE", email };
        expect(ids(await linkedExternalSummariesForClient(clientService, CLIENT_A))).toEqual([EXT_A_LIVE]);
        expect(ids(await linkedExternalSummariesForClient(clientService, CLIENT_B))).toEqual([EXT_B_LIVE]);
      }
    });

    it("household-scoped roles never see a row whose household is not in the mirror", async () => {
      const identities: Identity[] = [
        { role: "ADVISOR", email: ADVISOR_A },
        { role: "CLIENT_SERVICE", email: CS_B },
      ];
      for (const identity of identities) {
        const rows = await linkedExternalSummariesForClient(identity, CLIENT_A);
        expect(ids(rows)).not.toContain(EXT_A_NO_HOUSEHOLD);
      }
    });

    it.each([
      ["VIEWER", ADVISOR_A],
      ["VIEWER", CS_B],
      ["OWNER", ADVISOR_A],
      ["admin", "plaz-admin@example.invalid"],
      ["", ADVISOR_A],
      [null, ADVISOR_A],
      ["ADVISOR", null],
      ["CLIENT_SERVICE", null],
    ] as const)("role %j with email %j reads no rows for either client", async (role, email) => {
      const identity: Identity = { role, email };
      expect(await linkedExternalSummariesForClient(identity, CLIENT_A)).toEqual([]);
      expect(await linkedExternalSummariesForClient(identity, CLIENT_B)).toEqual([]);
    });

    it("returns the stored as-of unchanged so a stale summary stays visibly stale", async () => {
      const rows = await linkedExternalSummariesForClient({ role: "ADVISOR", email: ADVISOR_A }, CLIENT_A);
      const live = rows.find((r) => r.externalAccountId === EXT_A_LIVE);
      expect(live?.linkStatus).toBe("ACTIVE");
      expect(live?.asOf?.toISOString()).toBe(STALE_AS_OF.toISOString());
      expect(live).toMatchObject({ cashAmount: 5, securitiesAmount: 25, holdingsTotal: 30, institutionBalance: 29 });
    });
  });

  describe("previewLinkedHoldings under RLS with Warehouse mocked", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.stubEnv("EPIC_PLAID_LINKED_HOLDINGS", "1");
      vi.stubEnv("ALLOW_PLAID_HOLDINGS_PREVIEW", "1");
      vi.stubEnv("STATEMENT_PIPELINE_URL", "");
      mocks.queryWarehouseCard.mockResolvedValue(CARD_ROWS);
    });
    afterEach(() => vi.unstubAllEnvs());

    it.each(["ADMIN", "OPERATIONS"])("%s previews an authorized active account without persisting it", async (role) => {
      asSession(role, `plaz-${role.toLowerCase()}@example.invalid`);
      const before = await summarySnapshot();
      const auditBefore = await fixtureAuditRows();

      const result = await previewLinkedHoldings({ clientSfId: CLIENT_B, externalAccountId: EXT_B_LIVE });

      expect(result).toEqual({
        ok: true,
        asOf: "2026-10-02",
        holdingsTotal: 30,
        institutionBalance: 31,
        difference: -1,
        rows: [
          { symbol: "VTI", name: "Vanguard Total", quantity: 2, value: 20, label: "unknown", reason: "rules_unavailable" },
          { symbol: "sec-cash", name: "Cash", quantity: 10, value: 10, label: "unknown", reason: "rules_unavailable" },
        ],
      });
      const serialized = JSON.stringify(result);
      for (const field of ["access_token", "access-sandbox-secret", "isin", "cusip", "cost_basis", "security_type"]) {
        expect(serialized).not.toContain(field);
      }
      expect(mocks.queryWarehouseCard).toHaveBeenCalledTimes(1);
      expect(mocks.queryWarehouseCard).toHaveBeenCalledWith(
        6899,
        [{
          id: PREVIEW_PARAM_ID,
          type: "string/=",
          target: ["variable", ["template-tag", "external_account_id"]],
          value: EXT_B_LIVE,
        }],
        "plaid-holdings-preview",
        expect.any(Function),
      );
      expect(await summarySnapshot()).toEqual(before);
      expect(await fixtureAuditRows()).toBe(auditBefore);
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it("an Admin preview of an inactive link is unauthorized and never reaches Warehouse", async () => {
      asSession("ADMIN", "plaz-admin@example.invalid");
      expect(
        await previewLinkedHoldings({ clientSfId: CLIENT_A, externalAccountId: EXT_A_INACTIVE }),
      ).toEqual({ ok: false, reason: "unauthorized" });
      expect(mocks.queryWarehouseCard).not.toHaveBeenCalled();
    });

    it("an account id paired with a different client is unauthorized", async () => {
      asSession("OPERATIONS", "plaz-operations@example.invalid");
      expect(
        await previewLinkedHoldings({ clientSfId: CLIENT_A, externalAccountId: EXT_B_LIVE }),
      ).toEqual({ ok: false, reason: "unauthorized" });
      expect(mocks.queryWarehouseCard).not.toHaveBeenCalled();
    });

    it.each([
      ["ADVISOR", ADVISOR_A, CLIENT_A, EXT_A_LIVE],
      ["CLIENT_SERVICE", CS_B, CLIENT_B, EXT_B_LIVE],
      ["VIEWER", ADVISOR_A, CLIENT_A, EXT_A_LIVE],
      ["OWNER", CS_B, CLIENT_B, EXT_B_LIVE],
      [undefined, ADVISOR_A, CLIENT_A, EXT_A_LIVE],
    ] as const)(
      "%s is unauthorized even for an active account in its own book",
      async (role, email, clientSfId, externalAccountId) => {
        asSession(role, email);
        expect(await previewLinkedHoldings({ clientSfId, externalAccountId })).toEqual({
          ok: false, reason: "unauthorized",
        });
        expect(mocks.queryWarehouseCard).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["epic off", undefined, "1"],
      ["preview off", "1", undefined],
      ["preview set to true", "1", "true"],
    ] as const)("Admin is unauthorized with %s", async (_label, epic, preview) => {
      vi.stubEnv("EPIC_PLAID_LINKED_HOLDINGS", epic);
      vi.stubEnv("ALLOW_PLAID_HOLDINGS_PREVIEW", preview);
      asSession("ADMIN", "plaz-admin@example.invalid");
      expect(
        await previewLinkedHoldings({ clientSfId: CLIENT_B, externalAccountId: EXT_B_LIVE }),
      ).toEqual({ ok: false, reason: "unauthorized" });
      expect(mocks.queryWarehouseCard).not.toHaveBeenCalled();
    });

    it("a Warehouse failure returns preview_failed and leaves the summary row readable and unchanged", async () => {
      asSession("ADMIN", "plaz-admin@example.invalid");
      mocks.queryWarehouseCard.mockRejectedValue(
        Object.assign(new Error("Warehouse 502"), { reason: "warehouse_error" }),
      );
      const before = await summarySnapshot();
      const auditBefore = await fixtureAuditRows();

      expect(
        await previewLinkedHoldings({ clientSfId: CLIENT_B, externalAccountId: EXT_B_LIVE }),
      ).toEqual({ ok: false, reason: "preview_failed" });

      expect(await summarySnapshot()).toEqual(before);
      expect(await fixtureAuditRows()).toBe(auditBefore);
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
      const after = await linkedExternalSummariesForClient(
        { role: "CLIENT_SERVICE", email: CS_B },
        CLIENT_B,
      );
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        externalAccountId: EXT_B_LIVE, linkStatus: "ACTIVE", holdingsTotal: 30, institutionBalance: 31,
      });
      expect(after[0].asOf?.toISOString()).toBe(FRESH_AS_OF.toISOString());
    });
  });
});
