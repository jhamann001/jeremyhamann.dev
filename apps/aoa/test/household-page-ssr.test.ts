import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authMock, directoryMock, redirectMock } = vi.hoisted(() => ({
  authMock: vi.fn(), directoryMock: vi.fn(), redirectMock: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/data/households", () => ({ getHouseholdDirectory: directoryMock }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@/components/households/HouseholdsTable", () => ({ HouseholdsTable: () => null }));

import HouseholdsPage from "@/app/(household-directory)/households/page";

async function renderPage(params: Record<string, string | string[] | undefined>) {
  const page = await HouseholdsPage({ searchParams: Promise.resolve(params) });
  await new Promise<void>((resolve, reject) => {
    const output = new PassThrough();
    const stream = renderToPipeableStream(page, {
      onShellReady: () => stream.pipe(output),
      onError: reject,
    });
    output.resume();
    output.on("end", resolve);
    output.on("error", reject);
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("Households SSR page-number boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HOUSEHOLD_DIRECTORY_FAST_PATH", "0");
    authMock.mockResolvedValue({ user: { id: "synthetic-user", role: "ADVISOR", email: "synthetic@example.test" } });
    redirectMock.mockImplementation((href: string) => { throw new Error(`redirect:${href}`); });
    directoryMock.mockResolvedValue({ page: 1, snapshot: "a".repeat(32) });
  });

  it.each(["99999999999999999999999", "1000001", "0", "-1", "1.5", "2x", ["1", "2"]])(
    "redirects invalid page %s before any directory/database read, retaining valid filters", async (page) => {
      await expect(HouseholdsPage({ searchParams: Promise.resolve({ page, q: "Synthetic", stage: "all" }) }))
        .rejects.toThrow("redirect:/households?q=Synthetic&stage=all");
      expect(directoryMock).not.toHaveBeenCalled();
    },
  );

  it("preserves valid legacy numbered links without requiring an API snapshot", async () => {
    await renderPage({ page: "250" });
    expect(directoryMock).toHaveBeenCalledWith(
      { role: "ADVISOR", email: "synthetic@example.test" },
      { query: "", stage: "client", advisor: "", status: "", sortKey: "name", sortDir: "asc" },
      250, 100,
    );
  });

  it("defaults missing page to1 and redirects unauthenticated callers before data access", async () => {
    await renderPage({});
    expect(directoryMock.mock.calls[0][2]).toBe(1);
    directoryMock.mockClear();
    authMock.mockResolvedValue(null);
    await expect(HouseholdsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/");
    expect(directoryMock).not.toHaveBeenCalled();
  });
});
