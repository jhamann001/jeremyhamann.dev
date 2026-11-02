import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import {
  INGEST_ASSET_MAP_MATCH,
  INGEST_ASSET_MAP_ACCOUNT_LINK,
  writeAudit,
} from "@/lib/audit";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { listLinksByStatus, setLink } from "@/lib/data/asset-map-link";
import { matchHousehold, normalizeName, type ClientCandidate } from "@/lib/data/asset-map-match";
import {
  listAccountLinksByFolder,
  replaceAccountOwnerCandidates,
  resolveDeterministicOwners,
  type AccountOwner,
} from "@/lib/data/asset-map-account-link";
import { matchAccountOwners } from "@/lib/data/asset-map-account-match";

// Node runtime: crypto (run id) + Prisma. Asset-mapping Phase-2 (P2.1) RECONCILE
// pass — the "matching brain" entrypoint. A scheduled/internal POST reads the
// LIVE mapping households (mirror.acat_asset_map_household, superseded_by IS NULL,
// source_folder_id NOT NULL) + the candidate AOA clients (mirror.client), runs the
// PURE fuzzy name-match lib (lib/data/asset-map-match) per household, and persists
// the tiered verdict into mirror.acat_asset_map_link through the P2.0 seam
// (setLink). See docs/planning/asset-mapping/phase2-person-link-design.md (§4.2).
//
// Mirrors app/api/cron/asset-map/route.ts EXACTLY: requireIngestToken → 401 (same
// bearer), ?dryRun=1, ONE withIngestScope tx, same-tx writeAudit, MAX_* guard,
// sanitized run id, 405 on non-POST. Auth reuses INGEST_TOKEN; no new secret. The
// Cloud Scheduler job + /api/cron middleware exclusion + restrictServiceUsage
// allow-list entry are out-of-band gcloud steps, NOT this PR.
//
// IDEMPOTENCY / SAFETY (design §4.2): a human decision NEVER loses. Rows already
// CONFIRMED or REJECTED are left UNTOUCHED (counted `preserved`) — only
// UNMATCHED/AUTO_LINKED/NEEDS_REVIEW rows are (re)written. So an ops confirmation
// survives every future reconcile, exactly like it survives re-scans (the link is
// folder-keyed).
//
// NO-PII / NO-LOG (design §6): only counts + a sanitized run id ever leave this
// route — never a client_name, never an account number. The audit detail is
// counts-only; error bodies are static strings.
export const runtime = "nodejs";

const SOURCE = "acat-asset-map";
// Bound the work per run so a runaway mirror can't blow the tx budget (the
// asset-map MAX_ITEMS idiom). ~tens of live households in reality; 20k is a wide
// ceiling → 413 above it.
const MAX_HOUSEHOLDS = 20000;

type ErrorBody = { error: string };
const err = (error: string, status: number) =>
  Response.json({ error } satisfies ErrorBody, { status });

// Shared 405 (NOT exported — Next rejects non-Route exports); each verb returns
// it, guaranteeing our body over Next's default.
function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

// Raw read shapes (snake_case, as the DB returns them).
type LiveHouseholdRow = { source_folder_id: string; client_name: string | null };
type ClientRow = {
  sf_id: string;
  household_id: string | null;
  first_name: string | null;
  last_name: string | null;
  cedar_ridge_user_id: string | null;
};

/** LIVE mapping households, one row per durable folder (design §4.2 / D-d: only
 *  superseded_by IS NULL AND source_folder_id IS NOT NULL — folder-less rows have
 *  no durable key and are excluded). DISTINCT ON collapses any duplicate live
 *  rows per folder to the most recently processed. */
async function readLiveHouseholds(tx: Prisma.TransactionClient): Promise<LiveHouseholdRow[]> {
  return tx.$queryRaw<LiveHouseholdRow[]>`
    SELECT DISTINCT ON (source_folder_id) source_folder_id, client_name
    FROM mirror.acat_asset_map_household
    WHERE superseded_by IS NULL AND source_folder_id IS NOT NULL
    ORDER BY source_folder_id, processed_at DESC NULLS LAST, synced_at DESC`;
}

/** Candidate AOA clients — the match targets. Excludes the retired
 *  households-as-clients placeholder rows (sf_id = household_id), the
 *  lib/data/clients.ts idiom, so the scorer never matches a placeholder. */
async function readCandidateClients(tx: Prisma.TransactionClient): Promise<ClientCandidate[]> {
  const rows = await tx.$queryRaw<ClientRow[]>`
    SELECT sf_id, household_id, first_name, last_name, cedar_ridge_user_id
    FROM mirror.client
    WHERE household_id IS NULL OR sf_id <> household_id`;
  return rows.map((r) => ({
    clientSfId: r.sf_id,
    householdSfId: r.household_id,
    cedarRidgeUserId: r.cedar_ridge_user_id,
    firstName: r.first_name,
    lastName: r.last_name,
  }));
}

type RunCounts = {
  households_scored: number;
  auto_linked: number;
  needs_review: number;
  unmatched: number;
  preserved: number;
};

// ---------------------------------------------------------------------------
// ACCOUNT PASS (P2.5, design §8.5). Runs AFTER the folder pass, inside the SAME
// ingest tx, for every live account under a folder whose link is AUTO_LINKED /
// CONFIRMED. Resolves each account's account_holder → the owning person(s) against
// the folder's resolved household members (a tiny pool), multi-owner native, and
// persists via replaceAccountOwnerCandidates. Human-decided owner rows
// (CONFIRMED/REJECTED) are preserved — the account is skipped wholesale. NO PII in
// the audit (counts only, never a holder name or account number, design §6).
// ---------------------------------------------------------------------------
type AccountRunCounts = {
  accounts_scored: number;
  account_auto_linked: number;
  account_needs_review: number;
  account_unmatched: number;
  accounts_preserved: number;
  accounts_unkeyable: number;
};

// PII-SAFE diagnostic for the unkeyable bucket (design §8.3 / D-h). Groups the
// no-durable-key accounts by account_type and which id was missing, so the
// unkeyable count is explainable (source parse gap vs summary/placeholder rows)
// without a DB read. account_type is a category, NEVER a holder name or number —
// safe in the response and the counts-only audit (§6).
type UnkeyableTypeCounts = {
  both_null: number;
  custodian_null: number;
  number_null: number;
};
type UnkeyableBreakdown = Record<string, UnkeyableTypeCounts>;

// Raw live-account read shape (snake_case).
type LiveAccountRow = {
  custodian: string | null;
  account_number: string | null;
  account_holder: string | null;
  account_type: string | null;
  total_value: unknown;
};

/** The folder's resolved household members — the account matcher's candidate pool
 *  (mirror.client scoped to the folder's confirmed household, placeholder rows
 *  excluded, the readCandidateClients idiom narrowed to one household). */
async function readHouseholdMembers(
  tx: Prisma.TransactionClient,
  householdSfId: string,
): Promise<ClientCandidate[]> {
  const rows = await tx.$queryRaw<ClientRow[]>`
    SELECT sf_id, household_id, first_name, last_name, cedar_ridge_user_id
    FROM mirror.client
    WHERE household_id = ${householdSfId}
      AND (household_id IS NULL OR sf_id <> household_id)`;
  return rows.map((r) => ({
    clientSfId: r.sf_id,
    householdSfId: r.household_id,
    cedarRidgeUserId: r.cedar_ridge_user_id,
    firstName: r.first_name,
    lastName: r.last_name,
  }));
}

/** Live accounts under a durable folder — join the live household UUID (the
 *  readHouseholdSummaries DISTINCT-ON idiom) to mirror.acat_asset_map_account. The
 *  caller skips accounts with NULL custodian OR NULL account_number (unkeyable). */
async function readLiveAccounts(
  tx: Prisma.TransactionClient,
  sourceFolderId: string,
): Promise<LiveAccountRow[]> {
  return tx.$queryRaw<LiveAccountRow[]>`
    WITH live AS (
      SELECT DISTINCT ON (source_folder_id) source_folder_id, id
      FROM mirror.acat_asset_map_household
      WHERE superseded_by IS NULL
        AND source_folder_id IS NOT NULL
        AND source_folder_id = ${sourceFolderId}
      ORDER BY source_folder_id, processed_at DESC NULLS LAST, synced_at DESC
    )
    SELECT a.custodian, a.account_number, a.account_holder, a.account_type, a.total_value
    FROM live
    JOIN mirror.acat_asset_map_account a ON a.household_id = live.id`;
}

/** Folder-scoped account key (design §8.3), for the preserved-account set. */
const acctKey = (custodian: string, accountNumber: string): string =>
  `${custodian} ${accountNumber}`;

// Discriminated result the tx callback returns so the guard maps cleanly to 413
// without a throw (a throw would roll back and surface as a generic 500).
type ScopeResult =
  | {
      ok: true;
      counts: RunCounts;
      accountCounts: AccountRunCounts;
      unkeyableBreakdown: UnkeyableBreakdown;
    }
  | { ok: false; reason: "too_large" };

export async function POST(req: Request): Promise<Response> {
  // 1. Auth — the same bearer gate the push ingest + other cron routes use.
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const runId = crypto.randomUUID();
  // Log-injection-safe run id (security scanner CWE-117 idiom — encodeURIComponent is the
  // recognized sanitizer).
  const safeRunId = encodeURIComponent(runId).slice(0, 256);

  // 2. ONE ingest tx: read live households + candidate clients (ingest_rw has
  //    SELECT + a USING(true) policy on mirror.*), score each household, persist
  //    the tier via setLink (skipped on dryRun), then the same-tx audit row.
  //
  //    SCALE NOTE: the CPU scoring (matchHousehold per household × candidate
  //    clients) runs INSIDE the write tx. Acceptable at current scale — tens of
  //    live households, bounded hard by MAX_HOUSEHOLDS — and ingest_rw is the sole
  //    mirror writer so a longer-held tx never blocks app traffic. If the mapping
  //    volume grows materially, move the scoring OUT of the tx (read → score in
  //    memory → open the tx only for the setLink writes + audit). Future opt, not
  //    needed now.
  let result: ScopeResult;
  try {
    result = await withIngestScope(async (tx): Promise<ScopeResult> => {
      const households = await readLiveHouseholds(tx);
      if (households.length > MAX_HOUSEHOLDS) return { ok: false, reason: "too_large" };

      const clients = await readCandidateClients(tx);

      // Human decisions are sacrosanct — never overwrite a CONFIRMED/REJECTED row
      // (design §4.2). Reads build the preserved-folder set; AUTO_LINKED is also
      // needed to feed the P2.5 account pass (folders whose household is resolved).
      const [confirmed, rejected, autoLinkedFolders] = await Promise.all([
        listLinksByStatus(tx, "CONFIRMED"),
        listLinksByStatus(tx, "REJECTED"),
        listLinksByStatus(tx, "AUTO_LINKED"),
      ]);
      const preservedFolders = new Set(
        [...confirmed, ...rejected].map((l) => l.sourceFolderId),
      );

      const counts: RunCounts = {
        households_scored: 0,
        auto_linked: 0,
        needs_review: 0,
        unmatched: 0,
        preserved: 0,
      };

      for (const h of households) {
        if (preservedFolders.has(h.source_folder_id)) {
          counts.preserved += 1;
          continue;
        }
        counts.households_scored += 1;
        // Names only for now — custodian/DTCC corroboration (design §3.3) is a
        // documented follow-on; the lib accepts a corroboration fn when wired.
        const match = matchHousehold(normalizeName(h.client_name), clients);
        if (match.status === "AUTO_LINKED") counts.auto_linked += 1;
        else if (match.status === "NEEDS_REVIEW") counts.needs_review += 1;
        else counts.unmatched += 1;

        if (!dryRun) {
          await setLink(tx, {
            sourceFolderId: h.source_folder_id,
            clientSfId: match.clientSfId,
            cedarRidgeUserId: match.cedarRidgeUserId,
            householdSfId: match.householdSfId,
            matchStatus: match.status,
            confidence: match.confidence,
          });
        }
      }

      // Same-tx audit row — counts only, NEVER names/account numbers. Written on
      // BOTH dryRun and live (dryRun's ONLY write is this row).
      await writeAudit(
        tx,
        { role: "INGEST", email: null },
        {
          action: INGEST_ASSET_MAP_MATCH,
          entityType: "ingest_run",
          entityId: runId,
          detail: { source: SOURCE, ...counts, dry_run: dryRun },
        },
      );

      // -------------------------------------------------------------------
      // ACCOUNT PASS (P2.5, design §8.5). For every live account under a folder
      // whose link is AUTO_LINKED / CONFIRMED and has a resolved household, resolve
      // account_holder → owning person(s) against that folder's household members.
      // -------------------------------------------------------------------
      const accountCounts: AccountRunCounts = {
        accounts_scored: 0,
        account_auto_linked: 0,
        account_needs_review: 0,
        account_unmatched: 0,
        accounts_preserved: 0,
        accounts_unkeyable: 0,
      };
      // PII-safe breakdown of the unkeyable bucket, accumulated in the loop below.
      const unkeyableBreakdown: UnkeyableBreakdown = {};

      // Folders whose household is resolved (AUTO_LINKED or CONFIRMED) — the only
      // folders that feed the account pass (design §8.5).
      const linkedFolders = [...autoLinkedFolders, ...confirmed].filter(
        (l) => l.householdSfId != null,
      );

      for (const folder of linkedFolders) {
        const householdSfId = folder.householdSfId as string;
        const members = await readHouseholdMembers(tx, householdSfId);
        const accounts = await readLiveAccounts(tx, folder.sourceFolderId);

        // Preserved accounts: any owner row already CONFIRMED/REJECTED by a human —
        // skip the whole account (the folder preserved-set idiom, account grain).
        const existing = await listAccountLinksByFolder(tx, folder.sourceFolderId);
        const preservedAccounts = new Set(
          existing
            .filter((r) => r.matchStatus === "CONFIRMED" || r.matchStatus === "REJECTED")
            .map((r) => acctKey(r.custodian, r.accountNumber)),
        );

        for (const a of accounts) {
          // Unkeyable — no durable key (design §8.3, the D-d orphan analog).
          if (a.custodian == null || a.account_number == null) {
            accountCounts.accounts_unkeyable += 1;
            // Diagnostic tally (PII-safe): by account_type + which id is missing.
            const type = a.account_type ?? "unknown";
            const b = (unkeyableBreakdown[type] ??= {
              both_null: 0,
              custodian_null: 0,
              number_null: 0,
            });
            if (a.custodian == null && a.account_number == null) b.both_null += 1;
            else if (a.custodian == null) b.custodian_null += 1;
            else b.number_null += 1;
            continue;
          }
          if (preservedAccounts.has(acctKey(a.custodian, a.account_number))) {
            accountCounts.accounts_preserved += 1;
            continue;
          }

          // Deterministic-first (§8.2): a STRUCTURED NO-OP in P2.5 —
          // resolveDeterministicOwners always returns [] (no mapping account is
          // post-funding), so every account falls through to the fuzzy, household-
          // scoped match. The `.length` check is the seam where the exact post-
          // funding path slots in later; do NOT wire it live in P2.5 (§1.3).
          const deterministic = await resolveDeterministicOwners(tx, {
            custodian: a.custodian,
            accountNumber: a.account_number,
          });
          if (deterministic.length > 0) continue; // unreachable in P2.5 (inert seam)

          accountCounts.accounts_scored += 1;
          const m = matchAccountOwners(a.account_holder, members);
          if (m.status === "AUTO_LINKED") accountCounts.account_auto_linked += 1;
          else if (m.status === "NEEDS_REVIEW") accountCounts.account_needs_review += 1;
          else accountCounts.account_unmatched += 1;

          if (!dryRun) {
            const owners: AccountOwner[] = m.isEntity
              ? [{ cedarRidgeUserId: null, clientSfId: null, ownershipRole: "ENTITY" }]
              : m.owners.map((o) => ({
                  cedarRidgeUserId: o.client.cedarRidgeUserId,
                  clientSfId: o.client.clientSfId,
                  ownershipRole: o.role,
                }));
            await replaceAccountOwnerCandidates(tx, {
              sourceFolderId: folder.sourceFolderId,
              custodian: a.custodian,
              accountNumber: a.account_number,
              isEntity: m.isEntity,
              matchStatus: m.status,
              confidence: m.confidence,
              owners,
            });
          }
        }
      }

      // Second same-tx audit row — the account pass's own counts-only trail (its own
      // queryable action constant). NEVER a holder name or account number (§6).
      await writeAudit(
        tx,
        { role: "INGEST", email: null },
        {
          action: INGEST_ASSET_MAP_ACCOUNT_LINK,
          entityType: "ingest_run",
          entityId: runId,
          detail: {
            source: SOURCE,
            ...accountCounts,
            unkeyable_breakdown: unkeyableBreakdown,
            dry_run: dryRun,
          },
        },
      );

      return { ok: true, counts, accountCounts, unkeyableBreakdown };
    });
  } catch {
    console.error(`[cron:asset-map-match] run_id=${safeRunId} tx_failed`);
    return err("internal", 500);
  }

  if (!result.ok) return err("too_large", 413);

  // 3. Response — counts only (folder pass + account pass). dry_run distinguishes a
  //    preview from a live write.
  return Response.json({
    ...result.counts,
    ...result.accountCounts,
    unkeyable_breakdown: result.unkeyableBreakdown,
    dry_run: dryRun,
    source: SOURCE,
  });
}
