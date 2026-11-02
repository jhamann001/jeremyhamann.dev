import { afterEach, describe, expect, it, vi } from "vitest";

const { construct, extend } = vi.hoisted(() => ({ construct: vi.fn(), extend: vi.fn() }));
vi.mock("@prisma/client", () => ({
  Prisma: {},
  PrismaClient: class {
    constructor(options: unknown) { construct(options); }
    $extends(extension: unknown) {
      extend(extension);
      // The application must retain the extended client, not its bare base.
      return { base: this, extension };
    }
  },
}));

const processGlobal = globalThis as unknown as { prisma?: unknown };
const originalClient = processGlobal.prisma;

afterEach(() => {
  if (originalClient === undefined) delete processGlobal.prisma;
  else processGlobal.prisma = originalClient;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("production Prisma singleton across separately evaluated server modules", () => {
  it("shares one extended pool across API, server component and middleware module copies", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic");
    delete processGlobal.prisma;

    // The production Next build contains independent lib/db module identities
    // for these layers. Re-evaluate the source while preserving the worker's
    // global object, as those separate compiled copies do.
    vi.resetModules();
    const api = await import("@/lib/db");
    vi.resetModules();
    const serverComponent = await import("@/lib/db");
    vi.resetModules();
    const middleware = await import("@/lib/db");

    expect(serverComponent.prisma).toBe(api.prisma);
    expect(middleware.prisma).toBe(api.prisma);
    expect(processGlobal.prisma).toBe(api.prisma);
    expect(construct).toHaveBeenCalledExactlyOnceWith({
      log: ["error"],
      datasources: { db: { url: "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic?connection_limit=5" } },
    });
    expect(extend).toHaveBeenCalledOnce();
    expect(extend.mock.calls[0][0]).toMatchObject({
      name: "retry-transient-connection",
      query: { $allOperations: expect.any(Function) },
    });
    expect(api.prisma).toHaveProperty("extension", extend.mock.calls[0][0]);
  });
});
