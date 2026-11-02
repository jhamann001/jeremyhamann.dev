import { createHash, timingSafeEqual } from "node:crypto";
import type { LegacyImportCounts, LegacyImportPreview } from "./legacy-import-engine";
import {
  LEGACY_BILLING_SOURCE, LEGACY_FEE_SOURCE, LEGACY_RECON_SOURCE,
  type LegacyParseIssue, type LegacySource,
} from "./legacy-import";
import { getLegacyImportTarget, type LegacyImportTarget } from "./legacy-import-target";

// Operator-only, pure approval binding. No files, environment reads, database,
// network calls, or request narratives are part of this module's output.
export type LegacyImportApprovalContext = {
  target: LegacyImportTarget;
  project: string;
  instance: string;
  database: string;
  owner: string;
  serverAddress: string;
  codeDigest: string;
  schemaDigest: string;
  /** Cloud job stable identity/image/source-generation binding; absent for workstation. */
  executionDigest?: string;
  inputDigests: {
    feeCredits: string | null;
    billingExceptions: string | null;
    tradeReconciliation: string | null;
    mapping: string | null;
  };
};

export type LegacyImportApprovalBlocker = {
  source: LegacySource | "unknown";
  legacyId: string | null;
  field: string;
  code: string;
};

export type LegacyImportApproval = {
  plan: {
    version: 1;
    context: LegacyImportApprovalContext;
    parsed: LegacyImportCounts;
    ready: LegacyImportCounts;
    existing: LegacyImportCounts;
    blockers: LegacyImportApprovalBlocker[];
    resolutionDigest: string;
  };
  digest: string;
};

export class LegacyImportApprovalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LegacyImportApprovalError";
  }
}

const MAX_REPORT_BYTES = 1_048_576;
const SOURCES = [LEGACY_FEE_SOURCE, LEGACY_BILLING_SOURCE, LEGACY_RECON_SOURCE] as const;
const CONTEXT_KEYS = ["target", "project", "instance", "database", "owner", "serverAddress", "codeDigest", "schemaDigest", "inputDigests"];
const INPUT_KEYS = ["feeCredits", "billingExceptions", "tradeReconciliation", "mapping"] as const;
const PLAN_KEYS = ["version", "context", "parsed", "ready", "existing", "blockers", "resolutionDigest"];
// Parser header names can be supplied by CSV input. Whitelisting, rather than
// a token-shaped regex alone, keeps accidental names/account values out.
const FIELDS = new Set([
  "unknown", "file", "header", "row", "id", "legacy_id", "source", "mapping", "scope",
  "submission_date", "user_role", "client_user_id", "fee_type", "fee_amount", "account_numbers",
  "waiver_reason", "created_at", "status", "credited_date", "client_name", "apex_request", "submitted_by",
  "waiver_start_month", "waiver_start_year", "waiver_start", "waiver_duration", "relevant_tickets",
  "account_1", "account_2", "account_3", "account_4", "account_5", "account_6", "accounts", "account_ids",
  "approval_status", "approved_by", "approval_date", "exception_type", "indefinite_duration", "review",
  "trade_date", "run_time", "total_apex", "total_meridian", "perfect_matches", "breaks",
  "unmatched_apex", "unmatched_meridian", "match_rate", "Notes", "client_sf_id", "household_sf_id", "source_digest",
]);
const CODES = new Set([
  "unclassified_issue", "empty_csv", "duplicate_header", "missing_header", "column_count_mismatch",
  "duplicate_legacy_id", "invalid_legacy_id", "invalid_date", "invalid_amount", "invalid_name", "invalid_bridge_id",
  "missing_accounts", "unsupported_fee_type", "unsupported_status", "missing_credited_date", "apex_request_too_long",
  "invalid_apex_request", "unresolved_submitter", "invalid_role", "reason_too_long", "unsupported_type", "invalid_duration",
  "invalid_reason", "partial_review_identity", "pending_has_review_metadata", "ticket_too_long", "invalid_timestamp",
  "run_date_not_after_trade_date", "invalid_count", "count_exceeds_total", "invalid_rate", "note_too_long",
  "mapping_key_mismatch", "reviewed_client_not_found", "household_scope_not_approved", "reviewed_household_required",
  "reviewed_client_not_in_household", "reviewed_household_accounts_required", "reviewed_account_not_owned",
  "reviewed_accounts_source_mismatch", "client_scope_has_household", "reviewed_accounts_unresolved", "no_proven_match",
  "ambiguous_match", "invalid_mapping_source", "duplicate_mapping", "invalid_mapping_scope", "invalid_client_sf_id",
  "invalid_household_sf_id", "household_mapping_accounts_required", "invalid_account_id", "unused_mapping",
  "existing_record_drift", "existing_mapping_drift",
]);

function fail(code: string): never { throw new LegacyImportApprovalError(code); }

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));
}

function digest(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && !/[^0-9a-f]/.test(value);
}

function numericId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 80 && !/[^0-9]/.test(value);
}

function source(value: unknown): value is LegacySource {
  return SOURCES.some((entry) => entry === value);
}

function privateAddress(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 7 || value.length > 15 || /[^0-9.]/.test(value)) return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !part || (part.length > 1 && part[0] === "0") || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function validContext(value: unknown): value is LegacyImportApprovalContext {
  const withExecution = value !== null && typeof value === "object" && Object.hasOwn(value, "executionDigest");
  if (!exactRecord(value, withExecution ? [...CONTEXT_KEYS, "executionDigest"] : CONTEXT_KEYS)
    || (withExecution && !digest(value.executionDigest))
    || (value.target !== "dev" && value.target !== "prod")) return false;
  const expected = getLegacyImportTarget(value.target);
  if (value.project !== expected.project || value.instance !== expected.instance
    || value.database !== expected.database || value.owner !== expected.owner
    || !privateAddress(value.serverAddress) || !digest(value.codeDigest) || !digest(value.schemaDigest)
    || !exactRecord(value.inputDigests, INPUT_KEYS)) return false;
  const inputs = value.inputDigests;
  return INPUT_KEYS.every((key) => inputs[key] === null || digest(inputs[key]))
    && ["feeCredits", "billingExceptions", "tradeReconciliation"].some((key) => inputs[key] !== null);
}

function validCounts(value: unknown): value is LegacyImportCounts {
  return exactRecord(value, SOURCES)
    && SOURCES.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0);
}

function validBlocker(value: unknown): value is LegacyImportApprovalBlocker {
  return exactRecord(value, ["source", "legacyId", "field", "code"])
    && (source(value.source) || value.source === "unknown")
    && (value.legacyId === null || numericId(value.legacyId))
    && typeof value.field === "string" && FIELDS.has(value.field)
    && typeof value.code === "string" && CODES.has(value.code);
}

function validPlan(value: unknown): value is LegacyImportApproval["plan"] {
  if (!exactRecord(value, PLAN_KEYS) || value.version !== 1 || !validContext(value.context)
    || !validCounts(value.parsed) || !validCounts(value.ready) || !validCounts(value.existing)
    || !Array.isArray(value.blockers) || !value.blockers.every(validBlocker) || !digest(value.resolutionDigest)) return false;
  const { parsed, ready, existing, context, blockers } = value;
  const inputKeys = ["feeCredits", "billingExceptions", "tradeReconciliation"] as const;
  return SOURCES.every((key, index) => existing[key] <= ready[key] && ready[key] <= parsed[key]
    && (parsed[key] === 0 || context.inputDigests[inputKeys[index]] !== null)
    && (ready[key] === parsed[key] || blockers.length > 0));
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function safeIssue(issue: LegacyParseIssue): LegacyImportApprovalBlocker {
  return {
    source: source(issue.source) ? issue.source : "unknown",
    legacyId: numericId(issue.legacyId) ? issue.legacyId : null,
    field: FIELDS.has(issue.field) ? issue.field : "unknown",
    code: CODES.has(issue.code) ? issue.code : "unclassified_issue",
  };
}

/** Only the digest of these private resolutions leaves this function. */
function resolutionDigest(preview: LegacyImportPreview): string {
  const requests = preview.requests.map((row) => {
    if ((row.source !== LEGACY_FEE_SOURCE && row.source !== LEGACY_BILLING_SOURCE)
      || !numericId(row.legacyId) || !digest(row.sourceDigest)
      || (row.scope !== "CLIENT" && row.scope !== "HOUSEHOLD")
      || typeof row.clientSfId !== "string" || !row.clientSfId
      || (row.householdSfId !== null && typeof row.householdSfId !== "string")
      || typeof row.clientName !== "string" || !Array.isArray(row.accountIds)
      || row.accountIds.some((id) => typeof id !== "string" || !id)) fail("approval_preview_invalid");
    return {
      source: row.source, legacyId: row.legacyId, sourceDigest: row.sourceDigest,
      scope: row.scope, clientSfId: row.clientSfId, householdSfId: row.householdSfId,
      accountIds: [...new Set(row.accountIds)].sort(compare), clientNameDigest: hash(row.clientName),
    };
  });
  const reconciliations = preview.reconciliations.map((row) => {
    if (row.source !== LEGACY_RECON_SOURCE || !numericId(row.legacyId) || !digest(row.sourceDigest)) fail("approval_preview_invalid");
    return { source: row.source, legacyId: row.legacyId, sourceDigest: row.sourceDigest };
  });
  return hash({
    requests: requests.sort((a, b) => compare(canonical(a), canonical(b))),
    reconciliations: reconciliations.sort((a, b) => compare(canonical(a), canonical(b))),
  });
}

export function createLegacyImportApproval(
  context: LegacyImportApprovalContext,
  preview: LegacyImportPreview,
): LegacyImportApproval {
  if (!validContext(context)) fail("approval_context_invalid");
  if (!preview || !validCounts(preview.parsed) || !validCounts(preview.ready) || !validCounts(preview.existing)
    || !Array.isArray(preview.requests) || !Array.isArray(preview.unresolved)
    || !Array.isArray(preview.reconciliations) || !Array.isArray(preview.issues)
    || preview.requests.some((row) => !row || typeof row !== "object")
    || preview.reconciliations.some((row) => !row || typeof row !== "object")
    || preview.unresolved.some((row) => !row || (row.source !== LEGACY_FEE_SOURCE && row.source !== LEGACY_BILLING_SOURCE))
    || preview.issues.some((issue) => !issue || typeof issue !== "object")) fail("approval_preview_invalid");
  for (const key of SOURCES) {
    const ready = key === LEGACY_RECON_SOURCE ? preview.reconciliations.length : preview.requests.filter((row) => row.source === key).length;
    const unresolved = preview.unresolved.filter((row) => row.source === key).length;
    if (preview.ready[key] !== ready || preview.parsed[key] !== ready + unresolved) fail("approval_preview_invalid");
  }
  const plan: LegacyImportApproval["plan"] = {
    version: 1,
    context: { ...context, inputDigests: { ...context.inputDigests } },
    parsed: { ...preview.parsed }, ready: { ...preview.ready }, existing: { ...preview.existing },
    blockers: preview.issues.map(safeIssue).sort((a, b) => compare(canonical(a), canonical(b))),
    resolutionDigest: resolutionDigest(preview),
  };
  if (!validPlan(plan)) fail("approval_preview_invalid");
  const approval = { plan, digest: hash(plan) };
  if (Buffer.byteLength(JSON.stringify(approval), "utf8") > MAX_REPORT_BYTES) fail("approval_report_too_large");
  return approval;
}

// JSON.parse silently accepts repeated keys. Reject those before trusting the
// decoded shape, including escaped aliases such as "plan" and "\u0070lan".
function rejectDuplicateKeys(raw: string): void {
  let index = 0;
  const whitespace = () => { while (/\s/.test(raw[index] ?? "") && index < raw.length) index++; };
  const string = (): string => {
    const start = index++;
    while (index < raw.length) {
      const character = raw[index++];
      if (character === "\\") index++;
      else if (character === '"') return JSON.parse(raw.slice(start, index)) as string;
    }
    fail("approval_report_invalid");
  };
  const value = (depth: number): void => {
    if (depth > 16) fail("approval_report_invalid");
    whitespace();
    if (raw[index] === '"') { string(); return; }
    if (raw[index] === "{") {
      index++;
      whitespace();
      const keys = new Set<string>();
      while (raw[index] !== "}") {
        const key = string();
        if (keys.has(key)) fail("approval_report_invalid");
        keys.add(key);
        whitespace();
        index++; // colon: syntax was already checked by JSON.parse
        value(depth + 1);
        whitespace();
        if (raw[index] !== ",") break;
        index++;
        whitespace();
      }
      index++;
      return;
    }
    if (raw[index] === "[") {
      index++;
      whitespace();
      while (raw[index] !== "]") {
        value(depth + 1);
        whitespace();
        if (raw[index] !== ",") break;
        index++;
      }
      index++;
      return;
    }
    while (index < raw.length && !/[\s,}\]]/.test(raw[index])) index++;
  };
  value(0);
}

/** A changed source, mapping, target, schema, code or existing count needs a new dry run. */
export function verifyLegacyImportApproval(
  raw: string,
  approvedDigest: string,
  currentApproval: LegacyImportApproval,
): void {
  if (typeof raw !== "string") fail("approval_report_invalid");
  if (Buffer.byteLength(raw, "utf8") > MAX_REPORT_BYTES) fail("approval_report_too_large");
  if (!digest(approvedDigest)) fail("approval_digest_invalid");
  let report: unknown;
  try { report = JSON.parse(raw); } catch { fail("approval_report_invalid"); }
  rejectDuplicateKeys(raw);
  if (!exactRecord(report, ["plan", "digest"]) || !validPlan(report.plan) || !digest(report.digest)) fail("approval_report_invalid");
  if (!timingSafeEqual(Buffer.from(report.digest, "hex"), Buffer.from(hash(report.plan), "hex"))
    || !timingSafeEqual(Buffer.from(report.digest, "hex"), Buffer.from(approvedDigest, "hex"))) fail("approval_report_digest_mismatch");
  if (!exactRecord(currentApproval, ["plan", "digest"]) || !validPlan(currentApproval.plan)
    || !digest(currentApproval.digest) || hash(currentApproval.plan) !== currentApproval.digest) fail("approval_current_invalid");
  if (currentApproval.digest !== report.digest) fail("approval_plan_changed");
  if (report.plan.blockers.length > 0) fail("approval_blockers_present");
}
