// @vitest-environment node
import { describe, expect, it } from "vitest";
import fixture from "./testing/snapshot-v1.json";
import { canonicalCrmId, canonicalTransferId, projectRecord, projectSnapshot } from "./projection";
import { TRANSFER_LINKAGE_MAX_RECORDS } from "./contract";
import { syntheticInputs, syntheticSnapshot, SYNTHETIC_TRANSFERS } from "./testing/fixtures";

describe("linkage evidence projection", () => {
  it("keeps the shared JSON fixture identical to the actual producer contract", () => {
    expect(syntheticSnapshot("baseline", new Date("2026-09-26T12:00:00.000Z"))).toEqual(fixture);
  });
  it("uses complete sorted junction holders, exposing no names/raw account numbers/cache", () => {
    const data = syntheticInputs();
    data.records[1].clientLinks.reverse();
    const result = projectRecord(data.records[1], data.accounts[1], data.directory);
    expect(result.cedarRidgeUserIds).toEqual([...result.cedarRidgeUserIds].sort());
    expect(result.receivingAccount).toMatchObject({ holderSetComplete: true, verification: "VERIFIED" });
    const wire = JSON.stringify(result);
    for (const hidden of ["SYNTHETIC002", "clientName", "canonicalName", "identitySetIds", "apexAccountId", "normalizedAccountNumber"]) expect(wire).not.toContain(hidden);
  });

  it("binds identity-only edits and transaction changes independently of operational timestamps", () => {
    const { records, accounts, directory } = syntheticInputs();
    const before = projectRecord(records[0], accounts[0], directory);
    for (const change of [{ identityVersion: 4 }, { direction: "OUT" }, { status: "Completed" },
      { controlNumber: "OTHER" }, { originalClientRequestDate: "2026-09-02" }, { apexAccountId: "OTHER" }]) {
      expect(projectRecord({ ...records[0], ...change }, accounts[0], directory).recordEvidenceDigest).not.toBe(before.recordEvidenceDigest);
    }
  });

  it("membership changes alter account/full-set digest without changing identityVersion or record digest", () => {
    const before = syntheticSnapshot("baseline");
    const after = syntheticSnapshot("membership-changed");
    const row = (value: typeof before) => value.records.find((r) => r.recordId === "synthetic-acat-single")!;
    expect(row(after).identityVersion).toBe(row(before).identityVersion);
    expect(row(after).recordEvidenceDigest).toBe(row(before).recordEvidenceDigest);
    expect(row(after).accountEvidenceDigest).not.toBe(row(before).accountEvidenceDigest);
    expect(row(after).receivingAccount.verification).toBe("HOLDER_MISMATCH");
    expect(after.snapshotDigest).not.toBe(before.snapshotDigest);
  });

  it("equivalent republished facts and read times retain every substantive digest", () => {
    const input = syntheticInputs();
    const before = projectRecord(input.records[0], input.accounts[0], input.directory);
    input.directory.snapshotId = "republished";
    input.directory.publishedGeneration++;
    input.directory.lastSuccessAt = "2026-09-26T13:00:00.000Z";
    input.accounts[0].lastSeenSnapshotId = "republished";
    for (const m of input.accounts[0].members) { m.lastSeenSnapshotId = "republished"; m.client.lastSeenSnapshotId = "republished"; }
    const after = projectRecord(input.records[0], input.accounts[0], input.directory);
    expect(after.recordEvidenceDigest).toBe(before.recordEvidenceDigest);
    expect(after.accountEvidenceDigest).toBe(before.accountEvidenceDigest);
    expect(syntheticSnapshot("baseline", new Date(0)).snapshotDigest).toBe(syntheticSnapshot("baseline", new Date()).snapshotDigest);
  });

  it("retains lifecycle/deleted/unlinked history and rejects an overflowing full snapshot", () => {
    const input = syntheticInputs();
    for (const status of ["Completed", "Canceled", "Purged", "Rejected"]) {
      const row = projectRecord({ ...input.records[0], status, deletedAt: new Date(0), clientLinks: [] }, null, input.directory);
      const snapshot = projectSnapshot(input.source, input.directory, new Date(), [row]);
      expect(snapshot.records[0]).toMatchObject({ status, deletedAt: new Date(0).toISOString(), cedarRidgeUserIds: [] });
    }
    expect(projectSnapshot(input.source, input.directory, new Date(), []).recordCount).toBe(0);
    const row = syntheticSnapshot().records[0];
    expect(() => projectSnapshot(input.source, input.directory, new Date(), Array(TRANSFER_LINKAGE_MAX_RECORDS + 1).fill(row))).toThrow("SNAPSHOT_OVERFLOW");
  });

  it("refuses verification for stale directory, unresolved/missing account and incomplete joint sets", () => {
    expect(syntheticSnapshot("stale-directory").records.every((r) => r.receivingAccount.verification === "SOURCE_UNAVAILABLE")).toBe(true);
    const input = syntheticInputs();
    expect(projectRecord(input.records[0], null, input.directory).receivingAccount.verification).toBe("ACCOUNT_UNRESOLVED");
    expect(projectRecord({ ...input.records[0], apexAccountId: "" }, null, input.directory).receivingAccount.verification).toBe("MISSING_ACCOUNT");
    expect(projectRecord({ ...input.records[0], apexAccountId: "••••0001" }, null, input.directory).receivingAccount.verification).toBe("ACCOUNT_UNRESOLVED");
    expect(projectRecord({ ...input.records[1], clientLinks: [input.records[1].clientLinks[0]] }, input.accounts[1], input.directory).receivingAccount.verification).toBe("HOLDER_MISMATCH");
  });

  it("retains competing external UUIDs instead of picking the newest", () => {
    const snapshot = syntheticSnapshot("new-competitor");
    expect(snapshot.records.filter((r) => r.acatTransferId === SYNTHETIC_TRANSFERS[0])).toHaveLength(2);
    expect(snapshot.snapshotDigest).not.toBe(syntheticSnapshot().snapshotDigest);
    expect(canonicalTransferId("N/A")).toBeNull();
  });

  it("canonicalizes CRM IDs without losing 15-character case and never asserts deal provenance", () => {
    const first = canonicalCrmId("006Ab0000000001")!;
    expect(first).toHaveLength(18);
    expect(canonicalCrmId(first.toLowerCase())).toBe(first);
    expect(canonicalCrmId("006ab0000000001")).not.toBe(first);
    expect(canonicalCrmId("006Ab0000000001999")).toBeNull();
    expect(canonicalCrmId("crm ticket text")).toBeNull();
    const input = syntheticInputs();
    expect(projectRecord({ ...input.records[0], crmDealId: "006Ab0000000001" }, input.accounts[0], input.directory))
      .toMatchObject({ crmDealId: first, crmDealIdProvenance: "LEGACY_UNVERIFIED" });
  });
});
