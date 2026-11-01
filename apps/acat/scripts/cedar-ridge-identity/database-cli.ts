import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { Prisma } from "@prisma/client";
import { getDirectoryStatus, lockDirectory, resolveClientIdentities } from "../../src/lib/client-directory";
import { sha256 } from "./canonical";
import { approvalSchema, type Manifest } from "./contracts";
import { applyManifest, undoPlan, type UndoPlan } from "./engine";
import { assertRestrictedOutput, readJson, writeRestricted } from "./files";
import { summarizeManifest, validateManifest, verifyManifestEvidence } from "./manifest";
import { validateEvidence } from "./match";
import { connectStore, loadApplications, validateReviewedSource } from "./store";
import { reconcile } from "./verify";
import { assertSourcePolicy, coverageSummary, sourceCoverage } from "./coverage";

export async function databaseCommand(command: string, values: Record<string, string>): Promise<void> {
  if (!["snapshot", "bind-directory", "apply", "verify", "undo-plan", "undo-apply"].includes(command)) throw new Error("UNKNOWN_COMMAND");
  const required = (key: string) => { if (!values[key]) throw new Error(`MISSING_${key.replace(/-/g, "_").toUpperCase()}`); return values[key]; };
  const target = required("target");
  const credentialName = required("database-url-env");
  if (!/^[A-Z][A-Z0-9_]+$/.test(credentialName)) throw new Error("INVALID_CREDENTIAL_VARIABLE");
  const databaseUrl = process.env[credentialName];
  if (!databaseUrl) throw new Error("DATABASE_CREDENTIAL_MISSING");
  const output = required("out");
  assertRestrictedOutput(output);
  const write = command === "apply" || command === "undo-apply";
  if (write) {
    // This reference records the separately approved durable archive; a local
    // temporary receipt is not a production retention plan or authorization.
    if (target.startsWith("production:") && !values["durable-evidence-reference"]) throw new Error("DURABLE_EVIDENCE_DESTINATION_REQUIRED");
    if ((statSync(dirname(output)).mode & 0o077) !== 0) throw new Error("EVIDENCE_DIRECTORY_NOT_PRIVATE");
    required("approved-digest"); required("approval-reference"); required("actor");
  }
  const store = await connectStore(databaseUrl, target);
  try {
    if (command === "snapshot") {
      const snapshot = await store.snapshot();
      writeRestricted(output, snapshot);
      console.log(JSON.stringify({ records: snapshot.records.length, snapshotHash: sha256(snapshot), preMigrationPlaceholders: false }));
      return;
    }
    if (command === "bind-directory") {
      const manifest = validateManifest(readJson(required("manifest")));
      const bound = await store.bind(manifest);
      writeRestricted(output, bound);
      console.log(JSON.stringify(summarizeManifest(bound)));
      return;
    }
    if (command === "apply") {
      const manifest = validateManifest(readJson(required("manifest")));
      const evidence = validateEvidence(readJson(required("evidence")));
      const approval = approvalSchema.parse({ manifestHash: required("approved-digest"), actor: required("actor"), reference: required("approval-reference") });
      const receipt = await applyManifest(manifest, evidence, approval, store);
      writeRestricted(output, { ...receipt, durableEvidenceReference: values["durable-evidence-reference"] ?? null });
      reportOutcomes(receipt.outcomes);
      return;
    }
    if (command === "undo-plan") {
      const manifest = validateManifest(readJson(required("manifest")));
      if (manifest.target !== store.target || manifest.databaseName !== store.databaseName || manifest.installationId !== store.installationId) throw new Error("TARGET_MISMATCH");
      const snapshot = await store.snapshot();
      const audits = await loadApplications(store.db);
      const rows = audits.filter((audit) => audit.operation === "apply" && audit.manifestHash === sha256(manifest)).map((audit) => ({
        recordId: audit.recordId, originalApplication: audit,
        expected: snapshot.records.find((row) => row.id === audit.recordId) ?? {
          ...manifest.rows.find((row) => row.expected.id === audit.recordId)!.expected,
          cedarRidgeUserId: audit.newUserId, cedarRidgeUserIds: audit.newUserIds, identityVersion: audit.afterVersion,
        },
      }));
      const plan: UndoPlan = { version: 2, runId: randomUUID(), originalManifestHash: sha256(manifest),
        generatedAt: new Date().toISOString(), target: store.target, databaseName: store.databaseName, installationId: store.installationId, rows };
      writeRestricted(output, plan);
      console.log(JSON.stringify({ undoPlanHash: sha256(plan), records: rows.length }));
      return;
    }
    if (command === "undo-apply") {
      const plan = readJson(required("undo-plan")) as UndoPlan;
      const approval = approvalSchema.parse({ manifestHash: required("approved-digest"), actor: required("actor"), reference: required("approval-reference") });
      const receipt = await undoPlan(plan, approval, store);
      writeRestricted(output, { ...receipt, durableEvidenceReference: values["durable-evidence-reference"] ?? null });
      reportOutcomes(receipt.outcomes);
      return;
    }
    const paths = required("manifests").split(",");
    const manifests: Manifest[] = paths.map((path) => validateManifest(readJson(path)));
    const evidencePaths = required("evidence-files").split(",");
    if (evidencePaths.length !== manifests.length) throw new Error("ONE_EVIDENCE_FILE_PER_MANIFEST_REQUIRED");
    const sources = evidencePaths.map((path) => validateEvidence(readJson(path)));
    sources.forEach(assertSourcePolicy);
    manifests.forEach((manifest, index) => verifyManifestEvidence(manifest, sources[index]));
    const result = await store.db.$transaction(async (tx) => {
      await lockDirectory(tx);
      const snapshot = await store.snapshotWithin(tx);
      const audits = await loadApplications(tx);
      const directory = await getDirectoryStatus(tx);
      const report = reconcile(manifests, snapshot, audits);
      for (const outcome of report.outcomes) {
        const record = snapshot.records.find((row) => row.id === outcome.recordId)!;
        if (outcome.status === "backfill-link-needs-validation") {
          try {
            const index = manifests.findIndex((manifest) => sha256(manifest) === outcome.manifestHash);
            const reviewedRow = manifests[index].rows.find((row) => row.expected.id === record.id)!;
            await validateReviewedSource(tx, reviewedRow, sources[index]);
            outcome.status = "verified-backfill-link";
          } catch { outcome.status = "backfill-link-unverified"; }
        } else if (outcome.status === "linked-needs-validation") {
          try {
            const current = await tx.acatRecord.findUniqueOrThrow({ where: { id: record.id } });
            await resolveClientIdentities(tx, { cedarRidgeUserIds: record.cedarRidgeUserIds, apexAccountId: record.apexAccountId,
              allowHistoricalAccount: true, allowPendingAccount: current.status === "PendingAccountOpening" && !record.apexAccountId.trim() });
            outcome.status = "verified-existing-link";
          } catch { outcome.status = "linked-unverified"; }
        }
      }
      return { ...report, directory };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60000 });
    const complete = result.directory.health === "FRESH" && result.missingRecordIds.length === 0 && result.outcomes.every((row) => ["verified-backfill-link", "verified-existing-link", "accepted-exception"].includes(row.status));
    writeRestricted(output, { ...result, complete, sourceCoverage: sources.map((source) => coverageSummary(sourceCoverage(source))), businessFieldProof: "Transaction-local before/after hashes; legitimate later business edits are not treated as backfill mutations." });
    console.log(JSON.stringify({ total: result.total, linkedPeople: result.linkedPeople, multiClientRecords: result.multiClientRecords, nonDeleted: result.nonDeleted, deleted: result.deleted, complete,
      directoryHealth: result.directory.health, statuses: countBy(result.outcomes.map((row) => row.status)), missingRecords: result.missingRecordIds.length }));
    if (!complete) process.exitCode = 2;
  } finally { await store.db.$disconnect(); }
}

function countBy(values: string[]) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
function reportOutcomes(outcomes: Array<{ outcome: string }>) {
  console.log(JSON.stringify({ outcomes: countBy(outcomes.map((row) => row.outcome)) }));
  if (outcomes.some((row) => row.outcome === "conflict" || row.outcome === "unresolved")) process.exitCode = 2;
}
