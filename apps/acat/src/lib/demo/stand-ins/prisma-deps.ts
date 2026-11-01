// The stand-ins' state in the app's own database: the fee store's rows and the Outbox.

import type { DemoFeeCreditRow, PrismaClient } from "@prisma/client";
import { holdDemoQuota } from "../limits";
import { recordOutbox } from "../outbox";
import { loadUniverse, type Universe } from "../universe";
import type { FeeStoreRow, StandInDeps } from "./server";

const toWire = (r: DemoFeeCreditRow): FeeStoreRow => ({
  id: r.id,
  client_name: r.clientName,
  client_user_id: r.clientUserId,
  fee_type: r.feeType,
  fee_amount: r.feeAmount,
  account_numbers: r.accountNumbers,
  waiver_reason: r.waiverReason,
  submission_date: r.submissionDate,
  status: r.status,
  apex_request: r.apexRequest,
  user_role: r.userRole,
});

export function prismaStandInDeps(prisma: PrismaClient): StandInDeps {
  let universe: Universe | null = null;
  return {
    universe: () => (universe ??= loadUniverse()),
    now: () => new Date(),
    recordOutbox: (entry) => recordOutbox(prisma, entry),
    feeRows: {
      async list(filter) {
        const rows = await prisma.demoFeeCreditRow.findMany({
          where: {
            ...(filter.client_name !== undefined ? { clientName: filter.client_name } : {}),
            ...(filter.account_numbers !== undefined ? { accountNumbers: filter.account_numbers } : {}),
          },
          orderBy: { id: "desc" },
          take: 200,
        });
        return rows.map(toWire);
      },
      async create(row) {
        const created = await prisma.$transaction(async (tx) => {
          await holdDemoQuota(tx, { feeCredits: 1 });
          return tx.demoFeeCreditRow.create({
            data: {
              clientName: row.client_name,
              clientUserId: row.client_user_id,
              feeType: row.fee_type,
              feeAmount: row.fee_amount,
              accountNumbers: row.account_numbers,
              waiverReason: row.waiver_reason,
              submissionDate: row.submission_date,
              status: row.status,
              apexRequest: row.apex_request,
              userRole: row.user_role,
            },
          });
        });
        return toWire(created);
      },
      async remove(id) {
        const existing = await prisma.demoFeeCreditRow.findUnique({ where: { id } });
        if (!existing) return null;
        await prisma.demoFeeCreditRow.delete({ where: { id } });
        return toWire(existing);
      },
    },
  };
}
