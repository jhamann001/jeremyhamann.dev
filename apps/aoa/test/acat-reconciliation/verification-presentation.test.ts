import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { preparedManifest, snapshot } from "./fixtures";
import { sealPreparedManifest } from "@/lib/data/acat-reconciliation/manifest";
vi.mock("server-only", () => ({}));
import { verifyReconciliationRun } from "@/lib/data/acat-reconciliation/verification";

function storedRun() {
  const manifest = preparedManifest();
  const item = manifest.decisions[0];
  const { decisionKey, payload, ...decision } = item;
  const sealed = sealPreparedManifest(manifest);
  return {
    id: "run", mode: manifest.mode, installation_id: manifest.installationId, source_scope: manifest.sourceScope,
    source_digest: manifest.sourceDigest, source_count: 1, source_complete: true, target_digest: manifest.targetDigest, target_count: 1,
    contract_version: 1, rule_version: manifest.ruleVersion, source_boundary: { source: snapshot().source },
    manifest_digest: sealed.digest, idempotency_key: sealed.idempotencyKey,
    decisions: [{ id: "decision", decision_key: decisionKey, record_id: item.recordId, transfer_id: item.transferId,
      action: item.action, reason: item.reason, rule_version: item.ruleVersion, evidence_digest: item.evidenceDigest,
      expected_target_version: item.targetVersion, target_evidence_digest: item.targetDigest,
      source_candidate_set_digest: item.sourceCandidateSetDigest, payload: { decision, context: payload }, outcome: "PENDING" }],
  };
}

describe("verified display coverage", () => {
  it("exposes counts only after the whole saved manifest validates", async () => {
    const run = storedRun();
    const tx = { acatLinkRun: { findUnique: vi.fn(async () => run) }, transfer: { findMany: vi.fn(async () => []) } };
    const verify = () => verifyReconciliationRun(tx as unknown as Prisma.TransactionClient, { role: "OPERATIONS", email: "synthetic@example.invalid" }, "run");
    const valid = await verify();
    expect(valid?.manifestValid).toBe(true);
    expect(valid?.coverage).toMatchObject({ aoa: { total: 1, categories: { proposed: 1 } }, tracker: { total: 1, categories: { proposed: 1 } } });
    expect(valid?.outcomes.PENDING).toBe(1);
    run.decisions[0].action = "preserve";
    expect(await verify()).toMatchObject({ manifestValid: false, coverage: null });
  });
});
