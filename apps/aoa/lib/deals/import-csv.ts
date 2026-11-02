// Shared pure toolkit for the D4 one-time import (TDD ticket ADR-6, §3, §7):
// hand-rolled CSV (RFC-4180 subset — ZERO new dependencies, locked), the
// report-column → DealInput mapping, the parse-and-review CSV shapes, and the
// counts-only reconciliation report. Lives in lib/ (not scripts/) so vitest
// exercises mapping + reporting directly — the same reason ADR-8 put
// validateDealInput in lib/.
//
// PII posture (absolute): nothing in this module ever puts a client name,
// household name, or amount into a report string — reconciliation output is
// counts + SF deal ids + field names only. The review CSV (which does carry
// names — it exists for human review) is written by the caller BESIDE the
// source file, outside the repo.

import type { DealInput, DealStage } from "@/lib/data/deal-types";
import {
  DEAL_STAGES,
  FUNDING_TYPE_OTHER,
  ROLLING_INTO_OPTIONS,
} from "@/lib/data/deal-types";
import {
  ACCOUNT_NUMBER_RE,
  type DealValidationError,
} from "@/lib/data/deal-validate";
import { parseDealName, type ParsedDealName } from "./parse-deal-name";

// ---------------------------------------------------------------------------
// CSV core (RFC-4180 subset): quoted fields, "" escapes, embedded
// commas/newlines, CRLF + LF, UTF-8 BOM. Hand-rolled — no csv library (ADR-6).
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  // Strip a UTF-8 BOM (Excel exports carry one).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ",") {
      endField();
      i += 1;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      endRow();
      i += 1;
    } else if (ch === "\n") {
      endRow();
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  // Final field/row (no trailing newline case). A single empty trailing line
  // (file ends with a newline) is not a row.
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Report columns (TDD §3 crosswalk). Header resolution is trim/case-tolerant
// and aliased so the importer stays dataset-agnostic across export quirks.
// ---------------------------------------------------------------------------

type FieldKey =
  | "sfDealId"
  | "name"
  | "firstName"
  | "lastName"
  | "householdName"
  | "householdSfId"
  | "clientSfId"
  | "amount"
  | "stage"
  | "stageRaw"
  | "createdDate"
  | "closeDate"
  | "lastActivityDate"
  | "ownerName"
  | "ownerSfUserId"
  | "secondaryOwner"
  | "personAum"
  | "potentialAum"
  | "cedarRidgeUserId"
  | "statements"
  | "plaidLinked"
  // D8 follow-on (deals-export-v2.csv): explicit account/funding columns.
  // When PRESENT they are authoritative — they replace the deal-name parse /
  // review-CSV enrichment for these fields. When absent (old-format CSVs)
  // everything behaves exactly as before.
  | "sendingFirm"
  | "fundingType"
  | "otherDetails"
  | "employer"
  | "rollingInto"
  | "accountNumber";

/** Canonical header first; aliases after (matched case-insensitively). */
export const REPORT_HEADERS: Record<FieldKey, readonly string[]> = {
  sfDealId: ["Deal: ID"],
  name: ["Deal: Deal Name"],
  firstName: ["Person: First Name"],
  lastName: ["Person: Last Name"],
  householdName: ["Person: Primary Entity"],
  householdSfId: [
    "Household SF ID (Person: Entity ID)",
    "Person: Entity ID",
    "Household SF ID",
  ],
  clientSfId: ["Person: Contact ID"],
  amount: ["AUM"],
  // Canonical "AoA - New Stage" (the D4 curated export) first; the CRM
  // report's coarser "Stage" column is a SECONDARY fallback so a report that
  // carries only "Stage" (Funded / Potential / Lost — mapped by parseStage)
  // still resolves a stage. First-hit-wins keeps "AoA - New Stage" winning
  // when a file has both (D4 backward-compat).
  stage: ["AoA - New Stage", "Stage"],
  stageRaw: ["Stage"],
  createdDate: ["Deal: Created Date"],
  closeDate: ["Close Date"],
  lastActivityDate: ["Deal: Last Activity Date"],
  ownerName: ["Person: Entity Owner"],
  ownerSfUserId: ["Owner SF User ID"],
  secondaryOwner: ["Person: Secondary Owner"],
  personAum: ["Person: AUM"],
  potentialAum: ["Person: Potential AUM"],
  cedarRidgeUserId: ["Person: Cedar Ridge User ID"],
  statements: ["Statements"],
  plaidLinked: ["Plaid Linked"],
  sendingFirm: ["Sending Firm"],
  fundingType: ["Funding Type"],
  otherDetails: ["Other Details"],
  employer: ["Employer"],
  rollingInto: ["Rolling Into"],
  accountNumber: ["Account Number"],
};

const REQUIRED_FIELDS: readonly FieldKey[] = [
  "sfDealId",
  "name",
  "firstName",
  "lastName",
  "amount",
  "stage",
  "createdDate",
];

export type ReportRecord = Partial<Record<FieldKey, string>>;

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase();
}

/**
 * Resolve a list of header cells → `FieldKey → column index`, using the
 * REPORT_HEADERS aliases (canonical first, matched trim/case-insensitively;
 * first alias that hits wins). The SINGLE definition of alias resolution —
 * shared by `recordsFromCsv` (header row of a CSV) and `reportRecordFromObject`
 * (the keys of an n8n row object) so the two paths can never drift. It does NOT
 * enforce REQUIRED_FIELDS — the caller decides whether a missing column throws
 * (the CSV parse) or maps to a null field that fails per-row validation (the
 * ingest endpoint).
 */
function resolveFieldColumns(headerCells: readonly string[]): Map<FieldKey, number> {
  const normalized = headerCells.map(normalizeHeader);
  const indexOfField = new Map<FieldKey, number>();
  for (const key of Object.keys(REPORT_HEADERS) as FieldKey[]) {
    for (const alias of REPORT_HEADERS[key]) {
      const idx = normalized.indexOf(normalizeHeader(alias));
      if (idx !== -1) {
        indexOfField.set(key, idx);
        break;
      }
    }
  }
  return indexOfField;
}

/**
 * Parse a report CSV into field-keyed records. Throws (naming HEADERS only —
 * never row data) when a required column is missing.
 */
export function recordsFromCsv(text: string): ReportRecord[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const indexOfField = resolveFieldColumns(rows[0]);

  const missing = REQUIRED_FIELDS.filter((k) => !indexOfField.has(k));
  if (missing.length > 0) {
    throw new Error(
      `CSV is missing required column(s): ${missing
        .map((k) => `"${REPORT_HEADERS[k][0]}"`)
        .join(", ")}`,
    );
  }

  return rows.slice(1).map((cells) => {
    const record: ReportRecord = {};
    for (const [key, idx] of indexOfField) {
      record[key] = cells[idx] ?? "";
    }
    return record;
  });
}

/**
 * Map ONE raw report-row OBJECT (n8n `extractFromFile` output — keyed by the
 * report's CSV column headers, values as strings) → `ReportRecord` (keyed by
 * FieldKey), using the SAME REPORT_HEADERS alias resolution `recordsFromCsv`
 * applies to a CSV header row (`resolveFieldColumns`). PURE (no Prisma) so it
 * stays in the contract layer and is unit-testable.
 *
 * Unlike `recordsFromCsv` it NEVER throws on a missing column: only the columns
 * actually present in the row become record keys (matching the CSV path, where
 * an absent column leaves its FieldKey `undefined` — the signal `mapReportRow`
 * reads for the D8 explicit-column fields). A row missing the deal-id column
 * therefore yields a record with no `sfDealId`, which maps to `sf_deal_id=null`
 * and is rejected per-item downstream. Non-string cell values are coerced with
 * `String()` (n8n can hand back numbers/booleans); null/undefined → "".
 *
 * PER-ROW vs PER-FILE "column present" NUANCE (benign; documented, not fixed):
 * the D8 optional account fields (Funding Type / Sending Firm / Account Number /
 * Employer / Rolling Into) key off `mapReportRow`'s `record[field] !== undefined`
 * "explicit column present" test. In the CSV path "present" is per-FILE — a
 * header either exists (present for EVERY row) or not — so all rows agree. Here
 * "present" is per-ROW: the key exists only when THAT row's object carries it.
 * If n8n ever OMITS empty-cell keys (some CSV/JSON steps do), one row with an
 * empty account cell would fall back to the deal-name parse while a sibling row
 * with the cell populated overrides it — inconsistent WITHIN one feed. Blast
 * radius is confined to those optional account fields; `stage` and `sf_deal_id`
 * (and all required fields) are unaffected. This is harmless UNLESS the CRM
 * report actually carries the D8 columns AND n8n drops empty keys; if that
 * combination ships, normalize here (seed every FieldKey to "") or upstream.
 */
export function reportRecordFromObject(
  row: Record<string, unknown>,
): ReportRecord {
  const keys = Object.keys(row);
  const indexOfField = resolveFieldColumns(keys);
  const record: ReportRecord = {};
  for (const [key, idx] of indexOfField) {
    const value = row[keys[idx]];
    record[key] = value == null ? "" : String(value);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Value coercions (TDD §3 mapping rules).
// ---------------------------------------------------------------------------

function str(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v === "" ? null : v;
}

/** "$1,234.56" → 1234.56; blank → NaN-for-required / null-for-optional. */
export function parseAmount(value: string | undefined): number | null {
  const v = str(value);
  if (v == null) return null;
  const cleaned = v.replace(/[$,\s]/g, "");
  if (cleaned === "" || !/^-?\d*\.?\d+$/.test(cleaned)) return Number.NaN;
  return Number(cleaned);
}

/** Normalize a report date to YYYY-MM-DD ("6/15/2026" Excel form accepted). */
export function normalizeDate(value: string | undefined): string | null {
  const v = str(value);
  if (v == null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const mdY = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdY) {
    const [, m, d, y] = mdY;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return v; // leave as-is: validateDealInput flags it
}

// "AoA - New Stage" DISPLAY labels → enum key (the TKT relabel vocabulary).
// Keyed on the upper-cased label so the lookup is case-insensitive. Only the
// three labels that do NOT already upper-case to their enum key need an entry:
// "Potential" → POTENTIAL and "Lost" → LOST fall through to the enum-key match
// below (as do the pre-relabel labels "Committed"/"Funding"/"Won", which also
// upper-case straight onto their keys — so old and new exports both import).
const STAGE_LABEL_TO_KEY: Record<string, DealStage> = {
  "POTENTIAL-COMMITTED": "COMMITTED",
  "POTENTIAL-IN PROCESS": "FUNDING",
  FUNDED: "WON",
};

/**
 * "AoA - New Stage" cell → DealStage enum (case-insensitive). Accepts BOTH the
 * new display labels (Potential / Potential-Committed / Potential-In Process /
 * Funded / Lost) AND the raw enum keys (POTENTIAL … LOST — what the app's CSV
 * export emits). Unknown values pass through so validateDealInput reports them
 * per-row instead of the mapper throwing mid-file.
 */
export function parseStage(value: string | undefined): DealStage {
  const v = (str(value) ?? "").toUpperCase();
  const labelled = STAGE_LABEL_TO_KEY[v];
  if (labelled) return labelled;
  const match = DEAL_STAGES.find((s) => s === v);
  return (match ?? (v as DealStage)) as DealStage;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  const v = (str(value) ?? "").toLowerCase();
  if (["yes", "y", "true", "1"].includes(v)) return true;
  if (["no", "n", "false", "0"].includes(v)) return false;
  return fallback;
}

/** The report's unassigned marker (or blank) → null owner (ADR-4/TDD §3). */
function parseOwner(value: string | undefined | null): string | null {
  const v = str(value ?? undefined);
  if (v == null || /^unassigned$/i.test(v)) return null;
  return v;
}

// Salesforce hyperlink-formula artifact. The CRM report exports owner
// columns as a half-encoded HYPERLINK() formula:
//   _HL_ENCODED_/<sfid>_HL_<Display Name>_HL__blank_HL_
// Splitting on the `_HL_` delimiter yields the segments; the one that begins
// `ENCODED_/` carries the SF id, and the NEXT segment is the display name.
const HL_DELIM = "_HL_";
const HL_ENCODED_PREFIX = "ENCODED_/";

/**
 * De-encode a Salesforce hyperlink artifact into `{ name, id }`. A value that
 * carries NO `_HL_` marker (a plain name like "Brandy Schaden") passes through
 * UNCHANGED as the name (id null). null/blank → both null. Malformed `_HL_`
 * values with no `ENCODED_/` segment yield `{ name: null, id: null }`.
 */
export function deHyperlink(value: string | undefined | null): {
  name: string | null;
  id: string | null;
} {
  const v = (value ?? "").trim();
  if (v === "") return { name: null, id: null };
  if (!v.includes(HL_DELIM)) return { name: v, id: null };

  const parts = v.split(HL_DELIM);
  const encodedIdx = parts.findIndex((p) => p.startsWith(HL_ENCODED_PREFIX));
  if (encodedIdx === -1) return { name: null, id: null };

  const id = parts[encodedIdx].slice(HL_ENCODED_PREFIX.length).trim();
  const name = (parts[encodedIdx + 1] ?? "").trim();
  return { name: name === "" ? null : name, id: id === "" ? null : id };
}

// ---------------------------------------------------------------------------
// D8 follow-on (deals-export-v2.csv): explicit-column coercions. A bare "-" /
// "—" cell is an export placeholder for empty (the mockup's em-dash idiom).
// ---------------------------------------------------------------------------

/** Like str(), but "-" / "—" placeholder cells also read as empty. */
function strOrDash(value: string | undefined): string | null {
  const v = str(value);
  return v === "-" || v === "—" ? null : v;
}

/**
 * "Funding Type" (+ "Other Details") → account_type, with the D8 Other
 * semantics: Other stores the details text (empty details → the literal
 * "Other"); empty funding type → null; anything else verbatim.
 */
export function mapFundingType(
  fundingType: string | undefined,
  otherDetails: string | undefined,
): string | null {
  const ft = strOrDash(fundingType);
  if (ft == null) return null;
  if (ft.toLowerCase() === FUNDING_TYPE_OTHER.toLowerCase())
    return strOrDash(otherDetails) ?? FUNDING_TYPE_OTHER;
  return ft;
}

/**
 * "Account Number" under the relaxed rule (shared ACCOUNT_NUMBER_RE): valid →
 * kept verbatim; invalid → null with `invalid: true` (a dry-run warning,
 * never a hard failure — the row still imports without an account #).
 */
export function normalizeAccountNumber(value: string | undefined): {
  value: string | null;
  invalid: boolean;
} {
  const v = strOrDash(value);
  if (v == null) return { value: null, invalid: false };
  return ACCOUNT_NUMBER_RE.test(v)
    ? { value: v, invalid: false }
    : { value: null, invalid: true };
}

/**
 * "Rolling Into" → one of ROLLING_INTO_OPTIONS (case-insensitive, canonical
 * casing kept); anything else → null with `invalid: true` (dry-run warning).
 */
export function parseRollingInto(value: string | undefined): {
  value: string | null;
  invalid: boolean;
} {
  const v = strOrDash(value);
  if (v == null) return { value: null, invalid: false };
  const canonical = (ROLLING_INTO_OPTIONS as readonly string[]).find(
    (o) => o.toLowerCase() === v.toLowerCase(),
  );
  return canonical
    ? { value: canonical, invalid: false }
    : { value: null, invalid: true };
}

// ---------------------------------------------------------------------------
// Review CSV (parse-and-review step — TDD §7 step 1). The file DOES carry
// names (it exists for human review) and therefore always lands BESIDE the
// source file, outside the repo (`reviewPathFor`). The importer treats a
// reviewed row's three account fields as authoritative.
// ---------------------------------------------------------------------------

export const REVIEW_HEADERS = [
  "Deal: ID",
  "Deal: Deal Name",
  "parsed_client_name",
  "transferring_firm",
  "account_type",
  "account_last4",
  "confidence",
  "status_prefix",
  "validation_errors",
] as const;

export type ReviewRow = {
  sf_deal_id: string | null;
  transferring_firm: string | null;
  account_type: string | null;
  account_last4: string | null;
};

/** `<dir>/<export>.csv` → `<dir>/<export>.account-fields.review.csv` — always beside the source. */
export function reviewPathFor(sourcePath: string): string {
  return sourcePath.replace(/\.csv$/i, "") + ".account-fields.review.csv";
}

export function buildReviewCsv(
  rows: readonly {
    record: ReportRecord;
    parsed: ParsedDealName;
    errors: readonly DealValidationError[];
  }[],
): string {
  const out: string[][] = [Array.from(REVIEW_HEADERS)];
  for (const { record, parsed, errors } of rows) {
    out.push([
      record.sfDealId ?? "",
      record.name ?? "",
      parsed.client_name ?? "",
      parsed.transferring_firm ?? "",
      parsed.account_type ?? "",
      parsed.account_last4 ?? "",
      parsed.confidence,
      parsed.status_prefix ?? "",
      errors.map((e) => `${e.field}: ${e.message}`).join(" | "),
    ]);
  }
  return toCsv(out);
}

/** Read a (human-corrected) review CSV back, keyed on `Deal: ID`. */
export function readReviewCsv(text: string): Map<string, ReviewRow> {
  const rows = parseCsv(text);
  const map = new Map<string, ReviewRow>();
  if (rows.length === 0) return map;
  const header = rows[0].map(normalizeHeader);
  const col = (name: string) => header.indexOf(normalizeHeader(name));
  const idIdx = col("Deal: ID");
  const firmIdx = col("transferring_firm");
  const typeIdx = col("account_type");
  const last4Idx = col("account_last4");
  if (idIdx === -1) {
    throw new Error(`Review CSV is missing the "Deal: ID" column.`);
  }
  for (const cells of rows.slice(1)) {
    const id = str(cells[idIdx]);
    if (id == null) continue;
    map.set(id, {
      sf_deal_id: id,
      transferring_firm: firmIdx === -1 ? null : str(cells[firmIdx]),
      account_type: typeIdx === -1 ? null : str(cells[typeIdx]),
      account_last4: last4Idx === -1 ? null : str(cells[last4Idx]),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Row mapping (TDD §3 crosswalk → DealInput; source=IMPORT always).
// ---------------------------------------------------------------------------

export type MappedRow = {
  input: DealInput;
  parsed: ParsedDealName;
  record: ReportRecord;
  /** PII-free per-row notes (field names only) — surfaced in the dry-run report. */
  warnings: string[];
};

export function mapReportRow(
  record: ReportRecord,
  review?: ReviewRow | null,
): MappedRow {
  const parsed = parseDealName(record.name);
  const warnings: string[] = [];

  // A reviewed row is authoritative for the three account fields (including
  // deliberately-blanked cells → null); otherwise the parser's output stands.
  const accountFields = review
    ? {
        transferring_firm: review.transferring_firm,
        account_type: review.account_type,
        account_last4: review.account_last4,
      }
    : {
        transferring_firm: parsed.transferring_firm,
        account_type: parsed.account_type,
        account_last4: parsed.account_last4,
      };

  // D8 follow-on: the v2 export's explicit columns win over BOTH the
  // deal-name parse and the review CSV — per column, only when the column is
  // actually present (old-format CSVs behave exactly as before).
  if (record.fundingType !== undefined) {
    accountFields.account_type = mapFundingType(
      record.fundingType,
      record.otherDetails,
    );
  }
  if (record.sendingFirm !== undefined) {
    accountFields.transferring_firm = strOrDash(record.sendingFirm);
  }
  if (record.accountNumber !== undefined) {
    const acct = normalizeAccountNumber(record.accountNumber);
    accountFields.account_last4 = acct.value;
    if (acct.invalid) warnings.push("account_number: invalid format — dropped");
  }
  // employer / rolling_into exist only in the v2 format; the keys are set
  // only when their columns exist so old-format mapping output is unchanged.
  const companionFields: Pick<DealInput, "employer" | "rolling_into"> = {};
  if (record.employer !== undefined) {
    companionFields.employer = strOrDash(record.employer);
  }
  if (record.rollingInto !== undefined) {
    const rolling = parseRollingInto(record.rollingInto);
    companionFields.rolling_into = rolling.value;
    if (rolling.invalid)
      warnings.push("rolling_into: unrecognized value — dropped");
  }

  // Owner columns arrive as Salesforce hyperlink artifacts in the CRM
  // report; de-encode to the plain display name (plain-text cells no-op). The
  // explicit "Owner SF User ID" column stays authoritative for the id; when it
  // is absent we fall back to the id embedded in the owner hyperlink.
  const ownerLink = deHyperlink(record.ownerName);
  const secondaryLink = deHyperlink(record.secondaryOwner);

  const amount = parseAmount(record.amount);
  const input: DealInput = {
    source: "IMPORT",
    sf_deal_id: str(record.sfDealId),
    name: str(record.name) ?? "",
    client_first_name: str(record.firstName) ?? "",
    client_last_name: str(record.lastName) ?? "",
    household_name: str(record.householdName),
    household_sf_id: str(record.householdSfId),
    // 18-char SF Contact id, stored as-is (mirror.client.sf_id is also 18-char
    // — a direct match, no width slicing like the household 15/18 case).
    client_sf_id: str(record.clientSfId),
    amount: amount ?? Number.NaN, // required — blank fails validation
    stage: parseStage(record.stage),
    stage_raw: str(record.stageRaw),
    created_date: normalizeDate(record.createdDate) ?? "",
    close_date: normalizeDate(record.closeDate),
    last_activity_date: normalizeDate(record.lastActivityDate),
    owner_name: parseOwner(ownerLink.name),
    owner_sf_user_id: str(record.ownerSfUserId) ?? ownerLink.id,
    secondary_owner: str(secondaryLink.name ?? undefined),
    person_aum: parseAmount(record.personAum),
    potential_aum: parseAmount(record.potentialAum),
    cedar_ridge_user_id: str(record.cedarRidgeUserId),
    statements: parseBool(record.statements, true),
    plaid_linked: parseBool(record.plaidLinked, false),
    ...accountFields,
    ...companionFields,
  };
  return { input, parsed, record, warnings };
}

/**
 * DealInput → Prisma `app.deal` row data (upsert create+update payload).
 * Re-declared here (the seed's `toDealData` idiom) because prisma/seed.ts is
 * frozen. Plain object — no Prisma import, so tests stay client-free.
 */
export function dealInputToDbData(input: DealInput) {
  return {
    source: input.source,
    sf_deal_id: input.sf_deal_id ?? null,
    name: input.name,
    client_first_name: input.client_first_name,
    client_last_name: input.client_last_name,
    household_name: input.household_name ?? null,
    household_sf_id: input.household_sf_id ?? null,
    client_sf_id: input.client_sf_id ?? null,
    amount: input.amount,
    stage: input.stage,
    stage_raw: input.stage_raw ?? null,
    created_date: new Date(input.created_date),
    close_date: input.close_date ? new Date(input.close_date) : null,
    last_activity_date: input.last_activity_date
      ? new Date(input.last_activity_date)
      : null,
    owner_name: input.owner_name ?? null,
    owner_sf_user_id: input.owner_sf_user_id ?? null,
    secondary_owner: input.secondary_owner ?? null,
    person_aum: input.person_aum ?? null,
    potential_aum: input.potential_aum ?? null,
    cedar_ridge_user_id: input.cedar_ridge_user_id ?? null,
    statements: input.statements ?? true,
    plaid_linked: input.plaid_linked ?? false,
    account_last4: input.account_last4 ?? null,
    account_type: input.account_type ?? null,
    transferring_firm: input.transferring_firm ?? null,
    // D8 follow-on: the v2 companions ride the upsert (create AND update —
    // explicit columns are authoritative on import) ONLY when the mapper set
    // them, so an old-format re-import never nulls values it doesn't carry.
    // NEVER in this payload: stage_history / lost_from / archived_* — the
    // import writes no timeline, no win/loss provenance, no archive state
    // (runbook posture).
    ...(input.employer !== undefined ? { employer: input.employer } : {}),
    ...(input.rolling_into !== undefined
      ? { rolling_into: input.rolling_into }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Reconciliation report (TDD §7 step 2) — COUNTS + SF IDS ONLY. Never a name,
// household, or amount: this string goes to stdout (and Cloud Run logs on the
// prod run — epic checklist item 5).
// ---------------------------------------------------------------------------

export type Reconciliation = {
  total: number;
  byStage: Record<DealStage, number>;
  invalidStage: number;
  validationFailures: {
    rowNumber: number; // 1-based data-row number (header excluded)
    sfDealId: string | null;
    fields: string[];
  }[];
  unparsedNameSfIds: (string | null)[]; // parser confidence "none"
  nullOwner: number;
  nullCedarRidgeUserId: number;
  // D8 follow-on: how many rows landed a non-null value per explicit field —
  // the fill picture the operator sanity-checks against the source export.
  fieldFill: {
    fundingType: number;
    employer: number;
    rollingInto: number;
    accountNumber: number;
    transferringFirm: number;
  };
  // Per-row soft warnings (field names only — no PII): values the mapper
  // dropped (invalid account # format / unrecognized rolling-into). Warnings
  // never block a run; they exist for the dry-run review.
  rowWarnings: {
    rowNumber: number;
    sfDealId: string | null;
    warnings: string[];
  }[];
};

export function buildReconciliation(
  rows: readonly (MappedRow & { errors: readonly DealValidationError[] })[],
): Reconciliation {
  const byStage = Object.fromEntries(DEAL_STAGES.map((s) => [s, 0])) as Record<
    DealStage,
    number
  >;
  let invalidStage = 0;
  const validationFailures: Reconciliation["validationFailures"] = [];
  const unparsedNameSfIds: (string | null)[] = [];
  let nullOwner = 0;
  let nullCedarRidgeUserId = 0;
  const fieldFill: Reconciliation["fieldFill"] = {
    fundingType: 0,
    employer: 0,
    rollingInto: 0,
    accountNumber: 0,
    transferringFirm: 0,
  };
  const rowWarnings: Reconciliation["rowWarnings"] = [];

  rows.forEach((row, i) => {
    const { input, parsed, errors, warnings } = row;
    if ((DEAL_STAGES as readonly string[]).includes(input.stage)) {
      byStage[input.stage] += 1;
    } else {
      invalidStage += 1;
    }
    if (errors.length > 0) {
      validationFailures.push({
        rowNumber: i + 1,
        sfDealId: input.sf_deal_id ?? null,
        fields: errors.map((e) => e.field),
      });
    }
    if (parsed.confidence === "none") {
      unparsedNameSfIds.push(input.sf_deal_id ?? null);
    }
    if (input.owner_name == null) nullOwner += 1;
    if (input.cedar_ridge_user_id == null) nullCedarRidgeUserId += 1;
    if (input.account_type != null) fieldFill.fundingType += 1;
    if (input.employer != null) fieldFill.employer += 1;
    if (input.rolling_into != null) fieldFill.rollingInto += 1;
    if (input.account_last4 != null) fieldFill.accountNumber += 1;
    if (input.transferring_firm != null) fieldFill.transferringFirm += 1;
    if (warnings.length > 0) {
      rowWarnings.push({
        rowNumber: i + 1,
        sfDealId: input.sf_deal_id ?? null,
        warnings: [...warnings],
      });
    }
  });

  return {
    total: rows.length,
    byStage,
    invalidStage,
    validationFailures,
    unparsedNameSfIds,
    nullOwner,
    nullCedarRidgeUserId,
    fieldFill,
    rowWarnings,
  };
}

export function formatReconciliation(r: Reconciliation): string {
  const lines: string[] = [];
  lines.push(`Reconciliation report (counts + SF ids only — no PII)`);
  lines.push(`  Total rows:                 ${r.total}`);
  lines.push(
    `  By stage:                   ` +
      DEAL_STAGES.map((s) => `${s} ${r.byStage[s]}`).join(" / ") +
      (r.invalidStage > 0 ? ` / INVALID ${r.invalidStage}` : ""),
  );
  lines.push(`  Validation failures:        ${r.validationFailures.length}`);
  for (const f of r.validationFailures) {
    lines.push(
      `    - row ${f.rowNumber} [${f.sfDealId ?? "no sf_deal_id"}]: ${f.fields.join(", ")}`,
    );
  }
  lines.push(
    `  Unparsed deal names:        ${r.unparsedNameSfIds.length}` +
      (r.unparsedNameSfIds.length > 0
        ? ` (${r.unparsedNameSfIds.map((id) => id ?? "no sf_deal_id").join(", ")})`
        : ""),
  );
  lines.push(`  Unassigned (null owner):    ${r.nullOwner}`);
  lines.push(`  Null cedar_ridge_user_id:     ${r.nullCedarRidgeUserId}`);
  lines.push(
    `  Field fill (non-null):      funding type ${r.fieldFill.fundingType}` +
      ` / employer ${r.fieldFill.employer}` +
      ` / rolling into ${r.fieldFill.rollingInto}` +
      ` / account # ${r.fieldFill.accountNumber}` +
      ` / firm ${r.fieldFill.transferringFirm}`,
  );
  lines.push(`  Row warnings (soft):        ${r.rowWarnings.length}`);
  for (const w of r.rowWarnings) {
    lines.push(
      `    - row ${w.rowNumber} [${w.sfDealId ?? "no sf_deal_id"}]: ${w.warnings.join("; ")}`,
    );
  }
  return lines.join("\n");
}
