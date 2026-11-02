"use server";

import { auth } from "@/auth";
import { writeAudit } from "@/lib/audit";
import {
  acatCustodianAdminEnabled,
  custodianAdminAllowed,
  custodianAuthorityStorageWritesEnabled,
  showCustodianAuthorityLibraryEnabled,
} from "@/lib/flags";
import { withUserScope, type Identity } from "@/lib/rls";
import { custodianProfileSchema, type CustodianProfile } from "@/lib/data/custodian-library-contract";
import {
  listCustodianFeeScheduleDocumentIds,
  readCustodianFeeScheduleBytes,
  reassignCustodianFeeScheduleDocuments,
} from "@/lib/data/custodian-admin";
import { buildFeeScheduleDocument, FeeScheduleUploadError } from "@/lib/data/custodian-fee-documents";
import {
  mergeCustodianAuthority,
  readCustodianAuthorityProfiles,
  saveCustodianAuthority,
  type CustodianAuthorityFeeRecord,
  type CustodianAuthorityProfileRecord,
  type CustodianAuthorityRefusal,
  type CustodianFeeRuleInput,
  type CustodianProfileInput,
  type CustodianSaveInput,
} from "@/lib/data/custodian-authority";
import { markCustodianLibraryStale } from "@/lib/data/acat-workspace";
import { demoMode } from "@/lib/demo/mode";
import {
  detailsPatch, feeFailure, feePayload, nameFailure, playbookPatch,
  type DetailsDraft, type FeeDraft, type PlaybookDraft,
} from "@/lib/data/custodian-admin-contract";

export type CustodianAdminResult =
  | { ok: true; custodian: CustodianProfile; reassigned?: number; deletedId?: string }
  | { ok: true; unchanged: true }
  | { ok: false; reason: string; retryable: boolean };

export type CustodianFeeScheduleDownloadResult =
  | { ok: true; filename: string; contentType: string; bytesBase64: string }
  | { ok: false; reason: string; retryable: boolean };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const NO_CUSTODIAN = "This custodian no longer exists in the tracker.";
const LIBRARY_OFF = "Custodian authority library is off.";
const DEMO_UPLOADS_OFF = "Uploading fee-schedule files is off in the public demo. The custodians' stored files still download.";

const fail = (reason: string, retryable = false): CustodianAdminResult => ({ ok: false, reason, retryable });

function authorityRefusalMessage(reason: CustodianAuthorityRefusal): string {
  switch (reason) {
    case "writes_disabled":
      return "Custodian authority writes are off.";
    case "not_permitted":
      return "Only admins can change custodian authority.";
    case "transfer_copy_behind":
      return "The transfer copy has not confirmed the previous custodian change yet.";
    case "not_found":
      return "This custodian was not found in Always-On Advice.";
    case "invalid_merge":
      return "Those custodians cannot be merged.";
    case "save_failed":
      return "The custodian save failed.";
    case "merge_failed":
      return "The custodian merge failed.";
    case "read_failed":
      return "The custodian library could not be read.";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

async function gate(): Promise<{ ok: true; email: string } | { ok: false; result: CustodianAdminResult }> {
  if (!acatCustodianAdminEnabled()) return { ok: false, result: fail("Custodian editing is off.") };
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const email = session?.user?.email ?? null;
  if (!session?.user || !custodianAdminAllowed(role) || !email?.trim()) {
    return { ok: false, result: fail("Only admins can change custodians.") };
  }
  return { ok: true, email };
}

function authorityIdentity(email: string): Identity {
  return { role: "ADMIN", email };
}

function mapFeeRecordToInput(fee: CustodianAuthorityFeeRecord): CustodianFeeRuleInput {
  return {
    id: fee.id,
    fee_type: fee.feeType,
    account_type: fee.accountType,
    transfer_type: fee.transferType,
    direction: fee.direction,
    amount: fee.amount,
    amount_text: fee.amountText,
    notes: fee.notes,
    documentation: fee.documentation,
  };
}

function mapFeeDraftToInput(draft: FeeDraft, id?: string): CustodianFeeRuleInput {
  const payload = feePayload(draft);
  return {
    id,
    fee_type: String(payload.feeType),
    account_type: String(payload.accountType),
    transfer_type: String(payload.transferType),
    direction: String(payload.direction),
    amount: payload.amount as number | null,
    amount_text: payload.amountText as string | null,
    notes: payload.notes as string | null,
    documentation: payload.documentation as string | null,
  };
}

function mapProfileToInput(
  record: CustodianAuthorityProfileRecord | CustodianProfile,
  overlay: Partial<CustodianProfileInput> = {},
): CustodianProfileInput {
  const avgDays = "avgProcessingDays" in record
    ? record.avgProcessingDays
    : record.configuredExpectedProcessingDays;
  const base: CustodianProfileInput = {
    id: record.id,
    name: record.name,
    acat_fee_amount: record.acatFeeAmount ?? undefined,
    avg_processing_days: typeof avgDays === "number" ? avgDays : undefined,
    contact_email: record.contactEmail,
    contact_method: record.contactMethod ?? null,
    contact_details: record.contactDetails ?? null,
    review_status: record.reviewStatus,
    transfer_type: record.transferType,
    documentation_status: record.documentationStatus,
    dtc_number: record.dtcNumber,
    receiving_account_number: record.receivingAccountNumber,
    signature: record.signature,
    letter_of_acceptance: record.letterOfAcceptance,
    medallion_required: record.medallionRequired,
    liquidation_method: record.liquidationMethod,
    return_method: record.returnMethod,
    watchouts: record.watchouts,
    paperwork_on_file: record.paperworkOnFile,
    transfers_to_date: record.transfersToDate,
  };
  return { ...base, ...overlay };
}

function feesFromRecord(record: CustodianAuthorityProfileRecord): CustodianFeeRuleInput[] {
  return record.fees.map((fee) => mapFeeRecordToInput(fee));
}

async function loadAuthorityRecord(custodianId: string): Promise<CustodianAuthorityProfileRecord | null> {
  const read = await readCustodianAuthorityProfiles("ADMIN");
  if (!read.ok) return null;
  return read.value.find((row) => row.id === custodianId) ?? null;
}

async function readSavedCustodian(custodianId: string): Promise<CustodianAdminResult> {
  const record = await loadAuthorityRecord(custodianId);
  if (!record) return fail(authorityRefusalMessage("not_found"), true);
  const documents = await withUserScope({ role: "ADMIN", email: null }, async (tx) =>
    tx.custodianFeeScheduleDocument.findMany({
      where: { custodianId },
      select: {
        id: true,
        filename: true,
        contentType: true,
        byteSize: true,
        sha256: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  );
  const assembled = {
    id: record.id,
    name: record.name,
    reviewStatus: record.reviewStatus,
    acatFeeAmount: record.acatFeeAmount,
    transferType: record.transferType,
    documentationStatus: record.documentationStatus,
    dtcNumber: record.dtcNumber,
    receivingAccountNumber: record.receivingAccountNumber,
    signature: record.signature,
    letterOfAcceptance: record.letterOfAcceptance,
    medallionRequired: record.medallionRequired,
    liquidationMethod: record.liquidationMethod,
    returnMethod: record.returnMethod,
    watchouts: record.watchouts,
    paperworkOnFile: record.paperworkOnFile,
    transfersToDate: record.transfersToDate,
    contactEmail: record.contactEmail,
    contactMethod: record.contactMethod as CustodianProfile["contactMethod"],
    contactDetails: record.contactDetails,
    configuredExpectedProcessingDays: record.avgProcessingDays,
    observedAvgProcessingBusinessDays: null,
    observedCompletedTransfers: 0,
    observedTimingAvailable: false,
    fees: record.fees.map((fee) => ({
      id: fee.id,
      feeType: fee.feeType,
      accountType: fee.accountType,
      transferType: fee.transferType,
      direction: fee.direction,
      amount: fee.amount,
      amountText: fee.amountText,
      notes: fee.notes,
      documentation: fee.documentation,
      createdAt: fee.createdAt,
      updatedAt: fee.updatedAt,
    })),
    feeSchedules: documents.map((doc) => ({
      id: doc.id,
      filename: doc.filename,
      contentType: doc.contentType as "application/pdf" | "image/png" | "image/jpeg",
      byteSize: doc.byteSize,
      sha256: doc.sha256,
      createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
    })),
  };
  const parsed = custodianProfileSchema.safeParse(assembled);
  if (!parsed.success) return fail(authorityRefusalMessage("read_failed"), true);
  return { ok: true, custodian: parsed.data };
}

async function saveAuthority(
  identity: Identity,
  input: CustodianSaveInput,
): Promise<CustodianAdminResult> {
  const saved = await saveCustodianAuthority(identity, input);
  if (!saved.ok) return fail(authorityRefusalMessage(saved.reason), true);
  markCustodianLibraryStale();
  return readSavedCustodian(saved.value.custodianId);
}

function localWritesReady(): { ok: true } | { ok: false; result: CustodianAdminResult } {
  if (!showCustodianAuthorityLibraryEnabled()) return { ok: true };
  if (!custodianAuthorityStorageWritesEnabled()) {
    return { ok: false, result: fail(authorityRefusalMessage("writes_disabled")) };
  }
  return { ok: true };
}

export async function createCustodian(name: string): Promise<CustodianAdminResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed.result;
  const failure = nameFailure(typeof name === "string" ? name : "");
  if (failure) return fail(failure);
  if (!showCustodianAuthorityLibraryEnabled()) {
    return fail(LIBRARY_OFF);
  }
  const writes = localWritesReady();
  if (!writes.ok) return writes.result;
  return saveAuthority(authorityIdentity(allowed.email), {
    profile: { name: name.trim() },
    fees: [],
  });
}

export async function saveCustodianDetails(profile: CustodianProfile, draft: DetailsDraft): Promise<CustodianAdminResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed.result;
  if (!ID.test(profile?.id ?? "")) return fail(NO_CUSTODIAN);
  const patch = detailsPatch(profile, draft);
  if (!patch.ok) return fail(patch.reason);
  if (Object.keys(patch.patch).length === 0) return { ok: true, unchanged: true };
  if (!showCustodianAuthorityLibraryEnabled()) {
    return fail(LIBRARY_OFF);
  }
  const writes = localWritesReady();
  if (!writes.ok) return writes.result;
  const record = await loadAuthorityRecord(profile.id);
  if (!record) return fail(authorityRefusalMessage("not_found"), true);
  const overlay: Partial<CustodianProfileInput> = {};
  if (typeof patch.patch.name === "string") overlay.name = patch.patch.name;
  if (typeof patch.patch.avgProcessingDays === "number") {
    overlay.avg_processing_days = patch.patch.avgProcessingDays;
  }
  return saveAuthority(authorityIdentity(allowed.email), {
    profile: mapProfileToInput(record, overlay),
    fees: feesFromRecord(record),
  });
}

export async function saveCustodianPlaybook(profile: CustodianProfile, draft: PlaybookDraft): Promise<CustodianAdminResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed.result;
  if (!ID.test(profile?.id ?? "")) return fail(NO_CUSTODIAN);
  const patch = playbookPatch(profile, draft);
  if (Object.keys(patch).length === 0) return { ok: true, unchanged: true };
  if (!showCustodianAuthorityLibraryEnabled()) {
    return fail(LIBRARY_OFF);
  }
  const writes = localWritesReady();
  if (!writes.ok) return writes.result;
  const record = await loadAuthorityRecord(profile.id);
  if (!record) return fail(authorityRefusalMessage("not_found"), true);
  const keyMap: Record<string, keyof CustodianProfileInput> = {
    dtcNumber: "dtc_number",
    receivingAccountNumber: "receiving_account_number",
    signature: "signature",
    letterOfAcceptance: "letter_of_acceptance",
    medallionRequired: "medallion_required",
    liquidationMethod: "liquidation_method",
    returnMethod: "return_method",
    watchouts: "watchouts",
    transferType: "transfer_type",
    documentationStatus: "documentation_status",
    paperworkOnFile: "paperwork_on_file",
    transfersToDate: "transfers_to_date",
    contactMethod: "contact_method",
    contactDetails: "contact_details",
  };
  const overlay: Partial<CustodianProfileInput> = {};
  for (const [camel, snake] of Object.entries(keyMap)) {
    if (Object.prototype.hasOwnProperty.call(patch, camel)) {
      (overlay as Record<string, unknown>)[snake] = patch[camel];
    }
  }
  return saveAuthority(authorityIdentity(allowed.email), {
    profile: mapProfileToInput(record, overlay),
    fees: feesFromRecord(record),
  });
}

export async function markCustodianReviewed(id: string): Promise<CustodianAdminResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed.result;
  if (!ID.test(id ?? "")) return fail(NO_CUSTODIAN);
  if (!showCustodianAuthorityLibraryEnabled()) {
    return fail(LIBRARY_OFF);
  }
  const writes = localWritesReady();
  if (!writes.ok) return writes.result;
  const record = await loadAuthorityRecord(id);
  if (!record) return fail(authorityRefusalMessage("not_found"), true);
  return saveAuthority(authorityIdentity(allowed.email), {
    profile: mapProfileToInput(record, { review_status: "VERIFIED" }),
    fees: feesFromRecord(record),
  });
}

export async function addCustodianFee(id: string, draft: FeeDraft): Promise<CustodianAdminResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed.result;
  if (!ID.test(id ?? "")) return fail(NO_CUSTODIAN);
  const failure = feeFailure(draft);
  if (failure) return fail(failure);
  if (!showCustodianAuthorityLibraryEnabled()) {
    return fail(LIBRARY_OFF);
  }
  const writes = localWritesReady();
  if (!writes.ok) return writes.result;
  const record = await loadAuthorityRecord(id);
  if (!record) return fail(authorityRefusalMessage("not_found"), true);
  const fees = [...feesFromRecord(record), mapFeeDraftToInput(draft)];
  return saveAuthority(authorityIdentity(allowed.email), {
    profile: mapProfileToInput(record),
    fees,
  });
}

export async function saveCustodianFee(id: string, feeId: string, draft: FeeDraft): Promise<CustodianAdminResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed.result;
  if (!ID.test(id ?? "") || !ID.test(feeId ?? "")) return fail(NO_CUSTODIAN);
  const failure = feeFailure(draft);
  if (failure) return fail(failure);
  if (!showCustodianAuthorityLibraryEnabled()) {
    return fail(LIBRARY_OFF);
  }
  const writes = localWritesReady();
  if (!writes.ok) return writes.result;
  const record = await loadAuthorityRecord(id);
  if (!record) return fail(authorityRefusalMessage("not_found"), true);
  const next = mapFeeDraftToInput(draft, feeId);
  const fees = feesFromRecord(record).map((fee) => (fee.id === feeId ? next : fee));
  if (!fees.some((fee) => fee.id === feeId)) fees.push(next);
  return saveAuthority(authorityIdentity(allowed.email), {
    profile: mapProfileToInput(record),
    fees,
  });
}

export async function deleteCustodianFee(id: string, feeId: string): Promise<CustodianAdminResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed.result;
  if (!ID.test(id ?? "") || !ID.test(feeId ?? "")) return fail(NO_CUSTODIAN);
  if (!showCustodianAuthorityLibraryEnabled()) {
    return fail(LIBRARY_OFF);
  }
  const writes = localWritesReady();
  if (!writes.ok) return writes.result;
  const record = await loadAuthorityRecord(id);
  if (!record) return fail(authorityRefusalMessage("not_found"), true);
  return saveAuthority(authorityIdentity(allowed.email), {
    profile: mapProfileToInput(record),
    fees: feesFromRecord(record).filter((fee) => fee.id !== feeId),
  });
}

export async function mergeCustodian(sourceId: string, targetId: string): Promise<CustodianAdminResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed.result;
  if (!ID.test(sourceId ?? "") || !ID.test(targetId ?? "")) return fail(NO_CUSTODIAN);
  if (!showCustodianAuthorityLibraryEnabled()) {
    return fail(LIBRARY_OFF);
  }
  const writes = localWritesReady();
  if (!writes.ok) return writes.result;
  const identity = authorityIdentity(allowed.email);
  const sourceDocIds = await listCustodianFeeScheduleDocumentIds(identity, sourceId);
  await reassignCustodianFeeScheduleDocuments(identity, sourceDocIds, targetId);
  const merged = await mergeCustodianAuthority(identity, { sourceId, targetId });
  if (!merged.ok) {
    await reassignCustodianFeeScheduleDocuments(identity, sourceDocIds, sourceId);
    return fail(authorityRefusalMessage(merged.reason), true);
  }
  markCustodianLibraryStale();
  const saved = await readSavedCustodian(targetId);
  if (!saved.ok || !("custodian" in saved)) return saved;
  return { ok: true, custodian: saved.custodian, deletedId: sourceId, reassigned: 0 };
}

export async function saveCustodianFeeSchedule(
  custodianId: string,
  file: { filename: string; contentType: string; bytesBase64: string },
): Promise<CustodianAdminResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed.result;
  // The public demo stores no visitor files: every other visitor could download them, and nothing bounds how many.
  if (demoMode()) return fail(DEMO_UPLOADS_OFF);
  if (!ID.test(custodianId ?? "")) return fail(NO_CUSTODIAN);
  if (!showCustodianAuthorityLibraryEnabled()) {
    return fail(LIBRARY_OFF);
  }
  if (!custodianAuthorityStorageWritesEnabled()) {
    return fail(authorityRefusalMessage("writes_disabled"));
  }
  const identity = authorityIdentity(allowed.email);
  let built;
  try {
    built = buildFeeScheduleDocument({
      filename: file.filename,
      contentType: file.contentType,
      content: Buffer.from(file.bytesBase64, "base64"),
    });
  } catch (error) {
    if (error instanceof FeeScheduleUploadError) return fail(error.message);
    throw error;
  }
  const id = crypto.randomUUID();
  const { filename, contentType, content, sha256, byteSize } = built;
  await withUserScope(identity, async (tx) => {
    await tx.custodianFeeScheduleDocument.create({
      data: {
        id,
        custodianId,
        filename,
        contentType,
        content,
        sha256,
        byteSize,
        createdBy: identity.email ?? "",
      },
    });
    await writeAudit(tx, identity, {
      action: "custodian_fee_schedule.upload",
      entityType: "custodian_fee_schedule_document",
      entityId: id,
      detail: { id, filename, byteSize, sha256 },
    });
  });
  markCustodianLibraryStale();
  return readSavedCustodian(custodianId);
}

export async function downloadCustodianFeeSchedule(
  documentId: string,
): Promise<CustodianFeeScheduleDownloadResult> {
  const allowed = await gate();
  if (!allowed.ok) {
    const denied = allowed.result;
    if (!denied.ok) return { ok: false, reason: denied.reason, retryable: denied.retryable };
    return { ok: false, reason: LIBRARY_OFF, retryable: false };
  }
  if (!ID.test(documentId ?? "")) {
    return { ok: false, reason: "That fee-schedule file was not found.", retryable: false };
  }
  if (!showCustodianAuthorityLibraryEnabled()) {
    return { ok: false, reason: LIBRARY_OFF, retryable: false };
  }
  if (!custodianAuthorityStorageWritesEnabled()) {
    return { ok: false, reason: authorityRefusalMessage("writes_disabled"), retryable: false };
  }
  const row = await readCustodianFeeScheduleBytes(authorityIdentity(allowed.email), documentId);
  if (!row) return { ok: false, reason: "That fee-schedule file was not found.", retryable: false };
  return {
    ok: true,
    filename: row.filename,
    contentType: row.contentType,
    bytesBase64: row.content.toString("base64"),
  };
}
