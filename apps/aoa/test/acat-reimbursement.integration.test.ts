import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import { markCase } from "./acat-book-flywheel";

vi.mock("server-only", () => ({}));

import {
  createReimbursementRequest,
  readPendingReimbursements,
  readReimbursementPrefill,
  readTransferFeeRequests,
} from "@/lib/data/acat-reimbursement";

// Runs only against the disposable loopback PostgreSQL the database job migrates (same gate as
// operations-fee-request-directory.integration.test.ts). Every row it writes belongs to the synthetic
// ids below and is deleted again; no tracker, Slack, or production system is involved.
const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const SUITE = "acat-reimbursement-integration";

const OPS = { role: "OPERATIONS", email: "reimbursement-synthetic@example.test" };
const ADVISOR = { role: "ADVISOR", email: "reimbursement-advisor-synthetic@example.test" };
const HOUSEHOLD = "001MPC385501240AAA";
const PAT = "003MPC385501240AAA";
const SAM = "003PUB862271316AAA";
const PAT_USER = "user-00000000-0000-4000-8000-00000000rmb1";
const ACCOUNTS = { patIra: "rmb-synthetic-acct-1", patBrokerage: "rmb-synthetic-acct-2", sam: "rmb-synthetic-acct-3" } as const;
const TRANSFERS = ["rmb-synthetic-transfer-1", "rmb-synthetic-transfer-2"] as const;
const KEYS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const CONFIRMED = {
  submissionKey: KEYS[0], clientSfId: PAT, accountId: ACCOUNTS.patIra, feeAmount: "50.00",
  feeTypes: ["ACAT out"], reason: "Synthetic reimbursement", tickets: "SYNTH-1",
};

gated("Reimbursement preview and confirm with actual PostgreSQL/RLS (ticket)", () => {
  let owner: PrismaClient;

  async function requestIds(): Promise<string[]> {
    const rows = await owner.operationsFeeRequest.findMany({
      where: { OR: [{ client_sf_id: { in: [PAT, SAM, PAT.slice(0, 15)] } }, { legacy_source: "fee_store_fee_credits", legacy_source_id: { startsWith: "rmb-synthetic" } }] },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async function cleanup() {
    const ids = await requestIds();
    await owner.auditLog.deleteMany({ where: { entityType: "operations_fee_request", entityId: { in: ids } } });
    await owner.operationsSlackNotification.deleteMany({ where: { request_id: { in: ids } } });
    await owner.operationsFeeRequestEvent.deleteMany({ where: { request_id: { in: ids } } });
    await owner.operationsFeeRequest.deleteMany({ where: { id: { in: ids } } });
    await owner.transfer.deleteMany({ where: { id: { in: [...TRANSFERS] } } });
    await owner.auditLog.deleteMany({ where: { entityType: "transfer", entityId: { in: [...TRANSFERS] } } });
    await owner.rowChange.deleteMany({ where: { schema_name: "app", table_name: "transfer", row_pk: { in: [...TRANSFERS] } } });
    await owner.$executeRaw`DELETE FROM mirror.client_account_aum WHERE custodian_account_id IN (${ACCOUNTS.patIra}, ${ACCOUNTS.patBrokerage}, ${ACCOUNTS.sam})`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id IN (${PAT}, ${SAM})`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${HOUSEHOLD}`;
  }

  async function seed() {
    await cleanup();
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      VALUES (${HOUSEHOLD}, 'Reimbursement Synthetic household', ${OPS.email})`;
    await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email, cedar_ridge_user_id)
      VALUES (${PAT}, ${HOUSEHOLD}, 'Pat', 'Reimbursement Synthetic', ${OPS.email}, ${PAT_USER}),
             (${SAM}, ${HOUSEHOLD}, 'Sam', 'Reimbursement Synthetic', ${OPS.email}, NULL)`;
    await owner.$executeRaw`INSERT INTO mirror.client_account_aum
      (custodian_account_id, apex_account_number, client_sf_id, household_sf_id, account_type, account_status, source_present)
      VALUES (${ACCOUNTS.patIra}, '5RB10ZHLK', ${PAT}, ${HOUSEHOLD}, 'IRA', 'OPEN', true),
             (${ACCOUNTS.patBrokerage}, '5RB20ZZZZ', ${PAT}, ${HOUSEHOLD}, 'Brokerage', 'OPEN', true),
             (${ACCOUNTS.sam}, '5RB30ZHLK', ${SAM}, ${HOUSEHOLD}, 'Roth', 'OPEN', true)`;
  }

  async function link(id: (typeof TRANSFERS)[number], recordId: string, clientSfId: string) {
    await owner.transfer.create({ data: {
      id, source: "APP", client_first_name: "ZZTEST", client_last_name: "Reimbursement Synthetic", client_sf_id: clientSfId,
      value: "1.00", stage: "DECISION", owner_kind: "OPERATIONS", acat_record_id: recordId,
      created_by: OPS.email, updated_by: OPS.email,
    } });
  }

  beforeAll(async () => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!url || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) throw new Error("Requires disposable loopback PostgreSQL");
    owner = new PrismaClient({ datasourceUrl: url });
  });
  beforeEach(async () => {
    vi.stubEnv("APP_ENV", "dev");
    await seed();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } });

  it("prefills the linked client and the one account ending with the masked suffix, from the real mirror", async () => {
    await link(TRANSFERS[0], "rmb-record-1", PAT);
    const prefill = await readReimbursementPrefill(OPS, { recordId: "rmb-record-1", cedarRidgeUserId: null, maskedAccount: "********ZHLK" });
    expect(prefill.clientSource).toBe("transfer-link");
    expect(prefill.client).toMatchObject({ clientSfId: PAT, name: "Pat Reimbursement Synthetic", householdName: "Reimbursement Synthetic household" });
    expect(prefill.accountId).toBe(ACCOUNTS.patIra);
    expect(prefill.client?.accounts.map((a) => [a.id, a.label, a.matchesTransfer])).toEqual([
      [ACCOUNTS.patBrokerage, "Brokerage · ••••ZZZZ", false], [ACCOUNTS.patIra, "IRA · ••••ZHLK", true],
    ]);
    expect(prefill.pending).toEqual([]);
    markCase(SUITE, "prefills the linked client and the one account ending with the masked suffix, from the real mirror", "integration");
  });

  it("falls back to the Cedar Ridge user id, ignores another client's account with the same suffix, and chooses nothing on a conflict", async () => {
    const byUser = await readReimbursementPrefill(OPS, { recordId: "rmb-record-none", cedarRidgeUserId: PAT_USER, maskedAccount: "********ZHLK" });
    expect(byUser).toMatchObject({ clientSource: "directory", accountId: ACCOUNTS.patIra });
    expect(byUser.client?.accounts.map((a) => a.id)).not.toContain(ACCOUNTS.sam);
    await link(TRANSFERS[1], "rmb-record-2", SAM);
    expect(await readReimbursementPrefill(OPS, { recordId: "rmb-record-2", cedarRidgeUserId: PAT_USER, maskedAccount: "********ZHLK" }))
      .toEqual({ client: null, clientSource: "conflict", accountId: null, pending: [] });
    expect(await readReimbursementPrefill(OPS, { recordId: "rmb-record-unlinked", cedarRidgeUserId: null, maskedAccount: "********ZHLK" }))
      .toEqual({ client: null, clientSource: "none", accountId: null, pending: [] });
    markCase(SUITE, "falls back to the Cedar Ridge user id, ignores another client's account with the same suffix, and chooses nothing on a conflict", "integration");
  });

  it("creates one Pending request for the confirmed client and account, once per submission key", async () => {
    const first = await createReimbursementRequest(OPS, CONFIRMED);
    expect(first).toMatchObject({ ok: true, request: { status: "PENDING", clientName: "Pat Reimbursement Synthetic", accountLabel: "IRA · ••••ZHLK", feeAmount: "50.00", feeTypes: ["ACAT out"] } });
    const id = first.ok ? first.request.id : "";
    const row = await owner.operationsFeeRequest.findUniqueOrThrow({ where: { id }, include: { events: true } });
    expect(row).toMatchObject({
      kind: "FEE_CREDIT", status: "PENDING", client_sf_id: PAT, account_ids: [ACCOUNTS.patIra], fee_types: ["ACAT out"],
      relevant_ticket_refs: ["SYNTH-1"], reason: "Synthetic reimbursement", submitted_by_email: OPS.email, submitted_by_role: "OPERATIONS",
    });
    expect(row.fee_amount?.toFixed(2)).toBe("50.00");
    expect(row.events.map((event) => [event.action, event.to_status])).toEqual([["SUBMITTED", "PENDING"]]);

    const replay = await createReimbursementRequest(OPS, CONFIRMED);
    expect(replay).toMatchObject({ ok: true, request: { id } });
    expect(await requestIds()).toHaveLength(1);

    expect(await createReimbursementRequest(OPS, { ...CONFIRMED, feeAmount: "60.00" })).toEqual({ ok: false, code: "conflict", field: null });
    expect(await requestIds()).toHaveLength(1);
    markCase(SUITE, "creates one Pending request for the confirmed client and account, once per submission key", "integration");
  });

  it("shows an existing Pending request on the preview and still creates another under a new key", async () => {
    await link(TRANSFERS[0], "rmb-record-1", PAT);
    await createReimbursementRequest(OPS, CONFIRMED);
    const preview = await readReimbursementPrefill(OPS, { recordId: "rmb-record-1", cedarRidgeUserId: null, maskedAccount: "********ZHLK" });
    expect(preview.pending).toHaveLength(1);
    expect(preview.pending[0]).toMatchObject({ feeAmount: "50.00", feeTypes: ["ACAT out"] });
    expect(await readPendingReimbursements(OPS, PAT, ACCOUNTS.patBrokerage)).toEqual([]);
    const second = await createReimbursementRequest(OPS, { ...CONFIRMED, submissionKey: KEYS[1] });
    expect(second.ok).toBe(true);
    expect(await requestIds()).toHaveLength(2);
    expect(await readPendingReimbursements(OPS, PAT, ACCOUNTS.patIra)).toHaveLength(2);
    markCase(SUITE, "shows an existing Pending request on the preview and still creates another under a new key", "integration");
  });

  it("writes nothing for an account the client does not own, an unknown client, or a name in place of an id", async () => {
    expect(await createReimbursementRequest(OPS, { ...CONFIRMED, accountId: ACCOUNTS.sam })).toEqual({ ok: false, code: "identity", field: null });
    expect(await createReimbursementRequest(OPS, { ...CONFIRMED, clientSfId: "003LIW625180347AAA" })).toEqual({ ok: false, code: "identity", field: null });
    expect(await createReimbursementRequest(OPS, { ...CONFIRMED, clientSfId: "Pat Reimbursement Synthetic" })).toMatchObject({ ok: false, code: "invalid", field: "client" });
    expect(await createReimbursementRequest(OPS, { ...CONFIRMED, accountId: "" })).toMatchObject({ ok: false, code: "invalid", field: "account" });
    expect(await requestIds()).toHaveLength(0);
    markCase(SUITE, "writes nothing for an account the client does not own, an unknown client, or a name in place of an id", "integration");
  });

  it("row-level security keeps every other role from creating or reading", async () => {
    expect(await createReimbursementRequest(ADVISOR, { ...CONFIRMED, submissionKey: KEYS[2] })).toEqual({ ok: false, code: "forbidden", field: null });
    expect(await requestIds()).toHaveLength(0);
    await createReimbursementRequest(OPS, CONFIRMED);
    expect(await readPendingReimbursements(ADVISOR, PAT, ACCOUNTS.patIra)).toEqual([]);
    expect((await readReimbursementPrefill(ADVISOR, { recordId: "rmb-record-1", cedarRidgeUserId: PAT_USER, maskedAccount: "********ZHLK" })).pending).toEqual([]);
    markCase(SUITE, "row-level security keeps every other role from creating or reading", "integration");
  });
  it("lists every request of every kind on file for the client and account in every status, migrated and new, and nothing for another account or client (ticket)", async () => {
    await link(TRANSFERS[0], "rmb-record-1", PAT);
    const created = await createReimbursementRequest(OPS, CONFIRMED);
    const newId = created.ok ? created.request.id : "";
    await createReimbursementRequest(OPS, { ...CONFIRMED, submissionKey: KEYS[1], accountId: ACCOUNTS.patBrokerage });
    await owner.operationsFeeRequest.create({ data: {
      kind: "FEE_CREDIT", status: "CREDITED", client_sf_id: PAT.slice(0, 15), account_ids: [ACCOUNTS.patIra], fee_types: ["ACAT in"],
      fee_amount: "25.00", reason: "", submitted_by_role: "OPERATIONS", submitted_at: new Date("2026-09-01T12:00:00Z"),
      credited_at: new Date("2026-09-03T00:00:00Z"), apex_request_id: "APX-SYNTH-1", completed_at: new Date("2026-09-03T12:00:00Z"),
      legacy_source_digest: "0".repeat(64), legacy_client_name: "Synthetic Legacy Client", legacy_source: "fee_store_fee_credits", legacy_source_id: "rmb-synthetic-1",
    } });
    for (const [status, ticket] of [["REJECTED", "rmb-synthetic-2"], ["CANCELLED", "rmb-synthetic-3"], ["APPROVED", "rmb-synthetic-4"]] as const) {
      await owner.operationsFeeRequest.create({ data: {
        kind: "FEE_CREDIT", status, client_sf_id: PAT, account_ids: [ACCOUNTS.patIra], fee_types: ["ACAT out"], fee_amount: "10.00",
        reason: "", submitted_by_role: "OPERATIONS", submitted_at: new Date("2026-09-02T12:00:00Z"), legacy_source_digest: "0".repeat(64), legacy_client_name: "Synthetic Legacy Client", legacy_source: "fee_store_fee_credits", legacy_source_id: ticket,
      } });
    }
    await owner.operationsFeeRequest.create({ data: {
      kind: "FEE_CREDIT", status: "PENDING", client_sf_id: SAM, account_ids: [ACCOUNTS.sam], fee_types: ["ACAT out"], fee_amount: "99.00",
      reason: "", submitted_by_role: "OPERATIONS", legacy_source_digest: "0".repeat(64), legacy_client_name: "Synthetic Legacy Client", legacy_source: "fee_store_fee_credits", legacy_source_id: "rmb-synthetic-5",
    } });
    await owner.operationsFeeRequest.create({ data: {
      kind: "SERVICE_GUARANTEE", status: "PENDING", client_sf_id: PAT, account_ids: [ACCOUNTS.patIra], fee_types: [], reason: "Synthetic waiver",
      waiver_start: new Date("2026-09-01T00:00:00Z"), waiver_duration_months: 3,
      submitted_by_role: "OPERATIONS", legacy_source_digest: "0".repeat(64), legacy_client_name: "Synthetic Legacy Client", legacy_source: "fee_store_fee_credits", legacy_source_id: "rmb-synthetic-6",
    } });
    const read = await readTransferFeeRequests(OPS, { recordId: "rmb-record-1", cedarRidgeUserId: null, maskedAccount: "********ZHLK" });
    expect(read).toMatchObject({ identity: "resolved", clientName: "Pat Reimbursement Synthetic", accountLabel: "IRA · ••••ZHLK", truncated: false });
    const requests = read.identity === "resolved" ? read.requests : [];
    expect(requests.map((r) => r.status).sort()).toEqual(["APPROVED", "CANCELLED", "CREDITED", "PENDING", "PENDING", "REJECTED"]);
    expect(requests.map((r) => r.kind).filter((kind) => kind !== "FEE_CREDIT")).toEqual(["SERVICE_GUARANTEE"]);
    expect(requests.find((r) => r.id === newId)).toMatchObject({ status: "PENDING", feeAmount: "50.00", feeTypes: ["ACAT out"] });
    expect(requests.find((r) => r.status === "CREDITED")).toMatchObject({ feeAmount: "25.00", feeTypes: ["ACAT in"], creditedAt: "2026-09-03T00:00:00.000Z" });
    expect(requests.map((r) => r.submittedAt)).toEqual([...requests.map((r) => r.submittedAt)].sort().reverse());
    expect(Object.keys(requests[0]).sort()).toEqual(["creditedAt", "feeAmount", "feeTypes", "id", "kind", "status", "submittedAt"]);
    markCase(SUITE, "lists every request of every kind on file for the client and account in every status, migrated and new, and nothing for another account or client (ticket)", "integration");
  });

  it("reads nothing for a transfer it cannot tie to one client and account, and row-level security keeps other roles out (ticket)", async () => {
    await createReimbursementRequest(OPS, CONFIRMED);
    expect(await readTransferFeeRequests(OPS, { recordId: "rmb-record-unlinked", cedarRidgeUserId: null, maskedAccount: "********ZHLK" }))
      .toEqual({ identity: "unresolved", reason: "client" });
    expect(await readTransferFeeRequests(OPS, { recordId: "rmb-record-none", cedarRidgeUserId: PAT_USER, maskedAccount: "********QQQQ" }))
      .toEqual({ identity: "unresolved", reason: "account" });
    const asAdvisor = await readTransferFeeRequests(ADVISOR, { recordId: "rmb-record-none", cedarRidgeUserId: PAT_USER, maskedAccount: "********ZHLK" });
    expect(asAdvisor.identity === "resolved" ? asAdvisor.requests : []).toEqual([]);
    // The advisor cannot resolve the client above, so the request table itself is probed under each scope.
    const visible = (identity: typeof OPS) => withUserScope(identity, (tx) => tx.operationsFeeRequest.count({ where: { client_sf_id: PAT } }));
    expect(await visible(OPS)).toBe(1);
    expect(await visible(ADVISOR)).toBe(0);
    markCase(SUITE, "reads nothing for a transfer it cannot tie to one client and account, and row-level security keeps other roles out (ticket)", "integration");
  });
});
