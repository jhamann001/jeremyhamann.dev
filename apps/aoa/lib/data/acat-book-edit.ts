import { mapAcatBookRow, resolveAcatBookStatus, type AcatBookRow } from "./acat-book";

export const ACAT_LIFECYCLE_STATUSES = [
  "WaitingForApex", "PendingAccountOpening", "WaitingOnClient", "WaitingForStatement",
  "AcatReceived", "ToCome", "Submitted", "PendingReview", "PendingContraResponse",
  "Accepted", "PendingSettlement", "PendingBookkeeping", "Completed", "Rejected",
  "Purged", "Canceled", "Deferred",
] as const;

const LIFECYCLE: ReadonlySet<string> = new Set(ACAT_LIFECYCLE_STATUSES);

export function isLifecycleStatus(value: string | null | undefined): boolean {
  return LIFECYCLE.has((value ?? "").trim());
}

export function lifecycleStatusOptions(): { value: string; label: string }[] {
  return ACAT_LIFECYCLE_STATUSES.map((value) => ({ value, label: resolveAcatBookStatus(value).label }));
}

export const ACAT_EDITABLE_FIELDS = [
  "status", "controlNumber", "direction", "type", "transferringContra",
  "wealthAdvisor", "feeCharged", "feeRequestCompleted",
] as const;
export type AcatEditableField = (typeof ACAT_EDITABLE_FIELDS)[number];
export type AcatEditDraft = Record<AcatEditableField, string>;

export const ACAT_CREATE_FIELDS = [
  "clientName", "apexAccountId", "status", "direction", "type",
  "transferringContra", "wealthAdvisor", "controlNumber",
] as const;
export type AcatCreateField = (typeof ACAT_CREATE_FIELDS)[number];

export const ACAT_CLIENT_REQUIRED = "Search for and select a Cedar Ridge client";
export const ACAT_DAY_TO_DAY_OFF = "Day-to-day book actions are turned off.";
export const ACAT_EDITS_OFF = "Editing transfers is turned off.";
export const ACAT_EDIT_FORBIDDEN = "You don't have permission to change transfers.";
export const ACAT_EDIT_NOT_LIFECYCLE = "Status is not a lifecycle status";
export const ACAT_EDIT_NO_CHANGES = "Nothing to save.";
export const ACAT_WRITE_UNAVAILABLE = "The tracker did not save this change — try again.";

export type AcatBookWriteResult = { ok: true; row: AcatBookRow } | { ok: false; reason: string };

export function draftFromRow(row: AcatBookRow): AcatEditDraft {
  return Object.fromEntries(ACAT_EDITABLE_FIELDS.map((field) => [field, row[field] ?? ""])) as AcatEditDraft;
}

export function buildAcatPatch(
  row: AcatBookRow,
  draft: Partial<Record<string, string>>,
): { patch: Partial<Record<AcatEditableField, string | null>>; changed: number } {
  const patch: Partial<Record<AcatEditableField, string | null>> = {};
  for (const field of ACAT_EDITABLE_FIELDS) {
    const next = (draft[field] ?? "").trim();
    if (next === (row[field] ?? "").trim()) continue;
    if (next === "") {
      if (field !== "status") patch[field] = null;
      continue;
    }
    patch[field] = next;
  }
  return { patch, changed: Object.keys(patch).length };
}

export function validateCreateDraft(
  draft: Partial<Record<string, string>>,
): { ok: true; body: Partial<Record<AcatCreateField, string>> } | { ok: false; reason: string } {
  const body: Partial<Record<AcatCreateField, string>> = {};
  for (const field of ACAT_CREATE_FIELDS) {
    const value = (draft[field] ?? "").trim();
    if (value !== "") body[field] = value;
  }
  if (!body.clientName) return { ok: false, reason: "Client name is required" };
  if (!body.apexAccountId) return { ok: false, reason: "Apex account number is required" };
  if (body.status && !isLifecycleStatus(body.status)) return { ok: false, reason: "Choose a lifecycle status" };
  return { ok: true, body: { ...body, status: body.status ?? "AcatReceived" } };
}

const SELECTED_CLIENT = /^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validateSelectedClientCreate(
  draft: Partial<Record<string, string>>,
): { ok: true; body: { cedarRidgeUserId: string; apexAccountId: string; status: string } } | { ok: false; reason: string } {
  const cedarRidgeUserId = (draft.cedarRidgeUserId ?? "").trim();
  const apexAccountId = (draft.apexAccountId ?? "").trim();
  if (!SELECTED_CLIENT.test(cedarRidgeUserId)) return { ok: false, reason: ACAT_CLIENT_REQUIRED };
  if (apexAccountId === "") return { ok: false, reason: "Apex account number is required" };
  const status = (draft.status ?? "").trim();
  if (status !== "" && !isLifecycleStatus(status)) return { ok: false, reason: "Choose a lifecycle status" };
  return { ok: true, body: { cedarRidgeUserId, apexAccountId, status: status || "AcatReceived" } };
}

export function buildDayToDayPatch(
  row: AcatBookRow,
  draft: Partial<Record<string, string>>,
): { patch: { notes?: string | null; tradeInstructions?: string | null }; changed: number } {
  if (row.textLoadError) return { patch: {}, changed: 0 };
  const patch: { notes?: string | null; tradeInstructions?: string | null } = {};
  for (const field of ["notes", "tradeInstructions"] as const) {
    if (draft[field] === undefined) continue;
    const next = draft[field].trim();
    if (next === (row[field] ?? "").trim()) continue;
    patch[field] = next === "" ? null : next;
  }
  return { patch, changed: Object.keys(patch).length };
}

export function keepUnsentText(stored: string, buffer: string, ok: boolean): string {
  return ok ? stored : buffer;
}

export function writeRejectionReason(status: number | null, body: unknown): string {
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  if ((status === 400 || status === 409 || status === 422) && typeof error === "string" && error.trim() !== "") {
    return error.trim().slice(0, 300);
  }
  if (status === 401 || status === 403) return "AoA is not allowed to change transfers in the tracker.";
  if (status === 404) return "This transfer no longer exists in the tracker.";
  if (status === 429) return "Too many changes at once — wait a minute and try again.";
  return ACAT_WRITE_UNAVAILABLE;
}

export function bookRowFromSaved(
  raw: unknown,
  previous: AcatBookRow | null,
  now: string,
  sent?: { notes?: string; tradeInstructions?: string },
): AcatBookRow | null {
  const mapped = mapAcatBookRow(raw);
  if (!mapped) return null;
  const record = (raw ?? {}) as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(record, key);
  const instructions = record.tradeInstructions;
  const notes = sent?.notes !== undefined
    ? (sent.notes.trim() || null)
    : (has("notes") ? mapped.notes : (previous?.notes ?? null));
  const tradeInstructions = sent?.tradeInstructions !== undefined
    ? (sent.tradeInstructions.trim() || null)
    : (has("tradeInstructions") ? mapped.tradeInstructions : (previous?.tradeInstructions ?? null));
  return {
    ...mapped,
    notes,
    tradeInstructions,
    custodianName: has("custodianName") ? mapped.custodianName : (previous?.custodianName ?? ""),
    textLoadError: has("notes") && has("tradeInstructions")
      ? null
      : (previous?.textLoadError ?? mapped.textLoadError),
    tradeInstructionsBlank: sent?.tradeInstructions !== undefined
      ? sent.tradeInstructions.trim() === ""
      : (typeof instructions !== "string" || instructions.trim() === ""),
    hasIssue: previous?.hasIssue ?? false,
    assetMap: previous?.assetMap ?? mapped.assetMap,
    lastActivityAt: now,
  };
}

export type AcatEditorState = { draft: AcatEditDraft; error: string | null };

export function editorAfterResult(state: AcatEditorState, result: AcatBookWriteResult): AcatEditorState {
  return result.ok
    ? { draft: draftFromRow(result.row), error: null }
    : { draft: state.draft, error: result.reason };
}
