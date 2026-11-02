import type { z } from "zod";
import type { DriftOverrideReason } from "@/lib/trade-requests/shared-types";
import type { DriftHistoryDays } from "./model";
import {
  accountDriftHistoryResponseSchema,
  accountDriftRunResponseSchema,
  driftAllowListResponseSchema,
  exclusionOverlapReportSchema,
  setDriftOverrideResponseSchema,
} from "./schemas";

// Browser side of the Drift screens. The routes (ticket) answer 404 unless Trade Requests are
// AOA-served, 401/403 when the AOA session or role is gone, and the standalone error bodies otherwise.

export const DRIFT_API = {
  history: "/api/trade-requests/drift/history",
  run: (runDateLocal: string) => `/api/trade-requests/drift/runs/${encodeURIComponent(runDateLocal)}`,
  allowList: "/api/trade-requests/drift/allow-list",
  exclusionOverlap: "/api/trade-requests/drift/exclusion-overlap",
  override: (accountId: string) => `/api/trade-requests/drift/overrides/${encodeURIComponent(accountId)}`,
} as const;

export const DRIFT_COPY = {
  title: "Account drift",
  unavailable: "Drift results are not available right now.",
  writesPaused: "Changes are paused right now. Try again later.",
  historyFailed: "Unable to load drift history. Please try again.",
  detailFailed: "Unable to load run detail.",
  overlapFailed: "Unable to load exclusion overlap diagnostic.",
  exportExclusionsFailed: "Unable to export exclusions.",
  saveFailed: "Unable to save the override.",
  clearFailed: "Unable to clear the override.",
  acceptFailed: "Unable to accept the suggestion.",
  allowListTitle: "Allow list",
  allowListEmpty: "No households are on the drift allow list.",
} as const;

export type AccountDriftHistoryResponse = z.infer<typeof accountDriftHistoryResponseSchema>;
export type AccountDriftRunResponse = z.infer<typeof accountDriftRunResponseSchema>;
export type DriftAllowListResponse = z.infer<typeof driftAllowListResponseSchema>;
export type ExclusionOverlapResponse = z.infer<typeof exclusionOverlapReportSchema>;

/** A failed Drift call. `signedOut` when the AOA session or role is gone (401, 403 or a redirect). */
export class DriftRequestError extends Error {
  constructor(message: string, readonly status: number | null, readonly signedOut: boolean) {
    super(message);
  }
}

type ApiErrorDetail = { path?: unknown; message?: unknown };

// trade-request client/src/api/client.ts:80-93
function formatValidationDetails(details: ApiErrorDetail[]): string[] {
  return details
    .map((d) => {
      const path = Array.isArray(d?.path) ? d.path.filter((p) => p !== "" && p != null).map(String).join(".") : "";
      const msg = typeof d?.message === "string" ? d.message : "";
      if (path && msg) return `${path}: ${msg}`;
      return msg || path;
    })
    .filter(Boolean);
}

/** The standalone extractApiError (client.ts:96-108) for a JSON error body; the route gate's codes get AOA copy. */
export function driftErrorMessage(body: unknown, fallback: string): string {
  const data = body as { error?: unknown; details?: unknown } | null;
  const serverMessage = typeof data?.error === "string" ? data.error : "";
  if (serverMessage === "not_found") return DRIFT_COPY.unavailable;
  if (serverMessage === "writes_paused") return DRIFT_COPY.writesPaused;
  if (!serverMessage || serverMessage === "unavailable") return fallback;
  const details = Array.isArray(data?.details) ? (data.details as ApiErrorDetail[]) : [];
  const fieldErrors = formatValidationDetails(details).slice(0, 3);
  return fieldErrors.length > 0 ? `${serverMessage}: ${fieldErrors.join("; ")}` : serverMessage;
}

async function send(url: string, init: RequestInit, fallback: string): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    });
  } catch {
    throw new DriftRequestError(fallback, null, false);
  }
  if (response.redirected || response.status === 401 || response.status === 403) {
    throw new DriftRequestError(fallback, response.status, true);
  }
  const body: unknown = init.method === "HEAD" || response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new DriftRequestError(driftErrorMessage(body, fallback), response.status, false);
  return { status: response.status, body };
}

async function getParsed<T>(url: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, fallback: string): Promise<T> {
  const { status, body } = await send(url, { method: "GET" }, fallback);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new DriftRequestError(fallback, status, false);
  return parsed.data;
}

export function fetchAccountDriftHistory(days: DriftHistoryDays): Promise<AccountDriftHistoryResponse> {
  return getParsed(`${DRIFT_API.history}?days=${days}`, accountDriftHistoryResponseSchema, DRIFT_COPY.historyFailed);
}

export function fetchAccountDriftRun(runDateLocal: string): Promise<AccountDriftRunResponse> {
  return getParsed(DRIFT_API.run(runDateLocal), accountDriftRunResponseSchema, DRIFT_COPY.detailFailed);
}

export function fetchAccountDriftAllowList(): Promise<DriftAllowListResponse> {
  return getParsed(DRIFT_API.allowList, driftAllowListResponseSchema, DRIFT_COPY.historyFailed);
}

/** HEAD 204 → the diagnostic is on; 404 → off (standalone client.ts:691-701). */
export async function fetchAccountDriftExclusionOverlapAvailability(): Promise<boolean> {
  try {
    await send(DRIFT_API.exclusionOverlap, { method: "HEAD" }, DRIFT_COPY.overlapFailed);
    return true;
  } catch (err) {
    if (err instanceof DriftRequestError && err.status === 404) return false;
    throw err;
  }
}

export function fetchAccountDriftExclusionOverlap(runDateLocal?: string): Promise<ExclusionOverlapResponse> {
  const query = runDateLocal ? `?runDateLocal=${encodeURIComponent(runDateLocal)}` : "";
  return getParsed(`${DRIFT_API.exclusionOverlap}${query}`, exclusionOverlapReportSchema, DRIFT_COPY.overlapFailed);
}

export type SetDriftOverrideInput = { reason: DriftOverrideReason; note?: string; expiresOn?: string | null };

export async function setDriftOverride(accountId: string, input: SetDriftOverrideInput, fallback: string = DRIFT_COPY.saveFailed) {
  const { status, body } = await send(DRIFT_API.override(accountId), { method: "PUT", body: JSON.stringify(input) }, fallback);
  const parsed = setDriftOverrideResponseSchema.safeParse(body);
  if (!parsed.success) throw new DriftRequestError(fallback, status, false);
  return parsed.data;
}

export async function clearDriftOverride(accountId: string): Promise<void> {
  await send(DRIFT_API.override(accountId), { method: "DELETE" }, DRIFT_COPY.clearFailed);
}
