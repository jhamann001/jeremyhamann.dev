import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ writeAudit: vi.fn(), ACAT_LINK_PREPARE: "PREPARE", ACAT_LINK_REVIEW: "REVIEW" }));
import { acatEvidenceHash, matchAcatPopulation } from "@/lib/data/acat-match";
import { historicalAcatEligibility, historicalAcatEvidenceSchema, historicalAcatPairBlocker, makeHistoricalAcatIntent,
  prepareHistoricalAcatManifest, readHistoricalReviewContext, readHistoricalAcatIntentWithinScope, historicalUndoAuditIntent, type HistoricalAcatSelection } from "@/lib/data/acat-historical-review";
import { reviewReconciliationDecision } from "@/lib/data/acat-reconciliation/persistence";
import { sealPreparedManifest } from "@/lib/data/acat-reconciliation/manifest";
import { sourceRecord, targetRecord, snapshot, TEST_AT } from "./acat-reconciliation/fixtures";

function fixture() {
  const record = { ...sourceRecord(), workflow: "ACAT", status: "Completed" };
  const target = { ...targetRecord(), stage: "FUNDED", hold: true, existingTransferUuid: null, receivingAccount: null, transactionReference: null };
  const source = snapshot([record]);
  source.snapshotDigest = acatEvidenceHash({ contractVersion: source.contractVersion, source: source.source, scope: source.scope,
    records: source.records.map((r) => [r.recordId, r.recordEvidenceDigest, r.accountEvidenceDigest]) });
  const selection: HistoricalAcatSelection = { transferId: target.transferId, recordId: record.recordId, historicalConfirmed: "yes",
    expectedTargetVersion: target.linkVersion, expectedTargetDigest: target.evidenceDigest, expectedSourceDigest: source.snapshotDigest,
    evidenceKind: "TRANSFER_DOCUMENT", evidenceReference: "confirmation-12345",
    correspondence: "Operations reviewed the original transfer confirmation and identified these exact two transfer records." };
  return { target, record, source, selection, intent: makeHistoricalAcatIntent([], []) };
}
const prepare = (f: ReturnType<typeof fixture>) => prepareHistoricalAcatManifest({ snapshot: f.source, targets: [f.target], rejectedPairs: [], intent: f.intent, selection: f.selection, now: TEST_AT });

describe("historical ACAT evidence and fixed eligibility", () => {
  it("seals a human-only pair from a held funded card without changing target or automatic matching", () => {
    const f = fixture(), before = JSON.stringify(f), prepared = prepare(f);
    const paired = prepared.manifest.decisions.find((d) => d.transferId === f.target.transferId)!;
    expect(paired).toMatchObject({ action: "review", recordId: f.record.recordId, reason: "missing_transaction_evidence" });
    expect(readHistoricalReviewContext({ context: paired.payload })).toMatchObject({ kind: "HISTORICAL_ACAT_REVIEW", intentDigest: f.intent.digest, confirmation: "SAME_TRANSFER_KEEP_HOLD" });
    expect(paired.payload).toMatchObject({ targetBefore: { hold: true, recordId: null, transferUuid: null } });
    expect(sealPreparedManifest(prepared.manifest)).toEqual({ digest: prepared.digest, idempotencyKey: prepared.idempotencyKey });
    expect(JSON.stringify(f)).toBe(before);
    expect(matchAcatPopulation(f.source, [f.target], { now: TEST_AT })).toMatchObject([{ action: "exclude", reason: "manual_hold" }, { action: "no_counterpart" }]);
  });
  it.each(["DECISION", "IN_TRANSFER", "FUNDED"])("allows the bounded target stage %s with full human evidence", (stage) => {
    const f = fixture(); f.target.stage = stage; expect(historicalAcatEligibility(f.target, f.record)).toBeNull();
    f.record.status = "Submitted"; expect(historicalAcatEligibility(f.target, f.record)).toBeNull();
  });
  it.each(["Canceled", "Rejected", "Purged", "Deferred", "unknown"])("does not broaden source lifecycle to %s", (status) => {
    const f = fixture(); f.record.status = status; expect(historicalAcatEligibility(f.target, f.record)).toBe("ineligible_source_lifecycle");
  });
  it.each(["CHECK", "WIRE", "ACH", "MANUAL", "unknown"])("does not recast non-ACAT rail %s", (fundingType) => {
    const f = fixture(); f.target.fundingType = fundingType; expect(historicalAcatEligibility(f.target, f.record)).toBe("not_acat_funding");
  });
  it("blocks unspecified, archived, deleted, outbound, wrong workflow/type and missing identity", () => {
    const f = fixture();
    expect(historicalAcatEligibility({ ...f.target, fundingType: null }, f.record)).toBe("funding_unspecified");
    expect(historicalAcatEligibility({ ...f.target, archived: true }, f.record)).toBe("archived_transfer");
    expect(historicalAcatEligibility({ ...f.target, stage: "OTHER" }, f.record)).toBe("ineligible_target_stage");
    expect(historicalAcatEligibility(f.target, { ...f.record, deletedAt: TEST_AT.toISOString() })).toBe("ineligible_source_lifecycle");
    expect(historicalAcatEligibility(f.target, { ...f.record, direction: "OUT" })).toBe("ineligible_source_lifecycle");
    expect(historicalAcatEligibility(f.target, { ...f.record, workflow: "OTHER" })).toBe("ineligible_source_lifecycle");
    expect(historicalAcatEligibility({ ...f.target, fundingType: "ACAT_PARTIAL" }, f.record)).toBe("funding_type_mismatch");
    expect(historicalAcatEligibility({ ...f.target, identityState: "missing" }, f.record)).toBe("missing_identity");
  });
  it("does not invent complete receiving holders for a joint source", () => {
    const f = fixture(); f.record.cedarRidgeUserIds.push("second-person"); f.record.receivingAccount.members.push({ ...f.record.receivingAccount.members[0], cedarRidgeUserId: "second-person" });
    expect(historicalAcatEligibility(f.target, f.record)).toBe("incomplete_joint_evidence");
  });
  it("requires a distinct confirmation, permitted kind, bounded reference and substantive rationale", () => {
    const f = fixture();
    for (const edit of [{ historicalConfirmed: "" }, { evidenceKind: "SAME_PERSON" }, { evidenceReference: "unknown" }, { correspondence: "Same client" }]) {
      expect(() => prepare({ ...f, selection: { ...f.selection, ...edit } as HistoricalAcatSelection })).toThrow();
    }
    expect(historicalAcatEvidenceSchema.safeParse({ ...f.selection, evidenceReference: "" }).success).toBe(false);
    expect(() => prepare({ ...f, selection: { ...f.selection, evidenceReference: "synthetic-person" } })).toThrow("historical_transfer_evidence_required");
    expect(() => prepare({ ...f, selection: { ...f.selection, evidenceReference: "2026-09-28" } })).toThrow("historical_transfer_evidence_required");
  });
  it("human evidence changes the immutable manifest, never a source transaction reference", () => {
    const f = fixture(), first = prepare(f); f.selection.evidenceReference = "confirmation-67890";
    expect(prepare(f).digest).not.toBe(first.digest); expect(f.target.transactionReference).toBeNull();
  });
  it("rejects stale target/source form proofs and malformed historical context", () => {
    const f = fixture();
    for (const edit of [{ expectedTargetVersion: 1 }, { expectedTargetDigest: "f".repeat(64) }, { expectedSourceDigest: "f".repeat(64) }]) {
      expect(() => prepare({ ...f, selection: { ...f.selection, ...edit } })).toThrow("historical_evidence_changed");
    }
    expect(() => prepareHistoricalAcatManifest({ snapshot: f.source, targets: [f.target], rejectedPairs: [], intent: f.intent, selection: f.selection, now: new Date(TEST_AT.getTime()+301000) })).toThrow();
    expect(() => readHistoricalReviewContext({ context: { historicalReview: { version: 1 } } })).toThrow();
  });
});

describe("historical intent and full reservation protection", () => {
  it("retains archived reservations and case-insensitive source collisions", () => {
    const f = fixture();
    expect(historicalAcatPairBlocker(f.source, [f.target, { ...f.target, transferId: "other", archived: true, existingTransferUuid: f.record.acatTransferId!.toUpperCase() }], f.target, f.record, f.intent)).toBe("reserved_link");
    f.source.records.push({ ...f.record, recordId: "other-source", acatTransferId: f.record.acatTransferId!.toUpperCase() });
    expect(historicalAcatPairBlocker(f.source, [f.target], f.target, f.record, f.intent)).toBe("duplicate_reference");
  });
  it("preserves any nonnull stored reference unless both canonical UUIDs match", () => {
    const f = fixture();
    expect(historicalAcatPairBlocker(f.source, [f.target], { ...f.target, existingTransferUuid: "legacy-unknown" }, { ...f.record, acatTransferId: null }, f.intent)).toBe("reserved_link");
    expect(historicalAcatPairBlocker(f.source, [f.target], { ...f.target, existingTransferUuid: f.record.acatTransferId!.toUpperCase() }, f.record, f.intent)).toBeNull();
  });
  it("does not let new ACCEPT evidence bypass a rejected pair or same-pair unlink/unknown clear", () => {
    const f = fixture();
    const rejection = makeHistoricalAcatIntent([{ id: "prior", recordId: f.record.recordId, reviewVersion: 2, evidenceDigest: "a".repeat(64) }], []);
    expect(() => prepare({ ...f, intent: rejection })).toThrow("prior_rejection");
    for (const prior of [{ recordId: f.record.recordId, transferUuid: null }, { recordId: null, transferUuid: f.record.acatTransferId!.toUpperCase() }, { recordId: null, transferUuid: "unknown" }]) {
      expect(() => prepare({ ...f, intent: makeHistoricalAcatIntent([], [{ id: "clear", ...prior }]) })).toThrow("prior_unlink");
    }
  });
  it("bounds intent history and detects changed/tampered digests", () => {
    const f = fixture(); expect(() => prepare({ ...f, intent: { ...f.intent, digest: "f".repeat(64) } })).toThrow("historical_intent_invalid");
    expect(() => makeHistoricalAcatIntent([], Array.from({ length: 1001 }, (_, i) => ({ id: String(i), recordId: "prior", transferUuid: null })))).toThrow();
  });
  it("intent reader includes prior rejection events even after PENDING/ACCEPT changes disposition", async () => {
    const query = vi.fn().mockResolvedValueOnce([{ id: "prior", recordId: "synthetic-record", reviewVersion: 5, evidenceDigest: "a".repeat(64) }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const intent = await readHistoricalAcatIntentWithinScope({ $queryRaw: query } as never, "synthetic-transfer");
    const sql = (query.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toContain("acat_link_review_event"); expect(sql).toContain("e.action='REJECT'"); expect(intent.rejections).toHaveLength(1);
    const clearSql = (query.mock.calls[1][0] as TemplateStringsArray).join("?");
    expect(clearSql).toContain("outcome='UNDONE'"); expect(clearSql).toContain("t.acat_link_provenance='UNDO'");
    const auditSql = (query.mock.calls[2][0] as TemplateStringsArray).join("?");
    expect(auditSql).toContain("action='acat_link.undo'");
  });
  it("resolves fixed Undo receipts to the old pair only and permits fresh different-pair review", () => {
    const f = fixture();
    const before = { recordId: "old-record", transferUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const after = { recordId: null, transferUuid: null };
    const detail = { changes: { acat_record_id: { from: before.recordId, to: null }, acat_transfer_id: { from: before.transferUuid, to: null } },
      acat_link_version: 2, provenance: "UNDO", automation_hold: true, decision_id: "old-decision", link_before: before, link_after: after };
    const decision = { id: "old-decision", transfer_id: f.target.transferId, record_id: before.recordId, applied_version: 2, outcome: "UNDONE",
      payload: { decision: { transferId: f.target.transferId, recordId: before.recordId }, context: { targetBefore: { ...after, hold: true } } } };
    const resolved = historicalUndoAuditIntent(f.target.transferId, { id: "1", detail: JSON.stringify(detail) }, [decision]);
    expect(resolved).toEqual({ id: "undo-audit:1", ...before });
    const intent = makeHistoricalAcatIntent([], [resolved]);
    expect(historicalAcatPairBlocker(f.source, [f.target], f.target, f.record, intent)).toBeNull();
    expect(historicalAcatPairBlocker(f.source, [f.target], f.target, { ...f.record, recordId: before.recordId }, intent)).toBe("prior_unlink");
    for (const bad of [null, "free form", JSON.stringify({ ...detail, decision_id: "other" }), JSON.stringify({ ...detail, acat_link_version: 1 }),
      JSON.stringify({ ...detail, changes: {} }), JSON.stringify({ ...detail, link_after: before })]) {
      const unresolved = historicalUndoAuditIntent(f.target.transferId, { id: "1", detail: bad }, [decision]);
      expect(unresolved).toEqual({ id: "undo-audit:1", recordId: null, transferUuid: null });
      expect(historicalAcatPairBlocker(f.source, [f.target], f.target, f.record, makeHistoricalAcatIntent([], [unresolved]))).toBe("prior_unlink");
    }
    expect(historicalUndoAuditIntent(f.target.transferId, { id: "1", detail: JSON.stringify(detail) }, [{ ...decision, outcome: "APPLIED" }]).recordId).toBeNull();
    expect(historicalUndoAuditIntent("other-transfer", { id: "1", detail: JSON.stringify(detail) }, [decision]).recordId).toBeNull();
  });
  it("ordinary ACCEPT does not accept a historical decision without its explicit confirmation", async () => {
    const f = fixture(), prepared = prepare(f), item = prepared.manifest.decisions.find((d) => d.transferId === f.target.transferId)!;
    const decision = { id: "decision", review_version: 0, evidence_digest: item.evidenceDigest, transfer_id: f.target.transferId,
      record_id: f.record.recordId, action: "review", outcome: "PENDING", payload: { decision: item, context: item.payload } };
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ id: "decision" }]), acatLinkDecision: { findUnique: vi.fn().mockResolvedValue(decision), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, acatLinkReviewEvent: { create: vi.fn() } };
    const input = { decisionId: "decision", expectedReviewVersion: 0, expectedEvidenceDigest: item.evidenceDigest, action: "ACCEPT" as const, reason: null };
    expect(await reviewReconciliationDecision(tx as never, { role: "OPERATIONS", email: "ops@example.invalid" }, input)).toEqual({ result: "ineligible", reason: "historical_confirmation_required" });
    expect(await reviewReconciliationDecision(tx as never, { role: "OPERATIONS", email: "ops@example.invalid" }, { ...input, action: "RESUME", expectedTargetVersion: 0 }, vi.fn())).toEqual({ result: "ineligible" });
    expect(tx.acatLinkDecision.updateMany).not.toHaveBeenCalled();
    expect(await reviewReconciliationDecision(tx as never, { role: "OPERATIONS", email: "ops@example.invalid" }, { ...input, historicalConfirmed: true })).toEqual({ result: "saved", reviewVersion: 1 });
  });
});
