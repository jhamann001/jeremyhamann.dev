import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { verifyLegacyImportDatabase } from "@/lib/operations/legacy-import-preflight";
import { validateLegacyImportCloudMetadata, validateLegacyImportDatabaseIdentity } from "@/lib/operations/legacy-import-target";

// The existing database CI opts in with AUDIT_TEST_DB_URL=1 and supplies this
// disposable database URL. No production/default URL fallback and no row writes.
const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const cloud = validateLegacyImportCloudMetadata("dev", {
  name: "aoa-dev-postgres", connectionName: "ops-portal-dev:us-central1:aoa-dev-postgres",
  region: "us-central1", ipAddresses: [{ type: "PRIVATE", ipAddress: "10.22.33.44" }],
});

gated.sequential("legacy import address formatting: real read-only PostgreSQL", () => {
  let database: PrismaClient;
  beforeAll(() => {
    const datasourceUrl = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!datasourceUrl) throw new Error("AUDIT_TEST_CLEANUP_URL is required for the disposable database test");
    database = new PrismaClient({ datasourceUrl, log: [] });
  });
  afterAll(async () => { await database?.$disconnect(); });

  it("proves inet-to-text adds /32 while host preserves the exact bare address", async () => {
    await database.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const [row] = await tx.$queryRaw<Array<{ legacy: string; normalized: string }>>`
        SELECT inet '10.22.33.44'::text AS legacy, host(inet '10.22.33.44') AS normalized`;
      expect(row).toEqual({ legacy: "10.22.33.44/32", normalized: "10.22.33.44" });
      const identity = { name: "aoa", current_user: "aoa_admin", session_user: "aoa_admin", rolsuper: false, rolbypassrls: false };
      expect(() => validateLegacyImportDatabaseIdentity("dev", cloud, { ...identity, server_address: row.legacy }))
        .toThrow("database_server_mismatch");
      expect(() => validateLegacyImportDatabaseIdentity("dev", cloud, { ...identity, server_address: row.normalized }))
        .not.toThrow();
    });
  });

  it("executes the actual preflight identity query without changing PostgreSQL's listener address", async () => {
    let captured: { strings: TemplateStringsArray; values: unknown[] } | undefined;
    const stop = new Error("captured_identity_query_only");
    const capture = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        captured = { strings, values };
        throw stop;
      },
    } as unknown as Prisma.TransactionClient;
    // Capture the real production tagged query before its policy/catalog checks.
    // The local test database is intentionally not an AOA private endpoint.
    await expect(verifyLegacyImportDatabase(capture, "dev", cloud, [])).rejects.toBe(stop);
    if (!captured) throw new Error("preflight_identity_query_not_captured");
    const identityQuery = Prisma.sql(captured.strings, ...captured.values);
    await database.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const identities = await tx.$queryRaw<Array<{ server_address: string | null }>>(identityQuery);
      const [endpoint] = await tx.$queryRaw<Array<{ host: string | null; legacy: string | null; read_only: string }>>`
        SELECT host(inet_server_addr()) AS host, inet_server_addr()::text AS legacy,
          current_setting('transaction_read_only') AS read_only`;
      expect(identities).toHaveLength(1);
      expect(endpoint.read_only).toBe("on");
      // CI uses TCP. Reject a socket-only test that could mask this regression.
      expect(endpoint.host).toBeTypeOf("string");
      expect(endpoint.legacy).not.toBe(endpoint.host);
      expect(identities[0].server_address).toBe(endpoint.host);
      expect(identities[0].server_address).not.toContain("/");
    });
  });
});
