import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClientSearch, CLIENT_SEARCH_DEBOUNCE_MS } from "./use-client-search";

const response = (name: string) => ({ ok: true, json: async () => ({ items: [{ cedarRidgeUserId: `user-${name}`, displayName: name, accountHints: [] }], hasMore: false, directory: { enabled: true, health: "FRESH", writeEligible: true } }) });

describe("useClientSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("debounces a bounded POST without putting names in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("Alex Example"));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ query }) => useClientSearch(query), { initialProps: { query: "A" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ query: " Alex Example " });
    expect(result.current.loading).toBe(true);
    await act(async () => { vi.advanceTimersByTime(CLIENT_SEARCH_DEBOUNCE_MS - 1); });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(fetchMock).toHaveBeenCalledWith("/api/clients/search", expect.objectContaining({ method: "POST", cache: "no-store", body: JSON.stringify({ query: "Alex Example", limit: 20 }) }));
    expect(result.current.items[0].displayName).toBe("Alex Example");
  });

  it("ignores an older response even when its transport does not honor abort", async () => {
    let resolveOld!: (value: ReturnType<typeof response>) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce(response("Blair Example"));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ query }) => useClientSearch(query), { initialProps: { query: "Alex" } });
    await act(async () => { vi.advanceTimersByTime(250); });
    rerender({ query: "Blair" });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    expect(result.current.items).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(250); });
    await act(async () => { resolveOld(response("Alex Example")); });
    expect(result.current.items[0].displayName).toBe("Blair Example");
    rerender({ query: "" });
    expect(result.current.items).toEqual([]);
  });

  it("returns an unavailable error without retaining previous results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response("Alex Example")).mockResolvedValueOnce({ ok: false, json: async () => ({ code: "DIRECTORY_UNAVAILABLE", error: "Directory unavailable" }) }));
    const { result, rerender } = renderHook(({ query }) => useClientSearch(query), { initialProps: { query: "Alex" } });
    await act(async () => { vi.advanceTimersByTime(250); });
    rerender({ query: "Blair" });
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(result.current.error).toBe("Directory unavailable");
    expect(result.current.items).toEqual([]);
  });

  it("does not search while disabled and supports a deliberate retry", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(response("Alex"));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ enabled }) => useClientSearch("Alex", enabled), { initialProps: { enabled: false } });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(result.current.error).toBe("Offline");
    act(() => result.current.retry());
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(result.current.error).toBeNull();
    expect(result.current.items).toHaveLength(1);
  });
});
