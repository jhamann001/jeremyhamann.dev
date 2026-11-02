import "server-only";
import { Prisma } from "@prisma/client";
import { writeAudit, ACAT_LINK_PREPARE, ACAT_LINK_REVIEW } from "@/lib/audit";
import type { Identity } from "@/lib/rls";
import { normalizeAppRole } from "@/lib/auth/app-roles";
import type { AcatLinkDisposition } from "../acat-link-contract";
import { readHistoricalReviewContext } from "../acat-historical-review";
import { sealPreparedManifest, stableManifestJson, type ManifestJson, type PreparedManifest } from "./manifest";

function humanActor(identity: Identity): { role: "ADMIN" | "OPERATIONS"; email: string } {
  const role = normalizeAppRole(identity.role);
  const email = identity.email?.trim();
  if ((role !== "ADMIN" && role !== "OPERATIONS") || !email) throw new Error("acat_reconciliation_forbidden");
  return { role, email };
}

function storedJson(value: ManifestJson): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  // PostgreSQL jsonb's spaces can enlarge the encoded representation slightly.
  // Leave headroom below its independent 64 KiB CHECK constraint.
  if (Buffer.byteLength(stableManifestJson(value), "utf8") > 60_000) throw new Error("acat_reconciliation_payload_too_large");
  return value === null ? Prisma.JsonNull : value;
}

/** Caller owns an actual RLS-scoped transaction. Pure preview never calls this
 * function. No business/link fields are modified by preparing a run. */
export async function prepareReconciliationRun(
  tx: Prisma.TransactionClient,
  identity: Identity,
  input: { manifest: PreparedManifest; sourceBoundary: ManifestJson; targetBoundary: Date; summary: ManifestJson },
): Promise<{ runId: string; created: boolean; manifestDigest: string }> {
  const actor = identity.role === "INGEST" && identity.email == null && input.manifest.mode === "AUTOMATIC"
    ? { role: "INGEST" as const, email: null }
    : humanActor(identity);
  if (!Number.isFinite(input.targetBoundary.getTime())) throw new Error("acat_reconciliation_invalid_boundary");
  const sealed = sealPreparedManifest(input.manifest);
  const boundary = input.sourceBoundary;
  const source = boundary !== null && typeof boundary === "object" && !Array.isArray(boundary) ? boundary.source : null;
  if (!source || typeof source !== "object" || Array.isArray(source)
    || source.system !== "transfer-tracker" || source.installationId !== input.manifest.installationId
    || !["production", "synthetic"].includes(typeof source.environment === "string" ? source.environment : "")) {
    throw new Error("acat_reconciliation_invalid_source_boundary");
  }
  const sourceBoundary = storedJson(input.sourceBoundary);
  const summary = storedJson(input.summary);
  const payloads = input.manifest.decisions.map((item) => {
    const { decisionKey: _key, payload: context, ...decision } = item;
    return storedJson({ decision: { ...decision }, context });
  });
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${sealed.idempotencyKey})::bigint)::text AS locked`;
  const existing = await tx.acatLinkRun.findUnique({
    where: { idempotency_key: sealed.idempotencyKey }, select: { id: true, manifest_digest: true },
  });
  if (existing) {
    if (existing.manifest_digest !== sealed.digest) throw new Error("acat_reconciliation_manifest_conflict");
    return { runId: existing.id, created: false, manifestDigest: sealed.digest };
  }
  const run = await tx.acatLinkRun.create({ data: {
    mode: input.manifest.mode, status: "PREPARED",
    contract_version: input.manifest.contractVersion, rule_version: input.manifest.ruleVersion,
    installation_id: input.manifest.installationId, source_scope: input.manifest.sourceScope,
    source_boundary: sourceBoundary, source_digest: input.manifest.sourceDigest,
    source_count: input.manifest.sourceCount, source_complete: input.manifest.sourceComplete,
    target_boundary: input.targetBoundary, target_digest: input.manifest.targetDigest, target_count: input.manifest.targetCount,
    manifest_digest: sealed.digest, idempotency_key: sealed.idempotencyKey,
    created_by: actor.email, created_role: actor.role, summary,
    decisions: { create: input.manifest.decisions.map((decision, index) => ({
      decision_key: decision.decisionKey, record_id: decision.recordId, transfer_id: decision.transferId,
      reason: decision.reason, action: decision.action, rule_version: decision.ruleVersion,
      evidence_digest: decision.evidenceDigest, expected_target_version: decision.targetVersion,
      target_evidence_digest: decision.targetDigest, source_candidate_set_digest: decision.sourceCandidateSetDigest,
      payload: payloads[index],
    })) },
  }, select: { id: true } });
  await writeAudit(tx, actor, {
    action: ACAT_LINK_PREPARE, entityType: "acat_link_run", entityId: run.id,
    detail: { mode: input.manifest.mode, sourceCount: input.manifest.sourceCount, targetCount: input.manifest.targetCount, decisionCount: input.manifest.decisions.length },
  });
  return { runId: run.id, created: true, manifestDigest: sealed.digest };
}

export type ReviewPolicyChange = {
  action: "HOLD" | "RESUME";
  transferId: string;
  expectedTargetVersion: number;
  decisionId: string;
};
export type ReviewPolicyWriter = (tx: Prisma.TransactionClient, identity: Identity, change: ReviewPolicyChange) => Promise<boolean>;
export type ReviewInput = {
  decisionId: string;
  expectedReviewVersion: number;
  expectedEvidenceDigest: string;
  action: AcatLinkDisposition;
  reason: string | null;
  /** Required for the guarded policy writer, never inferred from stale proof. */
  expectedTargetVersion?: number;
  /** A distinct, explicit confirmation of human historical evidence. */
  historicalConfirmed?: boolean;
};
export type ReviewResult = { result: "saved"; reviewVersion: number } | { result: "conflict" | "not_found" | "ineligible"; reason?: "historical_confirmation_required" };

/** A human review appends an event and audits in the same transaction. HOLD
 * and RESUME delegate the target mutation to B's sole guarded writer. A false
 * callback must be side-effect free; a thrown error rolls everything back. */
export async function reviewReconciliationDecision(
  tx: Prisma.TransactionClient, identity: Identity, input: ReviewInput, policyWriter?: ReviewPolicyWriter,
): Promise<ReviewResult> {
  const actor = humanActor(identity);
  const actions = new Set<AcatLinkDisposition>(["PENDING", "ACCEPT", "REJECT", "HOLD", "RESUME"]);
  const reason = input.reason?.trim() || null;
  if (!input.decisionId || !Number.isSafeInteger(input.expectedReviewVersion) || input.expectedReviewVersion < 0
    || !/^[a-f0-9]{64}$/.test(input.expectedEvidenceDigest) || !actions.has(input.action)
    || (reason !== null && reason.length > 2_000)) throw new Error("acat_reconciliation_invalid_review");
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app.acat_link_decision WHERE id = ${input.decisionId} FOR UPDATE`;
  if (!locked.length) return { result: "not_found" };
  const decision = await tx.acatLinkDecision.findUnique({ where: { id: input.decisionId } });
  if (!decision) return { result: "not_found" };
  if (decision.review_version !== input.expectedReviewVersion || decision.evidence_digest !== input.expectedEvidenceDigest) return { result: "conflict" };
  // Historical completed applications remain auditable. They are not rewritten
  // into a newly accepted proposal; compensation is a separate guarded action.
  if (["APPLIED", "NOOP", "UNDONE"].includes(decision.outcome) && input.action === "ACCEPT") return { result: "ineligible" };
  if ((input.action === "ACCEPT" || input.action === "REJECT") && (!decision.record_id || !decision.transfer_id)) return { result: "ineligible" };
  if (input.action === "ACCEPT" && ["preserve", "exclude", "no_counterpart"].includes(decision.action)) return { result: "ineligible" };
  const historical = readHistoricalReviewContext(decision.payload);
  if (historical && input.action === "RESUME") return { result: "ineligible" };
  if (historical && input.action === "ACCEPT" && input.historicalConfirmed !== true) return { result: "ineligible", reason: "historical_confirmation_required" };
  if (historical && input.action === "ACCEPT" && decision.action !== "review") return { result: "ineligible" };
  if (input.action === "HOLD" || input.action === "RESUME") {
    if (!decision.transfer_id || input.expectedTargetVersion === undefined || !Number.isSafeInteger(input.expectedTargetVersion)
      || input.expectedTargetVersion < 0 || !policyWriter) return { result: "ineligible" };
    const changed = await policyWriter(tx, actor, {
      action: input.action, transferId: decision.transfer_id, expectedTargetVersion: input.expectedTargetVersion, decisionId: decision.id,
    });
    if (!changed) return { result: "conflict" };
  }
  const revision = decision.review_version + 1;
  // Automation policy and pair approval are independent. Resuming a held
  // transfer must never erase a durable rejection of this particular pair.
  const policyOnly = input.action === "HOLD" || input.action === "RESUME";
  const updated = await tx.acatLinkDecision.updateMany({
    where: { id: decision.id, review_version: input.expectedReviewVersion, evidence_digest: input.expectedEvidenceDigest },
    data: {
      review_version: revision,
      // Pair approval attribution belongs to its ACCEPT/REJECT decision.
      // Policy actor/time/reason is recorded by the append-only event below.
      ...(policyOnly ? {} : { disposition: input.action, reviewed_by: actor.email, reviewed_at: new Date(), review_reason: reason }),
    },
  });
  if (updated.count !== 1) throw new Error("acat_reconciliation_review_cas_failed");
  await tx.acatLinkReviewEvent.create({ data: {
    decision_id: decision.id, revision, action: input.action, reason, actor_email: actor.email,
  } });
  await writeAudit(tx, actor, {
    action: ACAT_LINK_REVIEW, entityType: "acat_link_decision", entityId: decision.id,
    detail: { action: input.action, revision, reasonPresent: reason !== null },
  });
  return { result: "saved", reviewVersion: revision };
}
