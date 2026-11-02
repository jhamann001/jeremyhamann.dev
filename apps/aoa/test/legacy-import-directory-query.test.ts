import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { loadLegacyImportDirectory } from "@/lib/operations/legacy-import-engine";
import { LEGACY_FEE_SOURCE } from "@/lib/operations/legacy-import";

describe("legacy directory identity SQL", () => {
  it("normalizes both join sides and reviewed selectors without truncating opaque IDs", async () => {
    const query = vi.fn<(sql: Prisma.Sql) => Promise<unknown[]>>(async () => []);
    await loadLegacyImportDirectory([], [{ source: LEGACY_FEE_SOURCE, legacyId: "9909160001001", scope: "HOUSEHOLD",
      clientSfId: " DEV-DUP-CONTACT-A-20260824 ", householdSfId: " DEV-DUP-HH-A-20260824 ", accountIds: [] }],
    { $queryRaw: query } as unknown as Prisma.TransactionClient);
    const sql = query.mock.calls[0]![0] as Prisma.Sql;
    for (const identifier of ["a.client_sf_id", "c.sf_id", "app.resolve_crm_canonical_household_source_key(c.household_id)"]) {
      expect(sql.sql).toContain(`upper(CASE WHEN btrim(${identifier}) ~ '^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$'`);
      expect(sql.sql).toContain(`THEN left(btrim(${identifier}), 15) ELSE btrim(${identifier}) END)`);
    }
    expect(sql.sql).not.toContain("ON left(");
    expect(sql.values).toContain("DEV-DUP-CONTACT-A-20260824");
    expect(sql.values).toContain("DEV-DUP-HH-A-20260824");
    expect(sql.values).not.toContain("DEV-DUP-CONTACT-");
    expect(sql.sql).not.toContain("DEV-DUP-CONTACT-A-20260824");
  });
  it("retains normalized Salesforce 15-character reviewed selector parameters", async () => {
    const query = vi.fn<(sql: Prisma.Sql) => Promise<unknown[]>>(async () => []);
    await loadLegacyImportDirectory([], [{ source: LEGACY_FEE_SOURCE, legacyId: "9909160001001", scope: "CLIENT",
      clientSfId: "003syn000000001aaa", householdSfId: null, accountIds: [] }],
    { $queryRaw: query } as unknown as Prisma.TransactionClient);
    expect((query.mock.calls[0]![0] as Prisma.Sql).values).toContain("003SYN000000001");
  });
});
