import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ source: vi.fn(), ingest: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/data/acat-match-source", () => ({ fetchTransferLinkageSnapshot: mocks.source }));
vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: mocks.ingest }));
vi.mock("@/lib/rls", () => ({ withUserScope: mocks.user }));
import { applyAcatDecision, undoAcatDecision } from "@/lib/data/acat-auto-link";

const automatic = { decisionId: "synthetic-decision", identity: { role: "INGEST", email: null }, mode: "automatic" as const, expectedReviewVersion: 0 };
const reviewed = { ...automatic, identity: { role: "OPERATIONS", email: "ops@example.invalid" }, mode: "reviewed" as const };
const error = (code: string, sqlstate?: string) => new Prisma.PrismaClientKnownRequestError("synthetic error", {
  clientVersion: "synthetic", code, ...(sqlstate ? { meta: { code: sqlstate } } : {}),
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ACAT_AUTO_LINK", "1"); vi.stubEnv("ACAT_LINK_REVIEW", "1"); vi.stubEnv("AOA_WRITES_PAUSED", "0");
  mocks.source.mockResolvedValue({ snapshotDigest: "synthetic" });
});
afterEach(() => vi.unstubAllEnvs());

describe("ACAT application transaction boundary", () => {
  it.each([error("P2034"), error("P2010", "40001")])("turns a scheduler serialization conflict into a bounded conflict result", async (failure) => {
    mocks.ingest.mockRejectedValueOnce(failure);
    expect(await applyAcatDecision(automatic)).toMatchObject({ outcome: "CONFLICT", reason: "target_changed" });
    expect(mocks.source).toHaveBeenCalledTimes(1);
  });
  it("refetches a complete source snapshot before every reviewed retry", async () => {
    mocks.user.mockRejectedValueOnce(error("P2010", "40001")).mockRejectedValueOnce(error("P2034"))
      .mockResolvedValueOnce({ outcome: "APPLIED" });
    expect(await applyAcatDecision(reviewed)).toEqual({ outcome: "APPLIED" });
    expect(mocks.source).toHaveBeenCalledTimes(3);
    expect(mocks.user).toHaveBeenCalledTimes(3);
    expect(mocks.source.mock.invocationCallOrder[1]).toBeGreaterThan(mocks.user.mock.invocationCallOrder[0]);
  });
  it("does not misclassify arbitrary raw SQL failures as concurrency", async () => {
    const failure = error("P2010", "42501");
    mocks.ingest.mockRejectedValueOnce(failure);
    await expect(applyAcatDecision(automatic)).rejects.toBe(failure);
    expect(mocks.source).toHaveBeenCalledTimes(1);
  });
  it("returns a conflict when an undo loses its transaction race", async () => {
    mocks.user.mockRejectedValueOnce(error("P2010", "40001"));
    expect(await undoAcatDecision(reviewed)).toMatchObject({ outcome: "CONFLICT", reason: "target_changed" });
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it("does no work when automation is disabled", async () => {
    vi.stubEnv("ACAT_AUTO_LINK", "0");
    expect(await applyAcatDecision(automatic)).toMatchObject({ outcome: "BLOCKED", reason: "disabled" });
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
