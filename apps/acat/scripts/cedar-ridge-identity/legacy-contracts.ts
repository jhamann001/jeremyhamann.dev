// Frozen v1 contracts for read-only inspection. Never use these to authorize v2 writes.
import { z } from "zod";

export const USER_ID = /^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonempty = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const userId = z.string().regex(USER_ID);

export const trackerRowSchema = z.object({
  id: nonempty,
  cedarRidgeUserId: userId.nullable(),
  identityVersion: z.number().int().nonnegative(),
  clientName: z.string(),
  apexAccountId: z.string(),
  acatTransferId: z.string().nullable(),
  deletedAt: z.string().nullable(),
});
export type TrackerRow = z.infer<typeof trackerRowSchema>;

export const ownerCoverageAssumptionSchema = z.object({
  acceptedBy: nonempty, acceptedAt: timestamp, reference: nonempty, reason: nonempty,
}).strict();
export const sourceCoverageSchema = z.object({
  upstreamFreshness: z.enum(["verified", "unknown", "stale"]),
  ownerCoverageAssumption: ownerCoverageAssumptionSchema.optional(),
}).strict();

export const evidenceSchema = z.object({
  version: z.literal(1),
  extractedAt: timestamp,
  snapshotId: nonempty,
  sourceQueryHashes: z.record(z.string(), digest),
  // Retrieval recency is deliberately separate from upstream feed health.
  upstreamFreshness: z.enum(["verified", "unknown", "stale"]),
  freshnessEvidence: z.string(),
  ownerCoverageAssumption: ownerCoverageAssumptionSchema.optional(),
  clients: z.array(z.object({ userId, name: nonempty }).strict()),
  accounts: z.array(z.object({
    accountId: nonempty,
    accountNumber: z.string().nullable(),
    userId: userId.nullable(),
    relationshipType: z.string().nullable(),
  }).strict()),
  transfers: z.array(z.object({
    transferId: nonempty,
    userId,
    isInitiator: z.boolean(),
  }).strict()),
}).strict();
export type Evidence = z.infer<typeof evidenceSchema>;

export const trackerSnapshotSchema = z.object({
  version: z.literal(1),
  extractedAt: timestamp,
  target: nonempty,
  databaseName: nonempty,
  installationId: z.string().uuid().nullable().default(null),
  preMigrationPlaceholders: z.array(z.enum(["identityVersion", "cedarRidgeUserId"])).default([]),
  records: z.array(trackerRowSchema),
}).strict();
export type TrackerSnapshot = z.infer<typeof trackerSnapshotSchema>;

export const categories = [
  "stable-name-agrees", "stable-name-varies", "multiple-users", "name-only",
  "unmatched", "evidence-conflict", "already-linked",
] as const;
export type Category = (typeof categories)[number];

const unresolved = z.object({ kind: z.literal("unresolved") }).strict();
const reviewedFields = {
  reviewer: nonempty,
  reviewedAt: timestamp,
  reason: nonempty,
  corroboratingEvidence: z.string().trim().min(1).optional(),
};
export const decisionSchema = z.discriminatedUnion("kind", [
  unresolved,
  z.object({ kind: z.literal("link"), userId, ...reviewedFields }).strict(),
  z.object({ kind: z.literal("exception"), ...reviewedFields }).strict(),
]);
export type Decision = z.infer<typeof decisionSchema>;

export const manifestRowSchema = z.object({
  expected: trackerRowSchema,
  category: z.enum(categories),
  candidateIds: z.array(userId),
  accountCandidateIds: z.array(userId),
  transferCandidateIds: z.array(userId),
  nameCandidateIds: z.array(userId),
  // Only relevant identity evidence is hashed; an unrelated directory refresh
  // does not invalidate a reviewed decision whose supporting facts are intact.
  evidenceHash: digest,
  // Null until a read-only bind captures the actual published directory facts.
  directoryEvidenceHash: digest.nullable(),
  decision: decisionSchema,
}).strict();
export type ManifestRow = z.infer<typeof manifestRowSchema>;

export const manifestSchema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  generatedAt: timestamp,
  target: nonempty,
  databaseName: nonempty,
  installationId: z.string().uuid().nullable().default(null),
  trackerExtractedAt: timestamp,
  trackerHash: digest,
  evidenceHash: digest,
  sourceSnapshotId: nonempty,
  // Optional only for previously generated review artifacts. New plans include it.
  sourceCoverage: sourceCoverageSchema.optional(),
  preMigrationPlaceholders: z.array(z.enum(["identityVersion", "cedarRidgeUserId"])).default([]),
  rows: z.array(manifestRowSchema),
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;

export const approvalSchema = z.object({
  manifestHash: digest,
  reference: nonempty,
  actor: nonempty,
}).strict();
export type Approval = z.infer<typeof approvalSchema>;

export const auditProvenanceSchema = z.object({
  version: z.literal(1), operation: z.enum(["apply", "undo", "exception"]),
  runId: z.string().uuid(), manifestHash: digest, approvalReference: nonempty, actor: nonempty,
  recordId: nonempty, oldUserId: userId.nullable(), newUserId: userId.nullable(),
  beforeVersion: z.number().int().nonnegative(), afterVersion: z.number().int().nonnegative(),
  beforeBusinessHash: digest, afterBusinessHash: digest, evidenceHash: digest,
  directorySnapshotId: nonempty.nullable(), directoryEvidenceHash: digest.nullable(),
  reviewer: nonempty, reason: nonempty, timestamp,
}).strict();
export type AuditProvenance = z.infer<typeof auditProvenanceSchema>;

export const undoPlanSchema = z.object({
  version: z.literal(1), runId: z.string().uuid(), originalManifestHash: digest,
  generatedAt: timestamp, target: nonempty, databaseName: nonempty,
  installationId: z.string().uuid(),
  rows: z.array(z.object({ recordId: nonempty, originalApplication: auditProvenanceSchema, expected: trackerRowSchema }).strict()),
}).strict();

export type Outcome = {
  recordId: string;
  outcome: "applied" | "exception-recorded" | "noop" | "unresolved" | "conflict" | "undone";
  code?: string;
  provenance?: AuditProvenance;
};
export type Receipt = {
  version: 1;
  operation: "apply" | "undo";
  runId: string;
  manifestHash: string;
  target: string;
  startedAt: string;
  finishedAt: string;
  outcomes: Outcome[];
};
