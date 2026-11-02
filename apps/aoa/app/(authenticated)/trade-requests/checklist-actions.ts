"use server";

import { tradeRequestsWorkspaceEnabled } from "@/lib/flags";
import { loadRequestChecklist, saveRequestChecklistItem, type ChecklistResult } from "@/lib/trade-requests/checklist";
import { CHECKLIST_VALUE_MAX, isChecklistKey } from "@/lib/trade-requests/checklist-view";

// The delegated client confirms the signed-in person and their workspace role
// on every call, and the service allows checklist writes to reviewers only.

const UNAVAILABLE: ChecklistResult = { ok: false, message: "Checklist unavailable." };

const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 100;

export async function readRequestChecklist(id: unknown): Promise<ChecklistResult> {
  if (!tradeRequestsWorkspaceEnabled() || !validId(id)) return UNAVAILABLE;
  return loadRequestChecklist(id);
}

export async function writeRequestChecklistItem(id: unknown, change: unknown): Promise<ChecklistResult> {
  if (!tradeRequestsWorkspaceEnabled() || !validId(id) || change == null || typeof change !== "object") return UNAVAILABLE;
  const { key, checked, value } = change as Record<string, unknown>;
  if (!isChecklistKey(key) || typeof checked !== "boolean" || typeof value !== "string" || value.length > CHECKLIST_VALUE_MAX) {
    return UNAVAILABLE;
  }
  return saveRequestChecklistItem(id, { key, checked, value });
}
