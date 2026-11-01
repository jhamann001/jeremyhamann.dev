import {
  AcatRecord,
  ACAT_STATUSES,
  ACAT_STATUS_LABELS,
  TRANSFER_WORKFLOWS,
  TRANSFER_WORKFLOW_LABELS,
} from "./types";
import {
  getDaysOpen,
  getExpectedCompletionDate,
  getIssueCount,
  getReconStatus,
} from "./acat-derivations";
import { formatCentsExact, formatDateMMDDYYYY, formatMoneyStringExact } from "./format";

/**
 * Field-type taxonomy for the records schema. The filter engine, column
 * chooser, and CSV export all branch on this.
 */
export type FieldType =
  | "text"
  | "enum"
  | "date"
  | "number"
  | "boolean"
  | "multiselect";

/**
 * Synthetic columns that aren't direct keys on `AcatRecord` but are surfaced
 * to operators (computed from assets / dates).
 */
export type DerivedFieldKey =
  | "needsClientLink"
  | "daysOpen"
  | "assetCount"
  | "issueCount"
  | "reconStatus"
  | "expectedCompletionDate";

export type RecordFieldKey = keyof AcatRecord | DerivedFieldKey;

export interface RecordField {
  key: RecordFieldKey;
  label: string;
  type: FieldType;
  /** Options for `enum` and `multiselect`. For enums, also used as filter values. */
  options?: string[];
  /**
   * Optional value extractor. Defaults to `record[key]` for non-derived
   * fields. Always returns a stable, comparable representation:
   *  - text/enum/multiselect → string ("" when missing)
   *  - number → number | null
   *  - date → ISO date string ("YYYY-MM-DD") | ""
   *  - boolean → boolean
   */
  value: (r: AcatRecord) => string | number | boolean | null;
  /** Display formatter used by the row renderer + CSV. */
  format?: (v: string | number | boolean | null, r: AcatRecord) => string;
  /** Seed selection for the column chooser. */
  visibleByDefault?: boolean;
  /** When false, hide from the filter builder (usually for huge text). */
  filterable?: boolean;
  /** Synthetic columns (not keys on AcatRecord). */
  derived?: boolean;
}

const stringOrEmpty = (r: AcatRecord, key: keyof AcatRecord): string => {
  const v = r[key];
  if (v == null) return "";
  return String(v);
};

const dateOrEmpty = (r: AcatRecord, key: keyof AcatRecord): string => {
  const v = r[key];
  if (v == null || v === "") return "";
  // Accepts both "YYYY-MM-DD" and full ISO timestamps; normalises to YYYY-MM-DD
  const s = String(v);
  // Already a plain date string.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) return "";
  return t.toISOString().slice(0, 10);
};

const numberOrNull = (r: AcatRecord, key: keyof AcatRecord): number | null => {
  const v = r[key];
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const formatDate = (v: string | number | boolean | null): string => {
  if (typeof v !== "string" || !v) return "";
  return formatDateMMDDYYYY(v);
};

const formatNumber = (v: string | number | boolean | null): string => {
  if (v == null || v === "") return "";
  return String(v);
};

export const ACCOUNT_TYPE_OPTIONS = [
  "Brokerage / Individual",
  "Joint Account (JTWROS - Rights of Survivorship)",
  "Joint Account (TIC - Tenants in Common)",
  "Community Property Registration",
  "Traditional IRA",
  "Roth IRA",
  "Inherited Traditional IRA (w/ beneficiaries)",
  "Inherited Roth IRA",
  "Other",
];

// Current advisors only. A record assigned to a former advisor keeps that
// value (wealthAdvisor is a free string, not an enum) and remains editable;
// leaving a name off this list only removes it as a future choice.
export const ADVISOR_OPTIONS = ["Dana", "Rachel", "Sam", "None"];

const TRANSFER_TYPE_OPTIONS = ["Full", "Partial", "Residual Credit"];
const DIRECTION_OPTIONS = ["In", "Out"];
const YES_NO_OPTIONS = ["Yes", "No"];
const METHOD_OPTIONS = [
  "API",
  "Full Docusign",
  "Partial Docusign",
  "Non-ACAT Transfer (Manual)",
  "N/A",
];
const STATUS_LABEL_OPTIONS = ACAT_STATUSES.map((s) => ACAT_STATUS_LABELS[s]);
const TRANSFER_WORKFLOW_OPTIONS = TRANSFER_WORKFLOWS.map(
  (workflow) => TRANSFER_WORKFLOW_LABELS[workflow]
);

/**
 * Single source of truth for every column the records UI knows about.
 *
 * Every entry feeds:
 *  - the column chooser (which fields can be shown in the row)
 *  - the filter builder (which fields can be filtered, with which operators)
 *  - the CSV export (`exportCsv` in RecordsView)
 *  - dynamic row rendering (RecordRow)
 *
 * The set of `keyof AcatRecord` covered here is intentionally complete: when
 * a new field is added to `AcatRecord`, the schema integrity test in
 * `record-fields.test.ts` will fail until it's listed below or explicitly
 * excluded via `EXCLUDED_RECORD_KEYS`.
 */
export const RECORD_FIELDS: RecordField[] = [
  {
    key: "id",
    label: "ID",
    type: "text",
    value: (r) => r.id,
    visibleByDefault: false,
  },
  {
    key: "cedarRidgeUserId", label: "Cedar Ridge User ID", type: "text",
    value: (r) => r.cedarRidgeUserId ?? "",
  },
  {
    key: "cedarRidgeUserIds", label: "Cedar Ridge User IDs", type: "text",
    value: (r) => (r.cedarRidgeUserIds ?? (r.cedarRidgeUserId ? [r.cedarRidgeUserId] : [])).join(", "),
  },
  {
    key: "needsClientLink", label: "Needs client link", type: "boolean", derived: true,
    value: (r) => !(r.cedarRidgeUserIds?.length ?? (r.cedarRidgeUserId ? 1 : 0)),
  },
  {
    key: "clientName",
    label: "Client",
    type: "text",
    value: (r) => r.clientName,
    visibleByDefault: true,
  },
  {
    key: "status",
    label: "Status",
    type: "enum",
    options: STATUS_LABEL_OPTIONS,
    value: (r) => ACAT_STATUS_LABELS[r.status] ?? r.status,
    visibleByDefault: true,
  },
  {
    key: "transferringContra",
    label: "Contra",
    type: "text",
    value: (r) => stringOrEmpty(r, "transferringContra") || r.custodianName,
    visibleByDefault: true,
  },
  {
    key: "custodianName",
    label: "Custodian",
    type: "text",
    value: (r) => r.custodianName,
    visibleByDefault: false,
  },
  {
    key: "custodianId",
    label: "Custodian ID",
    type: "text",
    value: (r) => stringOrEmpty(r, "custodianId"),
    visibleByDefault: false,
  },
  {
    key: "direction",
    label: "Direction",
    type: "enum",
    options: DIRECTION_OPTIONS,
    value: (r) => stringOrEmpty(r, "direction"),
    visibleByDefault: true,
  },
  {
    key: "type",
    label: "Type",
    type: "enum",
    options: TRANSFER_TYPE_OPTIONS,
    value: (r) => stringOrEmpty(r, "type"),
    visibleByDefault: false,
  },
  {
    key: "accountType",
    label: "Account Type",
    type: "enum",
    options: ACCOUNT_TYPE_OPTIONS,
    value: (r) => stringOrEmpty(r, "accountType"),
    visibleByDefault: false,
  },
  {
    key: "methodRequested",
    label: "Method Requested",
    type: "multiselect",
    options: METHOD_OPTIONS,
    value: (r) => stringOrEmpty(r, "methodRequested"),
    visibleByDefault: false,
  },
  {
    key: "transferWorkflow",
    label: "Transfer Workflow",
    type: "enum",
    options: TRANSFER_WORKFLOW_OPTIONS,
    value: (r) =>
      TRANSFER_WORKFLOW_LABELS[r.transferWorkflow ?? "UNCLASSIFIED"],
    visibleByDefault: false,
  },
  {
    key: "wealthAdvisor",
    label: "Advisor",
    type: "enum",
    options: ADVISOR_OPTIONS,
    value: (r) => stringOrEmpty(r, "wealthAdvisor"),
    visibleByDefault: true,
  },
  {
    key: "crwEe",
    label: "CRW EE?",
    type: "enum",
    options: YES_NO_OPTIONS,
    value: (r) => stringOrEmpty(r, "crwEe"),
    visibleByDefault: false,
  },
  {
    key: "controlNumber",
    label: "Control #",
    type: "text",
    value: (r) => stringOrEmpty(r, "controlNumber"),
    visibleByDefault: true,
  },
  {
    key: "associatedControlNumber",
    label: "Associated Control #",
    type: "text",
    value: (r) => stringOrEmpty(r, "associatedControlNumber"),
    visibleByDefault: false,
  },
  {
    key: "acatTransferId",
    label: "ACAT Transfer ID",
    type: "text",
    value: (r) => stringOrEmpty(r, "acatTransferId"),
    visibleByDefault: false,
  },
  {
    key: "apexAccountId",
    label: "Apex Acct",
    type: "text",
    value: (r) => r.apexAccountId,
    visibleByDefault: true,
  },
  {
    key: "statementAccountNumber",
    label: "Statement Account #",
    type: "text",
    value: (r) => stringOrEmpty(r, "statementAccountNumber"),
    visibleByDefault: false,
  },
  {
    key: "statementAmount",
    label: "Statement Amount",
    type: "number",
    value: (r) => numberOrNull(r, "statementAmount"),
    format: (v) => (typeof v === "number" ? formatCentsExact(v) : ""),
    visibleByDefault: true,
  },
  {
    key: "dtccNumber",
    label: "DTCC #",
    type: "text",
    value: (r) => stringOrEmpty(r, "dtccNumber"),
    visibleByDefault: false,
  },
  {
    key: "acatDate",
    label: "ACAT Reference Date",
    type: "date",
    value: (r) => dateOrEmpty(r, "acatDate"),
    format: formatDate,
    visibleByDefault: true,
  },
  {
    key: "originalClientRequestDate",
    label: "Original Client Request Date",
    type: "date",
    value: (r) => dateOrEmpty(r, "originalClientRequestDate"),
    format: formatDate,
    visibleByDefault: false,
  },
  {
    key: "opsSubmissionDateToApex",
    label: "Ops Submission Date to Apex",
    type: "date",
    value: (r) => dateOrEmpty(r, "opsSubmissionDateToApex"),
    format: formatDate,
    visibleByDefault: false,
  },
  {
    key: "apexCompletionDate",
    label: "Apex Completion Date",
    type: "date",
    value: (r) => dateOrEmpty(r, "apexCompletionDate"),
    format: formatDate,
    visibleByDefault: false,
  },
  {
    key: "residualMonitoringRequired",
    label: "Monitor for Residual",
    type: "boolean",
    value: (r) => Boolean(r.residualMonitoringRequired),
    visibleByDefault: false,
  },
  {
    key: "residualFollowUpDate",
    label: "Residual Follow-Up Date",
    type: "date",
    value: (r) => dateOrEmpty(r, "residualFollowUpDate"),
    format: formatDate,
    visibleByDefault: false,
  },
  {
    key: "lastUpdated",
    label: "Last Updated",
    type: "date",
    value: (r) => dateOrEmpty(r, "lastUpdated"),
    format: formatDate,
    visibleByDefault: false,
  },
  {
    key: "feeCharged",
    label: "Fee Charged",
    type: "enum",
    options: YES_NO_OPTIONS,
    value: (r) => stringOrEmpty(r, "feeCharged"),
    visibleByDefault: false,
  },
  {
    key: "feeAmount",
    label: "Fee Amount",
    type: "text",
    value: (r) => stringOrEmpty(r, "feeAmount"),
    format: (v) => (typeof v === "string" ? formatMoneyStringExact(v) : ""),
    visibleByDefault: false,
  },
  {
    key: "feeMemo",
    label: "Fee Memo",
    type: "text",
    value: (r) => stringOrEmpty(r, "feeMemo"),
    visibleByDefault: false,
  },
  {
    key: "feeRequestSubmitted",
    label: "Fee Request Submitted",
    type: "date",
    value: (r) => dateOrEmpty(r, "feeRequestSubmitted"),
    format: formatDate,
    visibleByDefault: false,
  },
  {
    key: "feeRequestCompleted",
    label: "Fee Request Completed",
    type: "date",
    value: (r) => dateOrEmpty(r, "feeRequestCompleted"),
    format: formatDate,
    visibleByDefault: false,
  },
  {
    key: "feeApexTicket",
    label: "Fee Apex Ticket",
    type: "text",
    value: (r) => stringOrEmpty(r, "feeApexTicket"),
    visibleByDefault: false,
  },
  {
    key: "feeCreditRequestId",
    label: "Fee Credit Req ID",
    type: "text",
    value: (r) => stringOrEmpty(r, "feeCreditRequestId"),
    visibleByDefault: false,
  },
  {
    key: "crmTicket",
    label: "CRM Ticket",
    type: "text",
    value: (r) => stringOrEmpty(r, "crmTicket"),
    visibleByDefault: false,
  },
  {
    key: "crmDealId",
    label: "CRM Deal ID",
    type: "text",
    value: (r) => r.crmDealId,
    visibleByDefault: false,
  },
  {
    key: "apexTicket",
    label: "Apex Ticket",
    type: "text",
    value: (r) => stringOrEmpty(r, "apexTicket"),
    visibleByDefault: false,
  },
  {
    key: "rejectionReason",
    label: "Rejection Reason",
    type: "text",
    value: (r) => stringOrEmpty(r, "rejectionReason"),
    visibleByDefault: false,
  },
  {
    key: "additionalResources",
    label: "Additional Resources",
    type: "text",
    value: (r) => stringOrEmpty(r, "additionalResources"),
    visibleByDefault: false,
  },
  {
    key: "tradeRequestId",
    label: "Trade Request ID",
    type: "text",
    value: (r) => stringOrEmpty(r, "tradeRequestId"),
    visibleByDefault: false,
  },
  {
    key: "tradeRequestUrl",
    label: "Trade Request Link",
    type: "text",
    value: (r) => stringOrEmpty(r, "tradeRequestUrl"),
    visibleByDefault: false,
  },
  {
    key: "tradeInstructions",
    label: "Trade Instructions",
    type: "text",
    value: (r) => stringOrEmpty(r, "tradeInstructions"),
    visibleByDefault: false,
  },
  {
    key: "notes",
    label: "Notes",
    type: "text",
    value: (r) => stringOrEmpty(r, "notes"),
    visibleByDefault: false,
  },
  {
    key: "mappingSource",
    label: "Mapping Source",
    type: "text",
    value: (r) => r.mappingSource,
    visibleByDefault: false,
  },
  {
    key: "apexSource",
    label: "Apex Source",
    type: "text",
    value: (r) => r.apexSource,
    visibleByDefault: false,
  },
  {
    key: "deletedAt",
    label: "Deleted At",
    type: "date",
    value: (r) => dateOrEmpty(r, "deletedAt"),
    format: formatDate,
    visibleByDefault: false,
    filterable: false,
  },
  {
    // ticket: stamp written by the PATCH handler when an ACAT's recon
    // crosses the auto-complete threshold. Surfaced as a hidden column
    // option for ops who want to filter on "recon already closed out".
    key: "reconCompletedAt",
    label: "Recon Completed At",
    type: "date",
    value: (r) =>
      r.reconCompletedAt
        ? r.reconCompletedAt.length >= 10
          ? r.reconCompletedAt.slice(0, 10)
          : r.reconCompletedAt
        : "",
    format: formatDate,
    visibleByDefault: false,
  },

  // Derived columns — composed from assets + dates, surfaced for filtering /
  // exporting parity with the live UI.
  {
    key: "daysOpen",
    label: "Days Open",
    type: "number",
    value: (r) => getDaysOpen(r),
    format: formatNumber,
    visibleByDefault: true,
    derived: true,
  },
  {
    key: "assetCount",
    label: "Assets",
    type: "number",
    value: (r) => r.assets.length,
    format: formatNumber,
    visibleByDefault: true,
    derived: true,
  },
  {
    key: "issueCount",
    label: "Issues",
    type: "number",
    value: (r) => getIssueCount(r),
    format: formatNumber,
    visibleByDefault: true,
    derived: true,
  },
  {
    // ticket: derived recon status. "complete" / "needs_review" /
    // "pending". RecordRow renders a colored badge; this column is on
    // by default so the auto-completion signal is visible without
    // hunting for it in the column chooser.
    key: "reconStatus",
    label: "Recon",
    type: "enum",
    options: ["Complete", "Needs Review", "Pending"],
    value: (r) => {
      const s = getReconStatus(r);
      if (s === "complete") return "Complete";
      if (s === "needs_review") return "Needs Review";
      return "Pending";
    },
    visibleByDefault: true,
    derived: true,
  },
  {
    // ticket: projected completion date from opsSubmissionDateToApex +
    // custodian.avgProcessingDays. Off by default — ops can toggle it on
    // when they want a per-transfer "should be done by" anchor.
    key: "expectedCompletionDate",
    label: "Expected Completion",
    type: "date",
    value: (r) => getExpectedCompletionDate(r) ?? "",
    format: formatDate,
    visibleByDefault: false,
    derived: true,
  },
];

/**
 * Keys on AcatRecord that intentionally don't appear in the schema. These
 * are non-scalar (assets) — listed here so the integrity test can exempt
 * them rather than failing.
 */
export const EXCLUDED_RECORD_KEYS: ReadonlySet<keyof AcatRecord> = new Set([
  "identityVersion",
  "linkedClients",
  "mappingAccountId",
  "assets",
  // Eager-loaded relation used by date derivations, not a scalar record field.
  "custodian",
  // ticket: `slackAlerted` lost its dedicated column when the per-record
  // "Flag to CS Slack" button was retired in favor of the daily Slack
  // digest (POST /api/cron/daily-digest). The schema column is still
  // present (historical data) but it isn't a user-facing field anymore.
  "slackAlerted",
]);

export const RECORD_FIELDS_BY_KEY: Map<RecordFieldKey, RecordField> = new Map(
  RECORD_FIELDS.map((f) => [f.key, f])
);

export function getField(key: RecordFieldKey): RecordField | undefined {
  return RECORD_FIELDS_BY_KEY.get(key);
}

/** Default visible columns for the records list. */
export function defaultVisibleColumns(): Set<RecordFieldKey> {
  return new Set(
    RECORD_FIELDS.filter((f) => f.visibleByDefault).map((f) => f.key)
  );
}

/**
 * Default column order — the order in which fields appear in `RECORD_FIELDS`.
 * Operators can override this via drag-and-drop on the records header; the
 * override is persisted in localStorage.
 */
export function defaultColumnOrder(): RecordFieldKey[] {
  return RECORD_FIELDS.map((f) => f.key);
}

/**
 * Normalise a stored column-order array against the current schema. Fields
 * that no longer exist are dropped; new fields added after the user's last
 * save are appended at the end so they remain reachable.
 */
export function normalizeColumnOrder(
  order: readonly RecordFieldKey[]
): RecordFieldKey[] {
  const known = RECORD_FIELDS_BY_KEY;
  const seen = new Set<RecordFieldKey>();
  const out: RecordFieldKey[] = [];
  for (const key of order) {
    if (!known.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  for (const f of RECORD_FIELDS) {
    if (!seen.has(f.key)) out.push(f.key);
  }
  return out;
}

/**
 * Produce the array of `RecordField`s sorted by the user-defined column order,
 * filtered to only the columns the user has marked visible. Unknown keys are
 * skipped silently. Used by the records header and row renderers so they
 * always agree on cell ordering.
 */
export function orderedVisibleFields(
  order: readonly RecordFieldKey[],
  visible: ReadonlySet<RecordFieldKey>
): RecordField[] {
  const out: RecordField[] = [];
  const seen = new Set<RecordFieldKey>();
  for (const key of order) {
    if (!visible.has(key)) continue;
    const field = RECORD_FIELDS_BY_KEY.get(key);
    if (!field || seen.has(key)) continue;
    seen.add(key);
    out.push(field);
  }
  // Fallback: any visible column missing from the order (e.g. column added
  // after the last save) renders at the end in its natural schema position.
  for (const field of RECORD_FIELDS) {
    if (visible.has(field.key) && !seen.has(field.key)) {
      seen.add(field.key);
      out.push(field);
    }
  }
  return out;
}

/**
 * Move `key` to a new position within an order array. The target index is
 * interpreted in the post-removal coordinate space (i.e. "insert before the
 * field currently at this index, with `key` already extracted"). Returns a
 * new array; never mutates the input. Out-of-range targets clamp.
 */
export function moveColumn(
  order: readonly RecordFieldKey[],
  key: RecordFieldKey,
  targetIndex: number
): RecordFieldKey[] {
  const from = order.indexOf(key);
  if (from === -1) return order.slice();
  const next = order.slice();
  next.splice(from, 1);
  const clamped = Math.max(0, Math.min(targetIndex, next.length));
  next.splice(clamped, 0, key);
  return next;
}

/**
 * Format a field value for display in a row cell or CSV export. Falls back
 * to the raw `value()` output stringified.
 */
export function formatFieldValue(
  field: RecordField,
  record: AcatRecord
): string {
  const raw = field.value(record);
  if (field.format) return field.format(raw, record);
  if (raw == null) return "";
  return String(raw);
}
