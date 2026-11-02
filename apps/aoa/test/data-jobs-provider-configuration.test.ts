import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { getDataJobs } from "@/lib/data-jobs/registry";
import { n8nIncrementalConfiguration } from "@/lib/data-jobs/provider-configuration";
import { validateProviderCheckpoint } from "@/lib/data-jobs/validation";

const job = getDataJobs("dev")[0];
const now = new Date("2026-09-19T00:00:00.000Z");
const proof = {
  schemaVersion: 1, proofId: "synthetic-proof", environment: "dev", providerId: job.providerId,
  deployedVersion: "2.1.0", verifiedAt: "2026-09-18T00:00:00.000Z", expiresAt: "2026-09-25T00:00:00.000Z",
  startFiltersVerified: true, pendingStatusFiltersVerified: true, metadataOnlyDetailVerified: true,
  retentionHours: 72, seed: { observedAt: "2026-09-18T00:00:00.000Z", pendingExecutionIds: [], complete: true },
};
const state = { schemaVersion: 1, proofId: proof.proofId, startedCoverageFrom: proof.seed.observedAt,
  startedCoverageThrough: "2026-09-18T23:55:00.000Z", pendingExecutionIds: ["123"] };

describe("reviewed provider configuration and private checkpoints", () => {
  it("does not enable bounded completeness without an explicit per-job proof", () => {
    expect(n8nIncrementalConfiguration(job, now, undefined, state)).toEqual({ kind: "disabled" });
    expect(n8nIncrementalConfiguration(job, now, JSON.stringify([{ ...proof, environment: "prod" }]), state)).toEqual({ kind: "disabled" });
  });
  it("fails closed on malformed, duplicate, expired, unverified and oversized proof", () => {
    for (const raw of ["bad", "{}", "x".repeat(256001), JSON.stringify([proof, proof]),
      JSON.stringify([{ ...proof, expiresAt: now.toISOString() }]), JSON.stringify([{ ...proof, retentionHours: 1 }]),
      JSON.stringify([{ ...proof, pendingStatusFiltersVerified: false }])]) {
      expect(n8nIncrementalConfiguration(job, now, raw, state)).toEqual({ kind: "invalid" });
    }
  });
  it("uses only sanitized matching state and requires a new seed for a new proof", () => {
    const configured = n8nIncrementalConfiguration(job, now, JSON.stringify([proof]), { ...state, rawSecret: "never-persist" });
    expect(configured.kind).toBe("enabled");
    expect(JSON.stringify(configured)).not.toContain("never-persist");
    expect(configured).toMatchObject({ config: { state } });
    expect(n8nIncrementalConfiguration(job, now, JSON.stringify([{ ...proof, proofId: "new-proof" }]), state)).toMatchObject({ config: { state: null } });
    expect(n8nIncrementalConfiguration(job, now, JSON.stringify([proof]), { ...state, startedCoverageThrough: "2026-09-20T00:00:00.000Z" })).toEqual({ kind: "invalid" });
  });
  it("keeps invalidation durable and bounds checkpoint storage", () => {
    const checkpoint = validateProviderCheckpoint({ ...state, invalidatedAt: now.toISOString(), rawSecret: "never-persist" });
    expect(checkpoint).toEqual({ ...state, invalidatedAt: now.toISOString() });
    expect(() => validateProviderCheckpoint({ ...state, pendingExecutionIds: ["1", "1"] })).toThrow();
    expect(() => validateProviderCheckpoint({ ...state, pendingExecutionIds: Array.from({ length: 151 }, (_, index) => String(index)) })).toThrow();
    expect(() => validateProviderCheckpoint({ ...state, startedCoverageFrom: now.toISOString() })).toThrow();
  });
});
