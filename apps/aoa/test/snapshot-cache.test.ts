import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSnapshotCache } from "@/lib/data/snapshot-cache";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => vi.useRealTimers());

describe("bounded success-only snapshot cache", () => {
  it("does not slide TTL, expires at the exact boundary and clones snapshots", async () => {
    const cache = createSnapshotCache<{ value: number }>(30_000);
    const load = vi.fn().mockResolvedValue({ value: 1 });
    const first = await cache.read("source", load);
    first.data.value = 99;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await cache.read("source", load)).toEqual({ data: { value: 1 }, checkedAt: 1_000_000, expiresAt: 1_030_000 });
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await cache.read("source", load);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("evicts on refresh failure and never caches failures", async () => {
    const cache = createSnapshotCache<number>(300_000);
    const load = vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(2);
    await cache.read("source", load);
    await expect(cache.read("source", load, true)).rejects.toThrow("unavailable");
    expect((await cache.read("source", load)).data).toBe(2);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it("single-flights initial reads and refreshes without returning the old result", async () => {
    const cache = createSnapshotCache<number>(300_000);
    let resolve!: (n: number) => void;
    const load = vi.fn(() => new Promise<number>((r) => { resolve = r; }));
    const first = cache.read("s", load);
    const second = cache.read("s", load);
    await Promise.resolve(); resolve(1);
    expect((await first).data).toBe(1); expect((await second).data).toBe(1);
    const refresh = cache.read("s", load, true);
    const joined = cache.read("s", load, true);
    const ordinary = cache.read("s", load);
    await Promise.resolve(); resolve(2);
    expect((await refresh).data).toBe(2);
    expect((await joined).data).toBe(2); expect((await ordinary).data).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("does not let a superseded source read overwrite or evict the new source", async () => {
    const cache = createSnapshotCache<number>(300_000);
    let resolve!: (n: number) => void;
    const old = cache.read("old", () => new Promise<number>((r) => { resolve = r; }));
    await Promise.resolve();
    const load = vi.fn().mockResolvedValue(2);
    await cache.read("new", load);
    resolve(1); await old;
    expect((await cache.read("new", load)).data).toBe(2);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("counts slow source time against TTL and rejects clock rollback hits", async () => {
    const cache = createSnapshotCache<number>(30_000);
    const load = vi.fn().mockResolvedValue(1);
    await cache.read("s", load);
    vi.setSystemTime(999_000);
    await cache.read("s", load);
    expect(load).toHaveBeenCalledTimes(2);
    const slow = vi.fn(async () => { await vi.advanceTimersByTimeAsync(30_001); return 2; });
    const value = await cache.read("s", slow, true);
    expect(value.expiresAt).toBeLessThan(Date.now());
    await cache.read("s", load);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
