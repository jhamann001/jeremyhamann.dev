// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import { libraryFixture } from "./fixtures/custodian-library";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/transfers/AcatTrackingView", () => ({ AcatTrackingView: () => null }));
vi.mock("@/app/(authenticated)/acat-tracking/custodian-admin-actions", () => ({}));

import { AcatWorkspace } from "@/components/custodians/AcatWorkspace";

const NOW = 1_700_000_000_000;
const SCOPE = "ops-session";

function sessionResponse() {
  return {
    ok: true,
    json: async () => ({
      user: { role: "OPERATIONS" },
      navigationScope: SCOPE,
      expires: new Date(NOW + 3_600_000).toISOString(),
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/auth/session")) return sessionResponse();
    throw new Error(`unexpected ${url}`);
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("custodian library lease", () => {
  it("keeps the opened library visible after the five-minute cache window", async () => {
    const initial = {
      scope: SCOPE, serverNow: NOW, sessionExpiresAt: NOW + 3_600_000,
      snapshot: { view: "library" as const, data: libraryFixture, checkedAt: NOW, expiresAt: NOW + 300_000 },
    };
    render(createElement(AcatWorkspace, { scope: SCOPE, initialView: "library", initial }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("searchbox")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(screen.getByRole("searchbox")).toBeTruthy();
    expect(screen.getByText(/Stays open for this session/)).toBeTruthy();
    expect(screen.queryByText(/Snapshot expired/)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["VIEWER", "ADVISOR", "CLIENT_SERVICE", "", undefined])("still refuses %s", (role) => {
    expect(canReadCustodianLibrary(role)).toBe(false);
  });

  it("still allows the operations roles", () => {
    expect(canReadCustodianLibrary("ADMIN")).toBe(true);
    expect(canReadCustodianLibrary("OPERATIONS")).toBe(true);
  });
});
