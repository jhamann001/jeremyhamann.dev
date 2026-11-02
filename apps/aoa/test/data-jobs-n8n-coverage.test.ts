import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { collectN8nJob } from "@/lib/data-jobs/providers/n8n";
import { N8N_MAX_CHECKPOINT_BYTES, N8N_MAX_PENDING_EXECUTIONS, parseN8nCollectionState, parseN8nCoverageEvidence,
  type N8nCollectionState, type N8nCoverageEvidence } from "@/lib/data-jobs/providers/n8n-coverage";
import type { JobDefinition } from "@/lib/data-jobs/contracts";

const now = new Date("2026-09-18T16:10:00.000Z");
const def: JobDefinition = {
  id: "dev-synthetic", name: "Synthetic import", source: "Synthetic", environment: "dev", provider: "n8n",
  providerId: "SyntheticFlow123", trigger: "Schedule", runner: "n8n", destination: "Synthetic mirror", consumers: ["Synthetic view"],
  owner: "Operations", jobUrl: "https://n8n-dev.example/workflow/SyntheticFlow123", expectedEnabled: true, graceSeconds: 900, maxRunSeconds: 1800,
};
const proof: N8nCoverageEvidence = {
  schemaVersion: 1, proofId: "synthetic-reviewed-contract-v1", environment: "dev", providerId: def.providerId,
  deployedVersion: "2.34.0", verifiedAt: "2026-09-17T16:00:00.000Z", expiresAt: "2026-09-24T16:00:00.000Z",
  startFiltersVerified: true, pendingStatusFiltersVerified: true, metadataOnlyDetailVerified: true, retentionHours: 72,
  seed: { observedAt: "2026-09-17T16:00:00.000Z", pendingExecutionIds: [], complete: true },
};
const checkpoint: N8nCollectionState = {
  schemaVersion: 1, proofId: proof.proofId, startedCoverageFrom: proof.seed.observedAt,
  startedCoverageThrough: "2026-09-18T16:05:00.000Z", pendingExecutionIds: [],
};
const baseConfig = { baseUrl: "https://n8n-dev.example", apiKey: "synthetic-api-key" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const workflow = (settings: Record<string, unknown> = { saveDataSuccessExecution: "all", saveDataErrorExecution: "all" }) => ({
  id: def.providerId, active: true, activeVersionId: "published-v1", settings: { timezone: "America/New_York", ...settings },
  activeVersion: { versionId: "published-v1", nodes: [{ type: "n8n-nodes-base.scheduleTrigger", parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 15 }] } } }] },
});
const execution = (id: string, status = "success", overrides: Record<string, unknown> = {}) => ({
  id, workflowId: def.providerId, status, startedAt: "2026-09-18T16:05:00Z", stoppedAt: "2026-09-18T16:06:00Z", retryOf: null, ...overrides,
});
const fetchMock = vi.fn();
function standardFetch(options: {
  starts?: unknown[]; active?: Partial<Record<string, unknown[]>>; details?: Record<string, unknown>; settings?: Record<string, unknown>;
} = {}) {
  fetchMock.mockImplementation((url: URL) => {
    if (url.pathname.startsWith("/api/v1/workflows/")) return Promise.resolve(json(workflow(options.settings)));
    if (url.pathname === "/api/v1/executions") {
      const status = url.searchParams.get("status");
      return Promise.resolve(json({ data: status ? options.active?.[status] ?? [] : options.starts ?? [], nextCursor: null }));
    }
    const value = options.details?.[url.pathname.split("/").at(-1)!];
    return Promise.resolve(value instanceof Response ? value : json(value ?? {}, value ? 200 : 404));
  });
}
const collect = (state: N8nCollectionState | null = checkpoint, evidence = proof) => collectN8nJob(def, now,
  { ...baseConfig, incremental: { evidence, state } });
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("reviewed n8n start discovery with completion-window accounting", () => {
  it("bounds the start cohort and independently queries every nonterminal state, never payloads", async () => {
    standardFetch({ starts: [execution("new-terminal")] });
    const result = await collect();
    expect(result).toMatchObject({ coverage: "partial", code: "provider_null_start_history_unverified" });
    expect(result.n8nCheckpoint).toMatchObject({ startedCoverageThrough: now.toISOString(), pendingExecutionIds: [] });
    const listUrls = fetchMock.mock.calls.map(([url]) => url as URL).filter((url) => url.pathname === "/api/v1/executions");
    expect(listUrls[4].searchParams.get("startedAfter")).toBe("2026-09-18T16:04:00.000Z");
    expect(listUrls[4].searchParams.get("startedBefore")).toBe(now.toISOString());
    expect(listUrls.slice(0, 4).map((url) => url.searchParams.get("status"))).toEqual(["running", "waiting", "new", "unknown"]);
    expect(listUrls.every((url) => url.searchParams.get("includeData") === "false")).toBe(true);
    expect(listUrls.slice(0, 4).every((url) => !url.searchParams.has("startedAfter"))).toBe(true);
  });
  it("captures an old-started execution finishing now even when the start cohort is empty", async () => {
    standardFetch({ details: { long: execution("long", "error", { startedAt: "2026-09-01T10:00:00Z", stoppedAt: "2026-09-18T16:09:00Z" }) } });
    const result = await collect({ ...checkpoint, pendingExecutionIds: ["long"] });
    expect(result).toMatchObject({ coverage: "partial", code: "provider_null_start_history_unverified" });
    expect(result.runs[0]).toMatchObject({ status: "FAILED", startedAt: "2026-09-01T10:00:00.000Z", finishedAt: "2026-09-18T16:09:00.000Z" });
    expect(result.n8nCheckpoint?.pendingExecutionIds).toEqual([]);
    expect(fetchMock.mock.calls.at(-1)?.[0].searchParams.get("includeData")).toBe("false");
  });
  it("keeps queued null-start and suspended stoppedAt executions pending rather than completed", async () => {
    const queued = execution("queued", "new", { startedAt: null, stoppedAt: null });
    const waiting = execution("waiting", "waiting", { startedAt: "2026-09-01T10:00:00Z", stoppedAt: "2026-09-17T10:00:00Z" });
    standardFetch({ active: { new: [queued], waiting: [waiting] }, details: { queued, waiting } });
    const result = await collect();
    expect(result.n8nCheckpoint?.pendingExecutionIds).toEqual(["queued", "waiting"]);
    expect(result.runs.find((run) => run.id.endsWith(":waiting"))).toMatchObject({ status: "UNKNOWN", finishedAt: null, durationMs: null, code: "n8n_execution_waiting" });
    expect(result.runs.find((run) => run.id.endsWith(":queued"))).toMatchObject({ status: "RUNNING", startedAt: null, finishedAt: null });
  });
  it("requires a full 24h completion window after a reviewed pending seed", async () => {
    standardFetch();
    const seedAt = "2026-09-18T16:00:00.000Z";
    const result = await collect(null, { ...proof, verifiedAt: seedAt, seed: { ...proof.seed, observedAt: seedAt } });
    expect(result).toMatchObject({ coverage: "partial", code: "provider_completion_window_warming" });
    expect(result.n8nCheckpoint).toMatchObject({ startedCoverageFrom: seedAt, startedCoverageThrough: now.toISOString() });
  });
  it("retains missing pending IDs and does not move the start watermark", async () => {
    standardFetch({ starts: [execution("new-terminal")] });
    const result = await collect({ ...checkpoint, pendingExecutionIds: ["missing"] });
    expect(result).toMatchObject({ coverage: "partial", code: "provider_pending_execution_unavailable" });
    expect(result.n8nCheckpoint).toMatchObject({ startedCoverageThrough: checkpoint.startedCoverageThrough, pendingExecutionIds: ["missing"] });
    expect(result.runs).toHaveLength(1);
  });
  it("keeps a completion observed after the fixed window pending for the next poll", async () => {
    standardFetch({ details: { long: execution("long", "success", { stoppedAt: "2026-09-18T16:10:01Z" }) } });
    const result = await collect({ ...checkpoint, pendingExecutionIds: ["long"] });
    expect(result).toMatchObject({ coverage: "partial", code: "provider_null_start_history_unverified" });
    expect(result.runs).toEqual([]);
    expect(result.n8nCheckpoint?.pendingExecutionIds).toEqual(["long"]);
  });
  it("does not forget a run that finished between the status list and detail read", async () => {
    standardFetch({ active: { running: [execution("long", "running", { stoppedAt: null, startedAt: "2026-09-01T10:00:00Z" })] },
      details: { long: execution("long", "success", { startedAt: "2026-09-01T10:00:00Z", stoppedAt: "2026-09-18T16:09:00Z" }) } });
    const result = await collect();
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].status).toBe("SUCCEEDED");
    expect(result.n8nCheckpoint?.pendingExecutionIds).toEqual([]);
  });
  it("rejects ignored/out-of-range start filters without advancing", async () => {
    standardFetch({ starts: [execution("outside", "success", { startedAt: "2026-09-01T10:00:00Z" })] });
    const result = await collect();
    expect(result).toMatchObject({ coverage: "partial", code: "provider_start_filter_unverified", runs: [] });
    expect(result.n8nCheckpoint?.startedCoverageThrough).toBe(checkpoint.startedCoverageThrough);
  });
  it.each([{}, { saveDataSuccessExecution: "none", saveDataErrorExecution: "none" }])("never overrides unverified/disabled retention with a capability proof", async (settings) => {
    standardFetch({ settings });
    const result = await collect();
    expect(result.coverage).toBe("partial");
    expect(result.n8nCheckpoint?.invalidatedAt).toBe(now.toISOString());
    expect(result.n8nCheckpoint?.startedCoverageThrough).toBe(checkpoint.startedCoverageThrough);
  });
  it("does not heal a permanent retention gap merely because execution saving was reenabled", async () => {
    standardFetch();
    const result = await collect({ ...checkpoint, invalidatedAt: "2026-09-18T16:06:00.000Z" });
    expect(result).toMatchObject({ coverage: "partial", code: "provider_checkpoint_requires_review" });
    expect(result.n8nCheckpoint?.invalidatedAt).toBe("2026-09-18T16:06:00.000Z");
    expect(result.n8nCheckpoint?.startedCoverageThrough).toBe(checkpoint.startedCoverageThrough);
  });
  it("does not rebase over a retention gap or issue execution API calls", async () => {
    standardFetch();
    const old = "2026-09-14T16:00:00.000Z";
    const result = await collect(null, { ...proof, verifiedAt: old, seed: { ...proof.seed, observedAt: old } });
    expect(result).toMatchObject({ coverage: "partial", code: "provider_checkpoint_retention_gap" });
    expect(result.n8nCheckpoint).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps useful evidence but bounds pending refresh requests and advances no watermark on overflow", async () => {
    const pending = Array.from({ length: 40 }, (_, i) => String(i));
    standardFetch({ details: Object.fromEntries(pending.map((id) => [id, execution(id)])) });
    const result = await collect({ ...checkpoint, pendingExecutionIds: pending });
    expect(result).toMatchObject({ coverage: "partial", code: "provider_collection_budget_exceeded" });
    expect(fetchMock).toHaveBeenCalledTimes(33); // one workflow plus 32 metadata requests
    expect(result.n8nCheckpoint?.startedCoverageThrough).toBe(checkpoint.startedCoverageThrough);
    expect(result.n8nCheckpoint?.pendingExecutionIds).toHaveLength(13);
    expect(result.runs).toHaveLength(27);
  });
  it("preserves observed active evidence when repeated pagination prevents the later start query", async () => {
    standardFetch({ starts: [execution("same")] });
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: URL) => url.searchParams.get("status") === "running"
      ? Promise.resolve(json({ data: [execution("same", "running", { stoppedAt: null })], nextCursor: "repeat" })) : original(url));
    const result = await collect();
    expect(result).toMatchObject({ coverage: "partial", code: "provider_invalid_pagination" });
    expect(result.runs[0].status).toBe("RUNNING");
  });
  it("discovers a run that finishes between the active scan and the final start-cohort query", async () => {
    const run = execution("racing", "running", { startedAt: "2026-09-18T16:05:00Z", stoppedAt: null });
    let activeRead = false;
    standardFetch();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: URL) => {
      if (url.searchParams.get("status") === "running") { activeRead = true; return Promise.resolve(json({ data: [run], nextCursor: null })); }
      if (url.pathname === "/api/v1/executions" && !url.searchParams.has("status")) {
        return Promise.resolve(json({ data: activeRead ? [execution("racing", "error", { startedAt: run.startedAt })] : [], nextCursor: null }));
      }
      return original(url);
    });
    const result = await collect();
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].status).toBe("FAILED");
    expect(result.n8nCheckpoint?.pendingExecutionIds).toEqual([]);
  });
  it("does not claim a complete percentage when a never-started terminal outcome could fall between polls", async () => {
    standardFetch();
    const result = await collect();
    expect(result).toMatchObject({ coverage: "partial", code: "provider_null_start_history_unverified", runs: [] });
    expect(result.n8nCheckpoint?.startedCoverageThrough).toBe(now.toISOString());
  });
  it("persists proof invalidation on pending-capacity overflow without an oversized checkpoint", async () => {
    const active = Array.from({ length: N8N_MAX_PENDING_EXECUTIONS + 1 }, (_, i) => execution(`active-${i}`, "running", { stoppedAt: null }));
    standardFetch({ settings: { saveDataSuccessExecution: "none", saveDataErrorExecution: "none" }, active: { running: active },
      details: Object.fromEntries(active.map((entry) => [entry.id, entry])) });
    const result = await collect();
    expect(result).toMatchObject({ coverage: "partial", code: "provider_pending_capacity_exceeded" });
    expect(result.n8nCheckpoint).toMatchObject({ invalidatedAt: now.toISOString(), startedCoverageThrough: checkpoint.startedCoverageThrough, pendingExecutionIds: [] });
  });
});

describe("sanitized capability and checkpoint contracts", () => {
  it("strips unrelated metadata and rejects cross-environment or expired capability assumptions", () => {
    expect(parseN8nCoverageEvidence({ ...proof, private: "discard" }, def, now)).toEqual(proof);
    expect(() => parseN8nCoverageEvidence({ ...proof, environment: "prod" }, def, now)).toThrow("provider_capability_evidence_unverified");
    expect(() => parseN8nCoverageEvidence({ ...proof, expiresAt: now.toISOString() }, def, now)).toThrow("provider_capability_evidence_unverified");
    expect(() => parseN8nCoverageEvidence({ ...proof, seed: { ...proof.seed, complete: false } }, def, now)).toThrow("provider_capability_evidence_unverified");
    expect(() => parseN8nCoverageEvidence({ ...proof, deployedVersion: "unknown" }, def, now)).toThrow("provider_capability_evidence_unverified");
  });
  it("validates state continuity and confines IDs before URL construction", () => {
    expect(parseN8nCollectionState({ ...checkpoint, private: "discard" }, proof, now)).toEqual(checkpoint);
    for (const bad of [{ ...checkpoint, proofId: "other" }, { ...checkpoint, pendingExecutionIds: ["../credentials"] },
      { ...checkpoint, pendingExecutionIds: ["duplicate", "duplicate"] }, { ...checkpoint, startedCoverageThrough: "2026-09-19T00:00:00Z" },
      { ...checkpoint, startedCoverageFrom: "2026-09-16T00:00:00Z" }]) {
      expect(() => parseN8nCollectionState(bad, proof, now)).toThrow("provider_checkpoint_invalid");
    }
  });
  it("keeps the largest valid sanitized checkpoint under the database guard", () => {
    const pendingExecutionIds = Array.from({ length: N8N_MAX_PENDING_EXECUTIONS }, (_, i) => `${i}`.padEnd(128, "a"));
    const value = parseN8nCollectionState({ ...checkpoint, pendingExecutionIds }, proof, now);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(N8N_MAX_CHECKPOINT_BYTES);
    expect(() => parseN8nCollectionState({ ...checkpoint, pendingExecutionIds: [...pendingExecutionIds, "overflow"] }, proof, now)).toThrow("provider_checkpoint_invalid");
  });
});
