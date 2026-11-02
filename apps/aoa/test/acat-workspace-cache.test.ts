import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { library, rows, transfers } = vi.hoisted(() => ({ library: vi.fn(), rows: vi.fn(), transfers: vi.fn() }));
vi.mock("@/lib/data/custodian-library", () => ({ getCustodianLibrary: library }));
vi.mock("@/lib/data/acat-status", () => ({ fetchAcatList: rows, fetchAcatOpsList: rows }));
vi.mock("@/lib/data/transfers", () => ({ listTransfers: transfers }));
import { markCustodianLibraryStale, readAcatWorkspace } from "@/lib/data/acat-workspace";
import { libraryFixture } from "./fixtures/custodian-library";
import { acatWorkspaceResponseSchema } from "@/lib/data/acat-workspace-contract";
const identity = { role: "OPERATIONS", email: "ops@example.test" };
let source = 0;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); vi.clearAllMocks();
  vi.stubEnv("TRANSFER_TRACKER_URL", `https://source-${source++}.example.test`);
  library.mockResolvedValue(libraryFixture); rows.mockResolvedValue([]); transfers.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("workspace source caches", () => {
  it("uses five minutes for reference data without a database read", async () => {
    const a = await readAcatWorkspace(identity, "library");
    await vi.advanceTimersByTimeAsync(299_999);
    expect(await readAcatWorkspace(identity, "library")).toEqual(a);
    expect(library).toHaveBeenCalledTimes(1); expect(transfers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await readAcatWorkspace(identity, "library");
    expect(library).toHaveBeenCalledTimes(2);
  });
  it("skips the cached library exactly once after an admin save marks it stale", async () => {
    await readAcatWorkspace(identity, "library");
    await readAcatWorkspace(identity, "library");
    expect(library).toHaveBeenCalledTimes(1);
    markCustodianLibraryStale();
    await readAcatWorkspace(identity, "library");
    expect(library).toHaveBeenCalledTimes(2);
    await readAcatWorkspace(identity, "library");
    expect(library).toHaveBeenCalledTimes(2);
  });
  it.each(["VIEWER", "ADVISOR", "CLIENT_SERVICE", "", undefined])("blocks %s before a warm cache hit", async (role) => {
    await readAcatWorkspace(identity, "library");
    await readAcatWorkspace(identity, "tracking");
    for (const view of ["library", "tracking"] as const) {
      await expect(readAcatWorkspace({ role, email: null }, view)).rejects.toThrow("forbidden");
    }
    expect(library).toHaveBeenCalledTimes(1); expect(rows).toHaveBeenCalledTimes(1); expect(transfers).toHaveBeenCalledTimes(1);
  });
  it("reuses only source rows for 30 seconds, rechecking archived-inclusive RLS linkage every time", async () => {
    rows.mockResolvedValue([{ id: "record", acatTransferId: "uuid", status: "Accepted", assetMap: {} }]);
    transfers.mockResolvedValueOnce([{ id: "first-link", acat_record_id: "record" }]).mockResolvedValue([]);
    const a = await readAcatWorkspace(identity, "tracking");
    const other = { role: "ADMIN", email: "admin@example.test" };
    const b = await readAcatWorkspace(other, "tracking");
    if (a.view !== "tracking" || b.view !== "tracking") throw new Error("view");
    expect(a.data.groups[0].rows[0].transferId).toBe("first-link");
    expect(b.data.groups[0].rows[0].transferId).toBeNull();
    expect(transfers).toHaveBeenLastCalledWith(other, { includeArchived: true });
    expect(rows).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); await readAcatWorkspace(identity, "tracking");
    expect(rows).toHaveBeenCalledTimes(2);
  });
  it("does not use old reference data after a forced failed refresh", async () => {
    await readAcatWorkspace(identity, "library"); library.mockRejectedValue(new Error("source failed"));
    await expect(readAcatWorkspace(identity, "library", true)).rejects.toThrow();
    await expect(readAcatWorkspace(identity, "library")).rejects.toThrow();
    expect(library).toHaveBeenCalledTimes(3);
  });
  it("starts the database and source reads concurrently and bounds list reads", async () => {
    transfers.mockReturnValue(new Promise(() => {})); rows.mockReturnValue(new Promise(() => {}));
    void readAcatWorkspace(identity, "tracking"); await Promise.resolve();
    expect(transfers).toHaveBeenCalledTimes(1); expect(rows).toHaveBeenCalledTimes(1);
    const signal = rows.mock.calls[0][0].signal as AbortSignal;
    expect(signal.aborted).toBe(false); await vi.advanceTimersByTimeAsync(8_000); expect(signal.aborted).toBe(true);
  });
  it("validates browser envelopes and strips unreviewed fields", async () => {
    const snapshot = await readAcatWorkspace(identity, "library");
    const value = { scope: "session", serverNow: Date.now(), sessionExpiresAt: 2_000_000, snapshot };
    expect(acatWorkspaceResponseSchema.parse({ ...value, secret: "omit" })).toEqual(value);
    expect(acatWorkspaceResponseSchema.safeParse({ ...value, snapshot: { ...snapshot, expiresAt: snapshot.expiresAt + 1 } }).success).toBe(false);
  });
});
