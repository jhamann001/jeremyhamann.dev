// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CedarRidgeDirectorySync } from "@prisma/client";
import { directoryStatusFromState } from "./repository";
import { assertPublishableSnapshot } from "./sync";
import { parseDirectoryRows } from "./source";
import { directoryRows } from "./test-fixtures";

const now = new Date("2026-09-25T13:00:00.000Z");
const state: CedarRidgeDirectorySync = { id: "global", installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", attemptGeneration: 1, publishedGeneration: 1,
  activeSnapshotId: "synthetic", lastAttemptAt: now, lastSuccessAt: now, sourceAsOf: now, sourceHealth: "FRESH",
  source: "synthetic", sourceFingerprint: "a".repeat(64), clientCount: 2, accountCount: 1, membershipCount: 2, lastErrorCode: null };
beforeEach(() => {
  vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "UPSTREAM_VERIFIED");
  vi.stubEnv("CLIENT_IDENTITY_ENABLED", "true"); vi.stubEnv("CLIENT_DIRECTORY_MAX_AGE_SECONDS", "3600");
  vi.stubEnv("CLIENT_DIRECTORY_SOURCE_MAX_AGE_SECONDS", "7200");
  vi.stubEnv("CLIENT_DIRECTORY_MAX_REMOVAL_PERCENT", "10");
});
afterEach(() => vi.unstubAllEnvs());
describe("freshness gates", () => {
  it("keeps enablement separate from verified health", () => {
    expect(directoryStatusFromState(state, now)).toMatchObject({ health: "FRESH", writeEligible: true, freshnessBasis: "UPSTREAM_VERIFIED" });
    vi.stubEnv("CLIENT_IDENTITY_ENABLED", "false");
    expect(directoryStatusFromState(state, now)).toMatchObject({ health: "FRESH", writeEligible: false });
  });
  it.each(["UPSTREAM_VERIFIED", "FETCH_SUCCESS"])("keeps the joint migration pause closed under %s with cutover disabled", (policy) => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", policy);
    vi.stubEnv("CLIENT_IDENTITY_ENABLED", "false");
    expect(directoryStatusFromState({ ...state, lastErrorCode: "JOINT_UPGRADE_PAUSED" }, now))
      .toMatchObject({ enabled: false, health: "UNAVAILABLE", writeEligible: false });
  });
  it.each([
    [{ lastSuccessAt: new Date(now.getTime() - 3_600_001) }, "STALE"],
    [{ sourceAsOf: new Date(now.getTime() - 7_200_001) }, "STALE"],
    [{ sourceHealth: "UNKNOWN" }, "UNKNOWN"],
    [{ sourceAsOf: null }, "UNKNOWN"],
    [{ sourceAsOf: new Date(now.getTime() + 300_001) }, "UNKNOWN"],
    [{ lastErrorCode: "SOURCE_INCOMPLETE" }, "UNAVAILABLE"],
    [{ activeSnapshotId: null }, "UNAVAILABLE"],
  ])("fails closed for %j", (change, health) => {
    expect(directoryStatusFromState({ ...state, ...change }, now)).toMatchObject({ health, writeEligible: false });
  });
  it("does not invent a freshness SLA", () => {
    vi.stubEnv("CLIENT_DIRECTORY_SOURCE_MAX_AGE_SECONDS", "");
    expect(directoryStatusFromState(state, now).health).toBe("UNKNOWN");
    expect(() => assertPublishableSnapshot(parseDirectoryRows(directoryRows(now.toISOString())), now)).toThrow("SOURCE_FRESHNESS_NOT_CONFIGURED");
  });
  it("requires an explicit publication removal limit even for the initial snapshot", () => {
    vi.stubEnv("CLIENT_DIRECTORY_MAX_REMOVAL_PERCENT", "");
    expect(() => assertPublishableSnapshot(parseDirectoryRows(directoryRows(now.toISOString())), now)).toThrow("SOURCE_REMOVAL_LIMIT_NOT_CONFIGURED");
  });
  it("rejects old or unsupported upstream health even when just fetched", () => {
    const snapshot = parseDirectoryRows(directoryRows(new Date(now.getTime() - 7_200_001).toISOString()));
    expect(() => assertPublishableSnapshot(snapshot, now)).toThrow("SOURCE_STALE");
    expect(() => assertPublishableSnapshot({ ...snapshot, sourceHealth: "UNKNOWN" }, now)).toThrow("SOURCE_UNVERIFIED");
  });
  it.each(["", "unexpected"])("retains strict upstream checks for policy %j", (policy) => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", policy);
    expect(directoryStatusFromState({ ...state, sourceHealth: "UNKNOWN", sourceAsOf: null }, now))
      .toMatchObject({ health: "UNKNOWN", freshnessBasis: "UPSTREAM_VERIFIED", writeEligible: false });
  });
  it("uses recent successful fetches only with explicit policy without requiring or inventing upstream evidence", () => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "FETCH_SUCCESS");
    vi.stubEnv("CLIENT_DIRECTORY_SOURCE_MAX_AGE_SECONDS", "");
    const unknown = { ...state, sourceHealth: "UNKNOWN", sourceAsOf: null };
    expect(directoryStatusFromState(unknown, now)).toMatchObject({ health: "FRESH", writeEligible: true,
      freshnessBasis: "FETCH_SUCCESS", sourceAsOf: null });
    expect(() => assertPublishableSnapshot({ ...parseDirectoryRows(directoryRows()), sourceHealth: "UNKNOWN", sourceAsOf: null }, now)).not.toThrow();
    expect(unknown.sourceHealth).toBe("UNKNOWN"); expect(unknown.sourceAsOf).toBeNull();
    vi.stubEnv("CLIENT_DIRECTORY_MAX_AGE_SECONDS", "");
    expect(directoryStatusFromState(unknown, now).health).toBe("UNKNOWN");
    expect(() => assertPublishableSnapshot({ ...parseDirectoryRows(directoryRows()), sourceHealth: "UNKNOWN", sourceAsOf: null }, now)).toThrow("SOURCE_FRESHNESS_NOT_CONFIGURED");
  });
  it.each([
    [{ lastSuccessAt: new Date(now.getTime() - 3_600_001) }, "STALE"],
    [{ sourceHealth: "STALE" }, "STALE"],
    [{ lastErrorCode: "SOURCE_HTTP_ERROR" }, "UNAVAILABLE"],
    [{ lastSuccessAt: new Date(now.getTime() + 300_001) }, "UNKNOWN"],
    [{ activeSnapshotId: null }, "UNAVAILABLE"],
  ])("still fails closed under fetch policy for %j", (change, health) => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "FETCH_SUCCESS");
    expect(directoryStatusFromState({ ...state, sourceAsOf: null, sourceHealth: "UNKNOWN", ...change }, now))
      .toMatchObject({ health, writeEligible: false, freshnessBasis: "FETCH_SUCCESS" });
  });
  it.each(["UPSTREAM_VERIFIED", "FETCH_SUCCESS"])("rejects explicitly stale sources under %s even without a watermark", (policy) => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", policy);
    expect(() => assertPublishableSnapshot({ ...parseDirectoryRows(directoryRows()), sourceHealth: "STALE", sourceAsOf: null }, now)).toThrow("SOURCE_STALE");
  });
  it.each(["UPSTREAM_VERIFIED", "FETCH_SUCCESS"])("cannot use %s to bypass partial or duplicate source validation", (policy) => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", policy);
    const partial = directoryRows(); partial.pop();
    expect(() => assertPublishableSnapshot(parseDirectoryRows(partial), now)).toThrow("SOURCE_INCOMPLETE");
    const duplicate = directoryRows(); duplicate[0].expected_clients = 3; duplicate.push({ ...duplicate[1] });
    expect(() => assertPublishableSnapshot(parseDirectoryRows(duplicate), now)).toThrow("SOURCE_DUPLICATE_CLIENT");
  });
});
