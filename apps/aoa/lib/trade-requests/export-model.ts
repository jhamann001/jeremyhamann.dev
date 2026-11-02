import { isTradeRequest, type PdfAccountExclusion } from "./detail-view";
import type { TradeRequest } from "./request-types";

// Standalone copy (trade-request client/src/components/TradingQueue.tsx
// ExportDropdown, client/src/App.tsx handleExport and its loaders), verbatim.
export const EXPORT_COPY = {
  button: "Export Compliance Log",
  preparing: "Preparing Export...",
  pdf: "PDF Report",
  pdfHint: "Formatted for compliance review",
  csv: "CSV Spreadsheet",
  csvHint: "For data analysis & archival",
  capped: "Export capped at 5,000 requests. The file may be incomplete — contact ops for a full report if needed.",
  standingUnavailable: (reason: string) => `Standing exclusions unavailable for export: ${reason}`,
  accountUnavailable: (reason: string) => `Account exclusions unavailable for export: ${reason}`,
  accountsPartial: (count: number) =>
    `Some exported accounts could not be resolved to current account IDs (${count}). Account-level exclusions may be partial.`,
  failed: (reason: string) => `Export failed: ${reason}`,
  /** The standalone extractApiError fallback, used when a failure carries no text. */
  defaultReason: "An unexpected error occurred",
} as const;

/** The service's bulk exclusion reads accept at most this many ids per call. */
export const EXPORT_LOOKUP_CHUNK = 1000;

export type ExportFormat = "csv" | "pdf";

export type TradeRequestClientExclusion = {
  id: string;
  clientId: string;
  ticker: string;
  kind: "advisor" | "client";
  reason: string;
  noBuy: boolean;
  noSell: boolean;
};

export type TradeRequestExport = {
  /** Every request in the firm, newest first, as the service ordered them. */
  requests: TradeRequest[];
  /** Current standing client-level exclusions by client id. */
  standingByClient: Record<string, TradeRequestClientExclusion[]>;
  /** Current standing account-level exclusions by request id. */
  accountExclusionsByRequestId: Record<string, PdfAccountExclusion[]>;
  /** Session messages raised while reading, in the order the standalone raises them. */
  messages: string[];
};

export type TradeRequestExportResult =
  | { ok: true; data: TradeRequestExport }
  | { ok: false; outcome: "not_set_up" | "failed"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

function isExclusion(value: unknown): value is Pick<TradeRequestClientExclusion, "kind" | "ticker" | "reason" | "noBuy" | "noSell"> {
  return isRecord(value) && (value.kind === "advisor" || value.kind === "client")
    && typeof value.ticker === "string" && typeof value.reason === "string"
    && typeof value.noBuy === "boolean" && typeof value.noSell === "boolean";
}

/** An id-keyed map with no prototype, so ids from the service are only ever plain keys. */
export function idMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** A `{ [id]: exclusion[] }` map as the bulk reads return it, or null if any entry is malformed. */
export function parseExclusionMap<T>(value: unknown): Record<string, T[]> | null {
  if (!isRecord(value)) return null;
  const map = idMap<T[]>();
  for (const [id, list] of Object.entries(value)) {
    if (!Array.isArray(list) || !list.every(isExclusion)) return null;
    map[id] = list as T[];
  }
  return map;
}

/** The export route's payload, re-checked in the browser before any file is built. */
export function parseTradeRequestExport(value: unknown): TradeRequestExport | null {
  if (!isRecord(value) || !Array.isArray(value.requests) || !value.requests.every(isTradeRequest)) return null;
  if (!Array.isArray(value.messages) || !value.messages.every((message) => typeof message === "string")) return null;
  const standingByClient = parseExclusionMap<TradeRequestClientExclusion>(value.standingByClient);
  const accountExclusionsByRequestId = parseExclusionMap<PdfAccountExclusion>(value.accountExclusionsByRequestId);
  if (!standingByClient || !accountExclusionsByRequestId) return null;
  return { requests: value.requests, standingByClient, accountExclusionsByRequestId, messages: value.messages };
}
