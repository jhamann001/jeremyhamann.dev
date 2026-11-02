import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import { withIngestScope } from "@/lib/ingest/scope";

// DB-enforced auto-audit (ADR-5): prove the `audit.log_row_change()` trigger
// writes the field-level trail for real writes to app.* business tables, with
// actor attribution read from the RLS GUCs.
//
// Gated like the other integration suites so `npm test` stays green with no DB:
// set AUDIT_TEST_DB_URL to opt in. withUserScope talks to the GLOBAL app_rw
// prisma client (lib/db.ts -> DATABASE_URL) and the feed case talks to the
// ingest_rw client (lib/ingest/db.ts -> INGEST_DATABASE_URL), so also point
// DATABASE_URL (and, for the feed case, INGEST_DATABASE_URL) at the DB when
// running this. A SEPARATE superuser/BYPASSRLS client seeds and tears down the
// fixtures (app_rw/ingest_rw have no DELETE on app.deal or the append-only audit
// table) and exercises the owner-only DELETE path. Locally:
//   AUDIT_TEST_DB_URL=1 \
//     DATABASE_URL=postgresql://app_rw@localhost:5432/aoa \
//     INGEST_DATABASE_URL=postgresql://ingest_rw@localhost:5432/aoa \
//     npx vitest run test/audit/row-change.integration.test.ts
//
// All ids are synthetic and namespaced (TEST-AUDIT-*) so cleanup is exact and a
// partial run leaves nothing stray.

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
// The feed/null-actor case additionally needs the ingest_rw connection.
const feedIt = process.env.INGEST_DATABASE_URL ? it : it.skip;

const DEAL_ID = "TEST-AUDIT-DEAL-1";
const ACTOR = "test@example.com";

// Superuser/BYPASSRLS client for setup + teardown (reads/writes past FORCE RLS,
// and can DELETE where app_rw/ingest_rw cannot). Prefer AUDIT_TEST_CLEANUP_URL;
// else a peer-auth superuser on the local aoa stack (mirrors test/ingest/db-
// fixture).
function makeCleanupClient(): PrismaClient {
  const url =
    process.env.AUDIT_TEST_CLEANUP_URL ??
    `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa`;
  return new PrismaClient({ datasources: { db: { url } } });
}

async function cleanup(db: PrismaClient): Promise<void> {
  // Delete the business row first because that DELETE itself is audited. Then
  // remove every audit fixture row, including the teardown DELETE entry.
  await db.$executeRaw`DELETE FROM app.deal WHERE id LIKE 'TEST-AUDIT-%'`;
  await db.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE 'TEST-AUDIT-%'`;
}

async function seedDeal(db: PrismaClient): Promise<void> {
  // Superuser bypasses RLS. The INSERT fires the trigger too (op='INSERT').
  await db.deal.create({
    data: {
      id: DEAL_ID,
      source: "APP",
      name: "Audit Fixture Deal",
      client_first_name: "Ada",
      client_last_name: "Chen",
      amount: "1000.00",
      stage: "POTENTIAL",
      created_date: new Date("2026-07-01"),
    },
  });
}

gated("audit.row_change trigger (AUDIT_TEST_DB_URL) — real app.deal writes", () => {
  let su: PrismaClient;

  beforeAll(() => {
    su = makeCleanupClient();
  });
  afterAll(async () => {
    await cleanup(su);
    await su.$disconnect();
  });
  beforeEach(async () => {
    await cleanup(su);
    await seedDeal(su);
  });

  it("INSERT → op='INSERT' with the full row snapshot in `changed`", async () => {
    // The seed INSERT (beforeEach) already fired the trigger.
    const rows = await su.rowChange.findMany({
      where: { row_pk: DEAL_ID, op: "INSERT" },
    });
    expect(rows).toHaveLength(1);
    const changed = rows[0].changed as Record<string, unknown>;
    // Full snapshot: contains the id plus known columns (NOT a {from,to} diff).
    expect(changed.id).toBe(DEAL_ID);
    expect(changed.name).toBe("Audit Fixture Deal");
    expect(changed.stage).toBe("POTENTIAL");
    expect(rows[0].table_name).toBe("deal");
    expect(rows[0].schema_name).toBe("app");
  });

  it("UPDATE → op='UPDATE' with the stage diff + actor from the RLS GUCs", async () => {
    // Real UPDATE through the app path: withUserScope sets app.user_role /
    // app.user_email, and the trigger reads them for actor attribution.
    await withUserScope({ role: "OPERATIONS", email: ACTOR }, (tx) =>
      tx.deal.update({ where: { id: DEAL_ID }, data: { stage: "COMMITTED" } }),
    );

    const rows = await su.rowChange.findMany({
      where: { row_pk: DEAL_ID, op: "UPDATE" },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.table_name).toBe("deal");
    expect(r.schema_name).toBe("app");
    expect(r.actor_email).toBe(ACTOR);
    expect(r.actor_role).toBe("OPERATIONS");

    // updated_at is excluded from the diff; only the stage change is recorded.
    const changed = r.changed as Record<string, { from: unknown; to: unknown }>;
    expect(Object.keys(changed)).toEqual(["stage"]);
    expect(changed.stage).toEqual({ from: "POTENTIAL", to: "COMMITTED" });
  });

  it("DELETE → op='DELETE' with the OLD row snapshot", async () => {
    // app.deal DELETE is revoked for app_rw AND ingest_rw (deals are hard-
    // undeletable for the runtime — restage to LOST). The only role that can
    // DELETE is the owner/superuser, so we exercise the trigger's DELETE path
    // via the superuser client (the same client the harness uses for teardown).
    await su.$executeRaw`DELETE FROM app.deal WHERE id = ${DEAL_ID}`;

    const rows = await su.rowChange.findMany({
      where: { row_pk: DEAL_ID, op: "DELETE" },
    });
    expect(rows).toHaveLength(1);
    const changed = rows[0].changed as Record<string, unknown>;
    // Full OLD snapshot of the deleted row.
    expect(changed.id).toBe(DEAL_ID);
    expect(changed.stage).toBe("POTENTIAL");
    expect(rows[0].table_name).toBe("deal");
  });

  it("updated_at-only change → NO row_change row (RETURN NULL skip path)", async () => {
    // A write whose ONLY difference is the housekeeping column updated_at must
    // be skipped by the trigger (the noise-suppression RETURN NULL branch).
    await su.$executeRaw`
      UPDATE app.deal
         SET updated_at = updated_at + interval '1 second'
       WHERE id = ${DEAL_ID}`;

    const updates = await su.rowChange.findMany({
      where: { row_pk: DEAL_ID, op: "UPDATE" },
    });
    expect(updates).toHaveLength(0);
  });

  feedIt(
    "feed write (ingest_rw, no GUCs) → actor_email/actor_role NULL, db_role='ingest_rw'",
    async () => {
      // withIngestScope sets NO app.user_* GUCs (GUC-less by design). A feed
      // update must still be audited, with a NULL actor and db_role identifying
      // the ingest role — the fail-closed-safe attribution path.
      await withIngestScope((tx) =>
        tx.deal.update({ where: { id: DEAL_ID }, data: { stage: "FUNDING" } }),
      );

      const rows = await su.rowChange.findMany({
        where: { row_pk: DEAL_ID, op: "UPDATE" },
      });
      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r.actor_email).toBeNull();
      expect(r.actor_role).toBeNull();
      expect(r.db_role).toBe("ingest_rw");
      const changed = r.changed as Record<string, { from: unknown; to: unknown }>;
      expect(changed.stage).toEqual({ from: "POTENTIAL", to: "FUNDING" });
    },
  );
});

// FUTURE-TABLE GUARDRAIL: the "can't be forgotten" guarantee must hold for
// tables added later — a new app.* base table with no audit trigger fails here.
// NOTE: this only enforces when AUDIT_TEST_DB_URL is set. The database CI job
// sets it, making this a blocking guardrail; plain local unit runs still skip.
gated("audit trigger coverage of schema `app` (future-table guardrail)", () => {
  let su: PrismaClient;

  // Tables in schema `app` that INTENTIONALLY have no audit trigger today, with
  // the reason. The reviewed migration triggers only the two business ROOT
  // tables (deal, transfer). A NEW app.* base table not listed here and without
  // a trigger will FAIL the assertion below — forcing a conscious choice: add a
  // `<table>_audit` trigger in a migration, or add it here with justification.
  const KNOWN_UNAUDITED = new Set<string>([
    // Prisma's migration ledger is framework metadata, not application data.
    "_prisma_migrations",
    // Auth.js (NextAuth) adapter tables — framework identity/session infra,
    // written by the adapter, not app business data.
    "User",
    "Account",
    "Session",
    "VerificationToken",
    // transfer children — the auto-audit scope is the business ROOT tables; a
    // child's lifecycle rides with its parent transfer today. If field-level
    // audit is ever needed on a child, add its trigger AND drop it from here.
    "transfer_task",
    "transfer_decision",
    "transfer_account",
    "transfer_position_flag",
    // Asset Transfer workspace intake children (ASSET_TRANSFER_WORKSPACE): each
    // write emits a redacted writeAudit event on the parent transfer.
    "transfer_statement",
    "transfer_account_match",
    // Statement file bytes and client filenames must never be copied into
    // audit.row_change. Uploads and downloads emit a redacted writeAudit event
    // carrying the document id, size and sha256 only.
    "transfer_statement_document",
    // Mailing reason and contents are free text; a row trigger would copy them
    // into audit.row_change. Writes emit a redacted writeAudit event instead.
    "transfer_mailing",
    // Mailing legs carry tracking numbers; writes emit the mailing's redacted
    // writeAudit event instead.
    "transfer_mailing_leg",
    // Paperwork record children (ATW-04): each insert emits a writeAudit event
    // with ids and the table name; form titles stay out of audit.row_change.
    "transfer_form_review",
    "transfer_sent_packet",
    "transfer_returned_signature",
    "transfer_app_authorization",
    "transfer_drs_service_request",
    "transfer_mailed_paperwork",
    // Submission, tracking and receipt children (ATW-06): control numbers and
    // receipt notes stay out of audit.row_change; writes emit writeAudit events.
    "transfer_submission",
    "transfer_tracking_update",
    "transfer_receipt",
    "transfer_receipt_line",
    // Check ticket and ACH initiation children (ATW-07): each insert emits a
    // writeAudit event on the parent transfer.
    "transfer_check_ticket",
    "transfer_ach_initiation",
    // Follow-up children (ATW-09): rejection responses and owners are free
    // text; writes emit writeAudit events with ids and the record kind only.
    "transfer_fee_reimbursement",
    "transfer_investment_link",
    "transfer_residual",
    "transfer_acat_rejection",
    // Outcome, correction and stage-change history (ATW-10): the tables are
    // themselves the movement history; writes emit writeAudit events with ids
    // and the record kind only, and stage moves keep their stage-change audit.
    "transfer_outcome",
    "transfer_correction",
    "transfer_stage_change",
    // Immutable approval versions carry a source snapshot + optional note.
    // Their redacted explicit audit event rides the parent transfer; a generic
    // trigger would duplicate position-level financial context into row_change.
    "transfer_funding_plan_approval",
    // Funding corrections keep the required reason and prior task snapshot in
    // restricted append-only history. Their controlled business audit event is
    // written atomically with the parent transfer; a generic row trigger would
    // duplicate private narrative/workflow context into audit.row_change.
    // transfer-funding-method-change.integration.test.ts pins RLS, immutability,
    // attribution, redaction and rollback when the business audit write fails.
    "transfer_funding_method_correction",
    // Unified Decision Center: questions, resolution narratives, and task
    // titles stay in FORCE-RLS tables. Redacted writeAudit events plus the
    // append-only decision_case_event table provide the review trail.
    "decision_case",
    "decision_task",
    "decision_case_event",
    // Slack closeout children — same story: ride the parent transfer; the
    // COMPLETE flip writes an explicit writeAudit(TRANSFER_SLACK_CLOSEOUT).
    "transfer_slack_closeout",
    "transfer_slack_item",
    // AI meeting prep (AI_MEETING_PREP) — DELIBERATELY not auto-audited.
    // audit.log_row_change() records the FULL NEW row snapshot on INSERT (and
    // the changed columns on UPDATE) with NO column redaction, so a trigger here
    // would copy the entire generated brief — the densest client PII in the app
    // — into audit.row_change on every generate, and again on every regenerate.
    // The trail is the explicit writeAudit(MEETING_PREP_GENERATE) instead, whose
    // detail is ids + enums + counts only and whose entityId is the row cuid
    // (never the appointment_key, which embeds the client name).
    "meeting_prep",
    // Central review queue: review_queue_event is the append-only workflow
    // trail, and human item changes also write a redacted business audit row.
    // The generic trigger is intentionally excluded from both tables because
    // review_queue_item.resolution_note is user-entered and may contain client
    // context; copying it into audit.row_change would violate data minimization.
    "review_queue_item",
    "review_queue_event",
    // ACAT reconciliation is its own evidence/review ledger. Prepared source
    // proof is immutable; review events are append-only and every human review,
    // link application/undo and preparation writes a redacted business audit in
    // the same transaction. Full-row auditing would duplicate source identity
    // proof and free-text review notes into a broader audit surface. Real RLS,
    // immutability, attribution and audit-failure rollback are pinned by
    // test/data/acat-reconciliation.integration.test.ts and the writer suite.
    "acat_link_run",
    "acat_link_decision",
    "acat_link_review_event",
    // PII-free singleton operational checkpoint. It stores only bounded opaque
    // cursors, completion bits, lease metadata, and sweep freshness. The
    // cursors must not be copied into the generic audit snapshot; operational
    // provenance is represented by the checkpoint timestamps/failure source.
    "review_queue_sweep_state",
    // CRM source mappings contain external source keys, including possible
    // account identifiers. The generic trigger would copy those values into
    // audit.row_change, so Phase 1 uses the dedicated, redacting
    // audit.log_crm_source_mapping_change trigger instead. Its presence and
    // redaction behavior are pinned by crm-identity-schema tests.
    "crm_source_mapping",
    // Employee roster snapshots contain HR identifiers/names and match rows
    // connect them to CRM contacts. Generic snapshots would duplicate that PII
    // into audit.row_change. Counts-only employee_roster.* / employee_contact.*
    // business events are written explicitly in the same transactions instead.
    "employee_roster_upload",
    "employee_roster_entry",
    "employee_contact_mapping",
    // Minimal derived badge cache; lifecycle changes ride the same explicit
    // apply/confirm/reject event as the authoritative roster/mapping write.
    "employee_client_status",
    // Duplicate candidates use a dedicated audit trigger that suppresses
    // last_seen_at-only detector refresh noise while retaining every business
    // field change. Candidate events are themselves the append-only workflow
    // trail and cannot be directly inserted by app_rw.
    "crm_duplicate_candidate",
    "crm_duplicate_candidate_event",
    // Schwab decisions use app.audit_schwab_account_mapping to retain every
    // version in the Operations-only, append-only mapping_event table. Generic
    // snapshots would duplicate client/household links into row_change; the
    // business audit is counts-only. The live test below pins this exception.
    "schwab_account_mapping",
    "schwab_account_mapping_event",
    // Close-date overrides contain a full custodian identifier. The generic
    // row trigger would copy that identifier into audit.row_change. Access is
    // instead ingest-only, retirement is linked to an immutable snapshot run,
    // and the account-AUM ingest audit records the retirement count.
    "account_close_date_override",
    // Trade reconciliation stores a redacted but financially sensitive run
    // payload plus operator narrative. Generic row snapshots would duplicate
    // both into audit.row_change. Each insert writes a separate counts-only
    // business audit event, while notes/reviews are themselves append-only.
    "trade_reconciliation_run",
    "trade_reconciliation_review_event",
    "trade_reconciliation_note_event",
    // Fee-request intake contains client/account references, exact requested
    // amounts, ticket references, and human narrative. The generic trigger
    // would duplicate that sensitive payload into audit.row_change. Requests
    // instead write one counts-only business audit event, while their
    // Operations-only event rows are an immutable workflow trail.
    "operations_fee_request",
    "operations_fee_request_event",
    // Delivery metadata only: request/event IDs, status, attempts and Slack
    // receipt. The linked immutable SUBMITTED event records its origin; forced
    // RLS and a transition guard protect updates. No duplicated request payload.
    "operations_slack_notification",
    // Worker-only lease/completion metadata, like review_queue_sweep_state.
    // Generic snapshots would persist the private fencing token and every
    // lease refresh; this is operational coordination, not a business edit.
    "data_job_collector",
    // Worker-only derived five-feed receipt snapshot and private lease token.
    // Forced RLS limits writes; no human edit or alert delivery. Generic row
    // copies would retain private checkpoint state outside its lifecycle.
    // data-arrival-migration.integration.test.ts pins real claim/save isolation.
    "data_arrival_receipt_checkpoint",
    // Private append-only, worker-only dev canary authorization receipts.
    // The receipt itself is durable evidence; generic snapshots would duplicate
    // its authorization ID. No UPDATE/DELETE grants or human mutation surface.
    "data_job_canary_attempt",
    // Immutable sanitized operational notification events; not business rows.
    // Forced-RLS worker writes, exact schema validation and unique incident/
    // phase evidence are tested separately. Generic audit duplicates metadata.
    "data_job_alert_event",
    // Derived monitoring cache, including private provider checkpoints. A
    // full-row trigger would copy checkpoint state into generic audit storage.
    "data_job_snapshot",
    // Sanitized provider execution evidence, repeatedly refreshed and subject
    // to bounded retention. Generic auditing would duplicate every refresh and
    // retain deleted telemetry outside that lifecycle.
    "data_job_run",
    // Worker-derived incidents with disabled delivery, not human decisions.
    // Retention-bounded operational evidence, not an immutable business audit.
    // Revisit redacted auditing before adding human actions or alert delivery.
    // data-jobs.integration.test.ts pins all four tables' forced RLS, ordinary
    // user write denial and absence of full-row audit copies through lifecycle.
    "data_job_incident",
  ]);

  beforeAll(() => {
    su = makeCleanupClient();
  });
  afterAll(async () => {
    await su.$disconnect();
  });

  it("every app.* base table is either audited by audit.log_row_change or explicitly allowlisted", async () => {
    // tgtype bitmask (pg_trigger): ROW=1, BEFORE=2, INSERT=4, DELETE=8,
    // UPDATE=16, INSTEAD=64. We require a ROW-level AFTER trigger bound to
    // audit.log_row_change that fires on all three of INSERT/UPDATE/DELETE.
    const rows = await su.$queryRaw<
      Array<{ table_name: string; has_audit_trigger: boolean }>
    >`
      SELECT c.relname AS table_name,
        EXISTS (
          SELECT 1
          FROM pg_trigger t
          JOIN pg_proc p       ON p.oid = t.tgfoid
          JOIN pg_namespace pn ON pn.oid = p.pronamespace
          WHERE t.tgrelid = c.oid
            AND NOT t.tgisinternal
            AND pn.nspname = 'audit'
            AND p.proname  = 'log_row_change'
            AND (t.tgtype &  2) = 0    -- AFTER (BEFORE bit clear)
            AND (t.tgtype & 64) = 0    -- not INSTEAD OF
            AND (t.tgtype &  1) = 1    -- ROW-level
            AND (t.tgtype &  4) <> 0   -- INSERT
            AND (t.tgtype &  8) <> 0   -- DELETE
            AND (t.tgtype & 16) <> 0   -- UPDATE
        ) AS has_audit_trigger
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app'
        AND c.relkind = 'r'
      ORDER BY c.relname`;

    // Sanity: the migration ran and app tables are visible.
    expect(rows.length).toBeGreaterThan(0);

    // The two business ROOT tables MUST be covered (positive lock).
    for (const name of [
      "deal",
      "transfer",
      "tax_budget",
      "crm_identity",
      "crm_identity_exception",
      "crm_relationship",
    ]) {
      const row = rows.find((r) => r.table_name === name);
      expect(row, `app.${name} missing from catalog`).toBeDefined();
      expect(
        row?.has_audit_trigger,
        `app.${name} must have an AFTER I/U/D trigger on audit.log_row_change`,
      ).toBe(true);
    }

    // No untracked table: anything lacking a trigger must be allowlisted.
    const untracked = rows
      .filter((r) => !r.has_audit_trigger && !KNOWN_UNAUDITED.has(r.table_name))
      .map((r) => r.table_name);
    expect(
      untracked,
      `app.* base table(s) with no audit.log_row_change trigger and not in ` +
        `KNOWN_UNAUDITED: ${untracked.join(", ")}. Add a <table>_audit trigger ` +
        `in a migration, or allowlist it with justification.`,
    ).toEqual([]);
  });

  it("Schwab's dedicated audit preserves insert/update provenance and protects history", async () => {
    // Synthetic opaque identity; no account or CRM fixture is needed for a
    // firm-operating mapping. Use exact cleanup, never a table-wide delete.
    const accountId = "schw_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const nextActor = "schwab-audit-reviewer@example.test";
    const cleanupMapping = async () => {
      await su.$executeRaw`DELETE FROM app.schwab_account_mapping_event WHERE account_id = ${accountId}`;
      await su.$executeRaw`DELETE FROM app.schwab_account_mapping WHERE account_id = ${accountId}`;
    };
    await cleanupMapping();
    try {
      await withUserScope({ role: "OPERATIONS", email: ACTOR }, (tx) =>
        tx.$executeRaw`INSERT INTO app.schwab_account_mapping
          (account_id, account_number_last4, account_scope, version, reviewed_by, reviewed_at)
          VALUES (${accountId}, '9099', 'FIRM_OPERATING', 999, 'forged@example.test', '1970-01-01')`,
      );
      await withUserScope({ role: "OPERATIONS", email: nextActor }, (tx) =>
        tx.$executeRaw`UPDATE app.schwab_account_mapping
          SET version = 999, reviewed_by = 'forged@example.test', reviewed_at = '1970-01-01'
          WHERE account_id = ${accountId}`,
      );
      const events = await su.$queryRaw<Array<{
        version: number;
        previous_decision: Record<string, unknown> | null;
        decision: Record<string, unknown>;
        reviewed_by: string;
        reviewed_at: Date;
      }>>`SELECT version, previous_decision, decision, reviewed_by, reviewed_at
          FROM app.schwab_account_mapping_event WHERE account_id = ${accountId} ORDER BY version`;
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        version: 1, previous_decision: null, reviewed_by: ACTOR,
        decision: { account_id: accountId, account_scope: "FIRM_OPERATING", version: 1, reviewed_by: ACTOR },
      });
      expect(events[1]).toMatchObject({
        version: 2, previous_decision: events[0].decision, reviewed_by: nextActor,
        decision: { account_id: accountId, account_scope: "FIRM_OPERATING", version: 2, reviewed_by: nextActor },
      });
      for (const event of events) {
        expect(event.reviewed_at.getUTCFullYear()).toBeGreaterThan(1970);
      }

      const tables = await su.$queryRaw<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid IN ('app.schwab_account_mapping'::regclass, 'app.schwab_account_mapping_event'::regclass)`;
      expect(tables).toHaveLength(2);
      expect(tables.every((table) => table.relrowsecurity && table.relforcerowsecurity)).toBe(true);
      for (const role of ["app_rw", "ingest_rw"]) {
        const [privileges] = await su.$queryRaw<Array<{ history_write: boolean; mapping_delete: boolean }>>`
          SELECT has_table_privilege(${role}, 'app.schwab_account_mapping_event', 'INSERT, UPDATE, DELETE, TRUNCATE') AS history_write,
                 has_table_privilege(${role}, 'app.schwab_account_mapping', 'DELETE, TRUNCATE') AS mapping_delete`;
        expect(privileges).toEqual({ history_write: false, mapping_delete: false });
      }
    } finally {
      await cleanupMapping();
    }
  });
});
