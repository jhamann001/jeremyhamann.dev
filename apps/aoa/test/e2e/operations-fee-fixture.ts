import { Prisma, type PrismaClient } from "@prisma/client";

export const FEE_HISTORY_CLIENT = "003BLO191836131AAA";
export const FEE_HISTORY_HOUSEHOLD = "001BLO191836131AAA";
export const FEE_HISTORY_ACCOUNT = "fee-history-synthetic-account";
export const feeHistoryId = (index: number) => `fee_history_synthetic_${String(index).padStart(4, "0")}`;
const IDS = Array.from({ length: 230 }, (_, index) => feeHistoryId(index + 1));
const EMAIL = "fee-paging-synthetic@example.test";

export async function cleanupFeeRequests(owner: PrismaClient) {
  await owner.auditLog.deleteMany({ where: { entityType: "operations_fee_request", entityId: { in: IDS } } });
  await owner.operationsSlackNotification.deleteMany({ where: { request_id: { in: IDS } } });
  await owner.operationsFeeRequestEvent.deleteMany({ where: { request_id: { in: IDS } } });
  await owner.operationsFeeRequest.deleteMany({ where: { id: { in: IDS } } });
  await owner.$executeRaw`DELETE FROM mirror.client_account_aum WHERE custodian_account_id = ${FEE_HISTORY_ACCOUNT}`;
  await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ${FEE_HISTORY_CLIENT}`;
  await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${FEE_HISTORY_HOUSEHOLD}`;
}

export async function seedFeeRequests(owner: PrismaClient) {
  await cleanupFeeRequests(owner);
  await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
    VALUES (${FEE_HISTORY_HOUSEHOLD}, 'Fee Paging Synthetic household', ${EMAIL})`;
  await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
    VALUES (${FEE_HISTORY_CLIENT}, ${FEE_HISTORY_HOUSEHOLD}, 'Fee Paging', 'Synthetic client', ${EMAIL})`;
  await owner.$executeRaw`INSERT INTO mirror.client_account_aum
    (custodian_account_id, apex_account_number, client_sf_id, household_sf_id, account_type, account_status, source_present)
    VALUES (${FEE_HISTORY_ACCOUNT}, 'SYNTHETIC0042', ${FEE_HISTORY_CLIENT}, ${FEE_HISTORY_HOUSEHOLD}, 'Brokerage', 'OPEN', true)`;
  const records: Prisma.OperationsFeeRequestCreateManyInput[] = IDS.map((id, offset) => {
    const index = offset + 1;
    const credit = index <= 215;
    const indefinite = index === 218;
    const status = credit ? index <= 200 ? "PENDING" : index <= 210 ? "APPROVED" : "CREDITED" : "PENDING";
    const kind = credit ? "FEE_CREDIT" : (["SERVICE_GUARANTEE", "BILLING_EXCEPTION", "LARGE_HOUSEHOLD_EXCEPTION"] as const)[index % 3];
    return {
      id, kind, status, client_sf_id: FEE_HISTORY_CLIENT, account_ids: [FEE_HISTORY_ACCOUNT],
      fee_types: credit ? ["Wire", "Transaction"] : [], fee_amount: credit ? `${index}.25` : null,
      waiver_start: credit ? null : new Date(index === 219 ? "2026-11-01T00:00:00Z" : "2026-09-01T00:00:00Z"),
      waiver_duration_months: credit || indefinite ? null : 3, indefinite_duration: indefinite,
      reason: "Synthetic request detail for paging verification", relevant_ticket_refs: ["SYNTHETIC-TICKET-42"],
      submitted_by_email: EMAIL, submitted_by_name: "Synthetic Operations", submitted_by_role: "OPERATIONS",
      submission_key: index === 1 ? "6fc31a81-ae16-4a1d-849b-7c69cb575a4d" : null,
      submission_digest: index === 1 ? "a".repeat(64) : null,
      submitted_at: new Date(index === 215 ? "2019-01-01T12:00:00Z" : "2026-09-17T12:00:00Z"),
      reviewed_by_email: status === "PENDING" ? null : EMAIL,
      reviewed_at: status === "PENDING" ? null : new Date("2026-09-17T13:00:00Z"),
      credited_at: status === "CREDITED" ? new Date("2026-09-17T00:00:00Z") : null,
      apex_request_id: status === "CREDITED" ? `SYNTHETIC-${index}` : null,
      completed_by_email: status === "CREDITED" ? EMAIL : null,
      completed_at: status === "CREDITED" ? new Date("2026-09-17T14:00:00Z") : null,
    };
  });
  await owner.operationsFeeRequest.createMany({ data: records });
  await owner.operationsFeeRequestEvent.createMany({ data: IDS.map((id) => ({
    request_id: id, action: "SUBMITTED", actor_email: EMAIL, actor_role: "OPERATIONS", to_status: "PENDING",
    detail: { note: "Synthetic audit note" }, at: new Date("2026-09-17T12:00:00Z"),
  })) });
  // Synthetic saved evidence only: delivery stays disabled in the browser app.
  const event = await owner.operationsFeeRequestEvent.findFirstOrThrow({
    where: { request_id: feeHistoryId(1), action: "SUBMITTED" },
  });
  await owner.operationsSlackNotification.create({ data: { request_id: feeHistoryId(1), event_id: event.id } });
}
