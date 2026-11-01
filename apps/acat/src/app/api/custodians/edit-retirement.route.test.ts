import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

const { verifyCustodianAdminCaller, rateLimit, mockAuth } = vi.hoisted(() => ({
  verifyCustodianAdminCaller: vi.fn(),
  rateLimit: vi.fn(),
  mockAuth: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));
vi.mock("@/lib/machine-auth", () => ({ verifyCustodianAdminCaller }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
vi.mock("@/lib/rate-limit-redis", () => ({ rateLimit }));
vi.mock("@/lib/custodian-timing-data", () => ({
  loadObservedCustodianTimings: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { POST as createCustodian } from "./route";
import { PATCH as patchCustodian, DELETE as deleteCustodian } from "./[id]/route";
import { POST as mergeCustodian } from "./[id]/merge/route";
import { POST as createFee } from "./[id]/fees/route";
import { PATCH as patchFee, DELETE as deleteFee } from "./[id]/fees/[feeId]/route";
import { POST as machineCreate } from "../machine/custodians/admin/route";
import { PATCH as machinePatch } from "../machine/custodians/admin/[id]/route";
import { POST as machineMerge } from "../machine/custodians/admin/[id]/merge/route";
import { POST as machineCreateFee } from "../machine/custodians/admin/[id]/fees/route";
import {
  PATCH as machinePatchFee,
  DELETE as machineDeleteFee,
} from "../machine/custodians/admin/[id]/fees/[feeId]/route";

const SWITCH = "ENFORCE_CUSTODIAN_TRACKER_READ_ONLY";
const idParams = { params: Promise.resolve({ id: "c1" }) };
const feeParams = { params: Promise.resolve({ id: "c1", feeId: "f1" }) };

function jsonRequest(url: string, method: string) {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-acting-user-email": "admin@example.test",
    },
    body: JSON.stringify({}),
  });
}

function enableAdminPaths(role: "ADMIN" | "USER") {
  vi.stubEnv("EPIC_ACAT_CUSTODIAN_ADMIN", "1");
  vi.stubEnv("ROLLOUT_ACAT_CUSTODIAN_ADMIN", "1");
  mockAuth.mockResolvedValue({ user: { email: "admin@example.test", role } });
  vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue(
    { role, active: true } as Awaited<ReturnType<typeof prisma.allowedUser.findUnique>>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(SWITCH, "0");
  vi.stubEnv("ENFORCE_CUSTODIAN_TRACKER_PROJECTION", "0");
  vi.stubEnv("EPIC_ACAT_CUSTODIAN_ADMIN", "0");
  vi.stubEnv("ROLLOUT_ACAT_CUSTODIAN_ADMIN", "0");
  mockAuth.mockResolvedValue(null);
  verifyCustodianAdminCaller.mockResolvedValue({ email: "sa@example.test" });
  rateLimit.mockResolvedValue({ allowed: true });
});
afterEach(() => vi.unstubAllEnvs());

describe("custodian edit retirement", () => {
  it("retirement switch on refuses every old custodian mutation after the admin check and before a write", async () => {
    vi.stubEnv(SWITCH, "1");
    enableAdminPaths("ADMIN");
    const calls = [
      createCustodian(jsonRequest("https://tracker.test/api/custodians", "POST") as Parameters<typeof createCustodian>[0]),
      patchCustodian(jsonRequest("https://tracker.test/api/custodians/c1", "PATCH") as Parameters<typeof patchCustodian>[0], idParams),
      deleteCustodian(jsonRequest("https://tracker.test/api/custodians/c1", "DELETE") as Parameters<typeof deleteCustodian>[0], idParams),
      mergeCustodian(jsonRequest("https://tracker.test/api/custodians/c1/merge", "POST") as Parameters<typeof mergeCustodian>[0], idParams),
      createFee(jsonRequest("https://tracker.test/api/custodians/c1/fees", "POST") as Parameters<typeof createFee>[0], idParams),
      patchFee(jsonRequest("https://tracker.test/api/custodians/c1/fees/f1", "PATCH") as Parameters<typeof patchFee>[0], feeParams),
      deleteFee(jsonRequest("https://tracker.test/api/custodians/c1/fees/f1", "DELETE") as Parameters<typeof deleteFee>[0], feeParams),
      machineCreate(jsonRequest("https://tracker.test/api/machine/custodians/admin", "POST")),
      machinePatch(jsonRequest("https://tracker.test/api/machine/custodians/admin/c1", "PATCH"), idParams),
      machineMerge(jsonRequest("https://tracker.test/api/machine/custodians/admin/c1/merge", "POST"), idParams),
      machineCreateFee(jsonRequest("https://tracker.test/api/machine/custodians/admin/c1/fees", "POST"), idParams),
      machinePatchFee(jsonRequest("https://tracker.test/api/machine/custodians/admin/c1/fees/f1", "PATCH"), feeParams),
      machineDeleteFee(jsonRequest("https://tracker.test/api/machine/custodians/admin/c1/fees/f1", "DELETE"), feeParams),
    ];
    const responses = await Promise.all(calls);
    expect(responses).toHaveLength(13);
    for (const response of responses) {
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: "custodian_edits_retired" });
    }
    expect(mockAuth).toHaveBeenCalledTimes(7);
    expect(verifyCustodianAdminCaller).toHaveBeenCalledTimes(6);
    for (const write of [
      prisma.custodian.upsert,
      prisma.custodian.update,
      prisma.custodian.delete,
      prisma.custodianFee.create,
      prisma.custodianFee.update,
      prisma.custodianFee.delete,
      prisma.$transaction,
    ]) {
      expect(write).not.toHaveBeenCalled();
    }
    markCase(
      "custodian-edit-retirement",
      "retirement switch on refuses every old custodian mutation after the admin check and before a write",
    );
  });

  it("retirement switch on still answers a non-admin with the existing 403", async () => {
    vi.stubEnv(SWITCH, "1");
    enableAdminPaths("USER");
    const browser = await patchCustodian(
      jsonRequest("https://tracker.test/api/custodians/c1", "PATCH") as Parameters<typeof patchCustodian>[0],
      idParams,
    );
    expect(browser.status).toBe(403);
    expect(await browser.json()).toEqual({ error: "Forbidden" });
    const machine = await machinePatch(
      jsonRequest("https://tracker.test/api/machine/custodians/admin/c1", "PATCH"),
      idParams,
    );
    expect(machine.status).toBe(403);
    expect(await machine.json()).toEqual({ error: "forbidden" });
    expect(prisma.custodian.update).not.toHaveBeenCalled();
    markCase(
      "custodian-edit-retirement",
      "retirement switch on still answers a non-admin with the existing 403",
    );
  });

  it("authorized browser create writes when the retirement switch is unset or 0 and returns 405 when it is 1", async () => {
    enableAdminPaths("ADMIN");
    vi.mocked(prisma.custodian.upsert).mockResolvedValue({
      id: "CUST-999",
      name: "Raymond James",
      reviewStatus: "VERIFIED",
    } as Awaited<ReturnType<typeof prisma.custodian.upsert>>);
    const request = () =>
      createCustodian(
        new Request("https://tracker.test/api/custodians", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Raymond James" }),
        }) as Parameters<typeof createCustodian>[0],
      );
    const upsertArgs = {
      where: { name: "Raymond James" },
      update: { reviewStatus: "VERIFIED" },
      create: { name: "Raymond James", reviewStatus: "VERIFIED" },
    };

    vi.stubEnv(SWITCH, undefined);
    const unsetResponse = await request();
    expect(unsetResponse.status).toBe(201);
    expect(await unsetResponse.json()).toMatchObject({ id: "CUST-999", name: "Raymond James" });
    expect(prisma.custodian.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.custodian.upsert).toHaveBeenCalledWith(upsertArgs);

    vi.stubEnv(SWITCH, "0");
    const offResponse = await request();
    expect(offResponse.status).toBe(201);
    expect(prisma.custodian.upsert).toHaveBeenCalledTimes(2);

    vi.stubEnv(SWITCH, "1");
    const onResponse = await request();
    expect(onResponse.status).toBe(405);
    expect(await onResponse.json()).toEqual({ error: "custodian_edits_retired" });
    expect(prisma.custodian.upsert).toHaveBeenCalledTimes(2);
    markCase(
      "custodian-edit-retirement",
      "authorized browser create writes when the retirement switch is unset or 0 and returns 405 when it is 1",
    );
  });

  it("retirement switch off keeps machine create on the current not_found path", async () => {
    const response = await machineCreate(
      jsonRequest("https://tracker.test/api/machine/custodians/admin", "POST"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(prisma.custodian.upsert).not.toHaveBeenCalled();
    markCase(
      "custodian-edit-retirement",
      "retirement switch off keeps machine create on the current not_found path",
    );
  });

  it("retirement switch off keeps signed-out browser create on the current 401 path", async () => {
    const response = await createCustodian(
      jsonRequest("https://tracker.test/api/custodians", "POST") as Parameters<typeof createCustodian>[0],
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(prisma.custodian.upsert).not.toHaveBeenCalled();
    markCase(
      "custodian-edit-retirement",
      "retirement switch off keeps signed-out browser create on the current 401 path",
    );
  });
});
