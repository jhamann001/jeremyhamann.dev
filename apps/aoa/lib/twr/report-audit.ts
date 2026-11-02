import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { withUserScope, type Identity } from "@/lib/rls";
import {
  PERFORMANCE_REPORT_GENERATE_ACCOUNT,
  PERFORMANCE_REPORT_GENERATE_HOUSEHOLD,
  writeAudit,
} from "@/lib/audit";

// Performance-report access-attempt recording (compliance review 2026-07-28).
//
// The two /performance pages are the firm's only client-performance surfaces and
// nothing recorded that one had been produced: no writeAudit call anywhere under
// app/(authenticated)/performance/** or lib/twr/**, and the DB-trigger auto-audit
// (audit.row_change) only covers app.deal / app.transfer, which a report never
// touches. An examiner asking "who attempted which client's report, and when" had no
// answer. This module is that answer for AUTHORIZED ATTEMPTS. It does not claim
// that rendering completed or that the output was delivered. Each attempt gets
// an opaque report id that is also printed on any output that does render.
//
// WHY A SEPARATE withUserScope. Every other audited action writes inside the SAME
// transaction as its row write (lib/audit.ts header) — a report writes no row, so
// there is no host transaction to join. It runs under the caller's OWN identity
// (app_rw + the RLS GUCs), NOT the machine ingest role: the actor is the human
// who opened the page.
//
// FAIL CLOSED, DELIBERATELY. Nothing here is caught. The write is issued BEFORE
// the custodial fetch, so if it fails the report is never assembled and no client
// data is disclosed — an unrecorded access cannot happen. This adds no new
// fragility class: both pages already require a successful Postgres read
// (apexAccountByNumber / householdHeader) to get this far, so the DB is a hard
// dependency of the page either way. Contrast the cron feed-health writer
// (app/api/cron/health/aum-freshness), which catches, because there an audit
// failure must not mask a stale-feed verdict.
//
// NO PII. Detail is ids + enums + the masked last-4 only, the ASSET_MAP_* /
// MEETING_PREP_* idiom. Never the full Apex account number, never a client or
// household NAME.

/**
 * True when this render is a Next.js router PREFETCH rather than a human opening
 * the page. Next sets `Next-Router-Prefetch: 1` on prefetch RSC requests.
 *
 * Today no prefetch reaches these routes at all: every entry point navigates
 * imperatively with `router.push` (components/client-portrait/AccountsSection,
 * components/households/HouseholdReportButton, components/households/HouseholdsTable)
 * and there is no `<Link>` to /performance/**, so nothing warms them. This guard
 * exists so that converting one of those buttons to a `<Link>` — whose default
 * prefetch fires on hover/viewport — cannot silently start logging report
 * generations nobody performed.
 */
export async function isRouterPrefetch(): Promise<boolean> {
  // Header lookup is case-insensitive.
  return (await headers()).get("next-router-prefetch") === "1";
}

/** Last 4 of an Apex account number — the masked form the audit trail already
 *  uses for a custodial account (TRANSFER_ASSET_MAP_LINK). Never the full
 *  number. */
export function accountLast4(apexAccountNumber: string | null | undefined): string | null {
  if (!apexAccountNumber) return null;
  return apexAccountNumber.slice(-4);
}

/** Opaque, generation-specific id shared by the audit attempt and report output. */
export function newPerformanceReportId(): string {
  return `aoa-pr-${randomUUID()}`;
}

/**
 * Record an authorized attempt to generate an ACCOUNT-level performance report.
 *
 * entityId is `custodian_account_id` — the mirror.client_account_aum PK (the Apex
 * ULID): a durable, opaque row key, which is what every entityId in this trail is
 * (a transfer id, a deal id, a meeting_prep cuid, an asset-map folder id). It is
 * deliberately NOT the Apex account number, which the trail treats as sensitive
 * and never stores (see ASSET_MAP_ACCOUNT_CONFIRM: "the DURABLE folder id — NEVER
 * the account number").
 *
 * MUST be called only after BOTH authz gates pass (canOpenReport + the RLS-scoped
 * apexAccountByNumber read). A refused request must leave no row implying access.
 */
export async function recordAccountReportGenerated(
  identity: Identity,
  account: {
    custodianAccountId: string;
    apexAccountNumber: string | null;
    accountType: string | null;
    clientSfId: string | null;
  },
): Promise<string> {
  const reportId = newPerformanceReportId();
  if (await isRouterPrefetch()) return reportId;
  await withUserScope(identity, (tx) =>
    writeAudit(tx, identity, {
      action: PERFORMANCE_REPORT_GENERATE_ACCOUNT,
      entityType: "performance_report",
      entityId: account.custodianAccountId,
      detail: {
        reportId,
        phase: "authorized_attempt",
        clientSfId: account.clientSfId,
        accountLast4: accountLast4(account.apexAccountNumber),
        accountType: account.accountType,
      },
    }),
  );
  return reportId;
}

/**
 * Record an authorized attempt to generate a HOUSEHOLD-level performance report.
 *
 * entityId is the household `sf_id` — the same Salesforce household key the trail
 * already carries as `householdSfId` (ASSET_MAP_LINK_CONFIRM,
 * ASSET_MAP_ACCOUNT_CONFIRM). `reportableAccounts` is the count of member accounts
 * with an Apex number, i.e. the breadth of the report — a count, never a number.
 *
 * MUST be called only after BOTH authz gates pass (canOpenReport + the RLS-scoped
 * householdHeader read).
 */
export async function recordHouseholdReportGenerated(
  identity: Identity,
  household: { householdSfId: string; reportableAccounts: number },
): Promise<string> {
  const reportId = newPerformanceReportId();
  if (await isRouterPrefetch()) return reportId;
  await withUserScope(identity, (tx) =>
    writeAudit(tx, identity, {
      action: PERFORMANCE_REPORT_GENERATE_HOUSEHOLD,
      entityType: "performance_report",
      entityId: household.householdSfId,
      detail: {
        reportId,
        phase: "authorized_attempt",
        householdSfId: household.householdSfId,
        reportableAccounts: household.reportableAccounts,
      },
    }),
  );
  return reportId;
}
