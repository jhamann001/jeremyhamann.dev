// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sync = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-directory/sync", () => ({ syncClientDirectory: sync }));
import { POST } from "./route";
import { DirectorySourceError } from "@/lib/client-directory/source";

const request = (authorization?: string) => new Request("http://localhost/api/cron/client-directory", {
  method: "POST", headers: authorization ? { authorization } : {},
});
beforeEach(() => { vi.stubEnv("CLIENT_DIRECTORY_SYNC_TOKEN", "synthetic-cron-token"); sync.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("directory cron boundary", () => {
  it.each([undefined, "", "Bearer wrong", "Basic synthetic-cron-token"])("rejects bad auth before source or DB access: %s", async (auth) => {
    expect((await POST(request(auth))).status).toBe(401); expect(sync).not.toHaveBeenCalled();
  });
  it("cannot accidentally activate without a separately configured token", async () => {
    vi.stubEnv("CLIENT_DIRECTORY_SYNC_TOKEN", "");
    expect((await POST(request())).status).toBe(503); expect(sync).not.toHaveBeenCalled();
  });
  it("invokes only its configured source", async () => {
    sync.mockResolvedValue({ status: "published", snapshotId: "synthetic" });
    const response = await POST(request("Bearer synthetic-cron-token"));
    expect(response.status).toBe(200); expect(sync).toHaveBeenCalledExactlyOnceWith();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("reports bounded static failure metadata", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    sync.mockRejectedValue(new DirectorySourceError("SOURCE_UNVERIFIED"));
    const response = await POST(request("Bearer synthetic-cron-token"));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "Directory sync failed.", code: "SOURCE_UNVERIFIED" });
    expect(log).toHaveBeenCalledWith("[client-directory] sync failed", { code: "SOURCE_UNVERIFIED" });
  });
});
