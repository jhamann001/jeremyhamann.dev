import "server-only";
import { ServiceAuth } from "@/lib/demo/service-auth";

export type HoldingsClassificationInput = {
  symbol: string | null;
  name: string | null;
  security_type: string | null;
};

// Read-only transferability labels for a holdings preview. Posts the
// symbol / name / security_type allowlist to the statement-pipeline classifier
// and never writes a household, asset map, or AUM row. A timeout, a non-200,
// or an unusable body becomes unknown for every row so the preview still renders.

export const HOLDINGS_TRANSFERABILITY_PATH = "/api/v1/holdings-transferability";
export const HOLDINGS_TRANSFERABILITY_TIMEOUT_MS = 5_000;

const LOG_TAG = "holdings-transferability";

export type TransferabilityLabel = "likely_transferable" | "likely_not" | "unknown";

export type TransferabilityAnnotation = {
  label: TransferabilityLabel;
  reason: string;
};

const LABELS = new Set<TransferabilityLabel>(["likely_transferable", "likely_not", "unknown"]);

const REASONS = new Set([
  "omni",
  "mutual_fund_non_omni",
  "mutual_fund_unlisted",
  "missing_symbol",
  "missing_security_type",
  "unrecognized_security_type",
  "rules_unavailable",
  "fixed_income",
  "apex_asset_unsupported",
  "standard_security",
  "cash",
  "needs_review",
]);

export function holdingsTransferabilityBaseUrl(): string | null {
  const raw = process.env.STATEMENT_PIPELINE_URL;
  if (!raw || raw.trim() === "") return null;
  return raw.replace(/\/+$/, "");
}

export function degradedTransferability(count: number): TransferabilityAnnotation[] {
  return Array.from({ length: count }, () => ({
    label: "unknown" as const,
    reason: "rules_unavailable",
  }));
}

export function annotationsFromClassifier(
  data: unknown,
  count: number,
): TransferabilityAnnotation[] {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return degradedTransferability(count);
  }
  const body = data as { rules_status?: unknown; rows?: unknown };
  if (body.rules_status !== "ok" || !Array.isArray(body.rows) || body.rows.length !== count) {
    return degradedTransferability(count);
  }
  return body.rows.map((raw) => parseAnnotation(raw));
}

function parseAnnotation(raw: unknown): TransferabilityAnnotation {
  if (raw == null || typeof raw !== "object") {
    return { label: "unknown", reason: "rules_unavailable" };
  }
  const label = (raw as { label?: unknown }).label;
  const reason = (raw as { reason?: unknown }).reason;
  if (typeof label !== "string" || !LABELS.has(label as TransferabilityLabel)) {
    return { label: "unknown", reason: "rules_unavailable" };
  }
  if (typeof reason !== "string" || !REASONS.has(reason)) {
    return { label: "unknown", reason: "rules_unavailable" };
  }
  return { label: label as TransferabilityLabel, reason };
}

export function classifierRequestBody(inputs: HoldingsClassificationInput[]): {
  rows: HoldingsClassificationInput[];
} {
  return {
    rows: inputs.map((row) => ({
      symbol: row.symbol,
      name: row.name,
      security_type: row.security_type,
    })),
  };
}

type ClassifierResponse = { status: number; data: unknown };

type ClassifierRequest = (
  url: string,
  body: { rows: HoldingsClassificationInput[] },
  timeoutMs: number,
) => Promise<ClassifierResponse>;

async function defaultRequest(
  url: string,
  body: { rows: HoldingsClassificationInput[] },
  timeoutMs: number,
): Promise<ClassifierResponse> {
  const base = holdingsTransferabilityBaseUrl();
  if (!base) throw new Error("missing pipeline url");
  const client = await new ServiceAuth().getIdTokenClient(base);
  const res = await client.request<unknown>({
    url,
    method: "POST",
    data: body,
    timeout: timeoutMs,
    validateStatus: () => true,
  });
  return { status: res.status, data: res.data };
}

export async function classifyHoldingsTransferability(
  inputs: HoldingsClassificationInput[],
  options: { request?: ClassifierRequest; timeoutMs?: number } = {},
): Promise<TransferabilityAnnotation[]> {
  const base = holdingsTransferabilityBaseUrl();
  if (!base) return degradedTransferability(inputs.length);
  const timeoutMs = options.timeoutMs ?? HOLDINGS_TRANSFERABILITY_TIMEOUT_MS;
  const request = options.request ?? defaultRequest;
  try {
    const res = await request(
      `${base}${HOLDINGS_TRANSFERABILITY_PATH}`,
      classifierRequestBody(inputs),
      timeoutMs,
    );
    if (res.status !== 200) {
      console.error(`[${LOG_TAG}] status=${res.status}`);
      return degradedTransferability(inputs.length);
    }
    return annotationsFromClassifier(res.data, inputs.length);
  } catch {
    console.error(`[${LOG_TAG}] transport_failed`);
    return degradedTransferability(inputs.length);
  }
}
