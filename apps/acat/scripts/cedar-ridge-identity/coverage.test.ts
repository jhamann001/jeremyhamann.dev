// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acceptCoverage } from "./coverage";
import { main } from "./cli";
import { writeRestricted } from "./files";
import { buildManifest, summarizeManifest, verifyApproval, verifyManifestEvidence } from "./manifest";
import { reviewPacket } from "./review-packet";
import { importWarehouse } from "./warehouse";
import { evidence, tracker, USER_A, USER_B, NOW } from "./fixtures/synthetic";
import { sha256 } from "./canonical";

const assumption = { acceptedBy: "synthetic-owner", acceptedAt: NOW, reference: "synthetic-session", reason: "Assumed ongoing coverage based on established apps" };
const unknown = { ...evidence, upstreamFreshness: "unknown" as const };

describe("explicit owner coverage acceptance", () => {
  it("requires a strict, complete acceptance and never converts stale or verified evidence into an assumption", () => {
    for (const bad of [{ ...assumption, acceptedBy: " " }, { ...assumption, acceptedAt: "today" }, { ...assumption, reference: "" }, { ...assumption, reason: " " }, { ...assumption, approved: true }]) {
      expect(() => acceptCoverage(unknown, bad)).toThrow();
    }
    expect(() => acceptCoverage(evidence, assumption)).toThrow("COVERAGE_ASSUMPTION_REQUIRES_UNKNOWN_SOURCE");
    expect(() => acceptCoverage({ ...unknown, upstreamFreshness: "stale" }, assumption)).toThrow("COVERAGE_ASSUMPTION_REQUIRES_UNKNOWN_SOURCE");
    expect(() => acceptCoverage(acceptCoverage(unknown, assumption), assumption)).toThrow("COVERAGE_ASSUMPTION_ALREADY_RECORDED");
  });
  it("writes a new private evidence file, preserving the original unknown source", async () => {
    const folder = mkdtempSync(join(tmpdir(), "identity-check-coverage-"));
    const input = join(folder, "source.json"), output = join(folder, "source-assumed.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      writeRestricted(input, unknown);
      const original = readFileSync(input, "utf8");
      await main(["accept-coverage", "--evidence", input, "--accepted-by", assumption.acceptedBy, "--accepted-at", NOW, "--reference", assumption.reference, "--reason", assumption.reason, "--out", output]);
      expect(readFileSync(input, "utf8")).toBe(original);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ upstreamFreshness: "unknown", ownerCoverageAssumption: assumption });
      expect(statSync(output).mode & 0o777).toBe(0o600);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("owner-assumed-not-upstream-verified"));
    } finally { log.mockRestore(); rmSync(folder, { recursive: true, force: true }); }
  });
  it("labels the assumption in summary/review and requires new evidence and approval digests", () => {
    const source = acceptCoverage(unknown, assumption), manifest = buildManifest(tracker, source);
    expect(summarizeManifest(manifest)).toMatchObject({ sourceCoverage: { upstreamFreshness: "unknown", coverageBasis: "owner-assumed-not-upstream-verified", rowApprovalGranted: false } });
    expect(reviewPacket(manifest, source)).toContain("COVERAGE IS OWNER-ASSUMED");
    const old = buildManifest(tracker, unknown);
    expect(manifest.evidenceHash).not.toBe(old.evidenceHash);
    expect(() => verifyManifestEvidence(old, source)).toThrow("SOURCE_COVERAGE_CHANGED_SINCE_REVIEW");
    expect(() => verifyApproval(manifest, { manifestHash: sha256(old), actor: "synthetic-owner", reference: "synthetic-session" })).toThrow("MANIFEST_APPROVAL_MISMATCH");
    expect(manifest.rows.every((row) => row.decision.kind === "unresolved")).toBe(true);
  });
});

describe("canonical warehouse import", () => {
  const directory = [{ source: "canonical-v2", cedar_ridge_user_id: USER_A, name: "Preferred CRM Name" }, { source: "canonical-v2", cedar_ridge_user_id: USER_B, name: "Pre-CRM Person" }];
  it("preserves the authoritative canonical names without requiring every CRM ID in raw user", () => {
    expect(importWarehouse(directory, [], [], NOW, "synthetic").clients).toEqual([{ userId: USER_A, name: "Preferred CRM Name" }, { userId: USER_B, name: "Pre-CRM Person" }]);
  });
  it("rejects duplicate IDs, blank preferred names and legacy exports instead of inventing a winner or query fingerprint", () => {
    expect(() => importWarehouse([...directory, directory[0]], [], [], NOW, "synthetic")).toThrow("DUPLICATE_CLIENT_ID");
    expect(() => importWarehouse([{ ...directory[0], name: " " }], [], [], NOW, "synthetic")).toThrow();
    expect(() => importWarehouse([{ ...directory[0], source: "user" }], [], [], NOW, "synthetic")).toThrow();
  });
});
