import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRawMock = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: queryRawMock } }));

import { readServingState } from "@/lib/trade-requests/serving-state";

describe("readServingState", () => {
  beforeEach(() => queryRawMock.mockReset());

  it("returns the row's three values", async () => {
    queryRawMock.mockResolvedValueOnce([{ serving_source: "aoa", digest_sender: "standalone", drift_sender: "aoa" }]);
    await expect(readServingState()).resolves.toEqual({ servingSource: "aoa", digestSender: "standalone", driftSender: "aoa" });
  });

  it("reads all-standalone when the row is missing", async () => {
    queryRawMock.mockResolvedValueOnce([]);
    await expect(readServingState()).resolves.toEqual({
      servingSource: "standalone",
      digestSender: "standalone",
      driftSender: "standalone",
    });
  });

  it("logs only the error code and reads all-standalone when the read fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    queryRawMock.mockRejectedValueOnce(Object.assign(new Error("permission denied for value secret-value"), { code: "P2010" }));
    await expect(readServingState()).resolves.toEqual({
      servingSource: "standalone",
      digestSender: "standalone",
      driftSender: "standalone",
    });
    expect(log).toHaveBeenCalledWith("[trade-requests] serving_state_read_failed code=P2010");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-value");
    log.mockRestore();
  });

  it("reads the row afresh on every call (no cache)", async () => {
    queryRawMock
      .mockResolvedValueOnce([{ serving_source: "standalone", digest_sender: "standalone", drift_sender: "standalone" }])
      .mockResolvedValueOnce([{ serving_source: "aoa", digest_sender: "aoa", drift_sender: "aoa" }]);
    expect((await readServingState()).servingSource).toBe("standalone");
    expect((await readServingState()).servingSource).toBe("aoa");
    expect(queryRawMock).toHaveBeenCalledTimes(2);
  });
});
