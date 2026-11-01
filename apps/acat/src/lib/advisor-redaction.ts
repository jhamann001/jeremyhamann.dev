// ticket: Advisor-facing redaction for the /advisor self-service view.
//
// Advisors get a narrow, read-only window into client transfers — enough
// to answer "where is my client's transfer?" without exposing PII, ops
// scratch notes, or anything an ops user needs to actually move money
// (account numbers, control numbers, fee details, audit trail, etc.).
//
// The single source of truth is `redactForAdvisor()` below. The matching
// API route (`GET /api/advisor/acats`) runs every record through this
// function before serializing the response, so the wire payload never
// contains anything not on the whitelist — even if a future change adds
// fields to AcatRecord, the advisor view stays safe by default.

import type { AcatStatus } from "./types";

/**
 * The exact shape an advisor sees. Every field here is either:
 *  - non-sensitive transfer status (client name, contra, dates), OR
 *  - a derived signal advisors need to triage ("when should this finish?").
 *
 * Anything NOT in this type must not be in the API response. Adding a
 * field is a deliberate disclosure decision; the test suite verifies the
 * narrowing has no leaks.
 */
export interface AdvisorAcatRecord {
  id: string;
  clientName: string;
  status: AcatStatus;
  direction: string | null;
  type: string | null;
  accountType: string | null;
  transferringContra: string | null;
  wealthAdvisor: string | null;

  // Free-text "additional resources" field, by convention a CRM
  // task URL maintained by ops. Whitelisted because it's the advisor's
  // jump-off point to the linked ticket; it never carries account
  // numbers or PII (those are stripped fields above).
  additionalResources: string | null;

  // Dates surface "how long has this taken / when will it finish".
  // We expose the client-facing anchors plus opsSubmissionDateToApex —
  // the latter looks internal but is just "ops kicked this off on day
  // X", which the advisor already needs to triage timing.
  originalClientRequestDate: string | null;
  opsSubmissionDateToApex: string | null;
  apexCompletionDate: string | null;
  acatDate: string;

  // Aggregate signal (integer cents) — not asset-level positions.
  statementAmount: number | null;

  // Custodian SLA only — name + processing days are non-sensitive and
  // power the aging tier color in the advisor view. fees + contactEmail
  // are NOT included. May be null on records with no linked custodian
  // or when the API route chose not to eager-load it.
  custodian: AdvisorCustodian | null;
}

export interface AdvisorCustodian {
  id: string;
  name: string;
  avgProcessingDays: number;
}

/**
 * Structural input type for the redactor.
 *
 * Intentionally NOT typed as `AcatRecord` — that would couple this
 * module to whether the wider TS model declares an optional
 * `custodian?` relation, which differs across branches/phases of the
 * project. Accepting a structural shape lets the API route pass the
 * raw Prisma `findMany({ include: { custodian: true } })` result
 * directly, and the redactor only sees the keys it cares about.
 *
 * Anything missing is treated as "not visible" (the safe default).
 */
export interface RedactionInput {
  id: string;
  clientName: string;
  status: AcatStatus;
  direction?: string | null;
  type?: string | null;
  accountType?: string | null;
  transferringContra?: string | null;
  wealthAdvisor?: string | null;
  additionalResources?: string | null;
  originalClientRequestDate?: string | null;
  opsSubmissionDateToApex?: string | null;
  apexCompletionDate?: string | null;
  acatDate: string;
  statementAmount?: number | null;
  custodian?: CustodianInput | null;
}

export interface CustodianInput {
  id: string;
  name: string;
  avgProcessingDays?: number | null;
  // The redactor will ignore any other fields the caller hands in —
  // fees, contactEmail, acatFeeAmount, etc.
  [extra: string]: unknown;
}

/**
 * Strip every sensitive field from a raw record and return the narrow
 * advisor-safe shape. This is the only sanctioned way to turn a full
 * record into something an advisor can see.
 *
 * Server-side use only: the function is pure and synchronous, but the
 * point is to enforce that the API route — not the client — decides
 * what's visible. Proxy separately blocks ADVISOR sessions
 * from reaching `/api/acats`, so even a buggy frontend can't pull the
 * full record.
 */
export function redactForAdvisor(record: RedactionInput): AdvisorAcatRecord {
  return {
    id: record.id,
    clientName: record.clientName,
    status: record.status,
    direction: nullableString(record.direction),
    type: nullableString(record.type),
    accountType: nullableString(record.accountType),
    transferringContra: nullableString(record.transferringContra),
    wealthAdvisor: nullableString(record.wealthAdvisor),
    additionalResources: nullableString(record.additionalResources),
    originalClientRequestDate: nullableString(record.originalClientRequestDate),
    opsSubmissionDateToApex: nullableString(record.opsSubmissionDateToApex),
    apexCompletionDate: nullableString(record.apexCompletionDate),
    acatDate: record.acatDate,
    statementAmount:
      typeof record.statementAmount === "number"
        ? record.statementAmount
        : null,
    custodian: redactCustodian(record.custodian),
  };
}

function redactCustodian(c: CustodianInput | null | undefined): AdvisorCustodian | null {
  if (!c) return null;
  const days = typeof c.avgProcessingDays === "number" ? c.avgProcessingDays : null;
  // Without a usable SLA the custodian object is informationless —
  // skip it rather than expose a half-empty object the client would
  // need a null-check for.
  if (days == null) return null;
  return {
    id: c.id,
    name: c.name,
    avgProcessingDays: days,
  };
}

function nullableString(v: string | null | undefined): string | null {
  if (v == null || v === "") return null;
  return v;
}

/**
 * Whitelist of keys an advisor is allowed to see — used by both the
 * runtime redactor and the test that guards against accidental leaks
 * when AcatRecord grows new fields.
 */
export const ADVISOR_VISIBLE_KEYS: ReadonlySet<keyof AdvisorAcatRecord> =
  new Set([
    "id",
    "clientName",
    "status",
    "direction",
    "type",
    "accountType",
    "transferringContra",
    "wealthAdvisor",
    "additionalResources",
    "originalClientRequestDate",
    "opsSubmissionDateToApex",
    "apexCompletionDate",
    "acatDate",
    "statementAmount",
    "custodian",
  ]);
