import { describe, it, expect, vi, beforeEach } from "vitest";
import { markCase } from "@/lib/test-flywheel";

const auth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => auth(...args),
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const resolveClientIdentities = vi.fn();
vi.mock("@/lib/client-directory", () => ({
  lockDirectory: vi.fn().mockResolvedValue(undefined),
  resolveClientIdentities: (...args: unknown[]) => resolveClientIdentities(...args),
  replaceAcatRecordClients: vi.fn().mockResolvedValue({ identityVersion: 1 }),
}));

const { applyAcatCreate } = await import("./acat-record-write");
const { prisma } = await import("@/lib/prisma");

const CALLER = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const SELECTED = "user-11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CLIENT_IDENTITY_ENABLED;
});

describe("machine create", () => {
  it("machine create without a selected client returns IDENTITY_REQUIRED", async () => {
    markCase("machine-create", "machine create without a selected client returns IDENTITY_REQUIRED");
    const result = await applyAcatCreate({
      body: { clientName: "Ada", apexAccountId: "APEX1" },
      performedBy: CALLER,
    });
    if (result.kind !== "response") throw new Error("expected a response");
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toMatchObject({ code: "IDENTITY_REQUIRED" });
    expect(prisma.acatRecord.create).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
  });

  it("machine create with user-11111111-1111-1111-1111-111111111111 accepts the selected client", async () => {
    markCase("machine-create", "machine create with user-11111111-1111-1111-1111-111111111111 accepts the selected client");
    const row = { id: "NEW-1", identityVersion: 0, assets: [], status: "AcatReceived", apexAccountId: "APEX1" };
    resolveClientIdentities.mockResolvedValue({
      canonicalName: "Sarah",
      cedarRidgeUserIds: [SELECTED],
      snapshotId: "snap",
      freshnessBasis: "UPSTREAM_VERIFIED",
      evidenceDigest: "digest",
    });
    vi.mocked(prisma.acatRecord.create).mockResolvedValue(row as never);
    vi.mocked(prisma.acatRecord.findUniqueOrThrow).mockResolvedValue(row as never);
    const result = await applyAcatCreate({
      body: { cedarRidgeUserId: SELECTED, apexAccountId: "APEX1" },
      performedBy: CALLER,
    });
    expect(result.kind).toBe("record");
    expect(auth).not.toHaveBeenCalled();
    expect(resolveClientIdentities).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cedarRidgeUserIds: [SELECTED] }),
    );
  });
});
