import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { renderToStaticMarkup } from "react-dom/server";

const { authSpy } = vi.hoisted(() => ({ authSpy: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/flags", () => ({
  operationsFeeRequestsPreviewEnabled: () => true,
  crmIdentityReadsEnabled: () => true,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/operations/fee-requests",
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("REDIRECT"); },
}));
// Keep the real server page/cards/disclosures. Client-side mutation widgets
// are not exercised by this database + server-render acceptance suite.
vi.mock("@/components/operations", () => ({
  FeeRequestIntake: () => null,
  FeeRequestWorkflow: () => null,
}));
vi.mock("@/components/operations/FeeRequestWorkflow", () => ({ FeeRequestWorkflow: () => null }));

import { withUserScope } from "@/lib/rls";
import {
  createOperationsFeeRequest,
  operationsFeeRequestPageData,
  transitionOperationsFeeRequest,
} from "@/lib/data/operations-fee-requests";
import Page from "@/app/(authenticated)/operations/fee-requests/page";

// Same explicit disposable-DB gate used by the repository's database CI job.
// All names, account labels and IDs below are synthetic; no export is loaded.
const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const PREFIX = "legacy-scope-synthetic-";
const HOUSEHOLD = "001SYN000000001AAA";
const OTHER_HOUSEHOLD = "001SYN000000002AAA";
const ANCHOR = "003SYN000000001AAA";
const PARTNER = "003SYN000000002AAA";
const OUTSIDER = "003SYN000000003AAA";
const ACCOUNT_A = `${PREFIX}account-a`;
const ACCOUNT_B = `${PREFIX}account-b`;
const ACCOUNT_OTHER = `${PREFIX}account-other`;
const EMAIL = "legacy-scope-ops@example.test";
const SOURCE_LABEL = "Synthetic Adah & Morgan <original reference>";

gated("reviewed legacy household requests: PostgreSQL and server-render acceptance", () => {
  let owner: PrismaClient;

  async function cleanup() {
    await owner.$executeRaw`
      DELETE FROM audit."AuditLog" WHERE "entityType" = 'operations_fee_request'
      AND "entityId" IN (SELECT id FROM app.operations_fee_request
        WHERE left(client_sf_id, 15) IN (${ANCHOR.slice(0, 15)}, ${PARTNER.slice(0, 15)}, ${OUTSIDER.slice(0, 15)}))`;
    await owner.$executeRaw`
      DELETE FROM app.operations_fee_request_event WHERE request_id IN (
        SELECT id FROM app.operations_fee_request
        WHERE left(client_sf_id, 15) IN (${ANCHOR.slice(0, 15)}, ${PARTNER.slice(0, 15)}, ${OUTSIDER.slice(0, 15)}))`;
    await owner.$executeRaw`
      DELETE FROM app.operations_fee_request
      WHERE left(client_sf_id, 15) IN (${ANCHOR.slice(0, 15)}, ${PARTNER.slice(0, 15)}, ${OUTSIDER.slice(0, 15)})`;
    await owner.$executeRaw`
      DELETE FROM mirror.client_account_aum
      WHERE custodian_account_id IN (${ACCOUNT_A}, ${ACCOUNT_B}, ${ACCOUNT_OTHER})`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id IN (${ANCHOR}, ${PARTNER}, ${OUTSIDER})`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id IN (${HOUSEHOLD}, ${OTHER_HOUSEHOLD})`;
  }

  function legacyData(overrides: Partial<Prisma.OperationsFeeRequestUncheckedCreateInput> = {}): Prisma.OperationsFeeRequestUncheckedCreateInput {
    return {
      id: `${PREFIX}request`, kind: "FEE_CREDIT", status: "PENDING",
      scope: "HOUSEHOLD", client_sf_id: ANCHOR, account_ids: [ACCOUNT_A, ACCOUNT_B],
      fee_types: ["Wire"], fee_amount: "1.00", reason: "Synthetic acceptance only",
      submitted_by_name: "Synthetic Importer", submitted_by_role: "OPERATIONS",
      submitted_at: new Date("2026-09-01T12:00:00Z"),
      legacy_source: "fee_store_fee_credits", legacy_source_id: "26",
      legacy_source_digest: "a".repeat(64), legacy_client_name: SOURCE_LABEL,
      legacy_household_sf_id: HOUSEHOLD, ...overrides,
    };
  }

  beforeAll(() => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!url) throw new Error("AUDIT_TEST_CLEANUP_URL is required for synthetic fixture cleanup");
    owner = new PrismaClient({ datasources: { db: { url } } });
  });

  beforeEach(async () => {
    await cleanup();
    authSpy.mockResolvedValue({ user: { role: "OPERATIONS", email: EMAIL } });
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      VALUES (${HOUSEHOLD}, 'Synthetic Adah household', ${EMAIL}),
             (${OTHER_HOUSEHOLD}, 'Synthetic Separate household', ${EMAIL})`;
    await owner.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      VALUES (${ANCHOR}, ${HOUSEHOLD}, 'Adah', 'Synthetic', ${EMAIL}),
             (${PARTNER}, ${HOUSEHOLD}, 'Morgan', 'Synthetic', ${EMAIL}),
             (${OUTSIDER}, ${OTHER_HOUSEHOLD}, 'Other', 'Synthetic', ${EMAIL})`;
    await owner.$executeRaw`
      INSERT INTO mirror.client_account_aum
        (custodian_account_id, apex_account_number, client_sf_id, household_sf_id,
         account_type, account_status, source_present)
      VALUES (${ACCOUNT_A}, 'SYN1111', ${ANCHOR}, ${HOUSEHOLD}, 'Brokerage', 'OPEN', true),
             (${ACCOUNT_B}, 'SYN2222', ${PARTNER}, ${HOUSEHOLD}, 'IRA', 'CLOSED', false),
             (${ACCOUNT_OTHER}, 'SYN3333', ${OUTSIDER}, ${OTHER_HOUSEHOLD}, 'Brokerage', 'OPEN', true)`;
  });

  afterAll(async () => {
    await cleanup();
    await owner.$disconnect();
  });

  it("exercises the real non-superuser runtime role with forced row security", async () => {
    const roles = await withUserScope({ role: "OPERATIONS", email: EMAIL }, (tx) =>
      tx.$queryRaw<Array<{ current_role: string; rolsuper: boolean; rolbypassrls: boolean; relforcerowsecurity: boolean }>>`
        SELECT current_user AS current_role, role.rolsuper, role.rolbypassrls,
               relation.relforcerowsecurity
        FROM pg_roles role CROSS JOIN pg_class relation
        WHERE role.rolname = current_user
          AND relation.oid = 'app.operations_fee_request'::regclass`,
    );
    expect(roles).toEqual([{
      current_role: "app_rw", rolsuper: false, rolbypassrls: false, relforcerowsecurity: true,
    }]);
  });

  it("imports both approved same-content IDs as separate requests, including the closed account", async () => {
    await owner.operationsFeeRequest.create({ data: legacyData() });
    await owner.operationsFeeRequest.create({ data: legacyData({
      id: `${PREFIX}second`, legacy_source_id: "27",
    }) });
    const result = await operationsFeeRequestPageData({ role: "OPERATIONS", email: EMAIL });
    const rows = result.requests.filter((row) => row.id.startsWith(PREFIX));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      scope: "HOUSEHOLD", clientName: SOURCE_LABEL,
      canonicalClientName: "Adah Synthetic", householdName: "Synthetic Adah household",
      feeAmount: "1.00", status: "PENDING", reviewedBy: null, reviewedAt: null,
      accounts: [
        { id: ACCOUNT_A, label: "Brokerage · ••••1111", ownerName: "Adah Synthetic" },
        { id: ACCOUNT_B, label: "IRA · ••••2222", ownerName: "Morgan Synthetic" },
      ],
    });
    await expect(owner.operationsFeeRequest.create({ data: legacyData({
      id: `${PREFIX}repeated-source-key`,
    }) })).rejects.toThrow();
  });

  it("permits exactly the ten approved household source keys", async () => {
    for (const [source, ids] of [
      ["fee_store_fee_credits", ["26", "27", "31", "40"]],
      ["fee_store_billing_exceptions", ["8", "11", "15", "18", "20", "24"]],
    ] as const) {
      for (const id of ids) {
        await expect(owner.operationsFeeRequest.create({ data: legacyData({
          id: `${PREFIX}${source}-${id}`, legacy_source: source, legacy_source_id: id,
          ...(source === "fee_store_billing_exceptions" ? {
            kind: "BILLING_EXCEPTION", fee_types: [], fee_amount: null,
            waiver_start: new Date("2026-09-01T00:00:00Z"), waiver_duration_months: 3,
          } : {}),
        }) })).resolves.toMatchObject({ scope: "HOUSEHOLD" });
      }
    }
    await expect(owner.operationsFeeRequest.create({ data: legacyData({
      legacy_source_id: "28",
    }) })).rejects.toThrow();
  });

  it("accepts consistent Salesforce 15/18-character forms without changing account ownership", async () => {
    await expect(owner.operationsFeeRequest.create({ data: legacyData({
      client_sf_id: ANCHOR.slice(0, 15), legacy_household_sf_id: HOUSEHOLD.slice(0, 15),
    }) })).resolves.toMatchObject({ scope: "HOUSEHOLD", account_ids: [ACCOUNT_A, ACCOUNT_B] });
  });

  it.each([
    ["unknown household", { legacy_household_sf_id: "001SYN000000099AAA" }, "legacy_household_not_canonical"],
    ["outside contact anchor", { client_sf_id: OUTSIDER }, "legacy_client_not_in_household"],
    ["outside account owner", { account_ids: [ACCOUNT_A, ACCOUNT_OTHER] }, "legacy_account_not_in_household"],
    ["missing account", { account_ids: [ACCOUNT_A, `${PREFIX}missing`] }, "legacy_account_not_in_household"],
  ] as const)("fails closed on %s at the actual insert trigger", async (_name, overrides, error) => {
    await expect(owner.operationsFeeRequest.create({
      data: legacyData(overrides as Partial<Prisma.OperationsFeeRequestUncheckedCreateInput>),
    })).rejects.toThrow(error);
  });

  it("renders household context, source text, canonical anchor and every masked account owner", async () => {
    await owner.operationsFeeRequest.create({ data: legacyData() });
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    for (const text of [
      "Legacy source reference", "Synthetic Adah &amp; Morgan &lt;original reference&gt;",
      "Synthetic Adah household", "Canonical contact: Adah Synthetic",
      "Brokerage · ••••1111 · Adah Synthetic", "IRA · ••••2222 · Morgan Synthetic",
    ]) expect(html).toContain(text);
    expect(html).toMatch(/<details[^>]*><summary/);
    expect(html).not.toContain("SYN1111");
    expect(html).not.toContain("SYN2222");
    expect(html).not.toContain("<original reference>");
  });

  it.each(["ADMIN", "OPERATIONS"])("keeps %s live intake client-scoped, pending and authenticated", async (role) => {
    const id = await createOperationsFeeRequest({ role, email: EMAIL }, {
      kind: "BILLING_EXCEPTION", clientSfId: ANCHOR, accountIds: [ACCOUNT_A], feeTypes: [],
      feeAmount: null, waiverStart: "2026-10-01", waiverDurationMonths: 1,
      indefiniteDuration: false, reason: "Synthetic live intake", relevantTicketRefs: [],
    });
    const row = await owner.operationsFeeRequest.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      scope: "CLIENT", status: "PENDING", submitted_by_email: EMAIL,
      submitted_by_role: role, legacy_source: null, legacy_source_id: null,
      legacy_source_digest: null, legacy_client_name: null, legacy_household_sf_id: null,
      reviewed_by_email: null, reviewed_at: null,
    });
    await expect(createOperationsFeeRequest({ role, email: EMAIL }, {
      kind: "FEE_CREDIT", clientSfId: ANCHOR, accountIds: [ACCOUNT_A, ACCOUNT_B],
      feeTypes: ["Wire"], feeAmount: "1.00", waiverStart: null, waiverDurationMonths: null,
      indefiniteDuration: false, reason: "Synthetic cross-contact attempt", relevantTicketRefs: [],
    })).rejects.toThrow("account_unavailable");
  });

  it.each(["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"])(
    "never grants %s the direct legacy insert path", async (role) => {
      for (const scope of ["CLIENT", "HOUSEHOLD"] as const) {
        await expect(withUserScope({ role, email: EMAIL }, (tx) =>
          tx.operationsFeeRequest.create({ data: legacyData({
            scope, legacy_household_sf_id: scope === "CLIENT" ? null : HOUSEHOLD,
            account_ids: scope === "CLIENT" ? [ACCOUNT_A] : [ACCOUNT_A, ACCOUNT_B],
          }) }),
        )).rejects.toThrow();
      }
    },
  );

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER"])("keeps archived request data invisible to %s", async (role) => {
    await owner.operationsFeeRequest.create({ data: legacyData() });
    const result = await operationsFeeRequestPageData({ role, email: EMAIL });
    expect(result.requests).toEqual([]);
    expect(result.counts.total).toBe(0);
    authSpy.mockResolvedValue({ user: { role, email: EMAIL } });
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
  });

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER"])("rejects live creation from %s even with in-book client information", async (role) => {
    await expect(createOperationsFeeRequest({ role, email: EMAIL }, {
      kind: "FEE_CREDIT", clientSfId: ANCHOR, accountIds: [ACCOUNT_A],
      feeTypes: ["Wire"], feeAmount: "1.00", waiverStart: null, waiverDurationMonths: null,
      indefiniteDuration: false, reason: "Synthetic unauthorized request", relevantTicketRefs: [],
    })).rejects.toThrow();
  });

  it("rejects forged submitter identity, role, or self-approved status at the database policy", async () => {
    for (const forgery of [
      { submitted_by_email: "someone-else@example.test" },
      { submitted_by_role: "ADMIN" },
      { status: "APPROVED" as const },
    ]) {
      await expect(withUserScope({ role: "OPERATIONS", email: EMAIL }, (tx) =>
        tx.operationsFeeRequest.create({ data: legacyData({
          scope: "CLIENT", account_ids: [ACCOUNT_A], submitted_by_email: EMAIL,
          legacy_source: null, legacy_source_id: null, legacy_source_digest: null,
          legacy_household_sf_id: null, legacy_client_name: null, ...forgery,
        }) }),
      )).rejects.toThrow();
    }
  });

  it("allows a normal review transition but keeps legacy scope, source label and household immutable", async () => {
    const { id } = await owner.operationsFeeRequest.create({ data: legacyData() });
    for (const data of [
      { scope: "CLIENT" as const },
      { legacy_household_sf_id: OTHER_HOUSEHOLD },
      { legacy_client_name: "Rewritten source" },
    ]) {
      await expect(withUserScope({ role: "OPERATIONS", email: EMAIL }, (tx) =>
        tx.operationsFeeRequest.update({ where: { id }, data }),
      )).rejects.toThrow("permission denied");
      // Runtime column privileges reject first. Also prove the independent
      // trigger prevents an owner-level writer changing the archived scope.
      await expect(owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_role', 'OPERATIONS', true)`;
        await tx.$executeRaw`SELECT set_config('app.user_email', ${EMAIL}, true)`;
        return tx.operationsFeeRequest.update({ where: { id }, data });
      })).rejects.toThrow("operations_fee_request_payload_immutable");
    }
    await expect(transitionOperationsFeeRequest({ role: "OPERATIONS", email: EMAIL }, {
      requestId: id, action: "APPROVE", note: "Synthetic review",
      creditedDate: null, apexRequestId: null,
    })).resolves.toBe("updated");
    expect(await owner.operationsFeeRequest.findUnique({ where: { id } })).toMatchObject({
      scope: "HOUSEHOLD", legacy_household_sf_id: HOUSEHOLD,
      legacy_client_name: SOURCE_LABEL, status: "APPROVED", reviewed_by_email: EMAIL,
    });
  });
});
