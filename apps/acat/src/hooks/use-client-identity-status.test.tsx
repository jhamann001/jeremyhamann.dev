import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useClientIdentityStatus } from "./use-client-identity-status";

function wrapper() {
  const cache = new Map();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>;
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("useClientIdentityStatus", () => {
  it("starts unknown and does not turn an unavailable endpoint into disabled cutover", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const { result } = renderHook(useClientIdentityStatus, { wrapper: wrapper() });
    expect(result.current.status).toBeNull();
    await waitFor(() => expect(result.current.error).toContain("unavailable"));
    expect(result.current.status).toBeNull();
  });

  it("uses server runtime status with a no-store request", async () => {
    const status = { enabled: true, writeEligible: true, health: "FRESH", pendingAccountPolicy: "PENDING_ACCOUNT_OPENING_ONLY", lastSuccessAt: null, sourceAsOf: null };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => status });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(useClientIdentityStatus, { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).toEqual(status));
    expect(fetchMock).toHaveBeenCalledWith("/api/clients/status", { cache: "no-store" });
  });
});
