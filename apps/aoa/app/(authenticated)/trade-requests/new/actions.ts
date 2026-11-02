"use server";

import { auth } from "@/auth";
import { tradeRequestsWorkspaceEnabled } from "@/lib/flags";
import { canUseTradeRequestsWorkspace } from "@/lib/trade-requests/access";
import { readPriorAllocation } from "@/lib/trade-requests/allocation";
import { readAccountExclusions, readClientExclusions, saveExclusionBatch } from "@/lib/trade-requests/exclusions";
import { NEW_REQUEST_COPY } from "@/lib/trade-requests/new-request";
import type { PriorAllocation } from "@/lib/trade-requests/new-request-allocation";
import {
  EXCLUSIONS_COPY,
  MAX_BATCH_ITEMS,
  MAX_REASON_LENGTH,
  MAX_TICKER_LENGTH,
  type ExclusionBatch,
  type ExclusionBatchSaved,
  type ExclusionsByEntity,
  type ExclusionsResult,
} from "@/lib/trade-requests/new-request-exclusions";
import {
  readNewRequestClients,
  resolveNewRequestHouseholds,
  type NewRequestClientsLoad,
  type NewRequestHouseholdsLoad,
} from "@/lib/trade-requests/new-request-data";

async function workspaceAllowed(): Promise<boolean> {
  if (!tradeRequestsWorkspaceEnabled()) return false;
  const session = await auth();
  return !!session?.user && canUseTradeRequestsWorkspace((session.user as { role?: string }).role);
}

// The households route refuses more than 50 entries per list; the selection
// caps already keep Submit disabled beyond that, so the form is left unchanged.
const MAX_IDS = 50;
function idList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_IDS) return null;
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 100 && !id.includes(","));
  return ids.length === value.length ? ids : null;
}

export async function loadNewRequestClients(): Promise<NewRequestClientsLoad> {
  if (!(await workspaceAllowed())) return { ok: false, outcome: "not_allowed", message: NEW_REQUEST_COPY.loadFailedDefault };
  return readNewRequestClients();
}

export async function loadPriorAllocation(clientId: unknown): Promise<PriorAllocation | null> {
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 50) return null;
  if (!(await workspaceAllowed())) return null;
  return readPriorAllocation(clientId);
}

export async function lookupNewRequestHouseholds(clientIds: unknown, accountIds: unknown): Promise<NewRequestHouseholdsLoad> {
  const clients = idList(clientIds);
  const accounts = idList(accountIds);
  if (!clients || !accounts || !(await workspaceAllowed())) return null;
  return resolveNewRequestHouseholds(clients, accounts);
}

// The service's bulk exclusion routes accept up to 1,000 ids.
const MAX_EXCLUSION_IDS = 1_000;
const entityId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 100;
function exclusionIds(value: unknown): string[] | null {
  return Array.isArray(value) && value.length <= MAX_EXCLUSION_IDS && value.every(entityId) ? value : null;
}

const flag = (value: unknown): value is boolean => typeof value === "boolean";
const item = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);

function exclusionBatch(value: unknown): ExclusionBatch | null {
  if (!item(value) || !Array.isArray(value.add) || !Array.isArray(value.remove) || !Array.isArray(value.edit)) return null;
  const { add, remove, edit } = value;
  if ([add, remove, edit].some((list) => list.length > MAX_BATCH_ITEMS) || add.length + remove.length + edit.length === 0) return null;
  const adds = add.every((entry) => item(entry)
    && typeof entry.ticker === "string" && entry.ticker.trim().length > 0 && entry.ticker.length <= MAX_TICKER_LENGTH
    && (entry.kind === "advisor" || entry.kind === "client")
    && typeof entry.reason === "string" && entry.reason.length <= MAX_REASON_LENGTH
    && flag(entry.noBuy) && flag(entry.noSell) && (entry.noBuy || entry.noSell));
  const edits = edit.every((entry) => item(entry) && entityId(entry.id) && flag(entry.noBuy) && flag(entry.noSell) && (entry.noBuy || entry.noSell));
  if (!adds || !remove.every(entityId) || !edits) return null;
  return {
    add: add.map((entry) => ({ ticker: entry.ticker, kind: entry.kind, reason: entry.reason, noBuy: entry.noBuy, noSell: entry.noSell })),
    remove: [...remove],
    edit: edit.map((entry) => ({ id: entry.id, noBuy: entry.noBuy, noSell: entry.noSell })),
  } as ExclusionBatch;
}

export async function loadClientExclusions(clientIds: unknown): Promise<ExclusionsResult<ExclusionsByEntity>> {
  const ids = exclusionIds(clientIds);
  if (!ids || !(await workspaceAllowed())) return { ok: false, message: EXCLUSIONS_COPY.loadFailed };
  return readClientExclusions(ids);
}

export async function loadAccountExclusions(accountIds: unknown): Promise<ExclusionsResult<ExclusionsByEntity>> {
  const ids = exclusionIds(accountIds);
  if (!ids || !(await workspaceAllowed())) return { ok: false, message: EXCLUSIONS_COPY.accountLoadFailedDialog };
  return readAccountExclusions(ids);
}

export async function applyExclusionBatch(scope: unknown, id: unknown, batch: unknown): Promise<ExclusionsResult<ExclusionBatchSaved>> {
  const parsed = exclusionBatch(batch);
  if ((scope !== "client" && scope !== "account") || !entityId(id) || !parsed || !(await workspaceAllowed())) {
    return { ok: false, message: EXCLUSIONS_COPY.applyFailed };
  }
  return saveExclusionBatch(scope, id, parsed);
}
