// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinkageError } from "./contract";
import { syntheticSnapshot } from "./testing/fixtures";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rate: vi.fn(), snapshot: vi.fn(), point: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/machine-auth", () => ({ verifyTransferLinkageCaller: mocks.auth }));
vi.mock("@/lib/rate-limit-redis", () => ({ rateLimit: mocks.rate }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn } }));
vi.mock("./repository", () => ({ readLinkageSnapshot: mocks.snapshot, readLinkagePoint: mocks.point }));
import { GET as snapshotGet } from "@/app/api/machine/transfer-linkage/route";
import { GET as pointGet } from "@/app/api/machine/transfer-linkage/[id]/route";

beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ email: "synthetic@example.test" }); mocks.rate.mockResolvedValue({ allowed: true }); });
describe("linkage routes", () => {
  it("returns complete no-store evidence only after auth and caller rate limit", async () => {
    const fixture = syntheticSnapshot(); mocks.snapshot.mockResolvedValue(fixture);
    const response = await snapshotGet(new Request("https://tracker.test/api/machine/transfer-linkage"));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(fixture);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Request), "snapshot");
    expect(mocks.rate).toHaveBeenCalledWith("machine-transfer-linkage", "synthetic@example.test", expect.any(Object));
  });
  it("does not read data on auth or rate-limit failure", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await snapshotGet(new Request("https://tracker.test/api/machine/transfer-linkage"))).status).toBe(401);
    expect(mocks.rate).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValue({ email: "synthetic@example.test" }); mocks.rate.mockResolvedValue({ allowed: false });
    expect((await snapshotGet(new Request("https://tracker.test/api/machine/transfer-linkage"))).status).toBe(429);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it("refuses filtering that might be mistaken for complete history", async () => {
    expect((await snapshotGet(new Request("https://tracker.test/api/machine/transfer-linkage?status=Submitted"))).status).toBe(400);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it("fails closed with no partial payload or sensitive error details", async () => {
    for (const error of [new LinkageError("SNAPSHOT_OVERFLOW"), new Error("SENSITIVE SOURCE DETAIL")]) {
      mocks.snapshot.mockRejectedValue(error);
      const response = await snapshotGet(new Request("https://tracker.test/api/machine/transfer-linkage"));
      expect(response.status).toBe(503); expect(await response.text()).not.toContain("SENSITIVE");
    }
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("SENSITIVE");
  });
  it("keeps missing point evidence explicit without treating it as candidate proof", async () => {
    const source = syntheticSnapshot();
    const result = { contractVersion: 1, source: source.source, scope: "RECORD", complete: false,
      observedAt: source.observedAt, directory: source.directory, outcome: "MISSING", record: null };
    mocks.point.mockResolvedValue(result);
    const response = await pointGet(new Request("https://tracker.test/api/machine/transfer-linkage/missing"), { params: Promise.resolve({ id: "missing" }) });
    expect(await response.json()).toEqual(result); expect(mocks.point).toHaveBeenCalledWith("missing");
  });
});
