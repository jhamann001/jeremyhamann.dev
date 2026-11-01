// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

import { DemoLimitError } from "../limits";
import { prismaStandInDeps } from "./prisma-deps";

// A database whose fee-store table holds `held` rows, run through one transaction.
function fakeDb(held: number) {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    demoFeeCreditRow: {
      count: vi.fn(async () => held),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 61, ...data })),
    },
  };
  return { db: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as PrismaClient, tx };
}

const row = {
  client_name: "Maeve Brennan", client_user_id: null, fee_type: "ACAT Transfer Fee", fee_amount: 95,
  account_numbers: "DEMO-191188", waiver_reason: null, submission_date: "2026-10-27T14:00:00Z", status: "Pending",
  apex_request: null, user_role: null,
};

describe("the fee store stand-in's rows in the public demo", () => {
  beforeEach(() => vi.stubEnv("PERSONA_SIGN_IN", "on"));
  afterEach(() => vi.unstubAllEnvs());

  it("adds a reimbursement under the cap, inside the cap's transaction", async () => {
    const { db, tx } = fakeDb(60);
    await expect(prismaStandInDeps(db).feeRows.create(row)).resolves.toMatchObject({ id: 61, client_name: "Maeve Brennan" });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
  });

  it("refuses one at the cap, as a 429 the stand-in passes on", async () => {
    const { db, tx } = fakeDb(300);
    const refused = await prismaStandInDeps(db).feeRows.create(row).catch((e) => e);
    expect(refused).toBeInstanceOf(DemoLimitError);
    expect(refused.status).toBe(429);
    expect(tx.demoFeeCreditRow.create).not.toHaveBeenCalled();
  });
});
