import { beforeEach, describe, expect, it } from "vitest";
import { markCase } from "@/lib/test-flywheel";
import {
  applyCustodianProjection,
  custodianEditBlockedResponse,
  custodianRevisionChecksum,
} from "@/lib/custodian-admin";

type CustodianRow = { id: string; name: string; projectionRevision: number | null };
type FeeRow = { id: string; custodianId: string };
type RecordRow = {
  id: string;
  custodianId: string | null;
  custodianName: string | null;
  transferringContra: string | null;
};
type AuditRow = { acatRecordId: string; action: string };
type ReceiptRow = { revision: number; bodySha256: string };
type Mem = {
  custodians: CustodianRow[];
  fees: FeeRow[];
  records: RecordRow[];
  audits: AuditRow[];
  receipts: ReceiptRow[];
  appliedRevision: number;
  statePresent: boolean;
};

function memory(): Mem {
  return {
    custodians: [],
    fees: [],
    records: [],
    audits: [],
    receipts: [],
    appliedRevision: 0,
    statePresent: true,
  };
}

function txFor(mem: Mem) {
  return {
    $queryRaw: async () => (mem.statePresent ? [{ id: 1 }] : []),
    custodianProjectionState: {
      findUnique: async () => (mem.statePresent ? { id: 1, appliedRevision: mem.appliedRevision } : null),
      update: async ({ data }: { data: { appliedRevision: number } }) => {
        mem.appliedRevision = data.appliedRevision;
        return { id: 1, appliedRevision: mem.appliedRevision };
      },
    },
    custodianProjectionReceipt: {
      findUnique: async ({ where }: { where: { revision: number } }) =>
        mem.receipts.find((receipt) => receipt.revision === where.revision) ?? null,
      create: async ({ data }: { data: ReceiptRow }) => {
        mem.receipts.push({ revision: data.revision, bodySha256: data.bodySha256 });
        return data;
      },
    },
    custodian: {
      upsert: async ({
        where, create, update,
      }: {
        where: { id: string };
        create: CustodianRow;
        update: { name: string; projectionRevision: number | null };
      }) => {
        const existing = mem.custodians.find((row) => row.id === where.id);
        if (!existing) {
          const created = { id: create.id, name: create.name, projectionRevision: create.projectionRevision };
          mem.custodians.push(created);
          return created;
        }
        existing.name = update.name;
        existing.projectionRevision = update.projectionRevision;
        return existing;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        mem.custodians.find((row) => row.id === where.id) ?? null,
      delete: async ({ where }: { where: { id: string } }) => {
        mem.custodians = mem.custodians.filter((row) => row.id !== where.id);
      },
    },
    custodianFee: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        mem.fees.find((fee) => fee.id === where.id) ?? null,
      upsert: async ({
        where, create,
      }: {
        where: { id: string };
        create: FeeRow;
        update: Record<string, unknown>;
      }) => {
        const existing = mem.fees.find((fee) => fee.id === where.id);
        if (!existing) {
          mem.fees.push({ id: create.id, custodianId: create.custodianId });
          return create;
        }
        return existing;
      },
      deleteMany: async ({ where }: { where: { custodianId: string; id?: { notIn: string[] } } }) => {
        const removed = mem.fees.filter((fee) => {
          if (fee.custodianId !== where.custodianId) return false;
          if (where.id?.notIn) return !where.id.notIn.includes(fee.id);
          return true;
        });
        mem.fees = mem.fees.filter((fee) => !removed.includes(fee));
        return { count: removed.length };
      },
    },
    acatRecord: {
      findMany: async ({ where }: { where: { custodianId: string } }) =>
        mem.records.filter((record) => record.custodianId === where.custodianId),
      updateMany: async ({
        where, data,
      }: {
        where: { custodianId: string };
        data: { custodianId: string; custodianName: string; transferringContra: string };
      }) => {
        let count = 0;
        for (const record of mem.records) {
          if (record.custodianId !== where.custodianId) continue;
          record.custodianId = data.custodianId;
          record.custodianName = data.custodianName;
          record.transferringContra = data.transferringContra;
          count += 1;
        }
        return { count };
      },
    },
    auditLog: {
      createMany: async ({ data }: { data: AuditRow[] }) => {
        mem.audits.push(...data.map((row) => ({ acatRecordId: row.acatRecordId, action: row.action })));
        return { count: data.length };
      },
    },
    custodianFeeScheduleDocument: {
      updateMany: async () => ({ count: 0 }),
    },
  };
}

function saveBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "cust-1",
    name: "Hash One",
    acat_fee_amount: 0,
    avg_processing_days: 7,
    contact_email: null,
    contact_method: "EMAIL",
    contact_details: null,
    review_status: "VERIFIED",
    transfer_type: "ACAT_API",
    documentation_status: "DOCUMENTED",
    dtc_number: "9999",
    receiving_account_number: null,
    signature: "Required",
    letter_of_acceptance: null,
    medallion_required: null,
    liquidation_method: null,
    return_method: null,
    watchouts: null,
    paperwork_on_file: true,
    transfers_to_date: 0,
    merged_into_id: null,
    retired_at: null,
    revision: "1",
    created_at: "2026-10-20T00:00:00.000Z",
    updated_at: "2026-10-20T00:00:00.000Z",
    fee_rules: [],
    ...overrides,
  };
}

async function deliver(
  mem: Mem,
  revision: number,
  previousRevision: number | null,
  body: unknown,
  checksum = custodianRevisionChecksum(body),
) {
  return applyCustodianProjection(txFor(mem) as never, { revision, previousRevision, checksum, body });
}

beforeEach(() => {
  delete process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION;
});

describe("custodian projection receipt", () => {
  it("revision 1 accepts once and advances the stored revision", async () => {
    markCase("custodian-projection", "revision 1 accepts once and advances the stored revision");
    const mem = memory();
    const result = await deliver(mem, 1, null, saveBody());
    expect(result).toEqual({ outcome: "accepted", revision: 1, movedTransfers: 0 });
    expect(mem.appliedRevision).toBe(1);
    expect(mem.receipts).toHaveLength(1);
  });

  it("the same head checksum is a duplicate and does not write again", async () => {
    markCase("custodian-projection", "the same head checksum is a duplicate and does not write again");
    const mem = memory();
    const body = saveBody();
    await deliver(mem, 1, null, body);
    const before = structuredClone(mem);
    const result = await deliver(mem, 1, null, body);
    expect(result).toEqual({ outcome: "duplicate", revision: 1 });
    expect(mem).toEqual(before);
    expect(mem.receipts).toHaveLength(1);
  });

  it("an earlier matching revision is a duplicate and leaves the head in place", async () => {
    markCase("custodian-projection", "an earlier matching revision is a duplicate and leaves the head in place");
    const mem = memory();
    const first = saveBody();
    await deliver(mem, 1, null, first);
    await deliver(mem, 2, 1, saveBody({ id: "cust-2", name: "Hash Two", revision: "2" }));
    const result = await deliver(mem, 1, null, first);
    expect(result).toEqual({ outcome: "duplicate", revision: 1 });
    expect(mem.appliedRevision).toBe(2);
  });

  it("a skipped revision is a gap and leaves the stored revision in place", async () => {
    markCase("custodian-projection", "a skipped revision is a gap and leaves the stored revision in place");
    const mem = memory();
    const result = await deliver(mem, 3, null, saveBody());
    expect(result).toEqual({ outcome: "rejected", revision: 3, reason: "gap" });
    expect(mem.appliedRevision).toBe(0);
    expect(mem.receipts).toHaveLength(0);
  });

  it("a previousRevision that is not the stored revision is a gap", async () => {
    markCase("custodian-projection", "a previousRevision that is not the stored revision is a gap");
    const mem = memory();
    await deliver(mem, 1, null, saveBody());
    const result = await deliver(mem, 2, 0, saveBody({ id: "cust-2", name: "Hash Two", revision: "2" }));
    expect(result).toEqual({ outcome: "rejected", revision: 2, reason: "gap" });
    expect(mem.appliedRevision).toBe(1);
  });

  it("a checksum that is not the canonical body hash is a mismatch", async () => {
    markCase("custodian-projection", "a checksum that is not the canonical body hash is a mismatch");
    const mem = memory();
    const result = await deliver(
      mem, 1, null, { a: 1 }, "0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(result).toEqual({ outcome: "rejected", revision: 1, reason: "mismatch" });
    expect(mem.appliedRevision).toBe(0);
    expect(custodianRevisionChecksum({ a: 1 })).toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
  });

  it("a merge keeps both transfers on the survivor and writes two audits", async () => {
    markCase("custodian-projection", "a merge keeps both transfers on the survivor and writes two audits");
    const mem = memory();
    mem.custodians.push({ id: "cust-source", name: "Source", projectionRevision: null });
    mem.records.push(
      { id: "r1", custodianId: "cust-source", custodianName: "Source", transferringContra: "Source" },
      { id: "r2", custodianId: "cust-source", custodianName: "Source", transferringContra: "Source" },
    );
    const body = {
      source: { id: "cust-source", name: "Source" },
      target: saveBody({ id: "cust-survivor", name: "Survivor" }),
    };
    const result = await deliver(mem, 1, null, body);
    expect(result).toMatchObject({ outcome: "accepted", revision: 1, movedTransfers: 2 });
    expect(mem.records.map((record) => record.custodianId)).toEqual(["cust-survivor", "cust-survivor"]);
    expect(mem.audits.filter((audit) => audit.action === "custodian-merge")).toHaveLength(2);
  });

  it("the edit gate is open while the switch is off", () => {
    markCase("custodian-projection", "the edit gate is open while the switch is off");
    expect(custodianEditBlockedResponse()).toBeNull();
  });

  it("the edit gate refuses while the switch is on", async () => {
    markCase("custodian-projection", "the edit gate refuses while the switch is on");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    const response = custodianEditBlockedResponse();
    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({ error: "custodian_authority_active" });
  });

  it("a stored revision delivered under a different hash is a mismatch", async () => {
    markCase("custodian-projection", "a stored revision delivered under a different hash is a mismatch");
    const mem = memory();
    const first = {
      id: "cust-hash-1",
      name: "Hash One",
      acat_fee_amount: 0,
      avg_processing_days: 7,
      contact_email: null,
      contact_method: "EMAIL",
      contact_details: null,
      review_status: "VERIFIED",
      transfer_type: "ACAT_API",
      documentation_status: "DOCUMENTED",
      dtc_number: "9999",
      receiving_account_number: null,
      signature: "Required",
      letter_of_acceptance: null,
      medallion_required: null,
      liquidation_method: null,
      return_method: null,
      watchouts: null,
      paperwork_on_file: true,
      transfers_to_date: 0,
      merged_into_id: null,
      retired_at: null,
      revision: "1",
      created_at: "2026-10-20T00:00:00.000Z",
      updated_at: "2026-10-20T00:00:00.000Z",
      fee_rules: [],
    };
    const firstChecksum = custodianRevisionChecksum(first);
    const accepted = await deliver(mem, 1, null, first, firstChecksum);
    expect(accepted).toMatchObject({ outcome: "accepted", revision: 1 });
    expect(mem.appliedRevision).toBe(1);
    expect(mem.receipts).toEqual([{ revision: 1, bodySha256: firstChecksum }]);
    const second = { ...first, name: "Hash Two", signature: "Revised" };
    const rejected = await deliver(mem, 1, null, second, custodianRevisionChecksum(second));
    expect(rejected).toEqual({ outcome: "rejected", revision: 1, reason: "mismatch" });
    expect(mem.appliedRevision).toBe(1);
    expect(mem.receipts).toEqual([{ revision: 1, bodySha256: firstChecksum }]);
  });
});
