import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { changeRecord, listRecords, readRecord, saveRecord } from "./store";
import {
  LIFECYCLE_STATUSES, RECON_DERIVED_STATUSES, advisorProjection, assetCounts, bookProjection, detailProjection, feeFields,
  hasApexUpload, inFlightRecords, listProjection, maskIdentifier, newTrackerRecord, normalizeDateToIso, normalizeDtccNumber,
  normalizeMoneyStringExact, reconSnapshot, sortByActivity, type MapStatus, type TrackerAsset, type TrackerClient,
  type TrackerMappingAccount, type TrackerRecord,
} from "./tracker-model";
import { businessDaysBetween, composeDashboard, suggestDtccNumber } from "./tracker-analytics";
import { linkageSnapshot } from "./tracker-linkage";
import { PreparationError, buildPreparation, changeScope, confirmTitle, generateForm, type CustodianPlaybook } from "./tracker-forms";
import type { PipelineAccount, PipelineHousehold } from "./pipeline";
import type { StandInCall, StandInReply, StandInRoute } from "./fetch";

// The Transfer Tracker's machine API, answered in the demo from its records (demo.stand_in_record, service "tracker":
// kind "acat" one per transfer record, kind "client" the Cedar Ridge client directory). Each route follows the
// tracker demo's route and library code (apps/acat/src/app/api/machine, apps/acat/src/lib) with the switches the
// tracker keeps dark in its own demo (drawer, recon, fees, history, dashboard, advisor list, transfer forms)
// treated as on, as in production. The operations reads (ops-book, ops-list, ops-record, ops-drawer) return the
// same rows with the two account numbers whole. Writes keep the tracker's field-level history.
// Re-exported for the seed and the demo's configuration.
export type { TrackerRecord, TrackerClient } from "./tracker-model";
export { DEMO_LINKAGE_INSTALLATION_ID } from "./tracker-linkage";

const DEFAULT_ACTOR = "Always-On-Advice";
const ok = (json: unknown, status = 200): StandInReply => ({ status, json });
const notFound = (): StandInReply => ({ status: 404, json: { error: "not_found" } });
const bad = (error: string, extra: Record<string, unknown> = {}): StandInReply => ({ status: 400, json: { error, ...extra } });
const now = () => new Date().toISOString();
const actorOf = (call: StandInCall) => call.headers.get("x-aoa-actor-email")?.trim().toLowerCase() || DEFAULT_ACTOR;

async function allRecords(): Promise<TrackerRecord[]> {
  return (await listRecords<TrackerRecord>("tracker", "acat")).map((r) => r.doc);
}
const liveRecords = async () => (await allRecords()).filter((r) => !r.deletedAt);

async function liveRecord(id: string): Promise<TrackerRecord | null> {
  const stored = await readRecord<TrackerRecord>("tracker", "acat", id);
  return stored && !stored.doc.deletedAt ? stored.doc : null;
}

async function directory(): Promise<TrackerClient[]> {
  return (await listRecords<TrackerClient>("tracker", "client")).map((r) => r.doc);
}

/** AoA's custodian authority, the custodian library this demo's tracker shares. Empty if it can't be read. */
async function custodians() {
  try {
    const { readCustodianAuthorityProfiles } = await import("@/lib/data/custodian-authority");
    const read = await readCustodianAuthorityProfiles("OPERATIONS");
    return read.ok ? read.value : [];
  } catch {
    // A fixed marker only: the error may carry custodian data.
    console.error("[demo-tracker] custodian_library_read_failed");
    return [];
  }
}

const contraKey = (name: string | null | undefined) => (name ?? "").trim().replace(/\./g, "").replace(/\s+/g, " ").toLowerCase();

/** The tracker's resolveCustodianForContra: the library custodian whose name matches the contra. */
async function custodianForContra(contra: string | null | undefined) {
  if (!contra?.trim()) return null;
  return (await custodians()).find((c) => contraKey(c.name) === contraKey(contra)) ?? null;
}

// --- validation (the tracker's validators.ts) ---

const shortStr = z.string().max(120);
const midStr = z.string().max(500);
const longStr = z.string().max(2000);
const dateStr = shortStr.refine((v) => !v.trim() || normalizeDateToIso(v) != null, "Use a valid date")
  .transform((v) => (v.trim() ? normalizeDateToIso(v)! : ""));
const moneyStr = shortStr.refine((v) => !v.trim() || normalizeMoneyStringExact(v) != null, "Use a valid dollar amount")
  .transform((v) => (v.trim() ? normalizeMoneyStringExact(v)! : ""));
const dtccStr = shortStr.refine((v) => !v.trim() || normalizeDtccNumber(v) != null, "DTC number must contain up to four digits")
  .transform((v) => (v.trim() ? normalizeDtccNumber(v)! : ""));
const httpUrl = midStr.url("Must be a valid URL").refine((u) => /^https?:\/\//i.test(u), { message: "Must start with http:// or https://" });
const workflowEnum = z.enum(["ACAT", "MANUAL", "DRS", "RESIDUAL", "UNCLASSIFIED"]);
const userIdSchema = z.string().regex(/^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "Use a valid Cedar Ridge user ID");
const userIdsSchema = z.array(userIdSchema).min(1).max(10).refine((ids) => new Set(ids).size === ids.length, "Select each person only once");
const versionSchema = z.number().int().min(0).max(2147483647);

const updateSchema = z.object({
  expectedIdentityVersion: versionSchema.optional(),
  clientName: z.string().min(1).max(120).optional(),
  apexAccountId: shortStr.optional(),
  acatTransferId: shortStr.optional().nullable(),
  accountType: shortStr.optional().nullable(),
  additionalResources: longStr.optional().nullable(),
  apexCompletionDate: dateStr.optional().nullable(),
  apexTicket: shortStr.optional().nullable(),
  associatedControlNumber: shortStr.optional().nullable(),
  controlNumber: shortStr.optional().nullable(),
  dtccNumber: dtccStr.optional().nullable(),
  direction: shortStr.optional().nullable(),
  crwEe: shortStr.optional().nullable(),
  feeAmount: moneyStr.optional().nullable(),
  feeCharged: shortStr.optional().nullable(),
  feeMemo: longStr.optional().nullable(),
  feeRequestCompleted: dateStr.optional().nullable(),
  feeRequestSubmitted: dateStr.optional().nullable(),
  feeApexTicket: shortStr.optional().nullable(),
  feeCreditRequestId: shortStr.optional().nullable(),
  methodRequested: shortStr.optional().nullable(),
  transferWorkflow: workflowEnum.optional(),
  notes: longStr.optional().nullable(),
  opsSubmissionDateToApex: dateStr.optional().nullable(),
  originalClientRequestDate: dateStr.optional().nullable(),
  residualMonitoringRequired: z.boolean().optional(),
  residualFollowUpDate: dateStr.optional().nullable(),
  crmTicket: midStr.optional().nullable(),
  rejectionReason: longStr.optional().nullable(),
  statementAccountNumber: shortStr.optional().nullable(),
  statementAmount: z.number().int().nullable().optional(),
  status: z.enum([...LIFECYCLE_STATUSES, "Matched", "Mismatch", "Pending"]).optional(),
  transferringContra: shortStr.optional().nullable(),
  tradeRequestId: shortStr.optional().nullable(),
  tradeRequestUrl: httpUrl.optional().nullable(),
  tradeInstructions: longStr.optional().nullable(),
  type: shortStr.optional().nullable(),
  wealthAdvisor: shortStr.optional().nullable(),
  crmDealId: shortStr.optional().nullable(),
  acatDate: dateStr.optional(),
  apexSource: z.enum(["Uploaded", "Pending Upload"]).optional(),
  reconCompletedAt: shortStr.optional().nullable(),
}).strict();
type Update = z.infer<typeof updateSchema>;
const UPDATE_FIELDS = Object.keys(updateSchema.shape).filter((k) => k !== "expectedIdentityVersion") as (keyof Update)[];

const assetUpdateSchema = z.object({
  id: z.string().min(1).max(120), actualQty: z.number().finite().optional(),
  mapStatus: z.enum(["Mapped", "Unmapped", "Pending", "Expected"]).optional(),
  issue: longStr.optional().nullable(), notes: longStr.optional().nullable(),
}).strict();
const assetCreateSchema = z.object({
  symbol: z.string().trim().min(1).max(120), description: z.string().max(120).default(""), cusip: shortStr.optional().nullable(),
  expectedQty: z.number().finite().min(0).default(0), actualQty: z.number().finite().default(0),
  mapStatus: z.enum(["Mapped", "Unmapped", "Pending", "Expected"]).default("Unmapped"),
  issue: longStr.optional().nullable(), notes: longStr.optional().nullable(),
  amount: z.number().finite().optional().nullable(), assetClass: shortStr.optional().nullable(),
}).strict();

function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request";
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

// The tracker keeps 500 history entries a record. Visitors can write as often as they like and an entry can carry two
// 2,000-character values, so the demo keeps the newest 100 (all the history route shows), and stops sooner once they
// pass 32,000 characters. The newest entry always stays.
const HISTORY_MAX_ENTRIES = 100;
const HISTORY_MAX_CHARS = 32_000;

function trimHistory(record: TrackerRecord) {
  let kept = 0;
  let chars = 0;
  for (const entry of record.history) {
    chars += JSON.stringify(entry).length;
    if (kept === HISTORY_MAX_ENTRIES || (kept > 0 && chars > HISTORY_MAX_CHARS)) break;
    kept += 1;
  }
  if (kept < record.history.length) record.history = record.history.slice(0, kept);
}

function addHistory(record: TrackerRecord, action: string, field: string | null, oldValue: unknown, newValue: unknown, performedBy: string) {
  record.history.unshift({
    id: randomUUID(), action, field,
    oldValue: oldValue == null ? null : String(oldValue), newValue: newValue == null ? null : String(newValue),
    performedBy, timestamp: now(),
  });
  trimHistory(record);
}

const isOutgoing = (r: { direction?: string | null }) => r.direction?.trim().toLowerCase() === "out";
const isResidual = (r: { type?: string | null }) => r.type?.trim().toLowerCase() === "residual credit";
function defaultFeeCharged(r: { direction?: string | null; type?: string | null; transferWorkflow?: string | null }): "Yes" | "No" | undefined {
  if (r.transferWorkflow?.trim().toUpperCase() === "DRS") return "No";
  return isOutgoing(r) && r.type?.trim().toLowerCase() === "full" ? "Yes" : undefined;
}
function followUpDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type PatchResult = { ok: true; record: TrackerRecord } | { ok: false; status: number; body: Record<string, unknown> };

/** The tracker's applyAcatPatch on one record: validated fields, coupled defaults, field-level history. Changes
 *  `record` in place. `assets`/`newAssets` only when the recon save sends them. */
async function applyPatch(
  record: TrackerRecord,
  body: Record<string, unknown>,
  performedBy: string,
  options: { assets?: unknown; newAssets?: unknown } = {},
): Promise<PatchResult> {
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, body: { error: zodMessage(parsed.error) } };
  const data = parsed.data;
  const identityChanged = (["clientName", "apexAccountId", "acatTransferId"] as const)
    .some((f) => data[f] !== undefined && data[f] !== record[f]);
  if (identityChanged && data.expectedIdentityVersion !== undefined && data.expectedIdentityVersion !== record.identityVersion) {
    return { ok: false, status: 409, body: { error: "This record changed. Reload it before editing its identity.", code: "IDENTITY_CONFLICT" } };
  }
  if (record.cedarRidgeUserIds.length) {
    if (data.clientName !== undefined && data.clientName !== record.clientName) {
      return { ok: false, status: 400, body: { error: "Use Change client to update a linked client's saved name", code: "IDENTITY_RELINK_REQUIRED" } };
    }
    if (identityChanged && data.expectedIdentityVersion === undefined) {
      return { ok: false, status: 409, body: { error: "Reload this record before editing its identity", code: "IDENTITY_CONFLICT" } };
    }
  } else if (data.apexAccountId !== undefined && !data.apexAccountId.trim()) {
    return { ok: false, status: 400, body: { error: "Apex account number is required for an unlinked record", code: "INVALID_REQUEST" } };
  }
  if (data.apexAccountId !== undefined) data.apexAccountId = data.apexAccountId.trim();
  if (data.transferWorkflow === "RESIDUAL") data.type = "Residual Credit";

  const updates = z.array(assetUpdateSchema).max(500).safeParse(Array.isArray(options.assets) ? options.assets : []);
  if (!updates.success) return { ok: false, status: 400, body: { error: zodMessage(updates.error) } };
  const additions = z.array(assetCreateSchema).max(500).safeParse(Array.isArray(options.newAssets) ? options.newAssets : []);
  if (!additions.success) return { ok: false, status: 400, body: { error: zodMessage(additions.error) } };
  if (updates.data.some((u) => !record.assets.some((a) => a.id === u.id))) {
    return { ok: false, status: 400, body: { error: "Asset does not belong to this record" } };
  }

  const before = { ...record };
  const changed = new Set<string>();
  for (const field of UPDATE_FIELDS) {
    let value = data[field] as unknown;
    if (value === undefined) continue;
    if (field === "crmDealId" && value === null) value = "";
    if (field === "statementAmount" && typeof value === "number") {
      value = isOutgoing({ direction: data.direction !== undefined ? data.direction : record.direction }) ? -Math.abs(value) : value;
    }
    const old = (record as unknown as Record<string, unknown>)[field];
    if (String(old ?? "") !== String(value ?? "")) {
      (record as unknown as Record<string, unknown>)[field] = value;
      changed.add(field);
      addHistory(record, "update", field, old, value, performedBy);
    }
  }
  if (record.mappingAccountId && ["statementAccountNumber", "clientName", "accountType"].some((f) => changed.has(f))) {
    addHistory(record, "update", "mappingAccountId", record.mappingAccountId, null, performedBy);
    record.mappingAccountId = null;
    record.mappingAccountSummary = null;
  }
  const shapeChanged = data.direction !== undefined || data.type !== undefined;
  const drs = record.transferWorkflow?.toUpperCase() === "DRS";
  const feeDefault = defaultFeeCharged(record);
  if ((drs ? !record.feeAmount?.trim() : shapeChanged) && feeDefault !== undefined && data.feeCharged === undefined && !before.feeCharged?.trim()) {
    addHistory(record, "update", "feeCharged", before.feeCharged, feeDefault, performedBy);
    record.feeCharged = feeDefault;
  }
  if (shapeChanged && isOutgoing(record) && !isResidual(record)) {
    if (data.residualMonitoringRequired === undefined && !before.residualMonitoringRequired) {
      addHistory(record, "update", "residualMonitoringRequired", "false", "true", performedBy);
      record.residualMonitoringRequired = true;
    }
    if (data.residualFollowUpDate === undefined && !before.residualFollowUpDate?.trim()) {
      record.residualFollowUpDate = followUpDate();
      addHistory(record, "update", "residualFollowUpDate", before.residualFollowUpDate, record.residualFollowUpDate, performedBy);
    }
  }
  if (data.direction?.trim().toLowerCase() === "out" && data.statementAmount === undefined
    && typeof before.statementAmount === "number" && before.statementAmount > 0) {
    record.statementAmount = -Math.abs(before.statementAmount);
    addHistory(record, "update", "statementAmount", before.statementAmount, record.statementAmount, performedBy);
  }
  if (data.transferringContra !== undefined) {
    const custodian = await custodianForContra(data.transferringContra);
    record.custodianId = custodian?.id ?? null;
    record.custodianName = custodian?.name ?? "";
    record.custodianAvgProcessingDays = custodian?.avgProcessingDays ?? null;
  }
  for (const update of updates.data) {
    const asset = record.assets.find((a) => a.id === update.id)!;
    for (const key of ["actualQty", "mapStatus", "issue", "notes"] as const) {
      if (update[key] === undefined || update[key] === asset[key]) continue;
      addHistory(record, "update", `asset:${asset.symbol}:${key}`, asset[key], update[key], performedBy);
      (asset as unknown as Record<string, unknown>)[key] = update[key];
    }
  }
  for (const created of additions.data) {
    record.assets.push({
      id: `asset-${randomUUID()}`, symbol: created.symbol, description: created.description, cusip: created.cusip ?? null,
      expectedQty: created.expectedQty, actualQty: created.actualQty, mapStatus: created.mapStatus, issue: created.issue ?? null,
      notes: created.notes ?? null, amount: created.amount ?? null, assetClass: created.assetClass ?? null,
    });
    addHistory(record, "create", `asset:${created.symbol}`, null, created.mapStatus, performedBy);
  }
  if (identityChanged) record.identityVersion += 1;
  // The tracker stamps recon complete once both sources are in and 90% or more of the positions match.
  if (!record.reconCompletedAt && hasApexUpload(record) && ["GCP Project API", "Mock / Local Fixture"].includes(record.mappingSource)) {
    const c = assetCounts(record);
    const denominator = c.matched + c.mismatch + c.pending;
    if (denominator > 0 && c.matched / denominator >= 0.9) {
      record.reconCompletedAt = now();
      addHistory(record, "update", "reconCompletedAt", null, record.reconCompletedAt, performedBy);
    }
  }
  record.lastUpdated = now();
  return { ok: true, record };
}

/** Runs `change` on a copy of the live record and saves the copy when the change succeeds. The change may read
 *  other records (custodians, the directory), so it runs first; the locked save then refuses with 409 if the
 *  record moved on in the meantime. */
async function withRecord(id: string, change: (record: TrackerRecord) => Promise<StandInReply>): Promise<StandInReply> {
  const current = await liveRecord(id);
  if (!current) return notFound();
  const working = structuredClone(current);
  const reply = await change(working);
  if (reply.status >= 300) return reply;
  // The transfer-form steps (tracker-forms.ts) add their own history entries.
  trimHistory(working);
  const saved = await changeRecord<TrackerRecord>("tracker", "acat", id,
    (doc) => (!doc.deletedAt && doc.lastUpdated === current.lastUpdated ? working : null));
  if (!saved || saved !== working && JSON.stringify(saved) !== JSON.stringify(working)) {
    return { status: 409, json: { error: "This record changed. Reload it and try again.", code: "STALE" } };
  }
  return reply;
}

// --- reads ---

async function listAcats({ url }: StandInCall): Promise<StandInReply> {
  const book = url.searchParams.get("book");
  const removed = url.searchParams.get("removed");
  if (book === "full") {
    if (removed !== null && removed !== "only") return bad("invalid_removed");
    return ok({ acats: await bookRows({ removed: removed === "only", ops: false }) });
  }
  return ok({ acats: inFlightRecords(await allRecords()).map((r) => listProjection(r)) });
}

async function bookRows(options: { removed: boolean; ops: boolean }) {
  const records = await allRecords();
  const rows = options.removed
    ? records.filter((r) => r.deletedAt).sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!) || b.createdAt.localeCompare(a.createdAt))
    : sortByActivity(records.filter((r) => !r.deletedAt));
  return rows.map((r) => bookProjection(r, { ops: options.ops }));
}

async function opsBook({ url }: StandInCall): Promise<StandInReply> {
  const removed = url.searchParams.get("removed");
  if (removed !== null && removed !== "only") return bad("invalid_removed");
  return ok({ acats: await bookRows({ removed: removed === "only", ops: true }) });
}

async function opsList(): Promise<StandInReply> {
  return ok({ acats: inFlightRecords(await allRecords()).map((r) => listProjection(r, { ops: true })) });
}

async function byTransferId({ params }: StandInCall): Promise<StandInReply> {
  const id = params.acatTransferId?.trim();
  if (!id) return notFound();
  const match = (await liveRecords()).filter((r) => r.acatTransferId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return match ? ok(plainDetail(match)) : notFound();
}

/** The detail as the tracker's create and by-transfer reads return it: no drawer options (DTCC masked, no version). */
function plainDetail(record: TrackerRecord) {
  const { identityVersion: _version, ...rest } = detailProjection(record);
  return { ...rest, dtccNumber: maskIdentifier(record.dtccNumber) };
}

async function byRecord({ params }: StandInCall): Promise<StandInReply> {
  const record = await liveRecord(params.id);
  return record ? ok(detailProjection(record)) : notFound();
}

async function opsRecord({ params }: StandInCall): Promise<StandInReply> {
  const record = await liveRecord(params.id);
  return record ? ok(detailProjection(record, { ops: true })) : notFound();
}

async function history({ params }: StandInCall): Promise<StandInReply> {
  const record = await liveRecord(params.id);
  if (!record) return notFound();
  return ok([...record.history].filter((e) => e.action !== "read").sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 100));
}

// --- record writes ---

const FORBIDDEN_ON_PATCH = ["assets", "newAssets", "reconCompletedAt", "apexSource", "feeApexTicket", "feeCreditRequestId"];

async function patchRecord(call: StandInCall): Promise<StandInReply> {
  const body = (call.body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || Array.isArray(body)) return bad("Send the changes as a JSON object");
  if (FORBIDDEN_ON_PATCH.some((k) => k in body)) return bad("Field is not accepted on this path");
  if (typeof body.status === "string" && RECON_DERIVED_STATUSES.has(body.status)) return bad("Status is not a lifecycle status");
  return withRecord(call.params.id, async (record) => {
    const result = await applyPatch(record, body, actorOf(call));
    return result.ok ? ok(detailProjection(result.record)) : { status: result.status, json: result.body };
  });
}

const createSchema = z.object({
  cedarRidgeUserIds: userIdsSchema,
  clientName: shortStr.default(""),
  apexAccountId: shortStr.default(""),
  acatTransferId: shortStr.optional(), accountType: shortStr.optional(), additionalResources: longStr.optional(),
  apexCompletionDate: dateStr.optional(), apexTicket: shortStr.optional(), associatedControlNumber: shortStr.optional(),
  controlNumber: shortStr.optional(), dtccNumber: dtccStr.optional(), direction: shortStr.optional(), crwEe: shortStr.optional(),
  feeAmount: moneyStr.optional(), feeCharged: shortStr.optional(), feeMemo: longStr.optional(),
  feeRequestCompleted: dateStr.optional(), feeRequestSubmitted: dateStr.optional(), feeApexTicket: shortStr.optional(),
  feeCreditRequestId: shortStr.optional(), methodRequested: shortStr.optional(), transferWorkflow: workflowEnum.optional(),
  notes: longStr.optional(), opsSubmissionDateToApex: dateStr.optional(), originalClientRequestDate: dateStr.optional(),
  residualMonitoringRequired: z.boolean().optional(), residualFollowUpDate: dateStr.optional(), crmTicket: midStr.optional(),
  rejectionReason: longStr.optional(), statementAccountNumber: shortStr.optional(), statementAmount: z.number().int().optional(),
  status: z.enum(LIFECYCLE_STATUSES).optional(), transferringContra: shortStr.optional(), tradeRequestId: shortStr.optional(),
  tradeRequestUrl: httpUrl.optional(), tradeInstructions: longStr.optional(), type: shortStr.optional(),
  wealthAdvisor: shortStr.optional(), crmDealId: shortStr.optional(), acatDate: dateStr.optional(),
}).strict();

const PENDING_ACCOUNT_STATUSES = new Set(["PendingAccountOpening", "WaitingForApex", "WaitingOnClient", "WaitingForStatement", "ToCome"]);

async function createRecord(call: StandInCall): Promise<StandInReply> {
  const parsed = createSchema.safeParse(call.body ?? {});
  if (!parsed.success) {
    const missing = parsed.error.issues.some((i) => i.path[0] === "cedarRidgeUserIds");
    return missing ? bad("Search for and select a Cedar Ridge client", { code: "IDENTITY_REQUIRED" }) : bad(zodMessage(parsed.error));
  }
  const d = parsed.data;
  const ids = [...d.cedarRidgeUserIds].sort();
  const people = await directory();
  const selected = ids.map((id) => people.find((p) => p.cedarRidgeUserId === id));
  if (selected.some((p) => !p || p.eligibility === "INACTIVE")) {
    return bad("Select an active Cedar Ridge client from the directory", { code: "IDENTITY_NOT_FOUND" });
  }
  const status = d.status ?? "AcatReceived";
  if (!d.apexAccountId.trim() && !PENDING_ACCOUNT_STATUSES.has(status) && ids.length > 1) {
    return bad("Apex account ID is required", { code: "INVALID_REQUEST" });
  }
  if (d.transferWorkflow === "RESIDUAL") d.type = "Residual Credit";
  const transferWorkflow = d.type === "Residual Credit" ? "RESIDUAL" : d.transferWorkflow || "UNCLASSIFIED";
  const monitor = isOutgoing(d) && !isResidual(d);
  const custodian = await custodianForContra(d.transferringContra);
  const performedBy = actorOf(call);
  const record = newTrackerRecord({
    id: `acat-${randomUUID()}`,
    clientName: selected.map((p) => p!.displayName).join(" & "),
    acatDate: d.acatDate || d.originalClientRequestDate || now().slice(0, 10),
    cedarRidgeUserIds: ids,
    apexAccountId: d.apexAccountId.trim(),
    acatTransferId: d.acatTransferId || null, accountType: d.accountType || null, additionalResources: d.additionalResources || null,
    apexCompletionDate: d.apexCompletionDate || null, apexTicket: d.apexTicket || null, associatedControlNumber: d.associatedControlNumber ?? null,
    controlNumber: d.controlNumber || null, dtccNumber: d.dtccNumber || null, direction: d.direction || null, crwEe: d.crwEe || null,
    feeAmount: d.feeAmount || null, feeCharged: d.feeCharged?.trim() || defaultFeeCharged({ ...d, transferWorkflow }) || null,
    feeMemo: d.feeMemo || null, feeRequestCompleted: d.feeRequestCompleted || null, feeRequestSubmitted: d.feeRequestSubmitted || null,
    feeApexTicket: d.feeApexTicket || null, feeCreditRequestId: d.feeCreditRequestId || null, methodRequested: d.methodRequested || null,
    transferWorkflow, notes: d.notes || null, opsSubmissionDateToApex: d.opsSubmissionDateToApex || null,
    originalClientRequestDate: d.originalClientRequestDate || null,
    residualMonitoringRequired: d.residualMonitoringRequired ?? monitor,
    residualFollowUpDate: d.residualFollowUpDate || (monitor ? followUpDate() : null),
    crmTicket: d.crmTicket || null, rejectionReason: d.rejectionReason || null, statementAccountNumber: d.statementAccountNumber || null,
    statementAmount: d.statementAmount == null ? null : isOutgoing(d) ? -Math.abs(d.statementAmount) : d.statementAmount,
    status, transferringContra: d.transferringContra || null, tradeRequestId: d.tradeRequestId || null,
    tradeRequestUrl: d.tradeRequestUrl || null, tradeInstructions: d.tradeInstructions || null, type: d.type || null,
    wealthAdvisor: d.wealthAdvisor || null, crmDealId: d.crmDealId || d.crmTicket || "",
    custodianId: custodian?.id ?? null, custodianName: custodian?.name ?? "", custodianAvgProcessingDays: custodian?.avgProcessingDays ?? null,
  });
  addHistory(record, "identity-create", "cedarRidgeUserIds", null, JSON.stringify(ids), performedBy);
  addHistory(record, "create", null, null, null, performedBy);
  if ((await saveRecord("tracker", "acat", record.id, record)) === "full") {
    return { status: 422, json: { error: "The demo can't hold more transfer records until tonight's reset.", code: "DEMO_LIMIT" } };
  }
  return ok(plainDetail(record), 201);
}

async function restoreRecord({ params }: StandInCall): Promise<StandInReply> {
  const stored = await readRecord<TrackerRecord>("tracker", "acat", params.id);
  if (!stored) return { status: 404, json: { error: "ACAT record not found" } };
  if (!stored.doc.deletedAt) return { status: 409, json: { error: "ACAT record is not deleted" } };
  await changeRecord<TrackerRecord>("tracker", "acat", params.id, (doc) => {
    addHistory(doc, "restore", "deletedAt", doc.deletedAt, null, DEFAULT_ACTOR);
    return { ...doc, deletedAt: null, lastUpdated: now() };
  });
  return ok({ success: true });
}

// --- drawer ---

const DRAWER_FIELDS = [
  "associatedControlNumber", "acatTransferId", "transferWorkflow", "direction", "type", "accountType", "methodRequested",
  "wealthAdvisor", "crwEe", "apexAccountId", "statementAccountNumber", "transferringContra", "dtccNumber", "statementAmount",
  "originalClientRequestDate", "opsSubmissionDateToApex", "apexCompletionDate", "residualMonitoringRequired",
  "residualFollowUpDate", "crmTicket", "crmDealId", "apexTicket", "additionalResources", "tradeRequestId", "tradeRequestUrl",
  "rejectionReason",
] as const;

const drawerSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("change"), field: z.enum(DRAWER_FIELDS), value: z.unknown(), expectedIdentityVersion: versionSchema.optional() }).strict(),
  z.object({ action: z.literal("complete"), apexCompletionDate: z.string(), controlNumber: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("reject"), reason: z.string() }).strict(),
  z.object({ action: z.literal("replaceClient"), relink: z.object({
    cedarRidgeUserIds: userIdsSchema, expectedIdentityVersion: versionSchema, reason: z.string().trim().min(1).max(2000),
    apexAccountId: shortStr.transform((v) => v.trim()).optional(), replaceDisplayName: z.boolean().default(false),
    acknowledgeMappingInvalidation: z.boolean().default(false),
  }).strict() }).strict(),
]);

const blank = (v: unknown) => v == null || (typeof v === "string" && !v.trim());

async function drawerChange(call: StandInCall): Promise<StandInReply> {
  const parsed = drawerSchema.safeParse(call.body);
  const refuse = async (status: number, error: string, code?: string): Promise<StandInReply> => {
    const current = await liveRecord(call.params.id);
    return current ? { status, json: { error, ...(code ? { code } : {}), transfer: detailProjection(current) } } : notFound();
  };
  if (!parsed.success) return refuse(400, zodMessage(parsed.error));
  const request = parsed.data;
  const performedBy = actorOf(call);
  let patch: Record<string, unknown>;
  if (request.action === "change") {
    if (blank(request.value)) return refuse(400, `${request.field} cannot be blank`);
    const check = updateSchema.shape[request.field].safeParse(request.value);
    if (!check.success) return refuse(400, zodMessage(check.error));
    patch = { [request.field]: typeof request.value === "string" ? request.value.trim() : request.value,
      ...(request.expectedIdentityVersion !== undefined ? { expectedIdentityVersion: request.expectedIdentityVersion } : {}) };
  } else if (request.action === "complete") {
    if (blank(request.apexCompletionDate)) return refuse(400, "Apex Completion Date is required to complete a transfer");
    if (!normalizeDateToIso(request.apexCompletionDate)) return refuse(400, "apexCompletionDate: Use a valid date");
    patch = { status: "Completed", apexCompletionDate: request.apexCompletionDate.trim() };
    if (request.controlNumber !== undefined) patch.controlNumber = request.controlNumber?.trim() || null;
  } else if (request.action === "reject") {
    const reason = request.reason.trim();
    if (!reason) return refuse(400, "A rejection reason is required");
    patch = { status: "Rejected", rejectionReason: reason };
  } else {
    return replaceClient(call, request.relink, performedBy, refuse);
  }
  const reply = await withRecord(call.params.id, async (record) => {
    const result = await applyPatch(record, patch, performedBy);
    return result.ok ? ok({ transfer: detailProjection(result.record) }) : { status: result.status, json: result.body };
  });
  if (reply.status >= 400 && reply.status !== 404) {
    const body = reply.json as { error?: string; code?: string };
    return refuse(reply.status, body.error ?? "Could not save", body.code);
  }
  return reply;
}

async function replaceClient(
  call: StandInCall,
  relink: { cedarRidgeUserIds: string[]; expectedIdentityVersion: number; reason: string; apexAccountId?: string; replaceDisplayName: boolean },
  performedBy: string,
  refuse: (status: number, error: string, code?: string) => Promise<StandInReply>,
): Promise<StandInReply> {
  const ids = [...relink.cedarRidgeUserIds].sort();
  const people = await directory();
  const selected = ids.map((id) => people.find((p) => p.cedarRidgeUserId === id));
  if (selected.some((p) => !p || p.eligibility === "INACTIVE")) return refuse(400, "Select an active Cedar Ridge client from the directory", "IDENTITY_NOT_FOUND");
  const reply = await withRecord(call.params.id, async (record) => {
    if (record.identityVersion !== relink.expectedIdentityVersion) {
      return { status: 409, json: { error: "This record changed. Reload it before editing its identity.", code: "IDENTITY_CONFLICT" } };
    }
    addHistory(record, "identity-relink", "cedarRidgeUserIds", JSON.stringify(record.cedarRidgeUserIds), JSON.stringify(ids), performedBy);
    record.cedarRidgeUserIds = ids;
    if (relink.replaceDisplayName) {
      const name = selected.map((p) => p!.displayName).join(" & ");
      if (name !== record.clientName) addHistory(record, "update", "clientName", record.clientName, name, performedBy);
      record.clientName = name;
    }
    if (relink.apexAccountId !== undefined && relink.apexAccountId !== record.apexAccountId) {
      addHistory(record, "update", "apexAccountId", record.apexAccountId, relink.apexAccountId, performedBy);
      record.apexAccountId = relink.apexAccountId;
    }
    record.identityVersion += 1;
    record.lastUpdated = now();
    return ok({ transfer: detailProjection(record) });
  });
  if (reply.status >= 400 && reply.status !== 404) {
    const body = reply.json as { error?: string; code?: string };
    return refuse(reply.status, body.error ?? "Could not save", body.code);
  }
  return reply;
}

async function drawerDelete(call: StandInCall): Promise<StandInReply> {
  const reason = z.object({ reason: z.string().trim().min(3, "Reason must be at least 3 characters").max(500, "Reason must be 500 characters or fewer") })
    .safeParse(call.body ?? {});
  if (!reason.success) return bad(zodMessage(reason.error));
  return withRecord(call.params.id, async (record) => {
    record.deletedAt = now();
    record.lastUpdated = record.deletedAt;
    addHistory(record, "delete", "deletedAt", null, record.deletedAt, actorOf(call));
    addHistory(record, "delete-reason", "reason", null, reason.data.reason, actorOf(call));
    return ok({ transfer: detailProjection(record), removed: true });
  });
}

// --- fees ---

const FEE_KEYS = ["feeCharged", "feeAmount", "feeMemo", "feeRequestSubmitted", "feeRequestCompleted", "feeApexTicket", "feeCreditRequestId"] as const;
const feeValue = z.union([z.string(), z.null()]);
const feeActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), fields: z.object(Object.fromEntries(FEE_KEYS.map((k) => [k, feeValue.optional()]))).strict()
    .refine((f) => Object.keys(f).length > 0) }).strict(),
  z.object({ action: z.literal("apply"), feeRuleIds: z.array(z.string().min(1).max(64)).min(1).max(50) }).strict(),
  z.object({ action: z.literal("log") }).strict(),
]);

const feeSnapshot = (record: TrackerRecord) => ({ fee: feeFields(record), log: record.feeLog ?? null });

async function readFees({ params }: StandInCall): Promise<StandInReply> {
  const record = await liveRecord(params.id);
  return record ? ok(feeSnapshot(record)) : notFound();
}

async function writeFees(call: StandInCall): Promise<StandInReply> {
  const current = await liveRecord(call.params.id);
  if (!current) return notFound();
  const refused = (error: string, record = current) => ({ status: 400, json: { error, ...feeSnapshot(record) } });
  const parsed = feeActionSchema.safeParse(call.body);
  if (!parsed.success || parsed.data.action === "log") return refused("refused");
  let fields: Record<string, unknown>;
  if (parsed.data.action === "save") {
    fields = parsed.data.fields;
  } else {
    const custodian = current.custodianId ? (await custodians()).find((c) => c.id === current.custodianId) : null;
    const rules = custodian?.fees ?? [];
    if (!custodian || !rules.length) return refused("no_rules");
    const wanted = parsed.data.feeRuleIds;
    const kept = rules.filter((rule) => wanted.includes(rule.id));
    if (kept.length !== new Set(wanted).size) return refused("refused");
    const total = kept.reduce((sum, rule) => sum + (rule.amount ?? 0), 0);
    fields = {
      feeAmount: `$${total.toFixed(2)}`,
      feeMemo: kept.map((rule) => `${rule.feeType}: ${rule.amount != null ? `$${rule.amount.toFixed(2)}` : (rule.amountText ?? "?")}`).join(" + "),
      feeCharged: total > 0 || kept.some((rule) => rule.amount == null) ? "Yes" : "No",
    };
  }
  return withRecord(call.params.id, async (record) => {
    const result = await applyPatch(record, fields, actorOf(call));
    return result.ok ? ok(feeSnapshot(result.record)) : refused("refused");
  });
}

// --- security reconciliation ---

const reconRowSchema = z.object({
  id: z.string().min(1).max(100), symbol: z.string().max(100), description: z.string().max(500), cusip: z.string().max(20).nullish(),
  actualQty: z.number().finite(), amount: z.number().finite().nullish(), assetClass: z.string().max(100).nullish(),
  status: z.enum(["Matched", "Mismatch", "Missing", "Unexpected", "Pending", "Expected", "Info"]),
  issue: z.string().max(2000).nullish(), notes: z.string().max(5000).nullish(),
});
const reconBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh"), sourceAccountId: z.string().uuid().optional() }),
  z.object({ action: z.literal("upload"), kind: z.enum(["apex", "mapping"]), filename: z.string().min(1).max(255), text: z.string().max(5_000_000) }),
  z.object({ action: z.literal("save"), rows: z.array(reconRowSchema).max(500), apexUploaded: z.boolean(), overriddenIds: z.array(z.string().max(100)).max(500) }),
]);

const reconRefusal = (record: TrackerRecord, status: number, message: string): StandInReply => ({
  status, json: reconSnapshot(record), headers: { "x-recon-refusal": message.replace(/[^\x20-\x7e]/g, "?").slice(0, 500) },
});

const toMapStatus = (status: string): MapStatus =>
  status === "Matched" || status === "Mismatch" || status === "Info" ? "Mapped" : status === "Pending" ? "Pending" : status === "Expected" ? "Expected" : "Unmapped";

async function readRecon({ params }: StandInCall): Promise<StandInReply> {
  const record = await liveRecord(params.id);
  return record ? ok(reconSnapshot(record)) : notFound();
}

/** The statement pipeline's current runs (the demo's pipeline stand-in records), newest first. */
async function pipelineAccounts(): Promise<Array<{ household: PipelineHousehold; account: PipelineAccount }>> {
  const runs = (await listRecords<PipelineHousehold>("pipeline", "household")).map((r) => r.doc)
    .sort((a, b) => b.processed_at.localeCompare(a.processed_at));
  return runs.flatMap((household) => household.accounts.filter((a) => !a.deleted_at).map((account) => ({ household, account })));
}

function accountSummary(household: PipelineHousehold, account: PipelineAccount): TrackerMappingAccount {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    id: account.id, clientName: household.client_name, holder: text(account.account_holder), custodian: text(account.custodian),
    registration: text(account.account_registration) || text(account.account_type_raw) || text(account.account_type),
    accountNumberLast4: text(account.account_number).slice(-4) || null, investorNumberLast4: text(account.investor_number).slice(-4) || null,
    statementDate: text(account.statement_date) || null, processedAt: household.processed_at || null,
    isHistorical: Boolean(household.superseded_by), positionCount: account.assets.filter((p) => !p.deleted_at).length,
  };
}

const compactNumber = (v: string | null | undefined) => (v ?? "").replace(/[\s-]/g, "").toUpperCase();

async function writeRecon(call: StandInCall): Promise<StandInReply> {
  const current = await liveRecord(call.params.id);
  if (!current) return notFound();
  const parsed = reconBodySchema.safeParse(call.body);
  if (!parsed.success) return reconRefusal(current, 400, "Invalid security reconciliation request");
  const body = parsed.data;
  if (body.action === "upload") {
    if (!body.filename.toLowerCase().endsWith(".csv")) return reconRefusal(current, 400, "Please upload a .csv file.");
    return reconRefusal(current, 422, "Uploading a file isn't part of the demo.");
  }
  if (body.action === "refresh") {
    const accountId = body.sourceAccountId ?? current.mappingAccountId;
    if (!accountId && !current.statementAccountNumber?.trim()) {
      return reconRefusal(current, 422, "Add the statement account number or choose a mapping account to sync.");
    }
    const source = (await pipelineAccounts()).find(({ account }) => (accountId
      ? account.id === accountId
      : compactNumber(account.account_number) === compactNumber(current.statementAccountNumber)));
    if (!source) {
      return reconRefusal(current, 404, "This account is not available in asset mapping. Choose a mapping account, verify the statement number, or upload the mapping CSV.");
    }
    const syncedAt = now();
    const reply = await withRecord(current.id, async (record) => {
      const previous = new Map(record.assets.map((a) => [a.symbol.toUpperCase(), a]));
      record.assets = source.account.assets.filter((p) => !p.deleted_at).map((p): TrackerAsset => {
        const kept = previous.get((p.symbol ?? "").toUpperCase());
        const statementAge = typeof source.account.statement_age_days === "number" ? source.account.statement_age_days : null;
        return {
          id: kept?.id ?? `asset-${randomUUID()}`, symbol: p.symbol ?? "", description: p.description ?? "",
          cusip: typeof p.cusip === "string" ? p.cusip : kept?.cusip ?? null,
          expectedQty: Number(p.quantity) || 0, actualQty: kept?.actualQty ?? 0, mapStatus: kept?.mapStatus ?? "Pending",
          issue: kept?.issue ?? null, notes: kept?.notes ?? null, amount: p.market_value == null ? null : Number(p.market_value),
          assetClass: p.asset_type ?? null, includeInTransfer: kept?.includeInTransfer ?? null,
          mappingTransferStatus: p.override_status || p.transfer_eligible, mappingTransferNotes: p.override_status ? p.override_notes ?? null : p.transfer_notes,
          mappingTransferring: p.transferring === "YES" ? true : p.transferring === "NO" ? false : null,
          mappingStatementDate: typeof source.account.statement_date === "string" ? source.account.statement_date : null,
          mappingStatementAgeDays: statementAge, mappingStatementIsStale: source.account.is_stale === true, mappingSyncedAt: syncedAt,
        };
      });
      record.mappingSource = "GCP Project API";
      record.mappingSyncedAt = syncedAt;
      record.mappingAccountId = source.account.id;
      record.mappingAccountSummary = accountSummary(source.household, source.account);
      addHistory(record, "asset-mapping-sync", "mappingAccountId", current.mappingAccountId, source.account.id, actorOf(call));
      record.lastUpdated = syncedAt;
      return ok(reconSnapshot(record));
    });
    return reply.status === 409 ? reconRefusal(current, 409, "This record changed. Reload it and try again.") : reply;
  }
  const overridden = new Set(body.overriddenIds);
  const assets = body.rows.filter((r) => r.id && !r.id.startsWith("apex-extra-"))
    .map((r) => ({ id: r.id, actualQty: r.actualQty, mapStatus: toMapStatus(r.status), issue: r.issue ?? null, notes: r.notes ?? null }));
  const newAssets = body.rows.filter((r) => r.id.startsWith("apex-extra-") && overridden.has(r.id)).map((r) => ({
    symbol: r.symbol, description: r.description, cusip: r.cusip ?? null, expectedQty: 0, actualQty: r.actualQty,
    mapStatus: toMapStatus(r.status), issue: r.issue ?? null, notes: r.notes ?? null, amount: r.amount ?? null, assetClass: r.assetClass ?? null,
  }));
  const reply = await withRecord(current.id, async (record) => {
    const result = await applyPatch(record, body.apexUploaded ? { apexSource: "Uploaded" } : {}, actorOf(call), { assets, newAssets });
    return result.ok ? ok(reconSnapshot(result.record)) : { status: result.status, json: result.body };
  });
  if (reply.status >= 400 && reply.status !== 404) {
    const message = (reply.json as { error?: string })?.error ?? "Failed to save";
    return reconRefusal(current, [400, 409, 422].includes(reply.status) ? reply.status : 409, message);
  }
  return reply;
}

async function reconAccounts({ params, url }: StandInCall): Promise<StandInReply> {
  if (!(await liveRecord(params.id))) return notFound();
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > 100) return bad("Enter 2 to 100 characters to search.");
  const needle = q.toLowerCase();
  const matches = (await pipelineAccounts()).filter(({ household, account }) =>
    [household.client_name, account.account_holder, account.custodian, account.account_type]
      .some((v) => typeof v === "string" && v.toLowerCase().includes(needle)));
  return ok({ accounts: matches.slice(0, 25).map(({ household, account }) => accountSummary(household, account)), truncated: matches.length > 25 });
}

// --- directory, DTC, custodians ---

const normalizeName = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();

async function clientSearch({ url }: StandInCall): Promise<StandInReply> {
  const query = (url.searchParams.get("query") ?? "").trim();
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit ? Number(rawLimit) : 20;
  if (query.length < 2 || query.length > 120 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    return bad("Enter a valid client search.", { code: "INVALID_REQUEST" });
  }
  const needle = normalizeName(query);
  const people = (await directory())
    .filter((p) => p.eligibility !== "INACTIVE" && normalizeName(p.displayName).includes(needle))
    .sort((a, b) => normalizeName(a.displayName).localeCompare(normalizeName(b.displayName)) || a.cedarRidgeUserId.localeCompare(b.cedarRidgeUserId));
  const at = now();
  return ok({
    items: people.slice(0, limit).map((p) => ({
      cedarRidgeUserId: p.cedarRidgeUserId, displayName: p.displayName,
      accountHints: p.accounts.filter((a) => a.isCurrent).sort((a, b) => a.investmentAccountId.localeCompare(b.investmentAccountId)).slice(0, 5)
        .map((a) => ({
          maskedAccountNumber: a.accountNumber ? (a.accountNumber.length > 4 ? `••••${a.accountNumber.slice(-4)}` : "••••") : null,
          custodian: a.custodian, relationshipType: a.relationshipType,
        })),
    })),
    hasMore: people.length > limit,
    directory: { enabled: true, health: "FRESH", writeEligible: true, pendingAccountPolicy: "PENDING_ACCOUNT_OPENING_ONLY",
      freshnessBasis: "FETCH_SUCCESS", lastSuccessAt: at, sourceAsOf: at },
  });
}

async function dtccSuggestion({ url }: StandInCall): Promise<StandInReply> {
  const contra = url.searchParams.get("contra") ?? "";
  if (!contra.trim()) return ok({ status: "none", dtccNumber: null, source: null, historicalSampleSize: 0 });
  if (contra.length > 120) return bad("contra is too long");
  const library = (await custodians()).map((c) => ({ name: c.name, dtcNumber: c.dtcNumber }));
  return ok(suggestDtccNumber(await allRecords(), library, contra));
}

async function custodianTimings(): Promise<StandInReply> {
  const totals = new Map<string, { days: number; count: number }>();
  for (const r of await liveRecords()) {
    if (!r.custodianId || r.type === "Residual Credit" || r.direction?.toLowerCase() !== "in" || !r.apexCompletionDate) continue;
    const start = r.originalClientRequestDate ?? r.acatDate;
    if (!start || new Date(r.apexCompletionDate).getTime() < new Date(start).getTime()) continue;
    const days = businessDaysBetween(start, r.apexCompletionDate);
    if (days == null) continue;
    const t = totals.get(r.custodianId) ?? { days: 0, count: 0 };
    totals.set(r.custodianId, { days: t.days + days, count: t.count + 1 });
  }
  const library = await custodians();
  const ids = [...new Set([...library.map((c) => c.id), ...totals.keys()])];
  const names = new Map(library.map((c) => [c.id, c.name]));
  return ok({
    schemaVersion: 1, retrievedAt: now(),
    custodians: ids.map((id) => {
      const t = totals.get(id);
      return { id, name: names.get(id) ?? null, observedAvgProcessingBusinessDays: t ? Math.round(t.days / t.count) : null, observedCompletedTransfers: t?.count ?? 0 };
    }).sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")) || a.id.localeCompare(b.id)),
  });
}

// --- dashboard and advisor list ---

async function dashboard(): Promise<StandInReply> {
  return ok(composeDashboard((await liveRecords()).slice(0, 5000)));
}

const reviewSchema = z.object({
  acatRecordId: z.string().min(1).max(120), ruleKey: z.string().min(1).max(120), fingerprint: z.string().min(1).max(500),
  status: z.enum(["OPEN", "IN_REVIEW", "CLOSED"]),
  resolution: z.enum(["CORRECTED", "RESOLVED_MANUALLY", "FALSE_POSITIVE", "NOT_APPLICABLE", "ACKNOWLEDGED_UNRESOLVED", "DUPLICATE"]).optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
}).strict().superRefine((v, ctx) => {
  if (v.status === "CLOSED" && !v.resolution) ctx.addIssue({ code: "custom", path: ["resolution"], message: "Resolution is required when closing an exception" });
  if (["FALSE_POSITIVE", "ACKNOWLEDGED_UNRESOLVED"].includes(v.resolution ?? "") && !v.note?.trim()) {
    ctx.addIssue({ code: "custom", path: ["note"], message: "A note is required for this resolution" });
  }
});

async function dashboardReview(call: StandInCall): Promise<StandInReply> {
  const parsed = reviewSchema.safeParse(call.body);
  if (!parsed.success) return bad(zodMessage(parsed.error));
  const v = parsed.data;
  if (!(await liveRecord(v.acatRecordId))) return { status: 404, json: { error: "transfer_not_found" } };
  const review = { ruleKey: v.ruleKey, fingerprint: v.fingerprint, status: v.status, resolution: v.resolution ?? null,
    note: v.note ?? null, reviewedBy: actorOf(call), reviewedAt: now() };
  await changeRecord<TrackerRecord>("tracker", "acat", v.acatRecordId, (doc) => ({
    ...doc, reviews: [...doc.reviews.filter((r) => !(r.ruleKey === v.ruleKey && r.fingerprint === v.fingerprint)), review],
  }));
  return ok({ id: `${v.acatRecordId}:${v.ruleKey}`, acatRecordId: v.acatRecordId, ...review });
}

async function appUserRole(email: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { email }, select: { role: true } });
  return user?.role ?? null;
}

async function advisorList(call: StandInCall): Promise<StandInReply> {
  const email = call.headers.get("x-aoa-actor-email")?.trim().toLowerCase();
  if (!email) return bad("invalid_request");
  const role = await appUserRole(email);
  if (role !== "ADVISOR" && role !== "ADMIN") return { status: 403, json: { error: "not_allowed" } };
  const rows = (await liveRecords()).sort((a, b) => b.acatDate.localeCompare(a.acatDate) || b.id.localeCompare(a.id)).slice(0, 5000);
  return ok({ acats: rows.map(advisorProjection) });
}

// --- transfer linkage ---

async function transferLinkage({ url }: StandInCall): Promise<StandInReply> {
  if (url.search) return bad("invalid_request");
  const snapshot = linkageSnapshot(await allRecords(), await directory());
  return snapshot ? ok(snapshot) : { status: 503, json: { error: "source_unavailable", code: "NOT_CONFIGURED" } };
}

// --- transfer forms ---

const FORM_STATUS: Record<string, number> = { invalid: 400, not_found: 404, stale: 409, review_required: 409, forbidden: 403 };
const formFailure = (reason: string): StandInReply => ({ status: FORM_STATUS[reason] ?? 503, json: { error: reason } });
const FORM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const REGISTRATION = z.enum(["Individual", "Joint tenants with rights of survivorship", "Joint tenants in common", "Community Property",
  "Traditional IRA", "Roth IRA", "Inherited Traditional IRA", "Inherited Roth IRA", "SEP IRA", "SIMPLE IRA", "Trust"]);
const confirmSchema = z.object({ expectedRevision: revision, operationId: z.string().uuid(), title: z.string().trim().min(1).max(200),
  registration: REGISTRATION, confirmed: z.literal(true) }).strict();
const scopeSchema = z.object({ expectedRevision: revision, operationId: z.string().uuid(), scope: z.enum(["FULL", "PARTIAL"]), confirmed: z.literal(true) }).strict();
const generateSchema = z.object({
  expectedRevision: revision, confirmationId: z.string().regex(FORM_ID), operationId: z.string().uuid(), workflowId: z.string().regex(FORM_ID),
  assetInstruction: z.enum(["IN_KIND", "LIQUIDATE", "MIXED"]),
  positionInstructions: z.array(z.object({ positionId: z.string().regex(FORM_ID), assetInstruction: z.enum(["IN_KIND", "LIQUIDATE"]) }).strict()).min(2).max(5000).optional(),
  deliveringTitle: z.string().trim().min(1).max(200), deliveringTitleConfirmed: z.literal(true),
  receivingAccountNumber: z.string().trim().min(1).max(100).optional(), receivingAccountNumberVerified: z.literal(true).optional(),
  accountsReviewed: z.literal(true), instructionsReviewed: z.literal(true), letterOfAuthorizationRequired: z.boolean(),
}).strict();

/** Every transfer-form call needs an AoA operations or admin user as the acting person. */
async function formActor(call: StandInCall): Promise<string | null> {
  const email = call.headers.get("x-aoa-actor-email")?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  const role = await appUserRole(email);
  return role === "ADMIN" || role === "OPERATIONS" ? email : null;
}

async function playbookFor(record: TrackerRecord): Promise<CustodianPlaybook | null> {
  if (!record.custodianId) return null;
  const c = (await custodians()).find((x) => x.id === record.custodianId);
  return c ? { id: c.id, name: c.name, signature: c.signature, letterOfAcceptance: c.letterOfAcceptance, medallionRequired: c.medallionRequired,
    liquidationMethod: c.liquidationMethod, returnMethod: c.returnMethod, watchouts: c.watchouts } : null;
}

function preparationRoute(kind: "read" | "confirm" | "scope" | "generate") {
  return async (call: StandInCall): Promise<StandInReply> => {
    const actor = await formActor(call);
    if (!actor) return formFailure("forbidden");
    if (!FORM_ID.test(call.params.id)) return formFailure("invalid");
    const current = await liveRecord(call.params.id);
    if (!current) return formFailure("not_found");
    try {
      if (kind === "read") return ok(buildPreparation(current, await playbookFor(current)));
      const schema = kind === "confirm" ? confirmSchema : kind === "scope" ? scopeSchema : generateSchema;
      const body = schema.safeParse(call.body);
      if (!body.success) return formFailure("invalid");
      let documentId: string | null = null;
      const reply = await withRecord(current.id, async (record) => {
        if (kind === "confirm") confirmTitle(record, body.data as z.infer<typeof confirmSchema>, actor);
        else if (kind === "scope") changeScope(record, body.data as z.infer<typeof scopeSchema>, actor);
        else documentId = await generateForm(record, body.data as z.infer<typeof generateSchema>, actor);
        return ok(null);
      });
      if (reply.status === 409) return formFailure("stale");
      if (reply.status !== 200) return reply;
      if (documentId) return ok({ documentId });
      const updated = await liveRecord(current.id);
      return updated ? ok(buildPreparation(updated, await playbookFor(updated))) : formFailure("not_found");
    } catch (error) {
      if (error instanceof PreparationError) return formFailure(error.reason);
      throw error;
    }
  };
}

async function preparationDocument(call: StandInCall): Promise<StandInReply> {
  if (!(await formActor(call))) return formFailure("forbidden");
  if (!FORM_ID.test(call.params.id) || !FORM_ID.test(call.params.documentId)) return formFailure("invalid");
  const record = await liveRecord(call.params.id);
  const document = record?.documents.find((d) => d.id === call.params.documentId);
  if (!document) return formFailure("not_found");
  const bytes = new Uint8Array(Buffer.from(document.content, "base64"));
  return {
    status: 200, bytes, headers: {
      "content-type": "application/pdf", "content-disposition": `attachment; filename="${document.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "cache-control": "no-store", "x-content-type-options": "nosniff",
      "x-transfer-document-sha256": document.sha256, "x-transfer-document-id": document.id,
    },
  };
}

const dark = async (): Promise<StandInReply> => notFound();

export const TRACKER_ROUTES: readonly StandInRoute[] = [
  ["GET", "/api/machine/acats", listAcats],
  ["POST", "/api/machine/acats", createRecord],
  ["GET", "/api/machine/acats/ops-book", opsBook],
  ["GET", "/api/machine/acats/ops-list", opsList],
  ["GET", "/api/machine/acats/ops-record/:id", opsRecord],
  ["GET", "/api/machine/acats/ops-drawer/:id", opsRecord],
  ["GET", "/api/machine/acats/by-record/:id", byRecord],
  ["PATCH", "/api/machine/acats/by-record/:id", patchRecord],
  ["PATCH", "/api/machine/acats/by-record/:id/drawer", drawerChange],
  ["DELETE", "/api/machine/acats/by-record/:id/drawer", drawerDelete],
  ["POST", "/api/machine/acats/by-record/:id/restore", restoreRecord],
  ["GET", "/api/machine/acats/by-record/:id/history", history],
  ["GET", "/api/machine/acats/by-record/:id/fees", readFees],
  ["POST", "/api/machine/acats/by-record/:id/fees", writeFees],
  ["GET", "/api/machine/acats/by-record/:id/security-recon", readRecon],
  ["POST", "/api/machine/acats/by-record/:id/security-recon", writeRecon],
  ["GET", "/api/machine/acats/by-record/:id/security-recon/accounts", reconAccounts],
  ["GET", "/api/machine/acats/by-record/:id/preparation", preparationRoute("read")],
  ["PUT", "/api/machine/acats/by-record/:id/preparation", preparationRoute("confirm")],
  ["PATCH", "/api/machine/acats/by-record/:id/preparation", preparationRoute("scope")],
  ["POST", "/api/machine/acats/by-record/:id/preparation", preparationRoute("generate")],
  ["GET", "/api/machine/acats/by-record/:id/preparation/documents/:documentId", preparationDocument],
  ["GET", "/api/machine/acats/:acatTransferId", byTransferId],
  ["GET", "/api/machine/clients/search", clientSearch],
  ["GET", "/api/machine/dtcc-suggestion", dtccSuggestion],
  ["GET", "/api/machine/custodians", custodianTimings],
  ["POST", "/api/machine/custodians/projection", dark],
  ["GET", "/api/machine/dashboard", dashboard],
  ["POST", "/api/machine/dashboard/reviews", dashboardReview],
  ["GET", "/api/machine/advisor/acats", advisorList],
  ["GET", "/api/machine/transfer-linkage", transferLinkage],
];
