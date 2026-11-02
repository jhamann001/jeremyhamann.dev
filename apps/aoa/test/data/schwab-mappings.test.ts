import { afterEach, describe, expect, it, vi } from "vitest";
import * as scope from "@/lib/rls";
import { reviewSchwabMappings } from "@/lib/data/schwab-mappings";
import { parseSchwabMappingCsv } from "@/lib/schwab/review";

const identity = { role: "OPERATIONS", email: "ops@example.test" };
const HOUSEHOLD = "001288867315530AAA";
const CLIENT = "003288867315530AAA";
const mapping = parseSchwabMappingCsv(`12345678,${HOUSEHOLD},${CLIENT},CLIENT`)![0]!;

function stub(options: { previous?: unknown[]; household?: unknown[]; client?: unknown[] } = {}) {
  const query = vi.fn().mockResolvedValueOnce([{ locked: "" }])
    .mockResolvedValueOnce(options.previous ?? [])
    .mockResolvedValueOnce(options.household ?? [{ sf_id: HOUSEHOLD, name: "Example Household", stage: "Lost Client" }])
    .mockResolvedValueOnce(options.client ?? [{ sf_id: CLIENT, name: "Alex Example", household_id: HOUSEHOLD }]);
  const execute = vi.fn().mockResolvedValue(1);
  const create = vi.fn().mockResolvedValue({});
  vi.spyOn(scope, "withUserScope").mockImplementation(async (_identity, fn) => fn({
    $queryRaw: query, $executeRaw: execute, auditLog: { create },
  } as never));
  return { query, execute, create };
}
afterEach(() => vi.restoreAllMocks());

describe("Schwab mapping review boundary", () => {
  it("previews target names/stages without writes or full numbers", async () => {
    const { execute, create } = stub();
    const result = await reviewSchwabMappings(identity, [mapping]);
    expect(result).toMatchObject({ status: "preview", rows: [{ clientName: "Alex Example", stage: "Lost Client", version: 0 }] });
    expect(JSON.stringify(result)).not.toContain("12345678");
    expect(execute).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it("denies non-Operations roles before opening a transaction", async () => {
    const tx = vi.spyOn(scope, "withUserScope");
    expect(await reviewSchwabMappings({ role: "ADVISOR", email: "advisor@example.test" }, [mapping], true)).toEqual({ status: "forbidden" });
    expect(tx).not.toHaveBeenCalled();
  });
  it("rechecks optimistic versions and refuses stale previews", async () => {
    const { execute } = stub({ previous: [{ ...mapping, version: 2 }] });
    expect(await reviewSchwabMappings(identity, [mapping], true)).toEqual({ status: "conflict" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("rechecks membership before saving", async () => {
    const { execute } = stub({ client: [{ sf_id: CLIENT, name: "Alex Example", household_id: "001092155893454AAA" }] });
    expect(await reviewSchwabMappings(identity, [mapping], true)).toEqual({ status: "target_mismatch" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("saves with counts-only business audit in the same transaction", async () => {
    const { execute, create } = stub();
    expect(await reviewSchwabMappings(identity, [mapping], true)).toEqual({ status: "saved" });
    expect(execute).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledOnce();
    const audit = JSON.stringify(create.mock.calls);
    expect(audit).toContain("schwab.mapping_review");
    for (const sensitive of ["12345678", "Alex Example", CLIENT, HOUSEHOLD]) expect(audit).not.toContain(sensitive);
  });
  it("rejects the entire batch before any writes if a later target is invalid", async () => {
    const { query, execute } = stub();
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const next = { ...mapping, accountId: `schw_${"a".repeat(32)}` };
    expect(await reviewSchwabMappings(identity, [mapping, next], true)).toEqual({ status: "target_mismatch" });
    expect(execute).not.toHaveBeenCalled();
  });
});
