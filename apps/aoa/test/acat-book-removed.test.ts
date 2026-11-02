import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

vi.mock("server-only", () => ({}));
const { requestMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: vi.fn(async () => ({ request: requestMock })) };
  });
  return { requestMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));
vi.mock("@/lib/data/transfers", () => ({ listTransfers: vi.fn(async () => []) }));

import { fetchAcatBook } from "@/lib/data/acat-status";
import { readAcatBook } from "@/lib/data/acat-workspace";

const SUITE = "acat-book-removed";
const live = { id: "live-1", clientName: "Live", status: "Submitted", apexAccountId: "****1111", removedAt: null };
const gone = { id: "gone-1", clientName: "Gone", status: "Submitted", apexAccountId: "****2222", removedAt: "2026-09-02T00:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ACAT_FIXTURE", "");
  requestMock.mockImplementation(async (opts: { url: string }) => ({
    status: 200,
    data: { acats: opts.url.includes("removed=only") ? [gone] : [live] },
  }));
});

describe("removed ACAT reads", () => {
  it("requests the removed query only when asked", async () => {
    expect((await fetchAcatBook()).map((r) => r.id)).toEqual(["live-1"]);
    expect((await fetchAcatBook({ removed: true })).map((r) => r.id)).toEqual(["gone-1"]);
    const urls = requestMock.mock.calls.map((c) => (c[0] as { url: string }).url);
    expect(urls[0]).toMatch(/\?book=full$/);
    expect(urls[1]).toMatch(/\?book=full&removed=only$/);
    markCase(SUITE, "fetch-removed-query");
  });

  it("loads removed rows into the snapshot only on request", async () => {
    const identity = { role: "OPERATIONS", email: "synthetic@example.test" };
    const plain = await readAcatBook(identity);
    expect(plain.removedRows).toBeNull();
    const withRemoved = await readAcatBook(identity, { removed: true });
    expect(withRemoved.rows.map((r) => r.id)).toEqual(["live-1"]);
    expect(withRemoved.removedRows?.map((r) => r.id)).toEqual(["gone-1"]);
    markCase(SUITE, "snapshot-removed-on-request");
  });
});
