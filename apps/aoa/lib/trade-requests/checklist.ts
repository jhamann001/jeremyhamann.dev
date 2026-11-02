import "server-only";
import { callTradeRequestService } from "./client";
import { REQUEST_DETAIL_COPY, isLoadableRequestId } from "./detail-view";
import { sanitizeChecklist, type ChecklistChange, type ChecklistState } from "./checklist-view";

// The tab shows no message for either failure (AC-84, AC-85); the message is
// returned for callers and tests only.
export type ChecklistResult = { ok: true; checklist: ChecklistState } | { ok: false; message: string };

const SAVE_FAILED = "Failed to save the checklist.";

function readBody(data: { checklist?: unknown } | null | undefined): ChecklistState | null {
  const value = data?.checklist;
  return value != null && typeof value === "object" && !Array.isArray(value) ? sanitizeChecklist(value) : null;
}

export async function loadRequestChecklist(id: string): Promise<ChecklistResult> {
  if (!isLoadableRequestId(id)) return { ok: false, message: REQUEST_DETAIL_COPY.loadFailed };
  const result = await callTradeRequestService<{ checklist?: unknown }>({
    operation: "checklistRead", method: "GET", path: `/requests/${encodeURIComponent(id)}/checklist`,
    defaultMessage: REQUEST_DETAIL_COPY.loadFailed,
  });
  if (!result.ok) return { ok: false, message: result.message };
  const checklist = readBody(result.data);
  return checklist ? { ok: true, checklist } : { ok: false, message: REQUEST_DETAIL_COPY.loadFailed };
}

/** One item; the service stamps who and when, and refuses a decided request (409). */
export async function saveRequestChecklistItem(id: string, change: ChecklistChange): Promise<ChecklistResult> {
  if (!isLoadableRequestId(id)) return { ok: false, message: SAVE_FAILED };
  const result = await callTradeRequestService<{ checklist?: unknown }>({
    operation: "checklistSave", method: "PUT", path: `/requests/${encodeURIComponent(id)}/checklist`,
    body: { key: change.key, checked: change.checked, value: change.value }, defaultMessage: SAVE_FAILED,
  });
  if (!result.ok) return { ok: false, message: result.message };
  const checklist = readBody(result.data);
  return checklist ? { ok: true, checklist } : { ok: false, message: SAVE_FAILED };
}
