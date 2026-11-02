import {
  ACAT_MATCH_RULE_VERSION, type AcatMatchDecision, type AoaAcatCandidate,
  type AcatLinkRunMode, type LinkageSnapshot,
} from "../acat-link-contract";
import { summarizeCoverage, type CoverageCategory, type CoverageDisposition, type CoverageSummary } from "./accounting";
import { manifestDigest, sealPreparedManifest, type PreparedManifest } from "./manifest";

const categoryFor = (decision: AcatMatchDecision): CoverageCategory => ({
  preserve: "linked", propose: "proposed", review: "pending", exclude: "excluded", no_counterpart: "no_counterpart",
} as const)[decision.action];

/** The matcher owns rules. This adapter independently checks its population
 * accounting and proposed graph before any durable review manifest is built. */
export function prepareManifestFromMatches(input: {
  mode: AcatLinkRunMode;
  snapshot: LinkageSnapshot;
  targets: readonly AoaAcatCandidate[];
  targetBoundary: Date;
  decisions: readonly AcatMatchDecision[];
}): { manifest: PreparedManifest; summary: CoverageSummary; digest: string; idempotencyKey: string } {
  const sourceIds = new Set(input.snapshot.records.map((record) => record.recordId));
  const targetIds = new Set(input.targets.map((target) => target.transferId));
  const targetDecisions = new Map<string, AcatMatchDecision>();
  const sourceDecisions = new Map<string, AcatMatchDecision[]>();
  const proposedSources = new Set<string>();
  for (const decision of input.decisions) {
    if (decision.sourceCandidateSetDigest !== input.snapshot.snapshotDigest) {
      throw new Error("acat_reconciliation_candidate_proof_mismatch");
    }
    if (decision.transferId !== null) {
      if (!targetIds.has(decision.transferId) || targetDecisions.has(decision.transferId)) {
        throw new Error("acat_reconciliation_invalid_target_decisions");
      }
      targetDecisions.set(decision.transferId, decision);
    }
    if (decision.recordId !== null && sourceIds.has(decision.recordId)) {
      const rows = sourceDecisions.get(decision.recordId) ?? [];
      rows.push(decision); sourceDecisions.set(decision.recordId, rows);
    } else if (decision.transferId === null) {
      throw new Error("acat_reconciliation_foreign_source_decision");
    }
    if (decision.action === "propose") {
      if (!decision.recordId || !decision.transferId || !sourceIds.has(decision.recordId)
        || proposedSources.has(decision.recordId)) throw new Error("acat_reconciliation_conflicting_proposals");
      proposedSources.add(decision.recordId);
      const source = input.snapshot.records.find((row) => row.recordId === decision.recordId);
      const target = input.targets.find((row) => row.transferId === decision.transferId);
      if (!source || !target || decision.targetVersion !== target.linkVersion || decision.targetDigest !== target.evidenceDigest
        || decision.sourceRecordDigest !== source.recordEvidenceDigest || decision.sourceAccountDigest !== source.accountEvidenceDigest) {
        throw new Error("acat_reconciliation_candidate_proof_mismatch");
      }
    }
  }
  const dispositions: CoverageDisposition[] = input.targets.flatMap((target) => {
    const decision = targetDecisions.get(target.transferId);
    return decision ? [{ population: "aoa", id: target.transferId, category: categoryFor(decision) }] : [];
  });
  for (const record of input.snapshot.records) {
    const decisions = sourceDecisions.get(record.recordId);
    if (!decisions?.length) continue; // summarizeCoverage rejects the missing row.
    let category: CoverageCategory;
    if (decisions.some((row) => row.action === "preserve" && row.reason === "existing_link")) category = "linked";
    else if (decisions.length > 1) category = "pending";
    else category = categoryFor(decisions[0]);
    if (decisions.length > 1 && decisions.some((row) => row.action === "propose")) {
      throw new Error("acat_reconciliation_conflicting_proposals");
    }
    dispositions.push({ population: "tracker", id: record.recordId, category });
  }
  const summary = summarizeCoverage({
    tracker: input.snapshot.records.map((row) => ({ id: row.recordId, status: row.status, deleted: row.deletedAt !== null, externalReference: row.acatTransferId })),
    aoa: input.targets.map((row) => ({ id: row.transferId, stage: row.stage, archived: row.archived, acatRecordId: row.existingRecordId, acatTransferId: row.existingTransferUuid })),
    trackerBoundary: { readAt: input.snapshot.observedAt, complete: input.snapshot.complete, declaredCount: input.snapshot.recordCount },
    aoaBoundary: { readAt: input.targetBoundary.toISOString(), complete: true, declaredCount: input.targets.length },
    dispositions,
  });
  const manifest: PreparedManifest = {
    mode: input.mode,
    contractVersion: input.snapshot.contractVersion,
    ruleVersion: ACAT_MATCH_RULE_VERSION,
    installationId: input.snapshot.source.installationId,
    sourceScope: input.snapshot.scope,
    sourceDigest: input.snapshot.snapshotDigest,
    sourceCount: input.snapshot.recordCount,
    sourceComplete: input.snapshot.complete,
    targetDigest: manifestDigest([...input.targets].sort((a, b) => a.transferId < b.transferId ? -1 : a.transferId > b.transferId ? 1 : 0)
      .map((target) => ({ transferId: target.transferId, evidenceDigest: target.evidenceDigest, linkVersion: target.linkVersion }))),
    targetCount: input.targets.length,
    decisions: input.decisions.map((decision) => {
      const target = input.targets.find((row) => row.transferId === decision.transferId);
      return {
        ...decision,
        decisionKey: manifestDigest({ ...decision }),
        payload: target ? { targetBefore: {
          recordId: target.existingRecordId, transferUuid: target.existingTransferUuid, hold: target.hold,
        } } : null,
      };
    }),
  };
  return { manifest, summary, ...sealPreparedManifest(manifest) };
}
