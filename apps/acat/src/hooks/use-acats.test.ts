import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import React from "react";
import { SWRConfig } from "swr";
import { useAcats } from "./use-acats";
import { jsonFetcher } from "@/lib/fetcher";
import { mockAcats } from "@/lib/mock-data";

// Wrap every renderHook with an isolated SWR cache (new Map per test) and
// disable dedupe/throttle so each invocation hits fetch cleanly. The shared
// app-level SWRProvider is intentionally bypassed here so tests exercise the
// hook contract rather than global defaults.
function makeWrapper() {
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(
      SWRConfig,
      {
        value: {
          fetcher: jsonFetcher,
          provider: () => new Map(),
          dedupingInterval: 0,
          focusThrottleInterval: 0,
          revalidateOnFocus: true,
          revalidateOnReconnect: true,
        },
      },
      children
    );
  return Wrapper;
}

describe("useAcats", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fetches records on mount and exposes them", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockAcats),
    });

    const { result } = renderHook(() => useAcats(60_000), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.acats).toEqual(mockAcats);
    expect(result.current.error).toBeNull();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/acats",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("sets error when fetch fails with non-ok status", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() => useAcats(60_000), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.error).toBe("HTTP 500"));
    expect(result.current.acats).toEqual([]);
  });

  it("sets error when fetch throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useAcats(60_000), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.error).toBe("network down"));
  });

  it("polls at the provided interval", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockAcats),
    });
    global.fetch = fetchMock;

    renderHook(() => useAcats(5_000), { wrapper: makeWrapper() });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("revalidates on window focus", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockAcats),
    });
    global.fetch = fetchMock;

    renderHook(() => useAcats(60_000), { wrapper: makeWrapper() });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    );
  });

  it("refresh() re-fetches on demand and clears prior error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, json: () => Promise.resolve(mockAcats) });
    global.fetch = fetchMock;

    const { result } = renderHook(() => useAcats(60_000), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.error).toBe("HTTP 503"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.acats).toEqual(mockAcats);
  });

  it("requests the deleted-included endpoint when includeDeleted is true", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockAcats),
    });
    global.fetch = fetchMock;

    const { result } = renderHook(
      () => useAcats({ includeDeleted: true, pollIntervalMs: 60_000 }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/acats?includeDeleted=true",
      expect.objectContaining({ cache: "no-store" })
    );
  });
});
