import { Prisma, PrismaClient } from "@prisma/client";
import sourceFixture from "../fixtures/transfer-linkage-v1.json";
import { acatEvidenceHash, makeAcatMatchDecision } from "../../lib/data/acat-match";
import { prepareManifestFromMatches } from "../../lib/data/acat-reconciliation/prepare";
import type { AoaAcatCandidate, LinkageSnapshot } from "../../lib/data/acat-link-contract";

export const BROWSER_PREFIX = "synthetic-acat-link-browser";
export const BROWSER_RUN_ID = `${BROWSER_PREFIX}-run`;
export const browserTransferId = (suffix: string) => `${BROWSER_PREFIX}-transfer-${suffix}`;
export const browserDecisionId = (suffix: string) => `${BROWSER_PREFIX}-decision-${suffix}`;
const suffixes = ["reject", "blocked"];
const users = [
  { id: `${BROWSER_PREFIX}-ops`, email: "ops@example.com", name: "Riley Ops", role: "OPERATIONS" as const },
  { id: `${BROWSER_PREFIX}-viewer`, email: "view@example.com", name: "Val Viewer", role: "VIEWER" as const },
];

export function validateAcatReviewBrowserDatabase(): URL {
  const parse = (raw: string | undefined, username: string) => {
    if (!raw) throw new Error("explicit_acat_review_browser_database_required");
    const url = new URL(raw);
    if (!["postgresql:", "postgres:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || url.port !== "15540"
      || url.pathname !== "/aoa_acat_integration_synthetic" || url.username !== username || url.hash
      || [...url.searchParams.keys()].some((key) => key !== "schema")
      || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || process.env.APP_ENV === "prod") {
      throw new Error("isolated_acat_review_browser_database_required");
    }
    return url;
  };
  parse(process.env.DATABASE_URL, "app_rw");
  return parse(process.env.DIRECT_DATABASE_URL, "aoa");
}

export default async function acatReviewBrowserFixture() {
  const owner = new PrismaClient({ datasourceUrl: validateAcatReviewBrowserDatabase().href });
  const entityIds = [BROWSER_RUN_ID, ...suffixes.flatMap((suffix) => [browserTransferId(suffix), browserDecisionId(suffix)])];
  const createdUsers: string[] = [];
  let ownFixtures = false;
  const clean = async () => {
    await owner.acatLinkReviewEvent.deleteMany({ where: { decision_id: { in: suffixes.map(browserDecisionId) } } });
    await owner.acatLinkDecision.deleteMany({ where: { id: { in: suffixes.map(browserDecisionId) }, run_id: BROWSER_RUN_ID } });
    await owner.acatLinkRun.deleteMany({ where: { id: BROWSER_RUN_ID, installation_id: BROWSER_PREFIX } });
    await owner.transfer.deleteMany({ where: { id: { in: suffixes.map(browserTransferId) }, created_by: `${BROWSER_PREFIX}@example.invalid` } });
    await owner.user.deleteMany({ where: { id: { in: createdUsers } } });
    await owner.$executeRaw`DELETE FROM audit."AuditLog" WHERE "entityId" IN (${Prisma.join(entityIds)})`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk IN (${Prisma.join([...entityIds, ...createdUsers])})`;
  };
  try {
    const [actual] = await owner.$queryRaw<Array<{ database: string; username: string }>>`SELECT current_database() AS database, current_user AS username`;
    if (actual.database !== "aoa_acat_integration_synthetic" || actual.username !== "aoa") throw new Error("synthetic_browser_database_mismatch");
    const collisions = await owner.transfer.count({ where: { id: { in: suffixes.map(browserTransferId) } } });
    if (collisions || await owner.acatLinkRun.count({ where: { id: BROWSER_RUN_ID } })) throw new Error("synthetic_browser_fixture_collision");
    ownFixtures = true;
    for (const user of users) {
      const existing = await owner.user.findUnique({ where: { email: user.email } });
      if (existing && existing.role !== user.role) throw new Error("synthetic_browser_persona_role_mismatch");
      if (!existing) { await owner.user.create({ data: user }); createdUsers.push(user.id); }
    }
    const now = new Date();
    const snapshot = structuredClone(sourceFixture) as LinkageSnapshot;
    snapshot.source.installationId = BROWSER_PREFIX;
    snapshot.observedAt = now.toISOString();
    snapshot.records = suffixes.map((suffix, index) => ({ ...snapshot.records[0], recordId: `${BROWSER_PREFIX}-record-${suffix}`,
      acatTransferId: `77777777-7777-4777-8777-${String(index + 1).padStart(12, "0")}` }));
    snapshot.recordCount = snapshot.records.length;
    snapshot.snapshotDigest = acatEvidenceHash({ contractVersion: 1, source: snapshot.source, scope: snapshot.scope,
      records: [...snapshot.records].sort((a, b) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)
        .map((row) => [row.recordId, row.recordEvidenceDigest, row.accountEvidenceDigest]) });
    const targets: AoaAcatCandidate[] = [];
    for (const suffix of suffixes) {
      const row = await owner.transfer.create({ data: { id: browserTransferId(suffix), source: "APP", client_first_name: "Synthetic Browser",
        client_last_name: suffix === "reject" ? "Reject" : "Blocked", value: 1234, stage: "DECISION", funding_type: "ACAT_FULL",
        acat_auto_link_hold: false, created_by: `${BROWSER_PREFIX}@example.invalid` } });
      targets.push({ transferId: row.id, linkVersion: row.acat_link_version, existingRecordId: null, existingTransferUuid: null,
        hold: false, stage: row.stage, fundingType: row.funding_type, archived: false, canonicalClientUserIds: ["synthetic-browser-user"],
        dealUserId: null, identityState: "verified", receivingAccount: null, transactionReference: null, evidenceDigest: acatEvidenceHash(row.id) });
    }
    const decisions = targets.map((target, index) => makeAcatMatchDecision(snapshot, target, snapshot.records[index], "missing_transaction_evidence", "review"));
    const prepared = prepareManifestFromMatches({ mode: "PREPARE", snapshot, targets, targetBoundary: now, decisions });
    const manifest = prepared.manifest;
    await owner.acatLinkRun.create({ data: { id: BROWSER_RUN_ID, mode: manifest.mode, contract_version: 1, rule_version: manifest.ruleVersion,
      installation_id: manifest.installationId, source_scope: manifest.sourceScope, source_boundary: { source: { ...snapshot.source } },
      source_digest: manifest.sourceDigest, source_count: manifest.sourceCount, source_complete: true, target_boundary: now,
      target_digest: manifest.targetDigest, target_count: manifest.targetCount, manifest_digest: prepared.digest, idempotency_key: prepared.idempotencyKey,
      created_by: `${BROWSER_PREFIX}@example.invalid`, created_role: "OPERATIONS", summary: { ...prepared.summary },
      decisions: { create: manifest.decisions.map((decision, index) => {
        const { decisionKey, payload: context, ...proof } = decision;
        return { id: browserDecisionId(suffixes[index]), decision_key: decisionKey, record_id: decision.recordId, transfer_id: decision.transferId,
          reason: decision.reason, action: decision.action, rule_version: decision.ruleVersion, evidence_digest: decision.evidenceDigest,
          expected_target_version: decision.targetVersion, target_evidence_digest: decision.targetDigest, source_candidate_set_digest: decision.sourceCandidateSetDigest,
          payload: { decision: { ...proof }, context } as Prisma.InputJsonValue };
      }) } } });
  } catch (error) { try { if (ownFixtures) await clean(); } finally { await owner.$disconnect(); } throw error; }
  return async () => { try { await clean(); } finally { await owner.$disconnect(); } };
}
