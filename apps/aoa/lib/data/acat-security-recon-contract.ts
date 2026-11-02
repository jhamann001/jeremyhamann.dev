// Security reconciliation contract (ticket). Pure and client-safe: no
// server-only import. The tracker owns every position and the matching
// arithmetic; this module only maps what the tracker returns, builds the
// requests AoA sends, and ports the tracker's display helpers so the section
// shows the same words, numbers, and download the tracker slide-out shows.

export const RECON_STATUSES = [
  "Matched", "Mismatch", "Missing", "Unexpected", "Pending", "Expected", "Info",
] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

/** The statuses a row override can pick (the tracker's select has no Info). */
export const RECON_EDIT_STATUSES: readonly ReconStatus[] = [
  "Matched", "Mismatch", "Missing", "Pending", "Expected", "Unexpected",
];

export const RECON_MAPPING_LIMIT_BYTES = 2 * 1024 * 1024;
export const RECON_APEX_LIMIT_CHARS = 5_000_000;
export const RECON_MAX_ROWS = 500;

export const RECON_OFF = "Security reconciliation is turned off.";
export const RECON_LOAD_FAILURE = "Could not load security reconciliation.";
export const RECON_UNAVAILABLE = "Security reconciliation is unavailable — try again.";
export const RECON_BUSY = "Another upload or save is still in progress. Try again when it finishes.";
export const RECON_SAVE_FAILURE = "Reconciliation was not saved.";
export const RECON_DOWNLOAD_FAILURE = "The download could not be created — try again.";
export const RECON_NOT_CSV = "Please upload a .csv file.";
export const RECON_MAPPING_TOO_LARGE = "Mapping CSV must be 2 MB or smaller.";
export const RECON_NO_STATEMENT = "Add the statement account number before uploading a mapping CSV.";
export const RECON_INVALID = "Invalid security reconciliation request";
export const RECON_ACCOUNTS_FAILURE = "Unable to load mapping accounts. Try searching again.";

export const RECON_TEMPLATE_FILENAME = "asset-mapping-upload-template.csv";
export const RECON_TEMPLATE_CSV =
  "Account Number,Symbol,Description,Shares,Market Value,Classification,Include in Partial Transfer\n";

export type ReconMapping = {
  mappingTransferStatus: string | null;
  mappingTransferNotes: string | null;
  mappingTransferring: boolean | null;
  mappingStatementDate: string | null;
  mappingStatementAgeDays: number | null;
  mappingStatementIsStale: boolean | null;
  mappingSyncedAt: string | null;
};

export type ReconPosition = {
  id: string;
  symbol: string;
  description: string;
  cusip: string | null;
  expectedQty: number;
  actualQty: number;
  amount: number | null;
  assetClass: string | null;
  status: ReconStatus;
  issue: string | null;
  notes: string | null;
  mapping: ReconMapping;
};

export type ReconCounts = { total: number; matched: number; issues: number; reconRate: number };

export type ReconSourceAccount = {
  id: string;
  clientName: string;
  holder: string;
  registration: string;
  custodian: string;
  accountNumberLast4: string | null;
  statementDate: string | null;
  isHistorical: boolean;
};

export type ReconSnapshot = {
  acatId: string;
  mappingSource: string | null;
  apexSource: string | null;
  lastSynced: string | null;
  sourceAccount: ReconSourceAccount | null;
  hasStatementAccount: boolean;
  positions: ReconPosition[];
  counts: ReconCounts;
};

export type ReconApexFormat = "acat" | "activities";
export type ReconPreview = { apexFormat: ReconApexFormat; positions: ReconPosition[]; counts: ReconCounts };

export type ReconFailure = { ok: false; refused: false; reason: string; retryable: boolean };
export type ReconRefusal = { ok: false; refused: true; status: number; message: string; snapshot: ReconSnapshot };
export type ReconSuccess = { ok: true; snapshot: ReconSnapshot; preview: ReconPreview | null };
export type ReconResult = ReconSuccess | ReconRefusal | ReconFailure;

export type ReconAccount = {
  id: string;
  clientName: string;
  holder: string;
  custodian: string;
  registration: string;
  accountNumberLast4: string | null;
  investorNumberLast4: string | null;
  statementDate: string | null;
  isHistorical: boolean;
  positionCount: number;
};
export type ReconAccountsResult =
  | { ok: true; accounts: ReconAccount[]; truncated: boolean }
  | { ok: false; reason: string; retryable: boolean };

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

function mapMapping(raw: unknown): ReconMapping {
  const m = isRecord(raw) ? raw : {};
  return {
    mappingTransferStatus: str(m.mappingTransferStatus),
    mappingTransferNotes: str(m.mappingTransferNotes),
    mappingTransferring: bool(m.mappingTransferring),
    mappingStatementDate: str(m.mappingStatementDate),
    mappingStatementAgeDays: finite(m.mappingStatementAgeDays),
    mappingStatementIsStale: bool(m.mappingStatementIsStale),
    mappingSyncedAt: str(m.mappingSyncedAt),
  };
}

const STATUS_SET: ReadonlySet<string> = new Set(RECON_STATUSES);

function mapPosition(raw: unknown): ReconPosition | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const symbol = str(raw.symbol);
  const description = str(raw.description);
  const expectedQty = finite(raw.expectedQty);
  const actualQty = finite(raw.actualQty);
  const status = str(raw.status);
  if (!id || symbol === null || description === null || expectedQty === null || actualQty === null) return null;
  if (status === null || !STATUS_SET.has(status)) return null;
  return {
    id,
    symbol,
    description,
    cusip: str(raw.cusip),
    expectedQty,
    actualQty,
    amount: finite(raw.amount),
    assetClass: str(raw.assetClass),
    status: status as ReconStatus,
    issue: str(raw.issue),
    notes: str(raw.notes),
    mapping: mapMapping(raw.mapping),
  };
}

function mapPositions(raw: unknown): ReconPosition[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ReconPosition[] = [];
  for (const row of raw) {
    const mapped = mapPosition(row);
    if (!mapped) return null;
    out.push(mapped);
  }
  return out;
}

function mapCounts(raw: unknown): ReconCounts | null {
  if (!isRecord(raw)) return null;
  const total = finite(raw.total);
  const matched = finite(raw.matched);
  const issues = finite(raw.issues);
  const reconRate = finite(raw.reconRate);
  if (total === null || matched === null || issues === null || reconRate === null) return null;
  return { total, matched, issues, reconRate };
}

function mapSourceAccount(raw: unknown): ReconSourceAccount | null {
  if (!isRecord(raw)) return null;
  return {
    id: str(raw.id) ?? "",
    clientName: str(raw.clientName) ?? "",
    holder: str(raw.holder) ?? "",
    registration: str(raw.registration) ?? "",
    custodian: str(raw.custodian) ?? "",
    accountNumberLast4: str(raw.accountNumberLast4),
    statementDate: str(raw.statementDate),
    isHistorical: raw.isHistorical === true,
  };
}

/** The tracker's stored reconciliation for one transfer, or null when the
 *  body is not one. Unknown keys are ignored. */
export function mapReconSnapshot(raw: unknown): ReconSnapshot | null {
  if (!isRecord(raw)) return null;
  const acatId = str(raw.acatId);
  if (!acatId || acatId.trim() === "") return null;
  const positions = mapPositions(raw.positions);
  const counts = mapCounts(raw.counts);
  if (!positions || !counts) return null;
  return {
    acatId,
    mappingSource: str(raw.mappingSource),
    apexSource: str(raw.apexSource),
    lastSynced: str(raw.lastSynced),
    sourceAccount: mapSourceAccount(raw.sourceAccount),
    hasStatementAccount: raw.hasStatementAccount === true,
    positions,
    counts,
  };
}

/** The Apex-file preview the tracker returns beside the stored snapshot. */
export function mapReconPreview(raw: unknown): ReconPreview | null {
  if (!isRecord(raw)) return null;
  const apexFormat = raw.apexFormat === "acat" || raw.apexFormat === "activities" ? raw.apexFormat : null;
  const positions = mapPositions(raw.positions);
  const counts = mapCounts(raw.counts);
  if (!apexFormat || !positions || !counts) return null;
  return { apexFormat, positions, counts };
}

// ---------------------------------------------------------------------------
// Status hues (tracker StatusBadge collapse, SecurityReconTab lines 897-909)
// ---------------------------------------------------------------------------

export type ReconHue = "emerald" | "amber" | "blue" | "violet";

export function reconStatusHue(status: ReconStatus): ReconHue {
  if (status === "Matched" || status === "Info") return "emerald";
  if (status === "Pending") return "blue";
  if (status === "Expected") return "violet";
  return "amber";
}

/** The tracker's "has an issue" test (row tint and red quantity). */
export function rowHasIssue(row: Pick<ReconPosition, "status">): boolean {
  return row.status !== "Matched" && row.status !== "Pending" && row.status !== "Info";
}

/** Fee rows (Info) are read-only; every other row can be overridden. */
export function isEditableRow(row: Pick<ReconPosition, "status">): boolean {
  return row.status !== "Info";
}

export type ReconEdit = Partial<Pick<ReconPosition, "actualQty" | "status" | "issue" | "notes">>;

export function applyReconEdits(rows: readonly ReconPosition[], edits: ReadonlyMap<string, ReconEdit>): ReconPosition[] {
  if (edits.size === 0) return [...rows];
  return rows.map((row) => {
    const edit = edits.get(row.id);
    return edit ? { ...row, ...edit } : row;
  });
}

// ---------------------------------------------------------------------------
// Display helpers ported from the tracker (src/lib/security-recon.ts, component)
// ---------------------------------------------------------------------------

const CASH_SYNONYMS = new Set(["CASH", "USD"]);

export function normalizeTicker(symbol: string): string {
  return symbol.replace(/[.\-'/\s_]/g, "").toUpperCase().trim();
}

export function isCashSymbol(symbol: string): boolean {
  return CASH_SYNONYMS.has(normalizeTicker(symbol));
}

export function formatReconCash(value: number, signed = false): string {
  const sign = value < 0 ? "-" : signed ? "+" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatMappingSync(value?: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return "Not yet recorded";
  return new Date(value).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function reconVariance(row: Pick<ReconPosition, "actualQty" | "expectedQty">): number {
  return row.actualQty - row.expectedQty;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type ReconUploadBody = { action: "upload"; kind: "apex" | "mapping"; filename: string; text: string };

export function buildUploadRequest(input: {
  kind: "apex" | "mapping";
  filename: string;
  text: string;
  size: number;
  hasStatementAccount: boolean;
}): { ok: true; body: ReconUploadBody } | { ok: false; reason: string } {
  if (!input.filename.toLowerCase().endsWith(".csv")) return { ok: false, reason: RECON_NOT_CSV };
  if (input.kind === "mapping") {
    if (input.size > RECON_MAPPING_LIMIT_BYTES) return { ok: false, reason: RECON_MAPPING_TOO_LARGE };
    if (!input.hasStatementAccount) return { ok: false, reason: RECON_NO_STATEMENT };
  }
  if (input.text.length > RECON_APEX_LIMIT_CHARS) return { ok: false, reason: RECON_INVALID };
  return { ok: true, body: { action: "upload", kind: input.kind, filename: input.filename, text: input.text } };
}

export type ReconSaveRow = {
  id: string;
  symbol: string;
  description: string;
  cusip: string | null;
  actualQty: number;
  amount: number | null;
  assetClass: string | null;
  status: ReconStatus;
  issue: string | null;
  notes: string | null;
};
export type ReconSaveBody = {
  action: "save";
  rows: ReconSaveRow[];
  apexUploaded: boolean;
  overriddenIds: string[];
};
export type ReconRefreshBody = { action: "refresh"; sourceAccountId?: string };
export type ReconActionBody = ReconUploadBody | ReconSaveBody | ReconRefreshBody;

/** The grid the user is looking at, reduced to the fields the tracker saves.
 *  An empty grid is allowed and stores no position rows. */
export function buildSaveRequest(input: {
  rows: readonly ReconPosition[];
  apexUploaded: boolean;
  overriddenIds: Iterable<string>;
}): { ok: true; body: ReconSaveBody } | { ok: false; reason: string } {
  if (input.rows.length > RECON_MAX_ROWS) return { ok: false, reason: RECON_INVALID };
  const overridden = [...new Set(input.overriddenIds)];
  if (overridden.length > RECON_MAX_ROWS) return { ok: false, reason: RECON_INVALID };
  const rows: ReconSaveRow[] = [];
  for (const row of input.rows) {
    if (!Number.isFinite(row.actualQty)) return { ok: false, reason: RECON_INVALID };
    rows.push({
      id: row.id,
      symbol: row.symbol,
      description: row.description,
      cusip: row.cusip,
      actualQty: row.actualQty,
      amount: row.amount,
      assetClass: row.assetClass,
      status: row.status,
      issue: row.issue,
      notes: row.notes,
    });
  }
  return { ok: true, body: { action: "save", rows, apexUploaded: input.apexUploaded, overriddenIds: overridden } };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 404, 409, 422, 502, 503]);

function unavailable(status: number | null): ReconFailure {
  return {
    ok: false,
    refused: false,
    reason: RECON_UNAVAILABLE,
    retryable: status === null || status >= 500 || status === 429,
  };
}

/** The tracker's response to a security-recon action. A refusal needs its
 *  x-recon-refusal header and the stored positions as the whole body; every
 *  other outcome is an opaque failure that carries no positions. */
export function reconResultFromUpstream(input: {
  status: number | null;
  data: unknown;
  refusal: string | null;
}): ReconResult {
  const { status, data, refusal } = input;
  if (status === 200) {
    const snapshot = mapReconSnapshot(data);
    if (!snapshot) return unavailable(status);
    const rawPreview = isRecord(data) ? data.preview : undefined;
    if (rawPreview === undefined) return { ok: true, snapshot, preview: null };
    const preview = mapReconPreview(rawPreview);
    return preview ? { ok: true, snapshot, preview } : unavailable(status);
  }
  if (status !== null && REFUSAL_STATUSES.has(status) && refusal && refusal.trim() !== "") {
    const snapshot = mapReconSnapshot(data);
    if (snapshot) return { ok: false, refused: true, status, message: refusal.trim(), snapshot };
  }
  return unavailable(status);
}

const FALLBACK: ReconFailure = { ok: false, refused: false, reason: RECON_UNAVAILABLE, retryable: true };

/** AoA's own route envelope, read in the browser. */
export function parseReconEnvelope(_httpStatus: number, body: unknown): ReconResult {
  if (!isRecord(body)) return FALLBACK;
  if (body.ok === true) {
    const snapshot = mapReconSnapshot(body.snapshot);
    if (!snapshot) return FALLBACK;
    if (body.preview === undefined || body.preview === null) return { ok: true, snapshot, preview: null };
    const preview = mapReconPreview(body.preview);
    return preview ? { ok: true, snapshot, preview } : FALLBACK;
  }
  if (body.ok === false && body.refused === true) {
    const snapshot = mapReconSnapshot(body.snapshot);
    const message = str(body.message);
    const status = finite(body.status);
    if (snapshot && message && status !== null) return { ok: false, refused: true, status, message, snapshot };
    return FALLBACK;
  }
  if (body.ok === false && body.refused === false) {
    const reason = str(body.reason);
    if (reason) return { ok: false, refused: false, reason, retryable: body.retryable === true };
  }
  return FALLBACK;
}

function mapAccount(raw: unknown): ReconAccount | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  return {
    id,
    clientName: str(raw.clientName) ?? "",
    holder: str(raw.holder) ?? "",
    custodian: str(raw.custodian) ?? "",
    registration: str(raw.registration) ?? "",
    accountNumberLast4: str(raw.accountNumberLast4),
    investorNumberLast4: str(raw.investorNumberLast4),
    statementDate: str(raw.statementDate),
    isHistorical: raw.isHistorical === true,
    positionCount: finite(raw.positionCount) ?? 0,
  };
}

/** The tracker's `{ accounts, truncated }` body. */
export function parseReconAccounts(raw: unknown): { accounts: ReconAccount[]; truncated: boolean } | null {
  if (!isRecord(raw) || !Array.isArray(raw.accounts)) return null;
  const accounts = raw.accounts.map(mapAccount).filter((a): a is ReconAccount => a !== null);
  return { accounts, truncated: raw.truncated === true };
}

/** AoA's accounts-route envelope, read in the browser. */
export function parseAccountsEnvelope(_httpStatus: number, body: unknown): ReconAccountsResult {
  const fallback: ReconAccountsResult = { ok: false, reason: RECON_ACCOUNTS_FAILURE, retryable: true };
  if (!isRecord(body)) return fallback;
  if (body.ok === true && Array.isArray(body.accounts)) {
    const accounts = body.accounts.map(mapAccount).filter((a): a is ReconAccount => a !== null);
    return { ok: true, accounts, truncated: body.truncated === true };
  }
  if (body.ok === false) {
    const reason = str(body.reason);
    if (reason) return { ok: false, reason, retryable: body.retryable === true };
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Download (tracker exportReconCsv, SecurityReconTab lines 1012-1076)
// ---------------------------------------------------------------------------

const CSV_HEADER = [
  "Symbol", "Description", "CUSIP", "Expected Qty (DB)", "Actual Qty (Apex)", "Variance", "Status", "Issue", "Notes",
  "Transfer Eligibility", "Transfer Eligibility Notes", "Transferring? (Asset Mapping)", "Statement Date",
  "Reported Statement Age (Days)", "Reported Statement Stale", "Asset Mapping Synced At",
];

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Every position in the grid, one CSV row each. Bytes match the tracker's. */
export function buildReconCsv(rows: readonly ReconPosition[]): string {
  const dataRows = rows.map((r) => [
    r.symbol,
    r.description,
    r.cusip ?? "",
    String(r.expectedQty),
    String(r.actualQty),
    String(r.actualQty - r.expectedQty),
    r.status,
    r.issue ?? "",
    r.notes ?? "",
    r.mapping.mappingTransferStatus ?? "",
    r.mapping.mappingTransferNotes ?? "",
    r.mapping.mappingTransferring === true ? "Yes" : r.mapping.mappingTransferring === false ? "No" : "",
    r.mapping.mappingStatementDate ?? "",
    r.mapping.mappingStatementAgeDays == null ? "" : String(r.mapping.mappingStatementAgeDays),
    r.mapping.mappingStatementIsStale === true ? "Yes" : r.mapping.mappingStatementIsStale === false ? "No" : "",
    r.mapping.mappingSyncedAt ?? "",
  ]);
  return [CSV_HEADER, ...dataRows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function reconCsvFilename(input: { controlNumber: string; clientName: string }, now: Date): string {
  const slug = input.controlNumber || input.clientName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `acat-${slug}-recon-${now.toISOString().slice(0, 10)}.csv`;
}
