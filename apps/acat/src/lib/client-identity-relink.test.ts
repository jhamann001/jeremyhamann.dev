import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

vi.mock("@/lib/client-directory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-directory")>();
  return {
    ...actual,
    lockDirectory: vi.fn().mockResolvedValue(undefined),
    resolveClientIdentities: vi.fn(),
    replaceAcatRecordClients: vi.fn().mockResolvedValue({ identityVersion: 6 }),
  };
});

const { relinkAcatClients } = await import("./client-identity-relink");
const { prisma } = await import("@/lib/prisma");
const directory = await import("@/lib/client-directory");

const OLD_USER = "user-11111111-1111-1111-1111-111111111111";
const NEW_USER = "user-22222222-2222-2222-2222-222222222222";
const OTHER_USER = "user-33333333-3333-3333-3333-333333333333";
const OPERATOR = "ops.person@example.com";

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: "REC-1",
    clientName: "Ada Lovelace",
    apexAccountId: "APEXACCT1",
    status: "AcatReceived",
    identityVersion: 5,
    mappingAccountId: null,
    clientLinks: [{ cedarRidgeUserId: OLD_USER, client: { canonicalName: "Ada Lovelace" } }],
    assets: [],
    ...overrides,
  };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  cedarRidgeUserId: NEW_USER,
  expectedIdentityVersion: 5,
  reason: "Wrong person linked",
  replaceDisplayName: true,
  acknowledgeMappingInvalidation: false,
  ...overrides,
}) as Parameters<typeof relinkAcatClients>[0]["input"];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation(((arg: (tx: unknown) => unknown) => arg(prisma)) as never);
  vi.mocked(directory.resolveClientIdentities).mockResolvedValue({
    canonicalName: "Sarah Selected",
    cedarRidgeUserIds: [NEW_USER],
    snapshotId: "snap-1",
    freshnessBasis: "UPSTREAM_VERIFIED",
    evidenceDigest: "digest-1",
  } as never);
  vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(stored() as never);
  vi.mocked(prisma.acatRecord.findUniqueOrThrow).mockResolvedValue(stored({ clientName: "Sarah Selected", identityVersion: 6 }) as never);
  vi.mocked(prisma.acatRecord.update).mockResolvedValue(stored() as never);
});

describe("relinkAcatClients", () => {
  it("relink helper: missing record is 404", async () => {
    markCase("client-identity-relink", "missing record is 404");
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(null);
    const result = await relinkAcatClients({ id: "REC-1", input: input(), performedBy: OPERATOR });
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.response.status).toBe(404);
    expect(await result.response.json()).toEqual({ error: "ACAT record not found" });
    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
  });

  it("relink helper: version mismatch is a 409 identity conflict", async () => {
    markCase("client-identity-relink", "version mismatch is a 409 identity conflict");
    const result = await relinkAcatClients({ id: "REC-1", input: input({ expectedIdentityVersion: 4 }), performedBy: OPERATOR });
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.response.status).toBe(409);
    expect((await result.response.json()).code).toBe("IDENTITY_CONFLICT");
    expect(directory.replaceAcatRecordClients).not.toHaveBeenCalled();
    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
  });

  it("relink helper: multi-person record refuses a single-person selection", async () => {
    markCase("client-identity-relink", "multi-person record refuses a single-person selection");
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(stored({
      clientLinks: [
        { cedarRidgeUserId: OLD_USER, client: { canonicalName: "Ada" } },
        { cedarRidgeUserId: OTHER_USER, client: { canonicalName: "Bob" } },
      ],
    }) as never);
    const result = await relinkAcatClients({ id: "REC-1", input: input(), performedBy: OPERATOR });
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.response.status).toBe(409);
    expect(directory.replaceAcatRecordClients).not.toHaveBeenCalled();
  });

  it("relink helper: no-op returns the stored record without audit writes", async () => {
    markCase("client-identity-relink", "no-op returns the stored record without audit writes");
    vi.mocked(directory.resolveClientIdentities).mockResolvedValue({
      canonicalName: "Ada Lovelace",
      cedarRidgeUserIds: [OLD_USER],
      snapshotId: "snap-1",
      freshnessBasis: "UPSTREAM_VERIFIED",
      evidenceDigest: "digest-1",
    } as never);
    const result = await relinkAcatClients({
      id: "REC-1",
      input: input({ cedarRidgeUserId: OLD_USER, replaceDisplayName: false }),
      performedBy: OPERATOR,
    });
    expect(result.kind).toBe("record");
    if (result.kind !== "record") return;
    expect(result.record.clientName).toBe("Ada Lovelace");
    expect(directory.replaceAcatRecordClients).not.toHaveBeenCalled();
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("relink helper: display-name replacement writes relink and provenance audit rows with the caller email", async () => {
    markCase("client-identity-relink", "display-name replacement writes relink and provenance audit rows with the caller email");
    const result = await relinkAcatClients({ id: "REC-1", input: input(), performedBy: OPERATOR });
    expect(result.kind).toBe("record");
    if (result.kind !== "record") return;
    expect(result.record.clientName).toBe("Sarah Selected");
    expect(directory.replaceAcatRecordClients).toHaveBeenCalledWith(prisma, {
      recordId: "REC-1",
      cedarRidgeUserIds: [NEW_USER],
      expectedIdentityVersion: 5,
    });
    expect(vi.mocked(prisma.acatRecord.update).mock.calls[0]?.[0]).toMatchObject({
      where: { id: "REC-1", identityVersion: 6 },
      data: { apexAccountId: "APEXACCT1", clientName: "Sarah Selected" },
    });
    const rows = vi.mocked(prisma.auditLog.createMany).mock.calls[0]?.[0]?.data as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.field)).toEqual(["cedarRidgeUserIds", "clientName"]);
    expect(rows.every((row) => row.action === "identity-relink" && row.performedBy === OPERATOR)).toBe(true);
    const provenance = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(provenance).toMatchObject({ action: "identity-relink-provenance", performedBy: OPERATOR });
    expect(JSON.parse(provenance.newValue as string)).toMatchObject({
      reason: "Wrong person linked",
      snapshotId: "snap-1",
      oldUserIds: [OLD_USER],
      newUserIds: [NEW_USER],
      beforeVersion: 5,
      afterVersion: 6,
    });
  });

  it("relink helper: mapping invalidation must be acknowledged", async () => {
    markCase("client-identity-relink", "mapping invalidation must be acknowledged");
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(stored({ mappingAccountId: "MAP-1" }) as never);
    const refused = await relinkAcatClients({ id: "REC-1", input: input(), performedBy: OPERATOR });
    expect(refused.kind).toBe("response");
    if (refused.kind !== "response") return;
    expect(refused.response.status).toBe(400);
    expect((await refused.response.json()).code).toBe("MAPPING_INVALIDATION_REQUIRED");
    expect(directory.replaceAcatRecordClients).not.toHaveBeenCalled();

    const accepted = await relinkAcatClients({ id: "REC-1", input: input({ acknowledgeMappingInvalidation: true }), performedBy: OPERATOR });
    expect(accepted.kind).toBe("record");
    const rows = vi.mocked(prisma.auditLog.createMany).mock.calls[0]?.[0]?.data as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.field)).toContain("mappingAccountId");
  });
});
