import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

const { applyCustodianProjection, verifyCustodianProjectionCaller, rateLimit } = vi.hoisted(() => ({
  applyCustodianProjection: vi.fn(),
  verifyCustodianProjectionCaller: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/custodian-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/custodian-admin")>("@/lib/custodian-admin");
  return { ...actual, applyCustodianProjection };
});
vi.mock("@/lib/machine-auth", () => ({ verifyCustodianProjectionCaller }));
vi.mock("@/lib/rate-limit-redis", () => ({ rateLimit }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

import { POST } from "./route";

const PROD = "ops-portal-run@ops-portal.iam.gserviceaccount.com";

function post(body: unknown) {
  return POST(new Request("https://tracker.test/api/machine/custodians/projection", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer synthetic" },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION;
  rateLimit.mockResolvedValue({ allowed: true });
  verifyCustodianProjectionCaller.mockResolvedValue({ email: PROD });
});

describe("POST /api/machine/custodians/projection", () => {
  it("the route is hidden while the switch is off", async () => {
    markCase("custodian-projection-http", "the route is hidden while the switch is off");
    const response = await post({ revision: 1, previousRevision: null, checksum: "abc", body: {} });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
    expect(applyCustodianProjection).not.toHaveBeenCalled();
  });

  it("an unauthorized delivery does not apply", async () => {
    markCase("custodian-projection-http", "an unauthorized delivery does not apply");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    verifyCustodianProjectionCaller.mockResolvedValue(null);
    const response = await post({ revision: 1, previousRevision: null, checksum: "abc", body: {} });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(applyCustodianProjection).not.toHaveBeenCalled();
  });

  it("an authorized next revision returns accepted", async () => {
    markCase("custodian-projection-http", "an authorized next revision returns accepted");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    applyCustodianProjection.mockResolvedValue({ outcome: "accepted", revision: 1, movedTransfers: 0 });
    const response = await post({ revision: 1, previousRevision: null, checksum: "abc", body: {} });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: "accepted", revision: 1 });
  });

  it("a matching replay returns duplicate", async () => {
    markCase("custodian-projection-http", "a matching replay returns duplicate");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    applyCustodianProjection.mockResolvedValue({ outcome: "duplicate", revision: 1 });
    const response = await post({ revision: 1, previousRevision: null, checksum: "abc", body: {} });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: "duplicate", revision: 1 });
  });

  it("a gap returns rejected", async () => {
    markCase("custodian-projection-http", "a gap returns rejected");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    applyCustodianProjection.mockResolvedValue({ outcome: "rejected", revision: 3, reason: "gap" });
    const response = await post({ revision: 3, previousRevision: 1, checksum: "abc", body: {} });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ outcome: "rejected", revision: 3, reason: "gap" });
  });

  it("a mismatch returns rejected", async () => {
    markCase("custodian-projection-http", "a mismatch returns rejected");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    applyCustodianProjection.mockResolvedValue({ outcome: "rejected", revision: 2, reason: "mismatch" });
    const response = await post({ revision: 2, previousRevision: 1, checksum: "abc", body: {} });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ outcome: "rejected", revision: 2, reason: "mismatch" });
  });

  it("a thrown mismatch returns rejected", async () => {
    markCase("custodian-projection-http", "a thrown mismatch returns rejected");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    applyCustodianProjection.mockRejectedValue({ status: 409, reason: "mismatch" });
    const response = await post({ revision: 4, previousRevision: 3, checksum: "abc", body: {} });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ outcome: "rejected", revision: 4, reason: "mismatch" });
  });

  it("a missing state row returns internal_error", async () => {
    markCase("custodian-projection-http", "a missing state row returns internal_error");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    applyCustodianProjection.mockRejectedValue({ status: 500 });
    const response = await post({ revision: 1, previousRevision: null, checksum: "abc", body: {} });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "internal_error" });
  });

  it("the route source contains the seven delivery tokens", () => {
    markCase("custodian-projection-http", "the route source contains the seven delivery tokens");
    const source = readFileSync("src/app/api/machine/custodians/projection/route.ts", "utf8");
    for (const token of ["previousRevision", "checksum", "\"accepted\"", "\"duplicate\"", "\"rejected\"", "\"gap\"", "\"mismatch\""]) {
      expect(source).toContain(token);
    }
  });
});
