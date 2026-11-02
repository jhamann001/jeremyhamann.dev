import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { INGEST_ASSET_MAP, writeAudit } from "@/lib/audit";
import { assetMappingEditsEnabled } from "@/lib/flags";
import { withIngestScope } from "@/lib/ingest/scope";
import {
  AssetMapError,
  assetMapBaseUrl,
  fetchHouseholdsPage,
  flattenHouseholds,
  type AccountRow,
  type FlattenedRows,
  type HouseholdRow,
  type PositionRow,
} from "@/lib/data/asset-map";
import { diagnoseRunIdentities } from "@/lib/data/asset-map-run-identity/diagnostic";
import {
  applyRunIdentities,
  buildIdentityCensus,
  runIdentityMode,
  type CensusPage,
  type IdentityWriteOutcome,
} from "@/lib/data/asset-map-run-identity/sync";

// The one asset-map import (ticket). The scheduled route, the scan-triggered
// import, and the save-triggered import all run through runAssetMapImport.
//
// LOCK: every write tx first takes one transaction-scoped advisory lock, so a
// second import's commit waits until the first one's tx ends.
//
// OLDER PULL: pulledAt is taken before the first page fetch. An account whose
// stored account_type_overridden_at is at or after pulledAt was reclassified
// after this pull began (an AoA save, or a newer import carrying a newer
// pipeline edit), so this pull keeps the stored account-type columns.

const SOURCE = "statement-pipeline";
const ENDPOINT = "/api/v1/households";
// Per-page size (contract cap is ≤200). At ~27 households one page suffices;
// the cap keeps a runaway response bounded per request.
const PER_PAGE = 200;
// Hard ceiling on pages fetched per run so a broken cursor/total can't loop
// forever (design §4.4). 50 pages × 200 = 10k households — far above reality.
const MAX_PAGES = 50;
// Cap total rows (households + accounts + positions) per run so a runaway source
// response can't blow the 120s transaction budget → 413 above it (design §4.4).
const MAX_ITEMS = 20000;

export type AssetMapImportResult = { status: number; body: Record<string, unknown> };

async function upsertHousehold(tx: Prisma.TransactionClient, r: HouseholdRow): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO mirror.acat_asset_map_household
      (id, client_name, run_number, processed_at, source_created_at, superseded_by,
       source_folder_id, total_value, total_accounts, total_positions, status_tallies)
    VALUES
      (${r.id}, ${r.client_name}, ${r.run_number}, ${r.processed_at}, ${r.source_created_at}, ${r.superseded_by},
       ${r.source_folder_id}, ${r.total_value}, ${r.total_accounts}, ${r.total_positions}, ${r.status_tallies}::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      client_name       = EXCLUDED.client_name,
      run_number        = EXCLUDED.run_number,
      processed_at      = EXCLUDED.processed_at,
      source_created_at = EXCLUDED.source_created_at,
      superseded_by     = EXCLUDED.superseded_by,
      source_folder_id  = EXCLUDED.source_folder_id,
      total_value       = EXCLUDED.total_value,
      total_accounts    = EXCLUDED.total_accounts,
      total_positions   = EXCLUDED.total_positions,
      status_tallies    = EXCLUDED.status_tallies,
      synced_at         = now()
  `;
}

async function upsertAccount(tx: Prisma.TransactionClient, r: AccountRow, pulledAt: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO mirror.acat_asset_map_account AS cur
      (id, household_id, custodian, account_type, account_type_raw, account_type_other,
       account_type_override, account_number, account_holder, statement_date, cash_balance,
       total_value, is_rollover, is_inherited, inherited_notes, apex_restriction,
       cost_basis_status, validation_status, validation_issues, statement_age_days,
       is_stale, is_deleted, custodian_intel, account_type_overridden_by, account_type_overridden_at)
    VALUES
      (${r.id}, ${r.household_id}, ${r.custodian}, ${r.account_type}, ${r.account_type_raw}, ${r.account_type_other},
       ${r.account_type_override}, ${r.account_number}, ${r.account_holder}, ${r.statement_date}, ${r.cash_balance},
       ${r.total_value}, ${r.is_rollover}, ${r.is_inherited}, ${r.inherited_notes}, ${r.apex_restriction},
       ${r.cost_basis_status}, ${r.validation_status}, ${r.validation_issues}::jsonb, ${r.statement_age_days},
       ${r.is_stale}, ${r.is_deleted}, ${r.custodian_intel}::jsonb, ${r.account_type_overridden_by}, ${r.account_type_overridden_at})
    ON CONFLICT (id) DO UPDATE SET
      household_id          = EXCLUDED.household_id,
      custodian             = EXCLUDED.custodian,
      account_type = CASE WHEN cur.account_type_overridden_at >= ${pulledAt}::timestamptz THEN cur.account_type ELSE EXCLUDED.account_type END,
      account_type_raw      = EXCLUDED.account_type_raw,
      account_type_other = CASE WHEN cur.account_type_overridden_at >= ${pulledAt}::timestamptz THEN cur.account_type_other ELSE EXCLUDED.account_type_other END,
      account_type_override = EXCLUDED.account_type_override,
      account_number        = EXCLUDED.account_number,
      account_holder        = EXCLUDED.account_holder,
      statement_date        = EXCLUDED.statement_date,
      cash_balance          = EXCLUDED.cash_balance,
      total_value           = EXCLUDED.total_value,
      is_rollover = CASE WHEN cur.account_type_overridden_at >= ${pulledAt}::timestamptz THEN cur.is_rollover ELSE EXCLUDED.is_rollover END,
      is_inherited = CASE WHEN cur.account_type_overridden_at >= ${pulledAt}::timestamptz THEN cur.is_inherited ELSE EXCLUDED.is_inherited END,
      inherited_notes       = EXCLUDED.inherited_notes,
      apex_restriction = CASE WHEN cur.account_type_overridden_at >= ${pulledAt}::timestamptz THEN cur.apex_restriction ELSE EXCLUDED.apex_restriction END,
      cost_basis_status     = EXCLUDED.cost_basis_status,
      validation_status     = EXCLUDED.validation_status,
      validation_issues     = EXCLUDED.validation_issues,
      statement_age_days    = EXCLUDED.statement_age_days,
      is_stale              = EXCLUDED.is_stale,
      is_deleted            = EXCLUDED.is_deleted,
      custodian_intel       = EXCLUDED.custodian_intel,
      account_type_overridden_by = CASE WHEN cur.account_type_overridden_at >= ${pulledAt}::timestamptz THEN cur.account_type_overridden_by ELSE EXCLUDED.account_type_overridden_by END,
      account_type_overridden_at = CASE WHEN cur.account_type_overridden_at >= ${pulledAt}::timestamptz THEN cur.account_type_overridden_at ELSE EXCLUDED.account_type_overridden_at END,
      synced_at             = now()
  `;
}

async function upsertPosition(tx: Prisma.TransactionClient, r: PositionRow): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO mirror.acat_asset_map_position
      (id, account_id, symbol, description, quantity, market_value, asset_type,
       transfer_eligible, classification_source, transfer_notes, effective_notes,
       notion_check, cost_basis, cost_basis_granularity, lots, original_transfer_eligible,
       override_status, override_notes, overridden_by, overridden_at, transferring,
       transferring_by, transferring_at, effective_status, is_deleted)
    VALUES
      (${r.id}, ${r.account_id}, ${r.symbol}, ${r.description}, ${r.quantity}, ${r.market_value}, ${r.asset_type},
       ${r.transfer_eligible}, ${r.classification_source}, ${r.transfer_notes}, ${r.effective_notes},
       ${r.notion_check}::jsonb, ${r.cost_basis}, ${r.cost_basis_granularity}, ${r.lots}::jsonb, ${r.original_transfer_eligible},
       ${r.override_status}, ${r.override_notes}, ${r.overridden_by}, ${r.overridden_at}, ${r.transferring},
       ${r.transferring_by}, ${r.transferring_at}, ${r.effective_status}, false)
    ON CONFLICT (id) DO UPDATE SET
      account_id                 = EXCLUDED.account_id,
      symbol                     = EXCLUDED.symbol,
      description                = EXCLUDED.description,
      quantity                   = EXCLUDED.quantity,
      market_value               = EXCLUDED.market_value,
      asset_type                 = EXCLUDED.asset_type,
      transfer_eligible          = EXCLUDED.transfer_eligible,
      classification_source      = EXCLUDED.classification_source,
      transfer_notes             = EXCLUDED.transfer_notes,
      effective_notes            = EXCLUDED.effective_notes,
      notion_check               = EXCLUDED.notion_check,
      cost_basis                 = EXCLUDED.cost_basis,
      cost_basis_granularity     = EXCLUDED.cost_basis_granularity,
      lots                       = EXCLUDED.lots,
      original_transfer_eligible = EXCLUDED.original_transfer_eligible,
      override_status            = EXCLUDED.override_status,
      override_notes             = EXCLUDED.override_notes,
      overridden_by              = EXCLUDED.overridden_by,
      overridden_at              = EXCLUDED.overridden_at,
      transferring               = EXCLUDED.transferring,
      transferring_by            = EXCLUDED.transferring_by,
      transferring_at            = EXCLUDED.transferring_at,
      effective_status           = EXCLUDED.effective_status,
      is_deleted                 = false,
      synced_at                  = now()
  `;
}

export async function runAssetMapImport({ dryRun }: { dryRun: boolean }): Promise<AssetMapImportResult> {
  // 2. Config. STATEMENT_PIPELINE_URL is the pipeline base URL (== the OIDC audience).
  //    Unset → config error (there is no known default URL yet). STATIC marker
  //    log only; never the url.
  const baseUrl = assetMapBaseUrl();
  if (!baseUrl) {
    console.error("[cron:asset-map] pipeline_url_missing");
    return { status: 503, body: { error: "config_error" } };
  }

  const runId = crypto.randomUUID();
  // Log-injection-safe run id (security scanner CWE-117 idiom — encodeURIComponent is the
  // recognized sanitizer).
  const safeRunId = encodeURIComponent(runId).slice(0, 256);
  // Run identity (ticket): "off" leaves this route exactly as before — no
  // identity table reads or writes and an unchanged response.
  const identityMode = runIdentityMode();
  const identityOn = identityMode !== "off";
  const notAttempted = (reason: string) =>
    identityOn ? { identity: { mode: identityMode, status: "not_attempted", reason } } : {};

  // 3. Pull EVERY page BEFORE opening the write tx. Any pipeline failure aborts
  //    here (502) with NO tx opened → a broken source can never half-write. The
  //    loop stops when the fetched count covers `total`, a page comes back empty,
  //    or MAX_PAGES is hit (a broken cursor/total guard).
  const pulledAt = new Date().toISOString();
  const rawHouseholds: unknown[] = [];
  const censusPages: CensusPage[] = [];
  let pages = 0;
  let truncated = false;
  try {
    let page = 1;
    while (page <= MAX_PAGES) {
      const pd = await fetchHouseholdsPage(baseUrl, page, PER_PAGE);
      pages += 1;
      rawHouseholds.push(...pd.households);
      if (identityOn) {
        censusPages.push({ requestedPage: page, requestedPerPage: PER_PAGE, envelope: pd.envelope, households: pd.households });
      }
      // Terminate on the ACCUMULATED count, not page*per_page — robust to a
      // short non-terminal page (a source that under-fills a middle page can't
      // make us stop early and under-fetch).
      if (pd.households.length === 0 || rawHouseholds.length >= pd.total) break;
      page += 1;
    }
    truncated = page > MAX_PAGES;
  } catch (e) {
    // fetchHouseholdsPage already logged status/marker (no url/token/body).
    const reason = e instanceof AssetMapError ? e.reason : "pull_failed";
    console.error(`[cron:asset-map] run_id=${safeRunId} pull_failed reason=${reason}`);
    return { status: 502, body: { error: "pipeline_error", ...notAttempted("fetch_failed") } };
  }

  // 4. Flatten to three FK-ordered row arrays. Per-row id validation → rejected[]
  //    (never aborts the batch — the account-aum posture).
  const flat: FlattenedRows = flattenHouseholds(rawHouseholds, undefined, { transferringText: assetMappingEditsEnabled() });
  const counts = {
    households: flat.households.length,
    accounts: flat.accounts.length,
    positions: flat.positions.length,
  };
  const total = counts.households + counts.accounts + counts.positions;
  // superseded_by is carried verbatim; count the superseded households for the
  // audit/response (we do NOT compute liveness — the source owns it).
  const superseded = flat.households.filter((h) => h.superseded_by != null).length;

  // 5. Row cap (before any write) — a runaway source must not blow the tx budget.
  if (total > MAX_ITEMS) return { status: 413, body: { error: "too_large", ...notAttempted("row_cap") } };

  // 6. Persist in ONE ingest tx, FK-parent order (household → account →
  //    position), then the same-tx audit row (ADR-8). dryRun writes NOTHING (no
  //    rows, no audit row) — the account-aum contract.
  if (!dryRun) {
    try {
      await withIngestScope(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('aoa:asset-map-import', 0))`;
        for (const h of flat.households) await upsertHousehold(tx, h);
        for (const a of flat.accounts) await upsertAccount(tx, a, pulledAt);
        for (const p of flat.positions) await upsertPosition(tx, p);
        await writeAudit(
          tx,
          { role: "INGEST", email: null },
          {
            action: INGEST_ASSET_MAP,
            entityType: "ingest_run",
            entityId: runId,
            detail: {
              source: SOURCE,
              endpoint: ENDPOINT,
              pages,
              households: counts.households,
              accounts: counts.accounts,
              positions: counts.positions,
              upserted: total,
              rejected: flat.rejected.length,
              superseded,
              dry_run: dryRun,
            },
          },
        );
      });
    } catch {
      console.error(`[cron:asset-map] run_id=${safeRunId} tx_failed`);
      // A failed base import permits NO identity writes, even for older parents.
      return { status: 500, body: { error: "internal", ...notAttempted("base_failed") } };
    }
  }

  // 7. Response. would_upsert on dryRun, upserted on a live run. Counts only —
  //    never row contents (unmasked account numbers / client names).
  const shared = {
    total,
    rejected: flat.rejected,
    superseded,
    pages,
    source: SOURCE,
  };
  const base = dryRun ? { would_upsert: counts, ...shared } : { upserted: counts, ...shared };
  if (!identityOn) return { status: 200, body: base };

  // 8. Identity phase — only after the base tx committed (or on dryRun, where
  //    nothing is written). Preview and dryRun do read-only comparison; write
  //    mode applies a complete census in a SEPARATE tx. Counts only.
  const census = buildIdentityCensus(censusPages, { truncated, maxPages: MAX_PAGES });
  const baseStatus = dryRun ? "dry_run" : "committed";
  if (dryRun || identityMode === "preview") {
    const diagnostics = await diagnoseRunIdentities(census, {
      mode: identityMode,
      dryRun,
      pulledRunIds: new Set(flat.households.map((h) => h.id)),
    });
    // The log line carries only census-derived counts and reason codes. The
    // diagnostics object records the request's dryRun flag, so nothing from it
    // is written to the log (security scanner CWE-117); the response below carries it.
    const censusReasons = encodeURIComponent(census.reasons.join(",") || "none").slice(0, 256);
    console.info(
      `[cron:asset-map] run_id=${safeRunId} identity mode=${identityMode} status=previewed` +
        ` census_complete=${census.complete ? "true" : "false"} reasons=${censusReasons}` +
        ` observed=${census.runs.observed}`,
    );
    return {
      status: 200,
      body: {
        ...base,
        base_status: baseStatus,
        identity: { mode: identityMode, status: "previewed", diagnostics },
      },
    };
  }

  const outcome: IdentityWriteOutcome = await applyRunIdentities(census, { runId, source: SOURCE, endpoint: ENDPOINT });
  const detail =
    outcome.status === "applied"
      ? `inserted=${outcome.counts.inserted} applied=${outcome.counts.sourceApplied} history=${outcome.counts.historyRows}` +
        ` quarantined=${outcome.counts.quarantinedEqualVersion + outcome.counts.quarantinedUnreviewed + census.runs.quarantined}`
      : outcome.status === "blocked"
        ? `reasons=${outcome.reasons.join(",")}`
        : `reason=${outcome.reason}`;
  const log = outcome.status === "failed" ? console.error : console.info;
  log(`[cron:asset-map] run_id=${safeRunId} identity mode=write status=${outcome.status} ${detail}`);
  return {
    status: outcome.status === "failed" ? 500 : 200,
    body: {
      ...base,
      base_status: baseStatus,
      identity: {
        mode: identityMode,
        ...outcome,
        census: {
          complete: census.complete,
          reasons: census.reasons,
          pages: census.pages,
          total: census.total,
          schema_status: census.schemaStatus,
          runs: census.runs,
        },
      },
    },
  };
}
