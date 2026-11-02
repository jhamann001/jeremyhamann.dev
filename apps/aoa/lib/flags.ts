// Feature-flag seam (ticket, blueprint §1 item 5 / §2). This repo has NO flag
// SaaS (no LaunchDarkly, no useFlag/flagEnabled helper) — the flag is a single
// server-side env var, the repo's existing env-var-toggle idiom (ACAT_FIXTURE,
// TRANSFER_TRACKER_URL in lib/data/acat-status.ts). Pure, server-only, no
// dependency: process.env is a Node/Next built-in.
//
// Slice 2 itself is UNFLAGGED (it does not call this) — the file exists so the
// S3 hard gate and the S4 deal→transfer sync can consume it later. Default OFF:
// only the exact string "1" enables it; unset / "" / "0" / "true" / anything
// else is OFF. The var MUST stay unset in prod until the owner flips it, and
// only after Slice 2 is merged + migrated (§3 Slice 1 constraint).

// Live metadata collection and the read-only UI are separately gated. Neither
// flag authorizes outbound alerts; no Slack delivery exists in this slice.
export function dataJobMonitoringEnabled(): boolean {
  return process.env.DATA_JOB_MONITORING === "1";
}

export function dataJobCollectionEnabled(): boolean {
  return process.env.DATA_JOB_COLLECTION === "1";
}

// Review visibility and automatic writes are independently dark by default.
// Neither bypasses authentication, RLS, source proof or the global write pause.
export function acatAutoLinkReviewEnabled(): boolean {
  return process.env.ACAT_LINK_REVIEW === "1";
}

export function acatAutoLinkEnabled(): boolean {
  return process.env.ACAT_AUTO_LINK === "1";
}

export function transferDealSourcedRedesignEnabled(): boolean {
  return process.env.TRANSFER_DEAL_SOURCED_REDESIGN === "1";
}

// Asset Transfer workspace (presentation epic, ATW-01). ON replaces the
// lifecycle board with the Household, Transfers, Work queue, Activity, and
// Mailing report views; OFF keeps today's board. Exact "1" only.
export function assetTransferWorkspaceEnabled(): boolean {
  return process.env.ASSET_TRANSFER_WORKSPACE === "1";
}

// Asset Transfer paperwork records (ATW-04). Callers require
// assetTransferWorkspaceEnabled() as well; this reader checks only its own
// env var. Exact "1" only.
export function paperworkRecordsEnabled(): boolean {
  return process.env.TRANSFER_PAPERWORK_RECORDS === "1";
}

// Canonical-development transfer-board parity. The repository seed keeps a
// stable DEMO-T-* baseline plus synthetic DEMO-* deals for local development
// and empty-environment recovery, but canonical cloud dev also carries approved
// source-system data. When this switch is ON, shared transfer reads exclude both
// direct demo cards and normal-keyed cards materialized from synthetic deals so
// the board, KPIs, board-search/linkage consumers, and meeting-prep context
// rehearse the real deal-sourced book. Production leaves the switch unset (and
// has no demo rows); local development leaves it unset so fixtures remain
// available.
// Reversible and read-only: it never deletes or archives a row.
export function hideDemoTransferCardsEnabled(): boolean {
  return process.env.HIDE_DEMO_TRANSFER_CARDS === "1";
}

// Asset-map rework S3 — the "assign an asset map to a transfer" surface (the
// funding-card link modal + the link/unlink server actions). Default OFF: only
// the exact string "1" enables it. Keep unset in prod until S3 is merged +
// migrated; the owner flips it. The flag gates BOTH the UI render branch AND the
// write actions (defense in depth — even if the UI leaked, the action no-ops
// when OFF).
export function assetMapTransferLinkEnabled(): boolean {
  return process.env.ASSET_MAP_TRANSFER_LINK === "1";
}

// Asset-map run identity sync (ticket). The parent gate turns on read-only
// census validation, CRM resolution and aggregate diagnostics on the existing
// /api/cron/asset-map import; the write gate additionally permits the separate
// identity transaction and is effective only while the parent is on. Exact "1"
// only; default off. Turning either off stops identity work without deleting
// stored relationships.
export function assetMapRunIdentityEnabled(): boolean {
  return process.env.ASSET_MAP_RUN_IDENTITY_ENABLED === "1";
}

export function assetMapRunIdentityWritesEnabled(): boolean {
  return process.env.ASSET_MAP_RUN_IDENTITY_WRITES_ENABLED === "1";
}

// Smart Nudges Template Library requirements resolver (ticket, Phase 1). Same
// server-only env-var idiom as above: only "1" enables the Template Library
// requirements panel; unset / "" / "0" / anything else is OFF (default off, no
// config needed to stay dark). Read server-side (in the smart-nudges route
// Server Component) and threaded as a prop into the client view.
export function smartNudgesRequirementsResolverEnabled(): boolean {
  return process.env.SMART_NUDGES_REQUIREMENTS_RESOLVER === "1";
}

// Global Topbar search (feat/global-search). Same server-only env idiom as the
// others: only "1" enables the live cross-entity search dropdown; unset/""/"0"/
// anything else is OFF → the Topbar keeps its inert placeholder input. Read in
// the (server) Topbar; the live component is a client child. Flip in prod after
// merge; unsetting is the instant rollback.
export function globalSearchEnabled(): boolean {
  return process.env.GLOBAL_SEARCH === "1";
}

// Checklist-as-stage-gate (feat/checklist-stage-gate). When ON: the transfer
// detail renders the to-do checklist in the readiness-card UI (StageChecklistCard),
// the standalone Decision Readiness card is hidden, and completing a stage's
// visible checklist is the hard gate for advancing (all forward moves). Default
// OFF (only "1" enables) → today's card + hardGateBlock behavior. Flip in prod
// after merge; unset to roll back. Takes precedence over the old
// TRANSFER_DEAL_SOURCED_REDESIGN gate in setStage when both are on.
export function checklistStageGateEnabled(): boolean {
  return process.env.CHECKLIST_STAGE_GATE === "1";
}

// Live Command Center Meetings (feat/appointments-feed). When ON, the Meetings
// card is fed by real upcoming appointments from mirror.appointment (the
// #appointments-feed Slack digest via /api/ingest/appointments) instead of the
// mock fixtures, and the "Preview · sample data" badge is dropped. Default OFF
// (only "1" enables) → the card keeps its mock fixtures until the feed is live and
// the owner flips it. The ingest endpoint + table exist regardless of this flag.
export function commandCenterMeetingsLiveEnabled(): boolean {
  return process.env.COMMAND_CENTER_MEETINGS_LIVE === "1";
}

// Live Command Center deal funnel (feat/command-center-funnel-live). When ON, the
// "Transfer pipeline" card is fed by real app.deal rows (four stage buckets in
// pipeline order + the cross-cutting "At risk" overlay) instead of the mock
// fixture, and the "Preview · sample data" badge is dropped from that card.
// Default OFF (only "1" enables; unset/""/"0"/anything else is OFF) → the mock
// fixture renders exactly as it does today, byte for byte. Deliberately SEPARATE
// from COMMAND_CENTER_MEETINGS_LIVE: the two cards have different data sources
// and must be flippable independently. Unsetting it is the instant rollback.
export function commandCenterFunnelLiveEnabled(): boolean {
  return process.env.COMMAND_CENTER_FUNNEL_LIVE === "1";
}

// AI communication drafting (feat/ai-drafting). Gates the Gemini-backed drafting
// FEATURE (the UI surfaces that will call lib/ai/draft.ts). Same server-only env
// idiom: only "1" enables; unset/""/"0"/anything else is OFF. Default OFF — the
// engine ships dark until a surface is wired and the owner flips it. NOTE: the
// /api/health/ai probe is intentionally INDEPENDENT of this flag (it verifies
// Gemini readiness before the feature is turned on) — it is gated by the ingest
// bearer token instead.
export function aiDraftingEnabled(): boolean {
  return process.env.AI_DRAFTING === "1";
}

// AI meeting prep (feat/ai-meeting-prep, slice 1). When ON: the Command Center
// Meetings card offers a REAL "Generate prep" that assembles context from the
// data AOA already holds, sends it through the Gemini engine, and persists the
// brief in app.meeting_prep. Same server-only env idiom: only "1" enables;
// unset/""/"0"/anything else is OFF (default off → the card behaves exactly as
// it does on main today). Gates BOTH the UI affordance AND the
// generateMeetingPrep Server Action (defense in depth — a leaked UI still
// refuses when OFF) AND the app.meeting_prep read in commandCenterData.
// Deliberately SEPARATE from aiDraftingEnabled (blueprint ADR-5): prep writes a
// PII table where comms drafting only renders text into an editable field, so
// the two must be flippable independently. Flip in prod after merge + migrate;
// unsetting it is the instant, complete rollback.
export function aiMeetingPrepEnabled(): boolean {
  return process.env.AI_MEETING_PREP === "1";
}

// Client Portrait experimental experiences (Dual-View and profile fixtures).
// These surfaces intentionally use deterministic synthetic fixtures while the
// underlying signal, portfolio-model and compliance services are validated.
// They may render ONLY on the canonical development environment: the explicit
// APP_ENV check matters because deployed dev runs with NODE_ENV=production.
// Production therefore fails closed even if the feature flag is accidentally
// copied there.
export function clientPortraitExperimentsEnabled(): boolean {
  return (
    process.env.APP_ENV?.toLowerCase() === "dev" &&
    process.env.CLIENT_PORTRAIT_EXPERIMENTS === "1"
  );
}

// Tasks demo sample rows (ticket). The Tasks page shows ONLY real, saved
// tasks. The made-up sample rows from the in-memory workflow store can be shown
// for demos, in a separate "Demo sample workflow (dev only)" block that is never
// counted, and only on the canonical development environment with the explicit
// switch: APP_ENV="dev" AND TASKS_SAMPLE_ROWS="1". Default OFF everywhere;
// production fails closed even if the switch is copied there. Evaluated
// server-side in the Tasks page and passed down as a boolean.
export function tasksSampleRowsEnabled(): boolean {
  return (
    process.env.APP_ENV?.toLowerCase() === "dev" &&
    process.env.TASKS_SAMPLE_ROWS === "1"
  );
}

// Live, read-only Trade Request-derived investment profile on Client Portrait.
// Independent from the synthetic Client Portrait experiments so development can
// validate real approved requests before production is enabled. Exact "1" only;
// unset is the instant rollback to the existing synthetic/legacy cards.
export function clientPortraitTradeProfileLiveEnabled(): boolean {
  return process.env.CLIENT_PORTRAIT_TRADE_PROFILE_LIVE === "1";
}

// Slack closeout checklist (feat/slack-transfer-checklist). When ON: entering
// IN_TRANSFER seeds a per-transfer closeout checklist, fires the n8n webhook, and the
// transfer detail shows the Slack completion status. Same server-only env idiom:
// only "1" enables; unset/""/"0"/anything else is OFF (default off → no seed, no
// webhook, no UI, identical to today). Flip in prod after merge + migrate; unset
// to roll back instantly. Gates BOTH the setStage side-effect and the UI render.
export function slackCloseoutEnabled(): boolean {
  return process.env.SLACK_TRANSFER_CLOSEOUT === "1";
}

// Initial-Funding check (feat/initial-funding-check). When ON, a transfer's
// receiving account that is already OPEN at Apex is checked against the client's
// Initial Funding trade requests; the ReceivingAccountsCard flags it when no such
// request lists that account. Same server-only env idiom: only "1" enables;
// default OFF → no check, no flag. Flip in prod after merge; unset to roll back.
export function initialFundingCheckEnabled(): boolean {
  return process.env.INITIAL_FUNDING_CHECK === "1";
}

// Manual transfer archive (feat/transfer-archive-falloff). When ON, the transfer
// DETAIL page shows an "Archive transfer" affordance (write roles, non-archived
// rows only) and the archiveTransfer server action accepts writes — the edge-case
// manual soft-delete (archived_reason='manual'). Gates BOTH the UI render AND the
// action (defense in depth — a leaked UI still no-ops when OFF). NOTE: the
// read-path fall-off (archived rows leave the board/stats) is a BUG FIX and is
// deliberately NOT behind this flag. Same server-only env idiom: only "1"
// enables; unset/""/"0"/anything else is OFF. Flip in prod after merge; unset to
// roll back instantly.
export function transferArchiveActionEnabled(): boolean {
  return process.env.TRANSFER_ARCHIVE_ACTION === "1";
}

// CRM relationship layer (ticket planning, Phase 0). These independent
// server-side seams deliberately have no consumers yet: Phase 0 defines the
// rollback boundaries before schema, reads, UI, or authorization behavior
// exists. Only the exact string "1" enables a seam; every other value fails
// closed. CRM_EBAC_ENFORCE must remain independent from the read-only identity
// and relationship flags so future shadow evaluation cannot accidentally widen
// or narrow access.
export function crmIdentityReadsEnabled(): boolean {
  return process.env.CRM_IDENTITY_READS === "1";
}

// Phase 3A machine writer. Independent from CRM_IDENTITY_READS so the registry
// can remain visible while automatic assignment is paused, or reconciliation
// can run before the explorer is exposed. Exact "1" only; default off.
export function crmIdentityReconciliationEnabled(): boolean {
  return process.env.CRM_IDENTITY_RECONCILIATION === "1";
}

// Separate mutation gate for the Phase 3A reconciler. This lets an environment
// mount the least-privilege credential and run reviewed dry-run coverage before
// the first registry or exception write is possible.
export function crmIdentityReconciliationWritesEnabled(): boolean {
  return process.env.CRM_IDENTITY_RECONCILIATION_WRITES === "1";
}

// Duplicate-candidate persistence is a separate rollout from the established
// identity registry writer. Default OFF: when unset, every identity run still
// executes the exact detector in a rollback-backed counts-only preview, but no
// candidate, event, or audit row survives. Enable only after preview review.
export function crmDuplicateDetectorWritesEnabled(): boolean {
  return process.env.CRM_DUPLICATE_DETECTOR_WRITES === "1";
}

// App-owned Phase 3A fast signal. This is deliberately independent from the
// reconciler and write gates: recurring/batch reconciliation can remain live
// while request-triggered work is paused. The caller also requires both parent
// gates before scheduling, so this switch can never enable writes by itself.
export function crmIdentityPostCommitSignalsEnabled(): boolean {
  return process.env.CRM_IDENTITY_POST_COMMIT_SIGNALS === "1";
}

// Phase 4C relationship snapshot runner. This is separate from the read-only
// CRM_RELATIONSHIPS UI seam and from the Phase 3 identity writer: mounting the
// reconciler for identity maintenance must not make relationship work callable.
// Preview and live mutation are independently owner-gated.
export function crmRelationshipReconciliationEnabled(): boolean {
  return process.env.CRM_RELATIONSHIP_RECONCILIATION === "1";
}

export function crmRelationshipReconciliationWritesEnabled(): boolean {
  return process.env.CRM_RELATIONSHIP_RECONCILIATION_WRITES === "1";
}

// Phase 4E recurring caller gate. A live one-time relationship snapshot remains
// possible with the Phase 4C write gate alone; scheduled/post-commit callers
// must additionally opt in through this independent, exact-value switch.
export function crmRelationshipContinuousRefreshEnabled(): boolean {
  return process.env.CRM_RELATIONSHIP_CONTINUOUS_REFRESH === "1";
}

export function crmRelationshipsEnabled(): boolean {
  return process.env.CRM_RELATIONSHIPS === "1";
}

export function crmDocumentsEnabled(): boolean {
  return process.env.CRM_DOCUMENTS === "1";
}

export function crmConsentEnabled(): boolean {
  return process.env.CRM_CONSENT === "1";
}

export function crmEbacEnforceEnabled(): boolean {
  return process.env.CRM_EBAC_ENFORCE === "1";
}

// Live, read-only CRM reporting. Unlike the synthetic relationship/document
// previews, this seam is environment-agnostic so the same reviewed build can
// be activated independently in dev and production. It remains default-off;
// the page and data seam also require an ADMIN/OPERATIONS session.
export function crmReportingEnabled(): boolean {
  return process.env.CRM_REPORTING === "1";
}

// Central Operations/Admin review queue. The read/workflow surface and the
// machine materializer are independently gated: a deployed queue can remain
// visible while refreshes are paused, and a shadow materialization can be
// verified before the UI is exposed. Both fail closed unless exactly "1".
export function reviewQueueEnabled(): boolean {
  return process.env.REVIEW_QUEUE === "1";
}

export function reviewQueueMaterializationEnabled(): boolean {
  return process.env.REVIEW_QUEUE_MATERIALIZATION === "1";
}

// Durable runtime statement that the recurring queue caller is expected to be
// active. This is deliberately separate from both the UI and materializer
// flags: Operations can pause the scheduler while retaining the queue and its
// existing work, and a manual materialization call must not be mistaken for a
// healthy recurring schedule.
export function reviewQueueSchedulerActive(): boolean {
  return process.env.REVIEW_QUEUE_SCHEDULER_ACTIVE === "1";
}

// Operations/Admin source-health dashboard. The read-only surface is
// independent from the review queue and its materializer so it can be deployed
// dark, validated, and rolled back without pausing either source workflow.
export function dataHealthEnabled(): boolean {
  return process.env.DATA_HEALTH === "1";
}

// Recent receipt capture/display is independent of provider job monitoring.
// The additive table is not gated; navigation, capture and reads default OFF.
export function dataArrivalReceiptsEnabled(): boolean {
  return process.env.DATA_ARRIVAL_RECEIPTS === "1" && dataHealthEnabled()
    && (process.env.APP_ENV === "dev" || process.env.APP_ENV === "prod");
}

// Operations rollout uses APP_ENV because canonical cloud dev also runs with
// NODE_ENV=production. Production needs a separate explicit approval flag in
// addition to the existing parent and child switches. Missing/unknown
// environments fail closed for data routes.
function operationsDataEnvironmentEnabled(): boolean {
  const appEnv = process.env.APP_ENV?.toLowerCase();
  return appEnv === "dev"
    || (appEnv === "prod" && process.env.OPERATIONS_PRODUCTION_ENABLED === "1");
}

export function operationsToolsEnabled(): boolean {
  return process.env.OPERATIONS_TOOLS === "1"
    && operationsDataEnvironmentEnabled();
}

export function operationsTradeReconciliationPreviewEnabled(): boolean {
  return (
    operationsToolsEnabled() &&
    process.env.OPERATIONS_TRADE_RECONCILIATION === "1"
  );
}

export function operationsFeeRequestsPreviewEnabled(): boolean {
  return (
    operationsToolsEnabled() &&
    process.env.OPERATIONS_FEE_REQUESTS === "1"
  );
}

export function epicAcatTransferDashboardEnabled(): boolean {
  return process.env.EPIC_ACAT_TRANSFER_DASHBOARD_TKT314 === "1";
}

export function operationsAcatTransferDashboardEnabled(): boolean {
  return operationsToolsEnabled()
    && epicAcatTransferDashboardEnabled()
    && process.env.SHOW_ACAT_TRANSFER_DASHBOARD_TKT314 === "1";
}

// Client Transfers advisor list (ticket epic, ticket work order). Epic flag
// `epic-acat-advisor-list-tkt324` and sub-feature flag
// `show-acat-advisor-list-tkt338`; both must be exactly "1", default off (unset
// is off). The tracker's own advisor page does not read either flag.
export function epicAcatAdvisorListEnabled(): boolean {
  return process.env.EPIC_ACAT_ADVISOR_LIST_TKT324 === "1";
}

export function acatAdvisorListEnabled(): boolean {
  return epicAcatAdvisorListEnabled()
    && process.env.SHOW_ACAT_ADVISOR_LIST_TKT338 === "1";
}

// Synthetic CRM UI prototypes are intentionally narrower than the underlying
// rollout seams above. Canonical dev runs NODE_ENV=production, so APP_ENV is
// the environment boundary that prevents a copied flag from exposing document
// prototype data in production. Relationships now use the live read-only seam.
function crmDevPreviewEnabled(flagEnabled: boolean): boolean {
  return process.env.APP_ENV?.toLowerCase() === "dev" && flagEnabled;
}

export function crmDocumentsPreviewEnabled(): boolean {
  return crmDevPreviewEnabled(crmDocumentsEnabled());
}

// In-app asset-mapping workspace, read slice (ticket; product key
// epic-aoa-asset-mapping-read, sub-feature of epic-aoa-asset-mapping-workspace).
// Gates the /asset-mapping page AND its read actions, including the read-only
// live pipeline calls. Exact "1" only; default off. Navigation is not affected.
export function assetMappingReadEnabled(): boolean {
  return process.env.EPIC_AOA_ASSET_MAPPING_READ === "1";
}

// In-app asset-mapping workspace, position and account edits (ticket; product
// key epic-aoa-asset-mapping-edits, sub-feature of epic-aoa-asset-mapping-workspace).
// Effective only while the read flag is also on. Gates the edit controls AND the
// seven edit actions. Exact "1" only; default off.
export function assetMappingEditsEnabled(): boolean {
  return assetMappingReadEnabled() && process.env.EPIC_AOA_ASSET_MAPPING_EDITS === "1";
}

// In-app asset-mapping workspace, destinations, source reassignment, and the
// household spreadsheet (ticket; product key epic-aoa-asset-mapping-destinations,
// sub-feature of epic-aoa-asset-mapping-workspace). Effective only while the read
// flag is also on. Gates the destinations section, the Transfers to control, the
// Export CSV button, AND the six destination actions. Exact "1" only; default off.
export function assetMappingDestinationsEnabled(): boolean {
  return assetMappingReadEnabled() && process.env.EPIC_AOA_ASSET_MAPPING_DESTINATIONS === "1";
}

// In-app asset-mapping workspace, client linking (ticket; product key
// epic-aoa-asset-mapping-client-linking, sub-feature of epic-aoa-asset-mapping-workspace).
// Effective only while the read flag is also on. Gates the client-link tab, the
// household card, AND the client-link actions. Exact "1" only; default off.
export function assetMappingClientLinkingEnabled(): boolean {
  return assetMappingReadEnabled() && process.env.EPIC_AOA_ASSET_MAPPING_CLIENT_LINKING === "1";
}

// In-app asset-mapping workspace, PDF, Drive save, and manual scan (product
// key epic-aoa-asset-mapping-documents, sub-feature of
// epic-aoa-asset-mapping-workspace). Effective only while the read flag is on.
// Gates the documents controls, the four documents routes, and the reviewer
// read. Exact "1" only; default off.
export function assetMappingDocumentsEnabled(): boolean {
  return assetMappingReadEnabled() && process.env.EPIC_AOA_ASSET_MAPPING_DOCUMENTS === "1";
}

// In-app asset-mapping workspace, epic release (ticket; product key
// epic-aoa-asset-mapping-workspace). Switches only the Asset Mapping navigation
// entry from the external app to /asset-mapping. Deliberately independent of
// the slice flags above: the read flag is already on in production, so it must
// not move navigation. Exact "1" only; default off.
export function assetMappingWorkspaceEnabled(): boolean {
  return process.env.EPIC_AOA_ASSET_MAPPING_WORKSPACE === "1";
}

// On-demand asset-map import (ticket): a finished scan and a confirmed
// account-type save each run the import, then the open household reloads.
// Independent of every other asset-mapping flag. Exact "1" only; default off.
export function assetMappingOnDemandImportEnabled(): boolean {
  return process.env.EPIC_AOA_ASSET_MAPPING_ON_DEMAND_IMPORT === "1";
}

// Plaid-linked holdings, epic release (ticket). Master kill switch for every
// Plaid-linked holdings surface. Exact "1" only; default off.
export function epicPlaidLinkedHoldingsEnabled(): boolean {
  return process.env.EPIC_PLAID_LINKED_HOLDINGS === "1";
}

// Active Plaid-linked account summaries on the Client Portrait Accounts card
// (ticket). Effective only while the epic flag is also on. Exact "1" only;
// default off.
export function showPlaidLinkedAccountSummariesEnabled(): boolean {
  return epicPlaidLinkedHoldingsEnabled()
    && process.env.SHOW_PLAID_LINKED_ACCOUNT_SUMMARIES === "1";
}

// Admin/Operations on-demand holdings preview on a Plaid-linked account row
// (ticket; Warehouse card 6899). Effective only while the epic flag is also on.
// Exact "1" only; default off.
export function allowPlaidHoldingsPreviewEnabled(): boolean {
  return epicPlaidLinkedHoldingsEnabled()
    && process.env.ALLOW_PLAID_HOLDINGS_PREVIEW === "1";
}

// ACAT book in AoA, epic release (product key epic-acat-ops-workspace-tkt290).
// Prerequisite of every ACAT book sub-feature flag. Exact "1" only; default off.
export function epicAcatOpsWorkspaceEnabled(): boolean {
  return process.env.EPIC_ACAT_OPS_WORKSPACE_TKT290 === "1";
}

// ACAT book workspace on /acat-tracking (product key show-acat-ops-book-tkt293,
// sub-feature of epic-acat-ops-workspace-tkt290). Effective only while the epic
// flag is also on. Exact "1" only; default off.
export function acatOpsBookEnabled(): boolean {
  return epicAcatOpsWorkspaceEnabled()
    && process.env.SHOW_ACAT_OPS_BOOK_TKT293 === "1";
}

// ACAT book edit controls (product key allow-acat-ops-edits-tkt294, sub-feature
// of epic-acat-ops-workspace-tkt290). Exact "1" only; default off.
export function acatOpsEditsEnabled(): boolean {
  return epicAcatOpsWorkspaceEnabled()
    && process.env.ALLOW_ACAT_OPS_EDITS_TKT294 === "1";
}

// ACAT transfer drawer in the book (ticket; product keys
// epic-acat-transfer-drawer-tkt319 and show-acat-transfer-drawer-tkt332).
// Effective only while the book surface is on. Exact "1" only; default off.
export function epicAcatTransferDrawerEnabled(): boolean {
  return process.env.EPIC_ACAT_TRANSFER_DRAWER_TKT319 === "1";
}
export function showAcatTransferDrawerEnabled(): boolean {
  return process.env.SHOW_ACAT_TRANSFER_DRAWER_TKT332 === "1";
}
export function acatTransferDrawerEnabled(): boolean {
  return acatOpsBookEnabled()
    && epicAcatTransferDrawerEnabled()
    && showAcatTransferDrawerEnabled();
}

// Security reconciliation in the transfer drawer (ticket; product keys
// epic-acat-security-recon-tkt320 and show-acat-security-recon-tkt334).
// Effective only while the transfer drawer is on. Exact "1" only; default off.
export function epicAcatSecurityReconEnabled(): boolean {
  return process.env.EPIC_ACAT_SECURITY_RECON_TKT320 === "1";
}
export function showAcatSecurityReconEnabled(): boolean {
  return process.env.SHOW_ACAT_SECURITY_RECON_TKT334 === "1";
}
export function acatSecurityReconEnabled(): boolean {
  return acatTransferDrawerEnabled()
    && epicAcatSecurityReconEnabled()
    && showAcatSecurityReconEnabled();
}

// Day-to-day ACAT book actions (ticket). Surface code reads the epic helper.
// The sub-feature flag is its prerequisite. Exact "1" only; default off.
export function showAcatBookDayToDayActionsEnabled(): boolean {
  return process.env.SHOW_ACAT_BOOK_DAY_TO_DAY_ACTIONS_TKT302 === "1";
}

export function epicAcatBookDayToDayActionsEnabled(): boolean {
  return showAcatBookDayToDayActionsEnabled()
    && process.env.EPIC_ACAT_BOOK_DAY_TO_DAY_ACTIONS_TKT302 === "1";
}

// Tracker column chooser on the ACAT book (ticket). The epic flag is its
// prerequisite; the day-to-day show flag is not read. Exact "1" only.
export function showAcatBookColumnsEnabled(): boolean {
  return process.env.SHOW_ACAT_BOOK_COLUMNS_TKT311 === "1";
}

export function acatBookColumnsEnabled(): boolean {
  return showAcatBookColumnsEnabled()
    && process.env.EPIC_ACAT_BOOK_DAY_TO_DAY_ACTIONS_TKT302 === "1";
}

// ticket custodian administration. Two switches, both exactly "1", default off.
// The epic switch is the product release; the sub-feature switch is ticket's
// screen. Off leaves the custodian library read-only.
export function epicAcatCustodianAdminEnabled(): boolean {
  return process.env.EPIC_ACAT_CUSTODIAN_ADMIN_TKT323 === "1";
}

export function acatCustodianAdminEnabled(): boolean {
  return epicAcatCustodianAdminEnabled() && process.env.SHOW_ACAT_CUSTODIAN_ADMIN_TKT337 === "1";
}

export function custodianAdminAllowed(role: string | null | undefined): boolean {
  return acatCustodianAdminEnabled() && role === "ADMIN";
}

// ticket / ticket. Product keys epic-custodian-database-authority-tkt397
// and show-custodian-authority-library-tkt400. Exact "1" only; default off.
// Off keeps the tracker-backed custodian library.
export function epicCustodianDatabaseAuthorityEnabled(): boolean {
  return process.env.EPIC_CUSTODIAN_DATABASE_AUTHORITY_TKT397 === "1";
}

export function showCustodianAuthorityLibraryEnabled(): boolean {
  return epicCustodianDatabaseAuthorityEnabled()
    && process.env.SHOW_CUSTODIAN_AUTHORITY_LIBRARY_TKT400 === "1";
}

// Custodian authority storage (ticket; key rollout-custodian-authority-storage-tkt399,
// epic epic-custodian-database-authority-tkt397). Per-surface switch: Always-On Advice
// custodian authority writes run only while this is exactly "1" and custodianAdminAllowed()
// admits the actor. Default off.
export function custodianAuthorityStorageWritesEnabled(): boolean {
  return process.env.ROLLOUT_CUSTODIAN_AUTHORITY_STORAGE_TKT399 === "1";
}

// Transfer fee and reimbursement section in the ACAT book drawer (ticket;
// product keys epic-acat-fee-reimbursement-tkt318 and
// show-acat-fee-reimbursement-tkt333). Both switches exact "1"; default off.
export function epicAcatFeeReimbursementEnabled(): boolean {
  return process.env.EPIC_ACAT_FEE_REIMBURSEMENT_TKT318 === "1";
}

export function acatFeeReimbursementEnabled(): boolean {
  return epicAcatFeeReimbursementEnabled()
    && process.env.SHOW_ACAT_FEE_REIMBURSEMENT_TKT333 === "1";
}

// Reimbursement preview and confirm in the fee section (ticket; product keys
// epic-acat-fee-reimbursement-tkt318 and show-acat-fee-request-create-tkt350).
// Log Reimbursement then creates one Pending Operations Tools fee request after
// the user reviews and confirms it. The fee release is its prerequisite. Exact
// "1" only; default off, which keeps the ticket link-out.
export function acatFeeRequestCreateEnabled(): boolean {
  return acatFeeReimbursementEnabled()
    && process.env.SHOW_ACAT_FEE_REQUEST_CREATE_TKT350 === "1";
}

// Paperwork section in the ACAT transfer drawer (ticket; product keys
// epic-acat-paperwork-tkt321 and show-acat-paperwork-tkt335). The section
// renders inside the drawer, so the drawer must be on too. Exact "1" only;
// default off.
export function epicAcatPaperworkEnabled(): boolean {
  return process.env.EPIC_ACAT_PAPERWORK_TKT321 === "1";
}
export function showAcatPaperworkEnabled(): boolean {
  return process.env.SHOW_ACAT_PAPERWORK_TKT335 === "1";
}
export function acatPaperworkEnabled(): boolean {
  return acatTransferDrawerEnabled()
    && epicAcatPaperworkEnabled()
    && showAcatPaperworkEnabled();
}

// Field history on the open transfer (ticket). Product keys
// epic-acat-field-history-tkt322 (epic) and show-acat-field-history-tkt336
// (this work order). The epic switch is the prerequisite. Exact "1" only;
// default off.
export function epicAcatFieldHistoryEnabled(): boolean {
  return process.env.EPIC_ACAT_FIELD_HISTORY_TKT322 === "1";
}

export function acatFieldHistoryEnabled(): boolean {
  return epicAcatFieldHistoryEnabled()
    && process.env.SHOW_ACAT_FIELD_HISTORY_TKT336 === "1";
}

// Trade Requests workspace, epic release (ticket; product key
// epic-trade-requests-workspace-tkt361). Moves the Trade Requests navigation
// entry from the standalone app to /trade-requests for ADMIN, OPERATIONS and
// ADVISOR and serves the workspace addresses. Exact "1" only; default off.
export function tradeRequestsWorkspaceEnabled(): boolean {
  return process.env.EPIC_TRADE_REQUESTS_WORKSPACE === "1";
}

// Trade Request backend move (ticket): New Request copy that promises no
// engine run and no generated execution plan (ticket; product key
// show-trade-requests-no-plan-copy). Turned on in the same step that turns
// standalone plan generation off. Exact "1" only, epic master too; default off
// keeps today's copy.
export function tradeRequestsNoPlanCopyEnabled(): boolean {
  return process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE === "1" && process.env.TRADE_REQUESTS_NO_PLAN_COPY === "1";
}

// Trade Request backend move (ticket, epic key epic-trade-requests-backend-move): ADMIN roster administration
// in AOA (ticket, key allow-trade-requests-roster-admin). Exact "1" on both; default off.
export function tradeRequestsRosterAdminEnabled(): boolean {
  return process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE === "1" && process.env.TRADE_REQUESTS_ROSTER_ADMIN === "1";
}

// Trade Request backend move (ticket): AOA's weekday Trade Request digest job (ticket, key
// rollout-trade-requests-digest-job). Exact "1" only; default off; the epic master must be "1". Posting also
// requires AOA to be the digest sender in trade_request.serving_state.
export function tradeRequestsDigestJobEnabled(): boolean {
  return process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE === "1" && process.env.TRADE_REQUESTS_DIGEST_JOB === "1";
}

// Trade Request backend move (ticket): circuit breaker for AOA's Trade Request Slack posts (ticket, key
// circuit-breaker-trade-requests-slack). On unless TRADE_REQUESTS_SLACK is "0"; the epic master must be "1".
export function tradeRequestsSlackEnabled(): boolean {
  return process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE === "1" && process.env.TRADE_REQUESTS_SLACK !== "0";
}

// Trade Request backend move (ticket): the AOA weekday drift job (ticket, key
// rollout-trade-requests-drift-job). "shadow" or "live" only while the epic master is exactly "1";
// any other value is off. Live mode also requires AOA to be the drift sender in the serving state.
export type TradeRequestsDriftJobMode = "off" | "shadow" | "live";
export function tradeRequestsDriftJobMode(): TradeRequestsDriftJobMode {
  if (process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE !== "1") return "off";
  const mode = process.env.TRADE_REQUESTS_DRIFT_JOB;
  return mode === "shadow" || mode === "live" ? mode : "off";
}

// Drift reads and override writes behind the Drift screens (ticket). Exact "1" on the epic master; the
// routes are also refused unless Trade Requests are AOA-served.
export function tradeRequestsDriftRoutesEnabled(): boolean {
  return process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE === "1";
}

// Trade Request backend move (ticket, epic key epic-trade-requests-backend-move): native AOA Trade Request
// handlers behind migration-trade-requests-native-backend (ticket reads, ticket writes). They run only while
// the serving state is AOA as well. Exact "1" on both; default off.
export function tradeRequestsNativeEnabled(): boolean {
  return process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE === "1" && process.env.TRADE_REQUESTS_NATIVE === "1";
}

// Native Trade Request reads (ticket): serve the copied client and account records when the ported feeds are not
// configured, as the standalone service does without Warehouse. Exact "1"; default off, so production fails closed.
// Owner-set on aoa-dev (no feeds there); never set in production.
export function tradeRequestsLocalSourcesEnabled(): boolean {
  return process.env.TRADE_REQUESTS_LOCAL_SOURCES === "1";
}

// Trade Request backend move (ticket): the Drift and Roster screens in the Trade Requests workspace
// (ticket, key show-trade-requests-drift-view). Exact "1" on the epic master and this switch; default
// off. The screens also need Trade Requests to be AOA-served; Roster also needs
// tradeRequestsRosterAdminEnabled() and an ADMIN.
export function tradeRequestsDriftViewEnabled(): boolean {
  return process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE === "1" && process.env.TRADE_REQUESTS_DRIFT_VIEW === "1";
}

// Custodian authority (ticket): deliver saved revisions to Tracker (ticket,
// key rollout-custodian-change-delivery-tkt404). Exact "1" only. Default off.
// This surface does not also read the epic switch.
export function custodianChangeDeliveryEnabled(): boolean {
  return process.env.ROLLOUT_CUSTODIAN_CHANGE_DELIVERY_TKT404 === "1";
}

// ticket custodian snapshot import. Exact "1" on this surface only.
// Does not read the epic switch or the ticket storage-write switch.
export function custodianSnapshotImportEnabled(): boolean {
  return process.env.MIGRATION_CUSTODIAN_SNAPSHOT_IMPORT_TKT403 === "1";
}
