import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), enabled: vi.fn(), paused: vi.fn(), scope: vi.fn(), source: vi.fn(),
  targets: vi.fn(), rejects: vi.fn(), intent: vi.fn(), build: vi.fn(), persist: vi.fn(), review: vi.fn(), revalidate: vi.fn(), selected: vi.fn(), position: vi.fn(), validate: vi.fn(), hold: vi.fn(), saved: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({ acatAutoLinkReviewEnabled: m.enabled }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: m.paused }));
vi.mock("@/lib/rls", () => ({ withUserScope: m.scope }));
vi.mock("@/lib/data/acat-match-source", () => ({ fetchTransferLinkageSnapshot: m.source, readAcatCandidatesWithinScope: m.targets, validateTransferLinkageSnapshot: m.validate }));
vi.mock("@/lib/data/acat-auto-link", () => ({ readAcatRejectedPairsWithinScope: m.rejects, setAcatAutomationHoldWithinScope: m.hold }));
vi.mock("@/lib/data/acat-reconciliation/persistence", () => ({ prepareReconciliationRun: m.persist, reviewReconciliationDecision: m.review }));
vi.mock("@/lib/data/acat-historical-review", async () => ({
  ...await vi.importActual<typeof import("@/lib/data/acat-historical-review")>("@/lib/data/acat-historical-review"),
  readHistoricalAcatIntentWithinScope: m.intent, prepareHistoricalAcatManifest: m.build,
}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
import { prepareHistoricalAcatPair, reviewAcatDecision } from "@/app/(authenticated)/acat-link-review/actions";
const actor = { role: "OPERATIONS", email: "ops@example.invalid" }, tx = { syntheticTransaction: true, acatLinkDecision: { findFirstOrThrow: m.selected, count: m.position, findUnique: m.saved } };
const source = { source: { system: "transfer-tracker", installationId: "synthetic", environment: "synthetic" }, records: [], directory: {}, observedAt: "2026-09-28T03:00:00Z" };
function form(overrides: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ transferId: "transfer-1", recordId: "record-1", historicalConfirmed: "yes",
    expectedTargetVersion: "2", expectedTargetDigest: "a".repeat(64), expectedSourceDigest: "b".repeat(64),
    evidenceKind: "TRANSFER_DOCUMENT", evidenceReference: "transfer-confirmation-123",
    correspondence: "I reviewed the original transaction confirmation and verified this exact transfer correspondence.", ...overrides })) data.set(key, value);
  return data;
}
beforeEach(() => {
  vi.resetAllMocks(); m.auth.mockResolvedValue({ user: actor }); m.enabled.mockReturnValue(true); m.paused.mockReturnValue(false);
  m.source.mockResolvedValue(source); m.targets.mockResolvedValue([{ transferId: "transfer-1" }]); m.rejects.mockResolvedValue([]);
  m.intent.mockResolvedValue({ digest: "intent" }); m.build.mockReturnValue({ manifest: { exact: true }, summary: { target: 1 } });
  m.saved.mockResolvedValue({ id: "decision-1", run_id: "saved-run", transfer_id: "transfer-1" });
  m.selected.mockResolvedValue({ id: "decision-101" }); m.position.mockResolvedValue(101);
  m.persist.mockResolvedValue({ runId: "run-1" }); m.scope.mockImplementation(async (_actor, fn) => fn(tx));
});
describe("historical review server action", () => {
  it.each(["disabled", "paused", "viewer", "signed-out"])("%s cannot read source or persist", async (condition) => {
    if (condition === "disabled") m.enabled.mockReturnValue(false);
    if (condition === "paused") m.paused.mockReturnValue(true);
    if (condition === "viewer") m.auth.mockResolvedValue({ user: { ...actor, role: "VIEWER" } });
    if (condition === "signed-out") m.auth.mockResolvedValue(null);
    await prepareHistoricalAcatPair(form()); expect(m.source).not.toHaveBeenCalled(); expect(m.scope).not.toHaveBeenCalled();
  });
  it("fetches source then reads and persists in one Operations serializable transaction", async () => {
    await expect(prepareHistoricalAcatPair(form())).rejects.toThrow("?run=run-1&population=aoa&page=3&focus=decision-101&message=prepared#decision-decision-101");
    expect(m.scope).toHaveBeenCalledExactlyOnceWith(actor, expect.any(Function), { isolationLevel: "Serializable", timeout: 30000 });
    expect(m.source.mock.invocationCallOrder[0]).toBeLessThan(m.scope.mock.invocationCallOrder[0]);
    expect(m.targets).toHaveBeenCalledExactlyOnceWith(tx); expect(m.rejects).toHaveBeenCalledExactlyOnceWith(tx);
    expect(m.intent).toHaveBeenCalledExactlyOnceWith(tx, "transfer-1");
    expect(m.build).toHaveBeenCalledWith(expect.objectContaining({ snapshot: source, targets: [{ transferId: "transfer-1" }], rejectedPairs: [], intent: { digest: "intent" }, selection: expect.objectContaining({ historicalConfirmed: "yes", expectedTargetVersion: 2 }) }));
    expect(m.persist).toHaveBeenCalledExactlyOnceWith(tx, actor, expect.objectContaining({ manifest: { exact: true }, sourceBoundary: sourceWithoutRecords(), summary: { target: 1 } }));
    expect(m.intent.mock.invocationCallOrder[0]).toBeLessThan(m.build.mock.invocationCallOrder[0]);
    expect(m.build.mock.invocationCallOrder[0]).toBeLessThan(m.persist.mock.invocationCallOrder[0]);
    expect(m.selected).toHaveBeenCalledExactlyOnceWith({ where: { run_id: "run-1", transfer_id: "transfer-1" }, select: { id: true } });
    expect(m.position).toHaveBeenCalledExactlyOnceWith({ where: { run_id: "run-1", transfer_id: { not: null }, id: { lte: "decision-101" } } });
    expect(m.review).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([{ historicalConfirmed: "" }, { evidenceKind: "SAME_PERSON" }, { evidenceReference: "reference with spaces" }, { correspondence: "Same client" }, { expectedTargetVersion: "-1" }, { transferId: "unsafe/id" }])("invalid form yields fixed feedback before source access: %j", async (override) => {
    await expect(prepareHistoricalAcatPair(form(override))).rejects.toThrow("?message=historical_invalid");
    expect(m.source).not.toHaveBeenCalled(); expect(m.scope).not.toHaveBeenCalled();
  });
  it("invalid input retains only opaque comparison coordinates, never external return destinations or evidence text", async () => {
    await expect(prepareHistoricalAcatPair(form({ correspondence: "too short", returnTo: "https://foreign.invalid/" })))
      .rejects.toThrow("?message=historical_invalid&historical=transfer-1&record=record-1");
    await expect(prepareHistoricalAcatPair(form({ transferId: "//foreign.invalid", recordId: "private record" })))
      .rejects.toThrow("REDIRECT:/acat-link-review?message=historical_invalid");
  });
  it("source outage is unavailable, not falsely described as changed evidence", async () => {
    m.source.mockRejectedValue(new Error("private upstream diagnostic"));
    await expect(prepareHistoricalAcatPair(form())).rejects.toThrow("?message=unavailable");
    expect(m.scope).not.toHaveBeenCalled(); expect(m.persist).not.toHaveBeenCalled();
  });
  it("source expiry after manifest persistence aborts the same transaction", async () => {
    m.validate.mockImplementation(() => { throw new Error("source expired while waiting for manifest lock"); });
    await expect(prepareHistoricalAcatPair(form())).rejects.toThrow("?message=stale");
    expect(m.persist).toHaveBeenCalledOnce();
    expect(m.validate.mock.invocationCallOrder[0]).toBeGreaterThan(m.persist.mock.invocationCallOrder[0]);
    expect(m.revalidate).not.toHaveBeenCalled();
  });
  it("missing historical confirmation gives actionable fixed feedback", async () => {
    m.review.mockResolvedValue({ result: "ineligible", reason: "historical_confirmation_required" });
    await expect(reviewAcatDecision(form({ decisionId: "decision-1", reviewVersion: "0", evidenceDigest: "c".repeat(64), action: "ACCEPT", historicalConfirmed: "" }))).rejects.toThrow("?message=historical_invalid");
    expect(m.review).toHaveBeenCalledWith(tx, actor, expect.objectContaining({ historicalConfirmed: false }), m.hold);
  });
  it("a stale current proof creates no run and exposes no private error detail", async () => {
    m.build.mockImplementation(() => { throw new Error("private concurrent target diagnostic"); });
    await expect(prepareHistoricalAcatPair(form())).rejects.toThrow("?message=stale");
    expect(m.persist).not.toHaveBeenCalled(); expect(m.revalidate).not.toHaveBeenCalled();
  });
});
function sourceWithoutRecords() { const { source: origin, directory, observedAt } = source; return { source: origin, directory, observedAt }; }
