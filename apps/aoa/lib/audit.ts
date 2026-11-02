import type { Prisma } from "@prisma/client";
import type { Identity } from "@/lib/rls";

// First audit writer (TDD ticket, ADR-5). Inserts into the append-only
// audit."AuditLog" — the app_rw role holds INSERT+SELECT only (never
// UPDATE/DELETE), enforced by the grants in the mirror_roles_grants_rls
// migration; rows are never mutated.
//
// The caller supplies the transaction client (the same `withUserScope` tx as
// the row write), so a failed write leaves no orphan audit row and a failed
// audit insert rolls the write back — the same-transaction guarantee every
// later write feature reuses.

// Deal action vocabulary (D3 server actions; D4 import may reuse). Stage
// transitions are the compliance-interesting event, so they get a distinct
// action whose detail records { from, to }.
export const DEAL_CREATE = "deal.create";
export const DEAL_UPDATE = "deal.update";
export const DEAL_STAGE_CHANGE = "deal.stage_change";
// D7 soft delete (WO ticket): archive/restore are lifecycle events on the
// deal itself; detail carries { name, stage, amount } (the deal.create idiom).
export const DEAL_ARCHIVE = "deal.archive";
export const DEAL_RESTORE = "deal.restore";
// tkt-deals-dedupe: the one-time legacy 15-char dedupe (scripts/dedupe-legacy-
// deals.ts) writes ONE row per LIVE run, inside the same owner transaction as
// the carries + archives. Detail is counts only (no PII): { received, twins,
// carried, terminal_skipped, archived, orphans }.
export const DEAL_DEDUPE = "deal.dedupe";

// Transfer action vocabulary (Phase Asset Transfer, TDD ticket ADR-5 —
// constants only; writeAudit is reused unchanged). Every event carries
// entityType = "transfer" and entityId = the TRANSFER id (child ids ride in
// `detail`), so the (entityType, entityId) index gives one queryable trail per
// transfer. Detail payloads are ids + enum values only — never PII/narratives:
//   transfer.stage_change   -> { from, to }
//   transfer.task_toggle    -> { taskId, done }
//   transfer.decision_set   -> { decisionId, symbol, from, to }
//   transfer.account_status -> { accountId, from, to }
export const TRANSFER_CREATE = "transfer.create";
export const TRANSFER_UPDATE = "transfer.update";
// Restricted proof stays in app.acat_link_*; general audit stores only
// controlled actions, versions/counts and opaque local decision/run IDs.
export const ACAT_LINK_PREPARE = "acat_link.prepare";
export const ACAT_LINK_REVIEW = "acat_link.review";
export const ACAT_LINK_APPLY = "acat_link.apply";
export const ACAT_LINK_UNDO = "acat_link.undo";
export const ACAT_LINK_HOLD = "acat_link.hold";
export const ACAT_LINK_RUN = "acat_link.run";
export const TRANSFER_STAGE_CHANGE = "transfer.stage_change";
export const TRANSFER_TASK_TOGGLE = "transfer.task_toggle";
export const TRANSFER_DECISION_SET = "transfer.decision_set";
export const TRANSFER_ACCOUNT_STATUS = "transfer.account_status";
// One finalized funding-plan version. Draft clicks never emit audit rows.
// detail contains enums/counts/version only — no account number or narrative:
//   { version, fundingType, source, positionCount, transferringCount, hasNote }
export const TRANSFER_FUNDING_PLAN_APPROVE = "transfer.funding_plan_approve";
// Partial-ACAT per-position "is transferring" set → { symbol, isTransferring }.
export const TRANSFER_POSITION_TRANSFERRING = "transfer.position_transferring";
// Asset-map rework S3 — link/unlink an asset-mapping account to a transfer.
// detail carries ids + custodian + masked last-4 ONLY (never the full account
// number or a holder name — §6 PII/no-log).
//   transfer.asset_map_link   -> { folderId, custodian, accountLast4 }
//   transfer.asset_map_unlink -> { }
export const TRANSFER_ASSET_MAP_LINK = "transfer.asset_map_link";
export const TRANSFER_ASSET_MAP_UNLINK = "transfer.asset_map_unlink";
// Slack closeout checklist — written when the n8n callback marks the LAST item
// done and the closeout flips to COMPLETE. detail = ids/counts only, no PII.
//   transfer.slack_closeout -> { status: "COMPLETE", items }
export const TRANSFER_SLACK_CLOSEOUT = "transfer.slack_closeout";
// Manual soft-archive (feat/transfer-archive-falloff, flag TRANSFER_ARCHIVE_ACTION)
// — the human counterpart of the reconciler's deal_lost/uncommitted stamps (which
// audit as ingest.transfer_sync counts, not per-row events). Lifecycle event on
// the transfer itself, the deal.archive idiom; detail is enums + numbers only
// (never PII): { stage, value, reason: "manual" }.
export const TRANSFER_ARCHIVE = "transfer.archive";
// Dismiss the reconciler's sync_flag review marker (transfer-syncflag-surface)
// — the "keep this transfer" resolution of the flag+manual-button design: a
// human reviewed the flagged transfer and cleared the marker instead of
// archiving it. Lifecycle event on the transfer itself; detail is the enum
// stamp only (never PII): { cleared_flag }.
export const TRANSFER_SYNC_FLAG_DISMISS = "transfer.sync_flag_dismiss";
// Asset Transfer workspace intake (ATW-02). detail is ids, booleans and the
// account-type enum strings only:
//   transfer.statement_record     -> { statementId, accepted, approvalCleared,
//                                      documentId?, reviewStatus? }
//   transfer.account_match_record -> { accountMatchId, match, approvalCleared }
// Statement files (ticket). Never the filename or bytes:
//   transfer.statement_upload   -> { documentId, contentType, byteSize, sha256 }
//   transfer.statement_download -> { transferId, sha256 } on the document entity
export const TRANSFER_STATEMENT_RECORD = "transfer.statement_record";
export const TRANSFER_STATEMENT_UPLOAD = "transfer.statement_upload";
export const TRANSFER_STATEMENT_DOWNLOAD = "transfer.statement_download";
export const TRANSFER_ACCOUNT_MATCH_RECORD = "transfer.account_match_record";
// ATW-05 paperwork mailing -> { mailingId, journey, hasPostage }. No contents
// or reason text in audit detail.
export const TRANSFER_MAILING_RECORD = "transfer.mailing_record";
// ATW-06 Operations records. Submission -> { submissionId }; tracking ->
// { trackingUpdateId, hasExpectedCompletion }; receipt -> { receiptId, version,
// partial, lineCount }. No control number, note or explanation text in detail.
export const TRANSFER_SUBMISSION_RECORD = "transfer.submission_record";
export const TRANSFER_TRACKING_RECORD = "transfer.tracking_record";
export const TRANSFER_RECEIPT_RECORD = "transfer.receipt_record";
// ATW-07 Client Service records. Check ticket -> { checkTicketId, withClient };
// ACH initiation -> { achInitiationId, stageMoved }.
export const TRANSFER_CHECK_TICKET_RECORD = "transfer.check_ticket_record";
export const TRANSFER_ACH_INITIATION_RECORD = "transfer.ach_initiation_record";
// ATW-09 follow-up records -> { recordId, kind } plus booleans. No response,
// owner or control-number text in detail.
export const TRANSFER_FOLLOW_UP_RECORD = "transfer.follow_up_record";
// ATW-10 outcome and correction records -> { recordId, kind, outcome? }. No
// reason or correction text in detail.
export const TRANSFER_OUTCOME_RECORD = "transfer.outcome_record";

// Unified Decision Center. Narrative questions/resolutions remain only in the
// FORCE-RLS decision tables; general audit detail is deliberately identifiers,
// controlled enums, versions, and task counts.
export const DECISION_CASE_CREATE = "decision.case_create";
export const DECISION_CASE_REOPEN = "decision.case_reopen";
export const DECISION_CASE_RESOLVE = "decision.case_resolve";
export const DECISION_TASK_UPDATE = "decision.task_update";

// Client Portrait — a human confirms which approved Trade Request is the
// authoritative instruction source for one Apex account. The selection is a
// reference only; Trade Request history and instruction payloads are immutable.
export const TRADE_PROFILE_SOURCE_CONFIRM = "trade_profile.source_confirm";
export const TRADE_PROFILE_SOURCE_CHANGE = "trade_profile.source_change";
// Central Operations review queue human workflow. Detail contains enum/boolean
// metadata only; assignment email, note text and source identifiers stay out of
// the general audit payload (the queue's append-only event table owns them).
export const REVIEW_QUEUE_UPDATE = "review_queue.update";
// CRM Explorer duplicate-review decisions. Candidates contain only opaque CRM
// IDs, controlled evidence/conflict codes, and an optional hashed account
// fingerprint. These actions never merge, delete, or rewrite a source record.
export const CRM_DUPLICATE_NOT_DUPLICATE = "crm.duplicate.not_duplicate";
export const CRM_DUPLICATE_SNOOZE = "crm.duplicate.snooze";
export const CRM_DUPLICATE_READY = "crm.duplicate.ready_for_follow_up";
export const CRM_DUPLICATE_REOPEN = "crm.duplicate.reopen";
export const CRM_DUPLICATE_FLAG = "crm.duplicate.flag";

// Ingest action vocabulary (Phase D, TDD ticket §11 — constants only;
// writeAudit is reused unchanged with { role: "INGEST", email: null }). Every
// event carries entityType = "ingest_run" and entityId = the run_id; detail is
// COUNTS ONLY, never PII: { source, endpoint, received, upserted, rejected,
// dry_run }. The full rejected list rides the HTTP response + a PII-free log —
// never the audit row.
export const INGEST_CLIENTS = "ingest.clients";
export const INGEST_ACCOUNTS = "ingest.accounts";
export const INGEST_TASKS = "ingest.tasks";
export const INGEST_EMAILS = "ingest.emails";
export const INGEST_ACTIVITY = "ingest.activity";
// Zendesk support-ticket ingest. The requester email, Cedar Ridge user id, and
// ticket/comment bodies never enter audit detail. It contains counts only:
// received/upserted/rejected plus linkage outcomes.
export const INGEST_ZENDESK_TICKETS = "ingest.zendesk_tickets";
// CRM/Salesforce Account + Contact parent-key feed. Key-only rows land in
// mirror.crm_parent_source; the dedicated CRM reconciler remains the only role
// allowed to mint app-owned identities or source mappings.
export const INGEST_CRM_PARENTS = "ingest.crm_parents";
// Diagnostic-only deleted/merged parent evidence. Rows remain key-only and
// cannot be consumed as identity sources by the CRM reconciler.
export const INGEST_CRM_PARENT_ORPHANS = "ingest.crm_parent_orphans";
// Appointments-Feed feed — the #appointments-feed Slack digest, forwarded
// by n8n and FULL-REPLACED into mirror.appointment per run (snapshot, not delta).
export const INGEST_APPOINTMENTS = "ingest.appointments";
// Risk-free-rate feed — the US Treasury daily par yield curve ("3 Mo" column),
// fetched by n8n and UPSERTED BY DATE into mirror.risk_free_rate (an append-only
// time series; NEVER a replace — history is immutable and a Treasury revision is
// an update of one date). Counts-only detail: { source, tenor, received,
// upserted, skipped, rejected, from, to, dry_run }. Public market data, so there
// is no PII here — the no-payload-logging rule still holds.
export const INGEST_RISK_FREE_RATE = "ingest.risk_free_rate";
// The FIRST ingest writer into an app-owned table (app.deal) — n8n keeps deal
// stages current. Same counts-only detail as every other ingest run.
export const INGEST_DEALS = "ingest.deals";
// tkt account-AUM feed — the first SCHEDULED (cron) ingest run, PULLED by the
// app from Warehouse card 6601 rather than pushed by n8n. entityId is the
// generated run id. detail carries source/card/counts plus the source's maximum
// as_of date and primary/retry trigger — never PII.
export const INGEST_ACCOUNT_AUM = "ingest.account_aum";
// Active Plaid-linked account summary ingest (Warehouse card pull). Counts only
// in detail — never PII, holdings rows, or account payloads.
export const INGEST_LINKED_EXTERNAL_ACCOUNT_SUMMARY =
  "ingest.linked_external_account_summary";
// Complete Schwab S3 account-balance snapshot. Detail is aggregate match and
// snapshot counts only; account numbers, registration names and Salesforce ids
// never enter the general audit trail.
export const INGEST_SCHWAB_ACCOUNT_BALANCES = "ingest.schwab_account_balances";
// ticket Slice 4 — the deal→transfer sync (a SCHEDULED cron reconciler, like
// account-AUM: PULLED from app.deal, not pushed by n8n). Counts-only detail;
// entityId is the generated run id. detail carries { received, created, updated,
// archived, flagged, noop, dry_run } — never PII. Flag-gated: the OFF path
// writes NO audit row at all (dark-deploy). dryRun writes ONLY this audit row.
export const INGEST_TRANSFER_SYNC = "ingest.transfer_sync";
// CRM Phase 3A scheduled/post-ingest identity sweep. The database function
// writes this counts-only event atomically with registry and exception changes
// as the dedicated identity_reconciler role. No source keys or PII are logged.
export const CRM_IDENTITY_RECONCILE = "crm.identity.reconcile";
// CRM Phase 4C relationship snapshot. The database function writes one event
// atomically with live relationship changes. detail contains per-derivation
// counts and completeness booleans only—never Salesforce keys or PII.
export const CRM_RELATIONSHIP_RECONCILE = "crm.relationship.reconcile";
// Manual Rippling employee-roster lifecycle. The roster and match tables carry
// employee/client identifiers and are deliberately excluded from generic row
// snapshots. These explicit events are the complete business trail and keep
// detail counts/booleans only—never names, employee ids, source keys, or notes.
export const EMPLOYEE_ROSTER_PREVIEW = "employee_roster.preview";
export const EMPLOYEE_ROSTER_APPLY = "employee_roster.apply";
export const EMPLOYEE_CONTACT_CONFIRM = "employee_contact.confirm";
export const EMPLOYEE_CONTACT_REJECT = "employee_contact.reject";
export const EMPLOYEE_CONTACT_INVALIDATE = "employee_contact.invalidate";
// Trade Reconciliation completed runs and human context. Payloads retain the
// detailed, Ops-only result; these general audit events carry controlled enums,
// counts/booleans, and optional opaque batch ids only—never source rows,
// account suffixes, row fingerprints, order IDs, or narrative text.
export const TRADE_RECONCILIATION_RUN = "trade_reconciliation.run";
export const TRADE_RECONCILIATION_BREAK_REVIEW = "trade_reconciliation.break_review";
export const TRADE_RECONCILIATION_RUN_NOTE = "trade_reconciliation.run_note";
// Fee Credit & Service Guarantee intake. The request table owns the sensitive
// client/account/reason payload; generic audit detail is counts/enums only.
export const OPERATIONS_FEE_REQUEST_CREATE = "operations.fee_request.create";
// Human review/completion transition. The request/event tables retain the
// narrative note and Apex reference; the generic audit trail receives only
// controlled enums and presence booleans.
export const OPERATIONS_FEE_REQUEST_TRANSITION = "operations.fee_request.transition";
// Asset-mapping Phase-1 ingest — a SCHEDULED cron PULL from the statement-pipeline's
// OIDC-gated /api/v1/households (household → accounts[] → positions[]), mirrored
// UNLINKED into mirror.acat_asset_map_*. Counts-only detail; entityId is the
// generated run id. detail carries { source, endpoint, pages, households,
// accounts, positions, upserted, rejected, superseded, dry_run } — never PII,
// never account numbers. dryRun writes NO row at all (not even this audit row).
export const INGEST_ASSET_MAP = "ingest.asset_map";
// Asset-map run identity sync (ticket) — the separate identity transaction that
// runs only after the INGEST_ASSET_MAP base transaction commits, with both
// ASSET_MAP_RUN_IDENTITY_ENABLED and ASSET_MAP_RUN_IDENTITY_WRITES_ENABLED on.
// Written in the SAME transaction as the identity snapshot/member/history writes,
// and only when that transaction changed stored identity state, so an unchanged
// retry adds no row. entityId is the import's run id. detail is COUNTS + census
// reason codes only — never a person id, name, payload or account number.
// Preview and dryRun write no row.
export const INGEST_ASSET_MAP_RUN_IDENTITY = "ingest.asset_map_run_identity";
// Asset-mapping Phase-2 (P2.1) reconcile/match pass — a SCHEDULED cron that reads
// the LIVE mapping households + candidate mirror.client rows, runs the fuzzy
// name-match brain (lib/data/asset-map-match), and writes tiered links into
// mirror.acat_asset_map_link via the P2.0 seam. Counts-only detail; entityId is
// the generated run id. detail carries { source, households_scored, auto_linked,
// needs_review, unmatched, preserved, dry_run } — NEVER names, NEVER account
// numbers. A CONFIRMED/REJECTED (human) link is preserved, never overwritten.
// dryRun computes tiers + returns counts but writes ONLY this audit row.
export const INGEST_ASSET_MAP_MATCH = "ingest.asset_map_match";
// Asset-mapping Phase-2 (P2.3) OPS review-queue write-back — a HUMAN confirm /
// reject of a mapping-household → client link (mirror.acat_asset_map_link), run
// under the ops user's OWN withUserScope (app_rw), NOT the machine ingest role.
// entityType = "asset_map_link", entityId = the durable source_folder_id (an
// opaque Drive folder id, not PII). detail is IDS + ENUM ONLY, NEVER a client
// name / account number: confirm → { status, clientSfId, householdSfId };
// reject → { status }. A CONFIRMED/REJECTED link is preserved by every future
// matcher run (the reconcile pass never downgrades a human decision).
export const ASSET_MAP_LINK_CONFIRM = "asset_map_link.confirm";
export const ASSET_MAP_LINK_REJECT = "asset_map_link.reject";
// Asset-mapping Phase-2 (P2.5) account-grain reconcile pass — the SECOND pass in
// app/api/cron/asset-map-match, run AFTER the folder pass for every live account
// under a folder whose link is AUTO_LINKED/CONFIRMED. Resolves each account's
// account_holder → the owning person(s) against the folder's household members and
// writes mirror.acat_asset_map_account_link. Counts-only detail (the
// INGEST_ASSET_MAP_MATCH idiom); entityId is the generated run id. detail carries
// { source, accounts_scored, account_auto_linked, account_needs_review,
// account_unmatched, accounts_preserved, accounts_unkeyable, unkeyable_breakdown,
// dry_run } — where unkeyable_breakdown groups the unkeyable bucket by account_type
// (a category) + which id was null. NEVER a holder name, NEVER an account number.
// dryRun writes ONLY this audit row.
export const INGEST_ASSET_MAP_ACCOUNT_LINK = "ingest.asset_map_account_link";
// Asset-mapping Phase-2 (P2.5) OPS account-review write-back — a HUMAN confirm /
// reject of an account's OWNER SET (mirror.acat_asset_map_account_link), run under
// the ops user's OWN withUserScope (app_rw), NOT the machine ingest role.
// entityType = "asset_map_account_link", entityId = the durable source_folder_id
// (an opaque Drive folder id, not PII — NEVER the account number). detail is IDS +
// custodian + COUNTS ONLY, NEVER a holder/client name or account number:
// confirm → { status, custodian, ownerCount, isEntity, clientSfIds, householdSfId };
// reject → { status, custodian }. Confirm writes the FULL owner set all-or-nothing;
// a CONFIRMED/REJECTED owner is preserved by every future matcher run.
export const ASSET_MAP_ACCOUNT_CONFIRM = "asset_map_account_link.confirm";
export const ASSET_MAP_ACCOUNT_REJECT = "asset_map_account_link.reject";
// ticket in-app asset-mapping edits. The statement-pipeline is the system of record
// and records AoA's allowlisted service account as the actor, so THIS row is the
// human attribution. Written under the operator's own withUserScope AFTER the
// pipeline accepted the change (the pipeline write cannot share AoA's tx).
// entityType = "asset_map_position" | "asset_map_account", entityId = the
// pipeline UUID. detail is enums only — never a name, account number, or the
// free-text Other label:
//   position_status -> { status }      position_transferring -> { value }
//   account_type    -> { accountType, hasOther }
//   position_delete / position_restore / account_delete / account_restore -> {}
export const ASSET_MAP_EDIT_POSITION_STATUS = "asset_map_edit.position_status";
export const ASSET_MAP_EDIT_POSITION_TRANSFERRING = "asset_map_edit.position_transferring";
export const ASSET_MAP_EDIT_ACCOUNT_TYPE = "asset_map_edit.account_type";
export const ASSET_MAP_EDIT_POSITION_DELETE = "asset_map_edit.position_delete";
export const ASSET_MAP_EDIT_POSITION_RESTORE = "asset_map_edit.position_restore";
export const ASSET_MAP_EDIT_ACCOUNT_DELETE = "asset_map_edit.account_delete";
export const ASSET_MAP_EDIT_ACCOUNT_RESTORE = "asset_map_edit.account_restore";
export const ASSET_MAP_CLIENT_LINK_PREVIEW = "asset_map_client_link.preview";
export const ASSET_MAP_CLIENT_LINK_APPLY = "asset_map_client_link.apply";
export const ASSET_MAP_CLIENT_LINK_LOOKUP_RETRY = "asset_map_client_link.lookup_retry";
export const ASSET_MAP_CLIENT_LINK_REVERT_PREVIEW = "asset_map_client_link.revert_preview";

// ticket in-app asset-mapping destinations. Same attribution split as the
// ticket edits: the pipeline records AoA's service account as the actor, so
// THIS row is the human attribution, written under the operator's own
// withUserScope AFTER the pipeline accepted the change. entityType =
// "asset_map_destination" (entityId = the pipeline destination UUID, or null
// when an add response omits it) or "asset_map_source_link" (entityId = the
// link UUID). detail is enums and ids only — never an owner name or account number:
//   add       -> { targetAccountType }     needs_to_be_opened -> { needsToBeOpened }
//   type      -> { targetAccountType }     delete             -> {}
//   source_reassign -> { targetAccountId, newDestination }
export const ASSET_MAP_DESTINATION_ADD = "asset_map_destination.add";
export const ASSET_MAP_DESTINATION_NEEDS_OPEN = "asset_map_destination.needs_to_be_opened";
export const ASSET_MAP_DESTINATION_TYPE = "asset_map_destination.type";
export const ASSET_MAP_DESTINATION_DELETE = "asset_map_destination.delete";
export const ASSET_MAP_SOURCE_REASSIGN = "asset_map_destination.source_reassign";

// In-app asset-mapping documents. The statement-pipeline records AoA's
// service account as the actor, so THIS row is the human attribution, written
// under the signed-in person's own withUserScope after the pipeline answered.
// detail is ids, enums, counts, and the pipeline's review time only — never a
// client name, filename, Drive link, or account number:
//   drive_save      -> entityType "asset_map_household", entityId household id,
//                      { reviewedAt }  (the reviewed_at the pipeline returned;
//                      the reviewer shown on later loads matches on it)
//   scan            -> entityType "asset_map_scan", entityId null,
//                      { outcome: "finished" | "failed", clientsProcessed }
//   household_pdf   -> entityType "asset_map_household", entityId household id, {}
//   all_clients_pdf -> entityType "asset_map_export", entityId null, {}
export const ASSET_MAP_DOCUMENTS_DRIVE_SAVE = "asset_map_documents.drive_save";
export const ASSET_MAP_DOCUMENTS_SCAN = "asset_map_documents.scan";
export const ASSET_MAP_DOCUMENTS_HOUSEHOLD_PDF = "asset_map_documents.household_pdf";
export const ASSET_MAP_DOCUMENTS_ALL_CLIENTS_PDF = "asset_map_documents.all_clients_pdf";

// tkt feed data-freshness/health monitor — the scheduled health check for the
// account-AUM feed (GET/POST /api/cron/health/aum-freshness). Written ONLY on a
// STALE verdict (a non-event on a healthy feed leaves no row), via withIngestScope
// like the ingest audit. entityType = "feed_health", entityId = the feed name;
// detail is counts/reason only — never PII, never secrets:
// { feed, reason, maxAsOf, expectedMinAsOf, staleByTradingDays, rowCount }.
export const FEED_HEALTH = "feed.health";

// AI meeting prep (AI_MEETING_PREP) — one row per human-triggered generation
// (and per regenerate). entityType = "meeting_prep", entityId = the
// app.meeting_prep row id (a cuid). NOTE: entityId is deliberately NOT the
// appointment_key — mirror.appointment.external_key embeds the CLIENT NAME
// (source|client|starts_at, lib/data/appointments.ts appointmentKey), and no PII
// may enter the trail. The table itself is allowlisted in KNOWN_UNAUDITED (the
// auto-audit trigger would snapshot the whole brief into audit.row_change), so
// THIS row is the entire audit trail for a generation. detail is ids + enums +
// COUNTS ONLY — never the brief, never the prompt, never a client/advisor name:
//   { clientSfId, model, finishReason, regenerated, generations, contextChars,
//     truncated, latencyMs,
//     sources: { accounts, deals, transfers, tasks, activity, emails } }
export const MEETING_PREP_GENERATE = "meeting_prep.generate";
// AI meeting prep — "Save to client portrait" / "Remove from portrait" (owner ask
// 2026-07-27). ATTACHING an internal PII brief to the client record, and
// detaching it again, are both lifecycle events on the same row, so they get
// their own actions (the deal.archive / deal.restore idiom). Same PII rules as
// MEETING_PREP_GENERATE: entityType = "meeting_prep", entityId = the
// app.meeting_prep row CUID (NEVER the appointment_key — it embeds the client
// name), detail is ids + enums ONLY, never the brief and never a name:
//   meeting_prep.save   -> { clientSfId, resaved }
//   meeting_prep.unsave -> { clientSfId }
// `resaved` distinguishes a first attach from a re-save that only moved
// saved_at — Save is idempotent: it UPDATEs the one row, never inserts a second.
export const MEETING_PREP_SAVE = "meeting_prep.save";
export const MEETING_PREP_UNSAVE = "meeting_prep.unsave";

// Client Portrait tax budget — a human creates or revises one app-owned row per
// client/year. entityId is the tax_budget row cuid; detail carries only the
// opaque client id, year, numeric inputs, and note presence (never note text).
export const TAX_BUDGET_SET = "tax_budget.set";
export const TAX_BUDGET_UPDATE = "tax_budget.update";

// Performance-report AUTHORIZED ATTEMPT (compliance review 2026-07-28). A client
// performance report left NO record that it had been produced — no writeAudit
// call under app/(authenticated)/performance/** or lib/twr/**, and the
// DB-trigger auto-audit only covers app.deal / app.transfer, which a report
// never touches. These two actions ARE the access record: "who ran which
// client's report, when". Written by lib/twr/report-audit.ts under the human's
// OWN withUserScope (a report writes no row, so there is no host transaction to
// join), AFTER both authz gates pass and BEFORE the custodial fetch — a refused
// request writes nothing.
//
// TWO actions, not one action + a scope enum, because the Events screen filters
// on an EXACT `action` value taken from a DISTINCT-action dropdown
// (lib/data/audit-log.ts, AuditLogQuery.action): "show me every account report
// this advisor ran" must be one dropdown pick, not a detail-JSON scan. It also
// matches this file's habit of one constant per distinct compliance event
// (deal.archive/deal.restore, meeting_prep.save/unsave).
//
// Both carry entityType = "performance_report". detail is IDS + ENUMS + COUNTS
// ONLY, never PII — never the full Apex account number, never a client or
// household name:
//   performance_report.generate_account   -> entityId = custodian_account_id
//       (the mirror.client_account_aum PK / Apex ULID — a durable opaque row key,
//       the same KIND of key every other entityId here is; NEVER the Apex
//       account number, which this trail treats as sensitive)
//       detail { reportId, phase: "authorized_attempt", clientSfId,
//                accountLast4, accountType }
//   performance_report.generate_household -> entityId = household sf_id
//       detail { reportId, phase: "authorized_attempt", householdSfId,
//                reportableAccounts }
//
// The historical action names remain stable for Events filters, but the phase
// is explicit: this pre-fetch row proves authorized intent/access, not a
// successful render, retained artifact, or delivery. reportId is printed on any
// output that does render so it can be correlated back to the attempt.
//
// DUPLICATE-RENDER CAVEAT (stated honestly): "generation" is a server render, so
// one row = one render, not necessarily one human intent. Today the only entry
// points are imperative `router.push` calls and there is no `<Link>` to
// /performance/**, so nothing prefetches these routes; report-audit.ts
// additionally skips the write on a `Next-Router-Prefetch: 1` request so a
// future `<Link>` cannot log phantom views. A reload, or a re-navigation that
// misses the client router cache, DOES write another row — each of those is a
// real re-generation, so the count stays honest.
export const PERFORMANCE_REPORT_GENERATE_ACCOUNT =
  "performance_report.generate_account";
export const PERFORMANCE_REPORT_GENERATE_HOUSEHOLD =
  "performance_report.generate_household";
// Written in the SAME transaction as audit.performance_report_record after the
// calculation completes. These prove a numeric snapshot was durably stored;
// they do NOT claim React/browser render, PDF creation, or delivery.
export const PERFORMANCE_REPORT_CALCULATED_ACCOUNT =
  "performance_report.calculated_account";
export const PERFORMANCE_REPORT_CALCULATED_HOUSEHOLD =
  "performance_report.calculated_household";
// Custodian authority (ticket). Written in the same transaction as the
// app.custodian_authority_event row for that revision. Detail is ids, the
// revision and counts only:
//   custodian_authority.save  -> entityId = custodian id,
//                                { revision, created, feeRules, retiredFeeRules }
//   custodian_authority.merge -> entityId = surviving custodian id, { revision, sourceId }
export const CUSTODIAN_AUTHORITY_SAVE = "custodian_authority.save";
export const CUSTODIAN_AUTHORITY_MERGE = "custodian_authority.merge";

export type AuditEntry = {
  /** Dotted action name, e.g. "deal.create" / "deal.stage_change". */
  action: string;
  /** Entity kind, e.g. "deal". */
  entityType?: string | null;
  /** Primary key of the touched row. */
  entityId?: string | null;
  /** JSON-serializable payload (e.g. { from, to } for stage changes). */
  detail?: unknown;
};

export async function writeAudit(
  tx: Prisma.TransactionClient,
  identity: Identity,
  entry: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      // Actor from the user scope — the same identity whose GUCs authenticate
      // the surrounding transaction to the RLS policies. Identity carries no
      // user id, so actorId stays null (email is the stable actor key).
      actorEmail: identity.email ?? null,
      actorRole: identity.role ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      detail: entry.detail == null ? null : JSON.stringify(entry.detail),
    },
  });
}
