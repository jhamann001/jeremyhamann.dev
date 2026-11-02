import "server-only";
import { callTradeRequestService, type TradeRequestResult } from "./client";
import {
  EXCLUSIONS_COPY,
  type ExclusionBatch,
  type ExclusionBatchSaved,
  type ExclusionsByEntity,
  type ExclusionsResult,
  type StandingExclusion,
} from "./new-request-exclusions";

const record = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

function exclusion(value: unknown): StandingExclusion | null {
  if (!record(value)) return null;
  const { id, ticker, kind, reason, noBuy, noSell, createdByName, createdAt } = value;
  if (typeof id !== "string" || typeof ticker !== "string" || (kind !== "advisor" && kind !== "client")) return null;
  if (typeof noBuy !== "boolean" || typeof noSell !== "boolean") return null;
  return {
    id, ticker, kind, noBuy, noSell,
    reason: typeof reason === "string" ? reason : "",
    createdByName: typeof createdByName === "string" ? createdByName : "",
    createdAt: typeof createdAt === "string" ? createdAt : "",
  };
}

function exclusionList(value: unknown): StandingExclusion[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.map(exclusion);
  return rows.every((row): row is StandingExclusion => row !== null) ? rows : null;
}

function byEntity(value: unknown): ExclusionsByEntity | null {
  if (!record(value)) return null;
  const out: ExclusionsByEntity = {};
  for (const [id, list] of Object.entries(value)) {
    const rows = exclusionList(list);
    if (!rows) return null;
    out[id] = rows;
  }
  return out;
}

function outcome<T>(result: TradeRequestResult<{ data?: unknown }>, parse: (data: unknown) => T | null, fallback: string): ExclusionsResult<T> {
  if (!result.ok) return { ok: false, message: result.message };
  const parsed = parse(result.data?.data);
  return parsed === null ? { ok: false, message: fallback } : { ok: true, data: parsed };
}

/** Standing lists of the given clients: one client is read alone (retried), several in one lookup (not retried). */
export async function readClientExclusions(clientIds: string[]): Promise<ExclusionsResult<ExclusionsByEntity>> {
  const unique = [...new Set(clientIds)];
  if (unique.length === 0) return { ok: true, data: {} };
  if (unique.length === 1) {
    const [clientId] = unique;
    const result = await callTradeRequestService<{ data?: unknown }>({
      operation: "clientExclusions", method: "GET", path: `/clients/${encodeURIComponent(clientId)}/exclusions`,
      defaultMessage: EXCLUSIONS_COPY.loadFailed,
    });
    return outcome(result, (data) => {
      const rows = exclusionList(data);
      return rows ? { [clientId]: rows } : null;
    }, EXCLUSIONS_COPY.loadFailed);
  }
  const result = await callTradeRequestService<{ data?: unknown }>({
    operation: "clientsExclusionsLookup", method: "POST", path: "/clients/exclusions/bulk",
    body: { clientIds: unique }, defaultMessage: EXCLUSIONS_COPY.loadFailed,
  });
  return outcome(result, byEntity, EXCLUSIONS_COPY.loadFailed);
}

/** Standing account-level lists of the given account ids (one lookup, not retried). */
export async function readAccountExclusions(accountIds: string[]): Promise<ExclusionsResult<ExclusionsByEntity>> {
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) return { ok: true, data: {} };
  const result = await callTradeRequestService<{ data?: unknown }>({
    operation: "accountExclusionsLookup", method: "POST", path: "/clients/account-exclusions/bulk",
    body: { accountIds: unique }, defaultMessage: EXCLUSIONS_COPY.accountLoadFailedDialog,
  });
  return outcome(result, byEntity, EXCLUSIONS_COPY.accountLoadFailedDialog);
}

function saved(value: unknown): ExclusionBatchSaved | null {
  if (!record(value)) return null;
  const exclusions = exclusionList(value.exclusions);
  const count = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null);
  const added = count(value.added);
  const removed = count(value.removed);
  const edited = count(value.edited);
  if (!exclusions || added === null || removed === null || edited === null) return null;
  return { exclusions, added, removed, edited };
}

/** One Apply in the Manage dialog: the whole batch commits or none of it does (not retried). */
export async function saveExclusionBatch(
  scope: "client" | "account", entityId: string, batch: ExclusionBatch,
): Promise<ExclusionsResult<ExclusionBatchSaved>> {
  const id = encodeURIComponent(entityId);
  const result = await callTradeRequestService<{ data?: unknown }>({
    operation: "exclusionSave", method: "POST",
    path: scope === "client" ? `/clients/${id}/exclusions/batch` : `/clients/account-exclusions/${id}/batch`,
    body: batch, defaultMessage: EXCLUSIONS_COPY.applyFailed,
  });
  return outcome(result, saved, EXCLUSIONS_COPY.applyFailed);
}
