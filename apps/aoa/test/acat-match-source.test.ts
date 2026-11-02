import { describe, expect, it, vi } from "vitest";
import sourceFixture from "./fixtures/transfer-linkage-v1.json";
vi.mock("server-only", () => ({}));
import { transferLinkageConfiguration, validateTransferLinkageSnapshot } from "@/lib/data/acat-match-source";
import { acatEvidenceHash } from "@/lib/data/acat-match";

const expected = { baseUrl: "https://synthetic.example.invalid", installationId: sourceFixture.source.installationId, environment: "synthetic" as const };
const now = new Date("2026-09-26T12:00:01.000Z");

describe("linkage source boundary", () => {
  it("requires explicit independent URL, installation and environment with no production fallback", () => {
    expect(() => transferLinkageConfiguration({})).toThrow("NOT_CONFIGURED");
    expect(transferLinkageConfiguration({ TRANSFER_LINKAGE_URL: `${expected.baseUrl}/`,
      TRANSFER_LINKAGE_INSTALLATION_ID: expected.installationId, TRANSFER_LINKAGE_ENVIRONMENT: "synthetic" })).toEqual(expected);
    for (const url of ["http://localhost", "https://user:secret@example.invalid", "https://example.invalid/path", "https://example.invalid?q=x", "https://example.invalid#x"]) {
      expect(() => transferLinkageConfiguration({ TRANSFER_LINKAGE_URL: url,
        TRANSFER_LINKAGE_INSTALLATION_ID: expected.installationId, TRANSFER_LINKAGE_ENVIRONMENT: "synthetic" })).toThrow("NOT_CONFIGURED");
    }
  });

  it("consumes the producer's exact synthetic v1 JSON fixture", () => {
    expect(validateTransferLinkageSnapshot(sourceFixture, expected, now)).toEqual(sourceFixture);
  });

  it.each(["wrong installation", "wrong environment", "partial point", "bad count", "digest tampering", "unexpected PII", "stale"])("rejects %s", (scenario) => {
    const source = structuredClone(sourceFixture);
    if (scenario === "wrong installation") source.source.installationId = "wrong";
    if (scenario === "wrong environment") source.source.environment = "production";
    if (scenario === "partial point") source.complete = false;
    if (scenario === "bad count") source.recordCount++;
    if (scenario === "digest tampering") source.snapshotDigest = "0".repeat(64);
    if (scenario === "unexpected PII") Object.assign(source.records[0], { clientName: "must not be sent" });
    if (scenario === "stale") source.observedAt = "2026-09-25T00:00:00.000Z";
    expect(() => validateTransferLinkageSnapshot(source, expected, now)).toThrow();
  });

  it.each([["wrong installation", "wrong_source"], ["stale", "stale_snapshot"], ["digest tampering", "invalid_snapshot"],
    ["unexpected PII", "invalid_snapshot"]])("names a stable reason for %s (ticket)", (scenario, reason) => {
    const source = structuredClone(sourceFixture);
    if (scenario === "wrong installation") source.source.installationId = "wrong";
    if (scenario === "stale") source.observedAt = "2026-09-25T00:00:00.000Z";
    if (scenario === "digest tampering") source.snapshotDigest = "0".repeat(64);
    if (scenario === "unexpected PII") Object.assign(source.records[0], { clientName: "must not be sent" });
    expect(() => validateTransferLinkageSnapshot(source, expected, now)).toThrow(expect.objectContaining({ code: "SOURCE_UNAVAILABLE", reason }));
  });

  it("rejects duplicate record/holder identity and directory outages", () => {
    const duplicate = structuredClone(sourceFixture);
    duplicate.records.push(duplicate.records[0]);
    duplicate.recordCount++;
    expect(() => validateTransferLinkageSnapshot(duplicate, expected, now)).toThrow();
    const holder = structuredClone(sourceFixture);
    holder.records[0].cedarRidgeUserIds.push(holder.records[0].cedarRidgeUserIds[0]);
    expect(() => validateTransferLinkageSnapshot(holder, expected, now)).toThrow();
    const stale = structuredClone(sourceFixture);
    stale.directory.health = "STALE";
    expect(() => validateTransferLinkageSnapshot(stale, expected, now)).toThrow("DIRECTORY_UNAVAILABLE");
  });

  it("uses sorted complete candidate facts while equivalent publication metadata can change", () => {
    const source = structuredClone(sourceFixture);
    source.records.reverse();
    source.directory.snapshotId = "synthetic-equivalent";
    source.directory.publishedGeneration++;
    source.observedAt = now.toISOString();
    expect(validateTransferLinkageSnapshot(source, expected, now).snapshotDigest).toBe(sourceFixture.snapshotDigest);
    source.records[0].recordEvidenceDigest = "a".repeat(64);
    expect(() => validateTransferLinkageSnapshot(source, expected, now)).toThrow();
    source.snapshotDigest = acatEvidenceHash({ contractVersion: source.contractVersion, source: source.source, scope: source.scope,
      records: [...source.records].sort((a, b) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)
        .map((record) => [record.recordId, record.recordEvidenceDigest, record.accountEvidenceDigest]) });
    expect(validateTransferLinkageSnapshot(source, expected, now).snapshotDigest).not.toBe(sourceFixture.snapshotDigest);
  });

  it("matches the producer's codepoint ordering for case-varied record identifiers", () => {
    const source = structuredClone(sourceFixture);
    source.records = ["a", "A"].map((recordId) => ({ ...source.records[0], recordId }));
    source.recordCount = 2;
    source.snapshotDigest = acatEvidenceHash({ contractVersion: source.contractVersion, source: source.source, scope: source.scope,
      records: [source.records[1], source.records[0]].map((row) => [row.recordId, row.recordEvidenceDigest, row.accountEvidenceDigest]) });
    expect(validateTransferLinkageSnapshot(source, expected, now).snapshotDigest).toBe(source.snapshotDigest);
  });

  it("counts repeated historical account memberships once and rejects inconsistent account facts", () => {
    const source = structuredClone(sourceFixture);
    const receivingAccount = { ...source.records[0].receivingAccount,
      members: Array.from({ length: 8 }, (_, index) => ({ ...source.records[0].receivingAccount.members[0], cedarRidgeUserId: `synthetic-user-${index}` })) };
    source.records = Array.from({ length: 2501 }, (_, index) => ({ ...source.records[0], recordId: `synthetic-${String(index).padStart(4, "0")}`,
      receivingAccount: { ...receivingAccount, holderSetComplete: index !== 0 } }));
    source.recordCount = source.records.length;
    source.snapshotDigest = acatEvidenceHash({ contractVersion: source.contractVersion, source: source.source, scope: source.scope,
      records: source.records.map((row) => [row.recordId, row.recordEvidenceDigest, row.accountEvidenceDigest]) });
    expect(validateTransferLinkageSnapshot(source, expected, now).recordCount).toBe(2501);
    source.records[1].receivingAccount.status = "inconsistent status";
    expect(() => validateTransferLinkageSnapshot(source, expected, now)).toThrow("SOURCE_UNAVAILABLE");
  });

  it("enforces the membership limit across distinct accounts", () => {
    const source = structuredClone(sourceFixture);
    source.records = Array.from({ length: 201 }, (_, index) => ({ ...source.records[0], recordId: `synthetic-${String(index).padStart(4, "0")}`,
      receivingAccount: { ...source.records[0].receivingAccount, id: `synthetic-account-${index}`,
        members: Array.from({ length: 100 }, (_, member) => ({ ...source.records[0].receivingAccount.members[0], cedarRidgeUserId: `synthetic-user-${index}-${member}` })) } }));
    source.recordCount = source.records.length;
    source.snapshotDigest = acatEvidenceHash({ contractVersion: source.contractVersion, source: source.source, scope: source.scope,
      records: source.records.map((row) => [row.recordId, row.recordEvidenceDigest, row.accountEvidenceDigest]) });
    expect(() => validateTransferLinkageSnapshot(source, expected, now)).toThrow("SOURCE_UNAVAILABLE");
  });
});
