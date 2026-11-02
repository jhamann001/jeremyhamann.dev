import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { PrismaClientMock } = vi.hoisted(() => ({
  PrismaClientMock: vi.fn(function (config: unknown) {
    return { config };
  }),
}));

vi.mock("@prisma/client", () => ({ PrismaClient: PrismaClientMock }));

type CrmReconcilerGlobal = {
  crmReconcilerPrisma?: unknown;
  crmReconcilerUrl?: string;
};

const crmGlobal = globalThis as unknown as CrmReconcilerGlobal;

describe("crmReconcilerClient", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "CRM_RECONCILER_DATABASE_URL",
      "postgresql://identity_reconciler@example.internal:5432/aoa?schema=app",
    );
    PrismaClientMock.mockClear();
    delete crmGlobal.crmReconcilerPrisma;
    delete crmGlobal.crmReconcilerUrl;
  });

  afterEach(() => {
    delete crmGlobal.crmReconcilerPrisma;
    delete crmGlobal.crmReconcilerUrl;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reuses one bounded Prisma pool across production requests", async () => {
    const { crmReconcilerClient } = await import("@/lib/crm/reconciler-db");

    const first = crmReconcilerClient();
    const second = crmReconcilerClient();

    expect(second).toBe(first);
    expect(PrismaClientMock).toHaveBeenCalledTimes(1);
    expect(PrismaClientMock).toHaveBeenCalledWith({
      log: ["error"],
      datasources: {
        db: {
          url: "postgresql://identity_reconciler@example.internal:5432/aoa?schema=app&connection_limit=1",
        },
      },
    });
  });

  it("preserves an explicitly bounded connection URL", async () => {
    vi.stubEnv(
      "CRM_RECONCILER_DATABASE_URL",
      "postgresql://identity_reconciler@example.internal:5432/aoa?schema=app&connection_limit=1",
    );
    const { crmReconcilerClient } = await import("@/lib/crm/reconciler-db");

    crmReconcilerClient();

    expect(PrismaClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        datasources: {
          db: {
            url: "postgresql://identity_reconciler@example.internal:5432/aoa?schema=app&connection_limit=1",
          },
        },
      }),
    );
  });

  it("fails closed without constructing a client when configuration is missing", async () => {
    vi.stubEnv("CRM_RECONCILER_DATABASE_URL", "");
    const { crmReconcilerClient } = await import("@/lib/crm/reconciler-db");

    expect(() => crmReconcilerClient()).toThrow("crm_reconciler_not_configured");
    expect(PrismaClientMock).not.toHaveBeenCalled();
  });
});
