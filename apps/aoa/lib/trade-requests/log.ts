// Structured logging for the ported Trade Request drift code (ticket). Keeps the standalone pino call shape,
// `logger.info(fields, message)` or `logger.info(message)`, and writes one Cloud Logging JSON line per call
// (lib/observability/structured-log.ts convention). Account identifiers, row-validation details and error
// objects are reduced, and error text is cut to its first line, so no client data reaches the log.
type Fields = Record<string, unknown>;
type LogFn = (fieldsOrMessage: Fields | string, message?: string) => void;
type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

// Keys the ported loaders and runner use for account identifiers, titles and row details.
const REDACTED = new Set(["accountId", "account", "accountTitle", "title", "householdName", "external_account_no", "errors"]);
const ID_LISTS = new Set(["accounts", "unmappedPositionsAccounts", "unmappedSnapshotAccounts"]);

function scrub(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ID_LISTS.has(key) && Array.isArray(value)) out[key] = `[${value.length} redacted]`;
    else if (REDACTED.has(key) || /accountno$/i.test(key)) out[key] = "[redacted]";
    else if (value instanceof Error) out[key] = value.name;
    else if (key === "message") out.error_message = String(value).split("\n")[0].replace(/Failing row contains.*/i, "").slice(0, 200);
    else out[key] = value;
  }
  return out;
}

function emit(severity: Severity, fieldsOrMessage: Fields | string, message?: string): void {
  const fields = typeof fieldsOrMessage === "string" ? {} : scrub(fieldsOrMessage);
  const text = typeof fieldsOrMessage === "string" ? fieldsOrMessage : message;
  const line = JSON.stringify({ severity, component: "trade_request_drift", ...fields, message: text });
  if (severity === "ERROR") console.error(line);
  else if (severity === "WARNING") console.warn(line);
  else console.log(line);
}

const logger: { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn } = {
  debug: (f, m) => {
    if (process.env.TRADE_REQUEST_DRIFT_DEBUG_LOG === "1") emit("DEBUG", f, m);
  },
  info: (f, m) => emit("INFO", f, m),
  warn: (f, m) => emit("WARNING", f, m),
  error: (f, m) => emit("ERROR", f, m),
};

export default logger;
