/**
 * Small, privacy-preserving structured log seams for Cloud Run.
 *
 * Cloud Logging recognizes single-line JSON written to stdout/stderr. These
 * records deliberately contain only bounded operational labels: no exception
 * messages/stacks, identities, request headers, source payloads, or run ids.
 * Terraform turns the stable `event` fields into development-only metrics.
 */

const SAFE_LABEL = /^[A-Za-z0-9_.:-]{1,80}$/;

export const INGEST_FRESHNESS_ENDPOINTS = [
  "accounts",
  "activity",
  "appointments",
  "clients",
  "crm-parents",
  "deals",
  "emails",
  "schwab-account-balances",
  "tasks",
  "zendesk-tickets",
] as const;

export type IngestFreshnessEndpoint = (typeof INGEST_FRESHNESS_ENDPOINTS)[number];

export type AuthFailureLogEntry = {
  severity: "ERROR";
  message: "Authentication operation failed";
  event: "auth.failure";
  component: "auth";
  error_type: string;
};

export type IngestSuccessLogEntry = {
  severity: "INFO";
  message: "Ingest completed";
  event: "ingest.success";
  component: "ingest";
  endpoint: IngestFreshnessEndpoint;
};

export type DirectoryTimingLogEntry = {
  severity: "INFO";
  message: "Directory query completed";
  event: "directory.query";
  component: "directory";
  directory: "households" | "households_preview" | "client_portrait";
  duration_ms: number;
  returned_rows: number;
};

export type DirectoryFailureLogEntry = {
  severity: "ERROR";
  message: "Directory query failed";
  event: "directory.failure";
  component: "directory";
  directory: DirectoryTimingLogEntry["directory"];
  duration_ms: number;
  category: "timeout" | "database" | "other";
};

export type DetailTimingLogEntry = {
  severity: "INFO";
  message: "Detail query completed";
  event: "detail.query";
  component: "detail";
  detail: "household" | "client_portrait";
  duration_ms: number;
};

function authErrorType(error: unknown): string {
  if (!error || typeof error !== "object") return "AuthError";

  const candidate =
    "type" in error && typeof error.type === "string"
      ? error.type
      : "name" in error && typeof error.name === "string"
        ? error.name
        : "AuthError";

  return SAFE_LABEL.test(candidate) ? candidate : "AuthError";
}

export function buildAuthFailureLogEntry(error: unknown): AuthFailureLogEntry {
  return {
    severity: "ERROR",
    message: "Authentication operation failed",
    event: "auth.failure",
    component: "auth",
    error_type: authErrorType(error),
  };
}

export function logAuthFailure(error: unknown): void {
  console.error(JSON.stringify(buildAuthFailureLogEntry(error)));
}

export function buildIngestSuccessLogEntry(
  endpoint: IngestFreshnessEndpoint,
): IngestSuccessLogEntry {
  return {
    severity: "INFO",
    message: "Ingest completed",
    event: "ingest.success",
    component: "ingest",
    endpoint,
  };
}

export function logIngestSuccess(endpoint: IngestFreshnessEndpoint): void {
  console.info(JSON.stringify(buildIngestSuccessLogEntry(endpoint)));
}

export function buildDirectoryTimingLogEntry(
  directory: DirectoryTimingLogEntry["directory"],
  durationMs: number,
  returnedRows: number,
): DirectoryTimingLogEntry {
  return {
    severity: "INFO",
    message: "Directory query completed",
    event: "directory.query",
    component: "directory",
    directory,
    duration_ms: Math.max(0, Math.round(durationMs)),
    returned_rows: Math.max(0, Math.trunc(returnedRows)),
  };
}

/** PII-free timing only: never add filters, names, IDs, email, or query text. */
export function logDirectoryTiming(
  directory: DirectoryTimingLogEntry["directory"],
  durationMs: number,
  returnedRows: number,
): void {
  console.info(JSON.stringify(
    buildDirectoryTimingLogEntry(directory, durationMs, returnedRows),
  ));
}

/** Bounded error labels only. Prisma's message/meta may include SQL or client data. */
export function logDirectoryFailure(
  directory: DirectoryTimingLogEntry["directory"],
  durationMs: number,
  error: unknown,
): void {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  const metaCode = error && typeof error === "object" && "meta" in error &&
    error.meta && typeof error.meta === "object" && "code" in error.meta ? error.meta.code : null;
  const category = code === "P2028" || code === "P1002" || metaCode === "57014" || metaCode === "55P03"
    ? "timeout" : code === "P2010" || code === "P1001" ? "database" : "other";
  const entry: DirectoryFailureLogEntry = {
    severity: "ERROR",
    message: "Directory query failed",
    event: "directory.failure",
    component: "directory",
    directory,
    duration_ms: Math.max(0, Math.round(durationMs)),
    category,
  };
  console.error(JSON.stringify(entry));
}

export function buildDetailTimingLogEntry(
  detail: DetailTimingLogEntry["detail"],
  durationMs: number,
): DetailTimingLogEntry {
  return {
    severity: "INFO",
    message: "Detail query completed",
    event: "detail.query",
    component: "detail",
    detail,
    duration_ms: Math.max(0, Math.round(durationMs)),
  };
}

/** PII-free timing only: never add names, IDs, email, routes, or query text. */
export function logDetailTiming(
  detail: DetailTimingLogEntry["detail"],
  durationMs: number,
): void {
  console.info(JSON.stringify(buildDetailTimingLogEntry(detail, durationMs)));
}
