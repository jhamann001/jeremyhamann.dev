import { createHash } from "node:crypto";
import { custodianSnapshotImportEnabled } from "@/lib/flags";

export const IMPORT_IDENTITY = {
  role: "ADMIN" as const,
  email: "custodian-snapshot-import@example.test",
};

const PROFILE_KEYS = [
  "id", "name", "reviewStatus", "acatFeeAmount", "transferType", "documentationStatus",
  "dtcNumber", "receivingAccountNumber", "signature", "letterOfAcceptance", "medallionRequired",
  "liquidationMethod", "returnMethod", "watchouts", "paperworkOnFile", "transfersToDate",
  "avgProcessingDays", "contactEmail", "contactMethod", "contactDetails",
] as const;

const FEE_KEYS = [
  "id", "feeType", "accountType", "transferType", "direction", "amount",
  "amountText", "notes", "documentation", "createdAt", "updatedAt",
] as const;

export type CustodianSnapshotFee = {
  id: string;
  feeType: string;
  accountType: string;
  transferType: string;
  direction: string;
  amount: number | null;
  amountText: string | null;
  notes: string | null;
  documentation: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustodianSnapshotFile = {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
  createdBy: string;
};

export type CustodianSnapshotCustodian = {
  id: string;
  name: string;
  reviewStatus: string;
  acatFeeAmount: number;
  transferType: string | null;
  documentationStatus: string | null;
  dtcNumber: string | null;
  receivingAccountNumber: string | null;
  signature: string | null;
  letterOfAcceptance: string | null;
  medallionRequired: string | null;
  liquidationMethod: string | null;
  returnMethod: string | null;
  watchouts: string | null;
  paperworkOnFile: boolean | null;
  transfersToDate: number | null;
  avgProcessingDays: number;
  contactEmail: string | null;
  contactMethod: string | null;
  contactDetails: string | null;
  fees: CustodianSnapshotFee[];
  feeScheduleDocuments: CustodianSnapshotFile[];
};

export type CustodianSnapshot = {
  schemaVersion: 1;
  custodians: CustodianSnapshotCustodian[];
};

export type StoredImportItem = {
  readonly kind: "custodian" | "fee_rule" | "fee_schedule_file";
  readonly originalId: string;
  readonly authorityId: string;
  readonly byteCount: number;
  readonly checksum: string;
  readonly revision: number | null;
  readonly confirmed: boolean;
};

export type ImportRefusal =
  | "flag_off"
  | "checksum_mismatch"
  | "duplicate_id"
  | "writes_disabled"
  | "not_permitted"
  | "save_failed"
  | "not_found"
  | "transfer_copy_behind"
  | "invalid_merge"
  | "merge_failed"
  | "read_failed";

export type ImportCustodianSnapshotResult =
  | { readonly refused: null; readonly snapshotSha256: string; readonly runId: string }
  | { readonly refused: ImportRefusal; readonly snapshotSha256: string | null; readonly runId: null };

export type ImportEvidenceStore = {
  findRun(snapshotSha256: string): Promise<{ id: string; items: StoredImportItem[] } | null>;
  createRun(snapshotSha256: string): Promise<{ id: string }>;
  upsertItem(importId: string, item: StoredImportItem): Promise<void>;
};

export type FeeScheduleInsert = {
  id: string;
  custodianId: string;
  filename: string;
  contentType: string;
  content: Uint8Array;
  sha256: string;
  byteSize: number;
  createdAt: Date;
  createdBy: string;
};

type SaveResult =
  | { ok: true; value: { custodianId: string; revision: bigint } }
  | {
      ok: false;
      reason:
        | "writes_disabled"
        | "not_permitted"
        | "transfer_copy_behind"
        | "not_found"
        | "invalid_merge"
        | "save_failed"
        | "merge_failed"
        | "read_failed";
    };

export type ImportCustodianSnapshotDeps = {
  saveCustodianAuthority: (
    identity: typeof IMPORT_IDENTITY,
    input: {
      profile: {
        id: string;
        name: string;
        acat_fee_amount: number;
        avg_processing_days: number;
        contact_email: string | null;
        contact_method: string | null;
        contact_details: string | null;
        review_status: string;
        transfer_type: string | null;
        documentation_status: string | null;
        dtc_number: string | null;
        receiving_account_number: string | null;
        signature: string | null;
        letter_of_acceptance: string | null;
        medallion_required: string | null;
        liquidation_method: string | null;
        return_method: string | null;
        watchouts: string | null;
        paperwork_on_file: boolean | null;
        transfers_to_date: number | null;
      };
      fees: Array<{
        id: string;
        fee_type: string;
        account_type: string;
        transfer_type: string;
        direction: string;
        amount: number | null;
        amount_text: string | null;
        notes: string | null;
        documentation: string | null;
      }>;
    },
  ) => Promise<SaveResult>;
  confirmCustodianAuthorityRevision: (revision: number) => Promise<void>;
  listCustodianAuthorityRevisions: () => Promise<ReadonlyArray<{ revision: number; body: unknown }>>;
  readAuthorityState: () => Promise<{ acceptedRevision: bigint; confirmedRevision: bigint }>;
  evidence: ImportEvidenceStore;
  findFeeSchedule: (originalId: string) => Promise<{ id: string } | null>;
  insertFeeSchedule: (row: FeeScheduleInsert) => Promise<void>;
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function traceImport(fields: { operation: "import" | "resume"; outcome: "ok" | "refused"; reason: string | null }): void {
  const runId = process.env.TEST_RUN_ID ?? "runtime";
  console.error(JSON.stringify({
    feature: "custodian-snapshot-import",
    operation: fields.operation,
    outcome: fields.outcome,
    reason: fields.reason,
    run_id: runId,
  }));
}

function finish(result: ImportCustodianSnapshotResult, operation: "import" | "resume"): ImportCustodianSnapshotResult {
  traceImport({ operation, outcome: result.refused === null ? "ok" : "refused", reason: result.refused });
  return result;
}

export function safeRevision(value: bigint | number): number {
  const revision = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(revision)) {
    traceImport({ operation: "import", outcome: "refused", reason: "revision_not_safe" });
    throw new Error("revision_not_safe");
  }
  return revision;
}

function recordDigest(record: Record<string, unknown>): { byteCount: number; checksum: string } {
  const bytes = Buffer.from(canonicalJson(record));
  return { byteCount: bytes.byteLength, checksum: sha256Hex(bytes) };
}

function picked(source: object, keys: readonly string[]): Record<string, unknown> {
  const record = source as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, record[key] ?? null]));
}

export function profileDigest(custodian: CustodianSnapshotCustodian): { byteCount: number; checksum: string } {
  return recordDigest(picked(custodian, PROFILE_KEYS));
}

export function feeDigest(fee: CustodianSnapshotFee): { byteCount: number; checksum: string } {
  return recordDigest(picked(fee, FEE_KEYS));
}

function remember(items: StoredImportItem[], stored: StoredImportItem): void {
  const index = items.findIndex((item) => item.kind === stored.kind && item.originalId === stored.originalId);
  if (index === -1) items.push(stored);
  else items[index] = stored;
}

function sameNullable(stored: unknown, expected: string | number | null): boolean {
  return (stored ?? null) === expected;
}

function compareId(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function feeRuleId(body: unknown, fee: CustodianSnapshotFee, used: ReadonlySet<string>): string | null {
  if (!body || typeof body !== "object" || !("fee_rules" in body)) return null;
  const rules = (body as { fee_rules: unknown }).fee_rules;
  if (!Array.isArray(rules)) return null;
  const candidates: string[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const row = rule as Record<string, unknown>;
    if (typeof row.id !== "string" || used.has(row.id)) continue;
    if (
      sameNullable(row.fee_type, fee.feeType)
      && sameNullable(row.account_type, fee.accountType)
      && sameNullable(row.transfer_type, fee.transferType)
      && sameNullable(row.direction, fee.direction)
      && sameNullable(row.amount, fee.amount)
      && sameNullable(row.notes, fee.notes)
      && sameNullable(row.amount_text, fee.amountText)
      && sameNullable(row.documentation, fee.documentation)
    ) candidates.push(row.id);
  }
  candidates.sort(compareId);
  return candidates[0] ?? null;
}

function refuse(reason: ImportRefusal, snapshotSha256: string | null = null): ImportCustodianSnapshotResult {
  return { refused: reason, snapshotSha256, runId: null };
}

function signatureOk(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === "application/pdf") {
    return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
  }
  if (contentType === "image/png") {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte);
  }
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return false;
}

function validate(snapshot: CustodianSnapshot, files: Readonly<Record<string, Uint8Array>>): ImportRefusal | null {
  if (snapshot.schemaVersion !== 1) return "checksum_mismatch";
  const ids = new Set<string>();
  for (const custodian of snapshot.custodians) {
    if (ids.has(`custodian:${custodian.id}`)) return "duplicate_id";
    ids.add(`custodian:${custodian.id}`);
    for (const fee of custodian.fees) {
      if (ids.has(`fee_rule:${fee.id}`)) return "duplicate_id";
      ids.add(`fee_rule:${fee.id}`);
    }
    for (const document of custodian.feeScheduleDocuments) {
      if (ids.has(`fee_schedule_file:${document.id}`)) return "duplicate_id";
      ids.add(`fee_schedule_file:${document.id}`);
      const bytes = files[document.id];
      if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) return "checksum_mismatch";
      if (bytes.byteLength !== document.byteSize || sha256Hex(bytes) !== document.sha256) return "checksum_mismatch";
      if (!signatureOk(document.contentType, bytes)) return "checksum_mismatch";
    }
  }
  return null;
}

function saveInput(custodian: CustodianSnapshotCustodian): Parameters<ImportCustodianSnapshotDeps["saveCustodianAuthority"]>[1] {
  // Tracker upserts the projection by these ids, so the authority keeps the Tracker custodian and fee ids.
  return {
    profile: {
      id: custodian.id,
      name: custodian.name,
      acat_fee_amount: custodian.acatFeeAmount,
      avg_processing_days: custodian.avgProcessingDays,
      contact_email: custodian.contactEmail,
      contact_method: custodian.contactMethod,
      contact_details: custodian.contactDetails,
      review_status: custodian.reviewStatus,
      transfer_type: custodian.transferType,
      documentation_status: custodian.documentationStatus,
      dtc_number: custodian.dtcNumber,
      receiving_account_number: custodian.receivingAccountNumber,
      signature: custodian.signature,
      letter_of_acceptance: custodian.letterOfAcceptance,
      medallion_required: custodian.medallionRequired,
      liquidation_method: custodian.liquidationMethod,
      return_method: custodian.returnMethod,
      watchouts: custodian.watchouts,
      paperwork_on_file: custodian.paperworkOnFile,
      transfers_to_date: custodian.transfersToDate,
    },
    fees: custodian.fees.map((fee) => ({
      id: fee.id,
      fee_type: fee.feeType,
      account_type: fee.accountType,
      transfer_type: fee.transferType,
      direction: fee.direction,
      amount: fee.amount,
      amount_text: fee.amountText,
      notes: fee.notes,
      documentation: fee.documentation,
    })),
  };
}

function bodyName(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("name" in body)) return null;
  const name = (body as { name: unknown }).name;
  return typeof name === "string" ? name : null;
}

function bodyId(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("id" in body)) return null;
  const id = (body as { id: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function importCustodianSnapshot(
  snapshot: CustodianSnapshot,
  files: Readonly<Record<string, Uint8Array>>,
  deps: ImportCustodianSnapshotDeps,
): Promise<ImportCustodianSnapshotResult> {
  if (!custodianSnapshotImportEnabled()) return finish(refuse("flag_off"), "import");
  const invalid = validate(snapshot, files);
  if (invalid) return finish(refuse(invalid), "import");
  const snapshotSha256 = sha256Hex(Buffer.from(canonicalJson(snapshot)));
  const existing = await deps.evidence.findRun(snapshotSha256);
  const operation = existing ? "resume" : "import";
  const run = existing ?? await deps.evidence.createRun(snapshotSha256);
  const items = [...(existing?.items ?? [])];

  for (const custodian of snapshot.custodians) {
    const prior = items.find((item) => item.kind === "custodian" && item.originalId === custodian.id);
    let authorityId: string;
    let revision: number;
    let eventBody: unknown;
    if (prior?.confirmed && prior.authorityId) {
      authorityId = prior.authorityId;
      revision = safeRevision(prior.revision ?? 0);
      const feeMissing = custodian.fees.some((fee) => !items.some((item) => item.kind === "fee_rule" && item.originalId === fee.id && item.confirmed));
      eventBody = feeMissing ? undefined : null;
    } else if (prior && !prior.confirmed && prior.revision != null && prior.authorityId) {
      revision = safeRevision(prior.revision);
      await deps.confirmCustodianAuthorityRevision(revision);
      const confirmed = { ...prior, revision, confirmed: true };
      await deps.evidence.upsertItem(run.id, confirmed);
      remember(items, confirmed);
      authorityId = prior.authorityId;
      eventBody = undefined;
    } else {
      const state = await deps.readAuthorityState();
      if (state.acceptedRevision !== state.confirmedRevision) {
        revision = safeRevision(state.acceptedRevision);
        const listed = await deps.listCustodianAuthorityRevisions();
        const event = listed.find((row) => row.revision === revision);
        const matchedId = event ? bodyId(event.body) : null;
        if (!event || bodyName(event.body) !== custodian.name || !matchedId) return finish(refuse("save_failed", snapshotSha256), operation);
        await deps.confirmCustodianAuthorityRevision(revision);
        authorityId = matchedId;
        eventBody = event.body;
      } else {
        const saved = await deps.saveCustodianAuthority(IMPORT_IDENTITY, saveInput(custodian));
        if (!saved.ok) return finish(refuse(saved.reason, snapshotSha256), operation);
        authorityId = saved.value.custodianId;
        revision = safeRevision(saved.value.revision);
        const pending: StoredImportItem = {
          kind: "custodian", originalId: custodian.id, ...profileDigest(custodian), revision, authorityId, confirmed: false,
        };
        await deps.evidence.upsertItem(run.id, pending);
        remember(items, pending);
        await deps.confirmCustodianAuthorityRevision(revision);
        const confirmed = { ...pending, confirmed: true };
        await deps.evidence.upsertItem(run.id, confirmed);
        remember(items, confirmed);
        eventBody = undefined;
      }
    }
    if (!items.some((item) => item.kind === "custodian" && item.originalId === custodian.id && item.confirmed)) {
      const stored: StoredImportItem = {
        kind: "custodian", originalId: custodian.id, ...profileDigest(custodian), revision: revision!, authorityId: authorityId!, confirmed: true,
      };
      await deps.evidence.upsertItem(run.id, stored);
      remember(items, stored);
    }

    const usedFeeIds = new Set<string>();
    for (const fee of custodian.fees) {
      const priorFee = items.find((item) => item.kind === "fee_rule" && item.originalId === fee.id && item.confirmed);
      if (priorFee) {
        usedFeeIds.add(priorFee.authorityId);
        continue;
      }
      if (eventBody === undefined) {
        const listed = await deps.listCustodianAuthorityRevisions();
        const event = listed.find((row) => row.revision === revision!);
        const matchedId = event ? bodyId(event.body) : null;
        if (!event || bodyName(event.body) !== custodian.name || matchedId !== authorityId!) return finish(refuse("save_failed", snapshotSha256), operation);
        eventBody = event.body;
      }
      const feeId = feeRuleId(eventBody, fee, usedFeeIds);
      if (!feeId) return finish(refuse("save_failed", snapshotSha256), operation);
      usedFeeIds.add(feeId);
      const stored: StoredImportItem = {
        kind: "fee_rule", originalId: fee.id, ...feeDigest(fee), revision: revision!, authorityId: feeId, confirmed: true,
      };
      await deps.evidence.upsertItem(run.id, stored);
      remember(items, stored);
    }

    for (const document of custodian.feeScheduleDocuments) {
      if (items.some((item) => item.kind === "fee_schedule_file" && item.originalId === document.id && item.confirmed)) continue;
      const already = await deps.findFeeSchedule(document.id);
      if (!already) {
        const bytes = files[document.id]!;
        await deps.insertFeeSchedule({
          id: document.id,
          custodianId: authorityId!,
          filename: document.filename,
          contentType: document.contentType,
          content: bytes,
          sha256: document.sha256,
          byteSize: document.byteSize,
          createdAt: new Date(document.createdAt),
          createdBy: document.createdBy,
        });
      }
      const stored: StoredImportItem = {
        kind: "fee_schedule_file",
        originalId: document.id,
        byteCount: document.byteSize,
        checksum: document.sha256,
        revision: null,
        authorityId: document.id,
        confirmed: true,
      };
      await deps.evidence.upsertItem(run.id, stored);
      remember(items, stored);
    }
  }

  return finish({ refused: null, snapshotSha256, runId: run.id }, operation);
}
