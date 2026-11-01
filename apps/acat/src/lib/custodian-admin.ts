import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { loadObservedCustodianTimings } from "@/lib/custodian-timing-data";
import { safeFeeScheduleFilename } from "@/lib/custodian-fee-documents";
import { verifyCustodianAdminCaller, type CustodianAdminRoute } from "@/lib/machine-auth";
import { rateLimit } from "@/lib/rate-limit-redis";
import { updateCustodianBaseSchema, validateCustodianContactUpdate } from "@/lib/validators";

// Both switches must be exactly "1". Unset everywhere by default.
export function custodianAdminEnabled(): boolean {
  return (
    process.env.EPIC_ACAT_CUSTODIAN_ADMIN === "1" &&
    process.env.ROLLOUT_ACAT_CUSTODIAN_ADMIN === "1"
  );
}

export function trackerCustodianEditsRetired(): boolean {
  return process.env.ENFORCE_CUSTODIAN_TRACKER_READ_ONLY === "1";
}

export function custodianEditsRetiredResponse(): NextResponse {
  return NextResponse.json({ error: "custodian_edits_retired" }, { status: 405 });
}

export function custodianProjectionEnabled(): boolean {
  return process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION === "1";
}

export function custodianSnapshotExportEnabled(): boolean {
  return process.env.ALLOW_CUSTODIAN_SNAPSHOT_EXPORT === "1";
}

export class CustodianSnapshotRefusal extends Error {
  constructor() {
    super("snapshot_refused");
    this.name = "CustodianSnapshotRefusal";
  }
}

export const CUSTODIAN_SNAPSHOT_SCHEMA_VERSION = 1;

const snapshotSelect = {
  id: true, name: true, reviewStatus: true, acatFeeAmount: true,
  transferType: true, documentationStatus: true, dtcNumber: true,
  receivingAccountNumber: true, signature: true, letterOfAcceptance: true,
  medallionRequired: true, liquidationMethod: true, returnMethod: true,
  watchouts: true, paperworkOnFile: true, transfersToDate: true,
  avgProcessingDays: true, contactEmail: true, contactMethod: true, contactDetails: true,
  fees: {
    orderBy: [{ feeType: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true, feeType: true, accountType: true, transferType: true,
      direction: true, amount: true, amountText: true, notes: true,
      documentation: true, createdAt: true, updatedAt: true,
    },
  },
  feeScheduleDocuments: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    select: {
      id: true, filename: true, contentType: true, byteSize: true,
      sha256: true, content: true, createdAt: true, createdBy: true,
    },
  },
} satisfies Prisma.CustodianSelect;

function iso(value: Date): string {
  return value.toISOString();
}

export function assertFeeScheduleBytes(content: Uint8Array | null, byteSize: number, sha256: string): Buffer {
  if (content == null) throw new CustodianSnapshotRefusal();
  const bytes = Buffer.from(content);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== byteSize || digest !== sha256) throw new CustodianSnapshotRefusal();
  return bytes;
}

type SnapshotRow = Prisma.CustodianGetPayload<{ select: typeof snapshotSelect }>;

function toSnapshotCustodian(row: SnapshotRow) {
  const { fees, feeScheduleDocuments, ...profile } = row;
  return {
    ...profile,
    fees: fees.map((fee) => ({
      ...fee,
      createdAt: iso(fee.createdAt),
      updatedAt: iso(fee.updatedAt),
    })),
    feeScheduleDocuments: feeScheduleDocuments.map((document) => {
      assertFeeScheduleBytes(document.content, document.byteSize, document.sha256);
      return {
        id: document.id,
        filename: document.filename,
        contentType: document.contentType,
        byteSize: document.byteSize,
        sha256: document.sha256,
        createdAt: iso(document.createdAt),
        createdBy: document.createdBy,
      };
    }),
  };
}

export async function loadCustodianSnapshot() {
  const rows = await prisma.custodian.findMany({
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: snapshotSelect,
  });
  return {
    schemaVersion: CUSTODIAN_SNAPSHOT_SCHEMA_VERSION,
    custodians: rows.map(toSnapshotCustodian),
  };
}

export async function loadFeeScheduleBytes(documentId: string) {
  const document = await prisma.custodianFeeScheduleDocument.findUnique({
    where: { id: documentId },
    select: { filename: true, contentType: true, content: true, byteSize: true, sha256: true },
  });
  if (!document) return null;
  const content = assertFeeScheduleBytes(document.content, document.byteSize, document.sha256);
  return {
    filename: safeFeeScheduleFilename(document.filename),
    contentType: document.contentType,
    content,
  };
}

export function custodianEditBlockedResponse(): NextResponse | null {
  if (!custodianProjectionEnabled()) return null;
  return NextResponse.json({ error: "custodian_authority_active" }, { status: 409 });
}

// The read-only library projection. Never include recentClients, record
// relations or retired fields; never replace with include/spread.
export const custodianLibrarySelect = {
  id: true, name: true, reviewStatus: true, acatFeeAmount: true,
  transferType: true, documentationStatus: true, dtcNumber: true,
  receivingAccountNumber: true, signature: true, letterOfAcceptance: true,
  medallionRequired: true, liquidationMethod: true, returnMethod: true,
  watchouts: true, paperworkOnFile: true, transfersToDate: true,
  avgProcessingDays: true, contactEmail: true,
  contactMethod: true, contactDetails: true,
  fees: {
    orderBy: [{ feeType: "asc" }, { id: "asc" }],
    select: {
      id: true, feeType: true, accountType: true, transferType: true,
      direction: true, amount: true, amountText: true, notes: true,
      documentation: true, createdAt: true, updatedAt: true,
    },
  },
} satisfies Prisma.CustodianSelect;

type LibraryRow = Prisma.CustodianGetPayload<{ select: typeof custodianLibrarySelect }>;
type Timings = Awaited<ReturnType<typeof loadObservedCustodianTimings>>;

export function toLibraryProfile({ avgProcessingDays, ...profile }: LibraryRow, timings: Timings) {
  return {
    ...profile,
    configuredExpectedProcessingDays: avgProcessingDays,
    observedAvgProcessingBusinessDays:
      timings.get(profile.id)?.observedAvgProcessingBusinessDays ?? null,
    observedCompletedTransfers: timings.get(profile.id)?.observedCompletedTransfers ?? 0,
  };
}

export async function loadStoredCustodian(id: string) {
  const [row, timings] = await Promise.all([
    prisma.custodian.findUnique({ where: { id }, select: custodianLibrarySelect }),
    loadObservedCustodianTimings(),
  ]);
  return row ? toLibraryProfile(row, timings) : null;
}

// recentClients is client history and never crosses the machine boundary.
export const machineUpdateCustodianSchema = updateCustodianBaseSchema
  .omit({ recentClients: true })
  .strict()
  .superRefine(validateCustodianContactUpdate);

export async function resolveActingAdmin(request: Request): Promise<string | null> {
  const email = request.headers.get("x-acting-user-email")?.trim().toLowerCase();
  if (!email) return null;
  const user = await prisma.allowedUser.findUnique({
    where: { email },
    select: { role: true, active: true },
  });
  return user?.active === true && user.role === "ADMIN" ? email : null;
}

const WRITE_LIMIT = { maxTokens: 60, interval: 60_000, failClosed: true };

export async function authorizeCustodianAdmin(
  request: Request,
  route: CustodianAdminRoute
): Promise<{ actor: string } | NextResponse> {
  const blocked = custodianEditBlockedResponse();
  if (blocked) return blocked;
  if (!custodianAdminEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const caller = await verifyCustodianAdminCaller(request, route);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { allowed } = await rateLimit("machine-custodian-admin", caller.email, WRITE_LIMIT);
  if (!allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const actor = await resolveActingAdmin(request);
  if (!actor) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return { actor };
}

// Repoint every record from source onto target (FK + denormalized display
// fields), one audit row per record, and preserve every attached source
// document on the target before deleting source (its fee rows cascade).
export async function mergeCustodianRecords(
  tx: Prisma.TransactionClient,
  args: { sourceId: string; target: { id: string; name: string }; performedBy: string }
): Promise<number> {
  const { sourceId, target, performedBy } = args;
  const affected = await tx.acatRecord.findMany({
    where: { custodianId: sourceId },
    select: { id: true, transferringContra: true, custodianName: true },
  });
  const updated = await tx.acatRecord.updateMany({
    where: { custodianId: sourceId },
    data: { custodianId: target.id, custodianName: target.name, transferringContra: target.name },
  });
  if (affected.length > 0) {
    await tx.auditLog.createMany({
      data: affected.map((r) => ({
        acatRecordId: r.id,
        action: "custodian-merge",
        field: "transferringContra",
        oldValue: r.transferringContra ?? r.custodianName ?? null,
        newValue: target.name,
        performedBy,
      })),
    });
  }
  await tx.custodianFeeScheduleDocument.updateMany({
    where: { custodianId: sourceId },
    data: { custodianId: target.id },
  });
  await tx.custodian.delete({ where: { id: sourceId } });
  return updated.count;
}

export async function mergeCustodianInto(args: {
  sourceId: string; target: { id: string; name: string }; performedBy: string;
}): Promise<number> {
  return prisma.$transaction((tx) => mergeCustodianRecords(tx, args));
}

const feeRuleSchema = z.object({
  id: z.string(),
  custodian_id: z.string(),
  fee_type: z.string(),
  account_type: z.enum(["ANY", "IRA", "BROKERAGE"]),
  transfer_type: z.enum(["ANY", "FULL", "PARTIAL"]),
  direction: z.enum(["ANY", "IN", "OUT"]),
  amount: z.number().nullable(),
  amount_text: z.string().nullable(),
  notes: z.string().nullable(),
  documentation: z.string().nullable(),
  retired_at: z.null(),
  revision: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

const saveSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  acat_fee_amount: z.number(),
  avg_processing_days: z.number().int(),
  contact_email: z.string().nullable(),
  contact_method: z.enum(["EMAIL", "PHONE", "PORTAL", "OTHER"]).nullable(),
  contact_details: z.string().nullable(),
  review_status: z.enum(["NEEDS_SETUP", "VERIFIED"]),
  transfer_type: z.enum(["ACAT_API", "MANUAL", "MIXED", "INTERNAL", "UNCONFIRMED"]).nullable(),
  documentation_status: z.enum(["DOCUMENTED", "PARTIAL", "NEEDS_CALL"]).nullable(),
  dtc_number: z.string().nullable(),
  receiving_account_number: z.string().nullable(),
  signature: z.string().nullable(),
  letter_of_acceptance: z.string().nullable(),
  medallion_required: z.string().nullable(),
  liquidation_method: z.string().nullable(),
  return_method: z.string().nullable(),
  watchouts: z.string().nullable(),
  paperwork_on_file: z.boolean().nullable(),
  transfers_to_date: z.number().int().nullable(),
  merged_into_id: z.string().nullable(),
  retired_at: z.null(),
  revision: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  fee_rules: z.array(feeRuleSchema),
}).strict();

const mergeSnapshotSchema = z.object({
  source: z.object({ id: z.string(), name: z.string() }).strict(),
  target: saveSnapshotSchema,
}).strict();

const projectionEnvelopeSchema = z.object({
  revision: z.number().int(),
  previousRevision: z.number().int().nullable(),
  checksum: z.string(),
  body: z.unknown(),
}).strict();

export function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === "bigint" || typeof value === "function") {
    throw new Error("custodian revision body is not JSON");
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function custodianRevisionChecksum(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export type ProjectionDecision =
  | { outcome: "accepted"; revision: number; movedTransfers: number }
  | { outcome: "duplicate"; revision: number }
  | { outcome: "rejected"; revision: number; reason: "gap" | "mismatch" };

export function decideProjectionRevision(input: {
  applied: number;
  receipt: { bodySha256: string } | null;
  revision: number;
  previousRevision: number | null;
  checksum: string;
  body: unknown;
}): ProjectionDecision {
  let checksumMatches = false;
  try {
    checksumMatches = input.checksum === custodianRevisionChecksum(input.body);
  } catch {
    return { outcome: "rejected", revision: input.revision, reason: "mismatch" };
  }
  const save = saveSnapshotSchema.safeParse(input.body);
  const merge = mergeSnapshotSchema.safeParse(input.body);
  if (!checksumMatches || (!save.success && !merge.success)) {
    return { outcome: "rejected", revision: input.revision, reason: "mismatch" };
  }
  if (input.receipt && input.receipt.bodySha256 !== input.checksum) {
    return { outcome: "rejected", revision: input.revision, reason: "mismatch" };
  }
  const duplicatePrevious = input.revision === 1
    ? input.previousRevision === null
    : input.previousRevision === input.revision - 1;
  if (input.receipt && input.receipt.bodySha256 === input.checksum && duplicatePrevious) {
    return { outcome: "duplicate", revision: input.revision };
  }
  const applyPrevious = input.applied === 0
    ? input.previousRevision === null
    : input.previousRevision === input.applied;
  if (!input.receipt && input.revision === input.applied + 1 && applyPrevious) {
    return { outcome: "accepted", revision: input.revision, movedTransfers: 0 };
  }
  return { outcome: "rejected", revision: input.revision, reason: "gap" };
}

async function writeProjectionCustodian(
  tx: Prisma.TransactionClient,
  snapshot: z.infer<typeof saveSnapshotSchema>,
  revision: number,
): Promise<void> {
  const data = {
    name: snapshot.name,
    acatFeeAmount: snapshot.acat_fee_amount,
    avgProcessingDays: snapshot.avg_processing_days,
    contactEmail: snapshot.contact_email,
    contactMethod: snapshot.contact_method,
    contactDetails: snapshot.contact_details,
    reviewStatus: snapshot.review_status,
    transferType: snapshot.transfer_type,
    documentationStatus: snapshot.documentation_status,
    dtcNumber: snapshot.dtc_number,
    receivingAccountNumber: snapshot.receiving_account_number,
    signature: snapshot.signature,
    letterOfAcceptance: snapshot.letter_of_acceptance,
    medallionRequired: snapshot.medallion_required,
    liquidationMethod: snapshot.liquidation_method,
    returnMethod: snapshot.return_method,
    watchouts: snapshot.watchouts,
    paperworkOnFile: snapshot.paperwork_on_file,
    transfersToDate: snapshot.transfers_to_date,
    projectionRevision: revision,
  };
  await tx.custodian.upsert({
    where: { id: snapshot.id },
    create: { id: snapshot.id, ...data },
    update: data,
  });
  for (const fee of snapshot.fee_rules) {
    if (fee.custodian_id !== snapshot.id) throw { status: 409, reason: "mismatch" as const };
    const existing = await tx.custodianFee.findUnique({ where: { id: fee.id } });
    if (existing && existing.custodianId !== snapshot.id) {
      throw { status: 409, reason: "mismatch" as const };
    }
    const feeData = {
      feeType: fee.fee_type,
      accountType: fee.account_type,
      transferType: fee.transfer_type,
      direction: fee.direction,
      amount: fee.amount,
      amountText: fee.amount_text,
      notes: fee.notes,
      documentation: fee.documentation,
    };
    await tx.custodianFee.upsert({
      where: { id: fee.id },
      create: { id: fee.id, custodianId: snapshot.id, ...feeData },
      update: feeData,
    });
  }
  const keptFeeIds = snapshot.fee_rules.map((fee) => fee.id);
  await tx.custodianFee.deleteMany({
    where: keptFeeIds.length === 0
      ? { custodianId: snapshot.id }
      : { custodianId: snapshot.id, id: { notIn: keptFeeIds } },
  });
}

export async function applyCustodianProjection(
  tx: Prisma.TransactionClient,
  envelope: { revision: number; previousRevision: number | null; checksum: string; body: unknown },
): Promise<ProjectionDecision> {
  const parsedEnvelope = projectionEnvelopeSchema.safeParse(envelope);
  if (!parsedEnvelope.success) {
    const revision = typeof envelope?.revision === "number" ? envelope.revision : 0;
    return { outcome: "rejected", revision, reason: "mismatch" };
  }
  const { revision, previousRevision, checksum, body } = parsedEnvelope.data;
  const save = saveSnapshotSchema.safeParse(body);
  const merge = mergeSnapshotSchema.safeParse(body);
  let checksumMatches = false;
  try {
    checksumMatches = checksum === custodianRevisionChecksum(body);
  } catch {
    checksumMatches = false;
  }
  if (!checksumMatches || (!save.success && !merge.success)) {
    return { outcome: "rejected", revision, reason: "mismatch" };
  }
  const locked = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT "id" FROM "CustodianProjectionState" WHERE "id" = 1 FOR UPDATE`;
  if (!locked.length) throw { status: 500 };
  const state = await tx.custodianProjectionState.findUnique({ where: { id: 1 } });
  if (!state) throw { status: 500 };
  const receipt = await tx.custodianProjectionReceipt.findUnique({ where: { revision } });
  const decision = decideProjectionRevision({
    applied: state.appliedRevision,
    receipt,
    revision,
    previousRevision,
    checksum,
    body,
  });
  if (decision.outcome !== "accepted") return decision;
  let movedTransfers = 0;
  try {
    if (merge.success) {
      await writeProjectionCustodian(tx, merge.data.target, revision);
      const source = await tx.custodian.findUnique({ where: { id: merge.data.source.id } });
      const target = await tx.custodian.findUnique({ where: { id: merge.data.target.id } });
      if (!source || !target || source.id === target.id) throw { status: 409, reason: "mismatch" as const };
      movedTransfers = await mergeCustodianRecords(tx, {
        sourceId: source.id,
        target: { id: target.id, name: target.name },
        performedBy: "custodian-projection",
      });
    } else if (save.success) {
      await writeProjectionCustodian(tx, save.data, revision);
    }
    await tx.custodianProjectionReceipt.create({
      data: { revision, bodySha256: checksum },
    });
    await tx.custodianProjectionState.update({
      where: { id: 1 },
      data: { appliedRevision: revision },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      const status = (error as { status?: unknown }).status;
      const reason = (error as { reason?: unknown }).reason;
      if (status === 409 && (reason === "gap" || reason === "mismatch")) throw error;
      if (status === 500) throw error;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw { status: 409, reason: "mismatch" as const };
    }
    throw error;
  }
  return { outcome: "accepted", revision, movedTransfers };
}
