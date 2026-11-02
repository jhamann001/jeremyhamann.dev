import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readCrmNavigationState } from "@/lib/data/crm-explorer";

describe("CRM navigation snapshot and summaries", () => {
  it("reads exact summaries with the ordered content digests in one scoped query", async () => {
    const query = vi.fn().mockResolvedValue([{
      snapshot: "a".repeat(32), identities: 120n, source_aliases: 150n,
      open_exceptions: 3n, potential_duplicates: 2n,
      latest_seen_at: new Date("2026-09-17T12:00:00Z"),
    }]);
    const result = await readCrmNavigationState({ $queryRaw: query } as unknown as Prisma.TransactionClient);

    expect(result).toEqual({
      snapshot: "a".repeat(32),
      stats: { identities: 120, sourceAliases: 150, openExceptions: 3, potentialDuplicates: 2, latestSeenAt: "2026-09-17T12:00:00.000Z" },
    });
    expect(query).toHaveBeenCalledOnce();
    const sql = (query.mock.calls[0][0] as Prisma.Sql).sql;
    for (const table of ["crm_identity", "crm_source_mapping", "crm_identity_exception", "crm_duplicate_candidate"]) {
      expect(sql.match(new RegExp(`FROM app\\.${table}\\s`, "g"))).toHaveLength(1);
    }
    expect(sql).toContain("count(*)::bigint AS source_aliases, max(last_seen_at) AS latest_seen_at");
    expect(sql).toContain("exception_state = 'OPEN'");
    expect(sql).toContain("source_active AND");
    expect(sql).toContain("status = 'SNOOZED' AND snoozed_until <= now()");
    expect(sql.match(/ORDER BY source\.id/g)).toHaveLength(13);
    expect(sql).toContain("source_0.version,source_1.version,source_2.version,source_3.version,source_4.version");
  });

  it("always rereads fresh scoped data, including empty scopes", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ snapshot: "a".repeat(32), identities: 1n, source_aliases: 1n, open_exceptions: 0n, potential_duplicates: 0n, latest_seen_at: null }])
      .mockResolvedValueOnce([{ snapshot: "b".repeat(32), identities: 0n, source_aliases: 0n, open_exceptions: 0n, potential_duplicates: 0n, latest_seen_at: null }]);
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    await readCrmNavigationState(tx);
    expect(await readCrmNavigationState(tx)).toEqual({
      snapshot: "b".repeat(32),
      stats: { identities: 0, sourceAliases: 0, openExceptions: 0, potentialDuplicates: 0, latestSeenAt: null },
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the snapshot envelope is unavailable", async () => {
    const query = vi.fn().mockResolvedValue([]);
    await expect(readCrmNavigationState({ $queryRaw: query } as unknown as Prisma.TransactionClient))
      .rejects.toThrow("crm_navigation_version_unavailable");
    expect(query).toHaveBeenCalledOnce();
  });
});
