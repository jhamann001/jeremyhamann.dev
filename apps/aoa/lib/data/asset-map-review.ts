import "server-only";
import { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import {
  getLink,
  listLinksByStatus,
  type AssetMapLink,
  type MatchStatus,
} from "@/lib/data/asset-map-link";
import {
  matchHousehold,
  normalizeName,
  type ClientCandidate,
} from "@/lib/data/asset-map-match";
import {
  listAccountLinksByFolder,
  listAccountLinksByStatus,
  type AccountOwnerRole,
} from "@/lib/data/asset-map-account-link";
import { matchAccountOwners } from "@/lib/data/asset-map-account-match";

// Asset-mapping ops REVIEW-QUEUE read seam — Phase 2 slice P2.3 (design §5).
// The read side of the ops surface: for every NEEDS_REVIEW link it joins the
// live mapping household (client_name + a brief accounts/custodian summary) and
// RECOMPUTES the ranked candidate clients LIVE via the pure matcher
// (lib/data/asset-map-match). Read-only; runs under the caller's withUserScope
// so the link table's ops-read RLS policy (acat_asset_map_link_ops_all) and
// mirror.client's own scoping gate it — a non-ops role sees zero rows.
//
// WHY RECOMPUTE (not read persisted candidates): the P2.0 link store has NO
// candidates column — the reconcile pass (P2.2) scores every folder but persists
// ONLY the winning verdict (status/ids/confidence), discarding the ranked list
// (asset-map-match.ts matchHousehold's "P2.3 NOTE" documents this deferral). So
// the queue re-runs matchHousehold on read against the CURRENT mirror.client set
// — candidates are always fresh (a client added since the last reconcile shows
// up immediately) and there is no denormalized candidate table to keep in sync.
//
// PII / NO-LOG (design §6): this seam RETURNS client_name + candidate names to
// the ops-only UI (that is the queue's whole purpose — a human reads the name to
// confirm). It NEVER logs. Names/account numbers never reach a log line or an
// error body anywhere downstream — the callers surface counts/ids only.
//
// DECIMAL TRAP (cf. asset-map-link.ts / account-aum.ts): total_value is a
// Postgres numeric → a Prisma Decimal at runtime. Number()-coerce it HERE at the
// seam (NULL stays null, never 0) so a raw Decimal never crosses the RSC boundary.

/** One ranked candidate client for a queued household, recomputed live. */
export type ReviewCandidate = {
  clientSfId: string;
  householdSfId: string | null;
  cedarRidgeUserId: string | null;
  /** Display name "First Last" (trimmed); the ops "why" surfaces it. */
  name: string;
  /** 0..1 confidence for this (household → client) pairing. */
  confidence: number;
  /** Shared name-token count of the best-matching person (the "why"). */
  sharedTokens: number;
};

/** A brief live accounts/custodian summary for a queued household (design §5). */
export type AccountsSummary = {
  accountCount: number;
  /** Distinct non-null custodians across the household's live accounts. */
  custodians: string[];
  /** Household total value (dollars), Number()-coerced from numeric; null if unset. */
  totalValue: number | null;
};

/** One review-queue row — a NEEDS_REVIEW mapping household with its ranked
 *  candidates and current link state. */
export type ReviewQueueRow = {
  sourceFolderId: string;
  /** Free-text client_name from the live household row (may be null). */
  householdName: string | null;
  accountsSummary: AccountsSummary;
  candidates: ReviewCandidate[];
  /** The stored link (match_status = NEEDS_REVIEW, confidence for display). */
  currentLink: AssetMapLink;
};

// Raw read shapes (snake_case, as the DB returns them).
type ClientRow = {
  sf_id: string;
  household_id: string | null;
  first_name: string | null;
  last_name: string | null;
  cedar_ridge_user_id: string | null;
};
type HouseholdSummaryRow = {
  source_folder_id: string;
  client_name: string | null;
  total_value: unknown; // Decimal | null at runtime
  account_count: number | bigint;
  custodians: string[] | null;
};

/** Candidate AOA clients — the match targets, the reconcile route's read verbatim
 *  (mirror.client, excluding the retired households-as-clients placeholder rows
 *  where sf_id = household_id, so the scorer never matches a placeholder). */
async function readCandidateClients(
  tx: Prisma.TransactionClient,
): Promise<ClientCandidate[]> {
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

/** Live household + accounts summary for the given durable folders. DISTINCT ON
 *  collapses any duplicate live rows per folder to the most recently processed
 *  (the reconcile route's readLiveHouseholds idiom), so the account aggregate
 *  never double-counts across versions. Empty folder set → no query, empty map. */
async function readHouseholdSummaries(
  tx: Prisma.TransactionClient,
  folderIds: string[],
): Promise<Map<string, HouseholdSummaryRow>> {
  if (folderIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<HouseholdSummaryRow[]>`
    WITH live AS (
      SELECT DISTINCT ON (source_folder_id)
             source_folder_id, id, client_name, total_value
      FROM mirror.acat_asset_map_household
      WHERE superseded_by IS NULL
        AND source_folder_id IS NOT NULL
        AND source_folder_id IN (${Prisma.join(folderIds)})
      ORDER BY source_folder_id, processed_at DESC NULLS LAST, synced_at DESC
    )
    SELECT live.source_folder_id,
           live.client_name,
           live.total_value,
           COUNT(a.id)::int AS account_count,
           COALESCE(
             array_agg(DISTINCT a.custodian) FILTER (WHERE a.custodian IS NOT NULL),
             ARRAY[]::text[]
           ) AS custodians
    FROM live
    LEFT JOIN mirror.acat_asset_map_account a ON a.household_id = live.id
    GROUP BY live.source_folder_id, live.client_name, live.total_value`;
  const map = new Map<string, HouseholdSummaryRow>();
  for (const r of rows) map.set(r.source_folder_id, r);
  return map;
}

function displayName(c: ClientCandidate): string {
  return `${c.firstName ?? ""} ${c.lastName ?? ""}`.replace(/\s+/g, " ").trim();
}

/**
 * The review queue: every NEEDS_REVIEW link AND every AUTO_LINKED link, each
 * joined to its live mapping household + accounts summary, with ranked candidate
 * clients recomputed live. Read-only, one withUserScope tx (the caller's RLS
 * scope; ops/admin/HoA see it, everyone else gets zero links from the RLS policy
 * → an empty queue).
 *
 * TWO groups, one call (design §5 + the P2.3 auto-link spot-check addition):
 *   • NEEDS_REVIEW — actionable: ops picks a candidate → CONFIRM, or REJECT.
 *   • AUTO_LINKED  — verify/override: the matcher already bound a client
 *     (currentLink carries it + its confidence), but a client-identity binding
 *     can't be silently trusted — ops eyeballs it and can CONFIRM (sign-off, so
 *     the matcher preserves it thereafter), re-confirm to a DIFFERENT candidate,
 *     or REJECT a wrong auto-link. The SAME live-recomputed candidates ride both
 *     groups, so an override target is always available.
 * NEEDS_REVIEW rows come first (actionable), then AUTO_LINKED (to verify);
 * within each, listLinksByStatus's synced_at DESC ordering (freshest first) is
 * preserved. UNMATCHED (no suggestion) and CONFIRMED/REJECTED (already decided)
 * are intentionally excluded from the queue. Each row carries its status via
 * currentLink.matchStatus so the UI groups without a second read. A queued
 * household whose live row has vanished (link exists but the household was
 * superseded away) still appears — null name + empty summary — never dropped.
 */
export async function listReviewQueue(id: Identity): Promise<ReviewQueueRow[]> {
  return withUserScope(id, async (tx) => {
    const [needsReview, autoLinked] = await Promise.all([
      listLinksByStatus(tx, "NEEDS_REVIEW"),
      listLinksByStatus(tx, "AUTO_LINKED"),
    ]);
    const links = [...needsReview, ...autoLinked];
    if (links.length === 0) return [];

    const folderIds = links.map((l) => l.sourceFolderId);
    const [clients, summaries] = await Promise.all([
      readCandidateClients(tx),
      readHouseholdSummaries(tx, folderIds),
    ]);

    return links.map((link) => {
      const summary = summaries.get(link.sourceFolderId);
      const householdName = summary?.client_name ?? null;
      const match = matchHousehold(normalizeName(householdName), clients);
      const candidates: ReviewCandidate[] = match.candidates.map((c) => ({
        clientSfId: c.client.clientSfId,
        householdSfId: c.client.householdSfId,
        cedarRidgeUserId: c.client.cedarRidgeUserId,
        name: displayName(c.client),
        confidence: c.score.score,
        sharedTokens: c.score.sharedTokens,
      }));
      return {
        sourceFolderId: link.sourceFolderId,
        householdName,
        accountsSummary: {
          accountCount: summary ? Number(summary.account_count) : 0,
          custodians: summary?.custodians ?? [],
          totalValue:
            summary == null || summary.total_value == null
              ? null
              : Number(summary.total_value),
        },
        candidates,
        currentLink: link,
      };
    });
  });
}

/** The resolved client ids a CONFIRM binds. */
export type ResolvedClient = {
  clientSfId: string;
  householdSfId: string | null;
  cedarRidgeUserId: string | null;
};

/**
 * Resolve a chosen client's sf_id → its household_sf_id + cedar_ridge_user_id from
 * mirror.client, or null if the sf_id is not a REAL, non-placeholder client the
 * caller can see. This is the SAFETY GATE for confirmLink (design/PR "never bind
 * an arbitrary unvalidated sf_id"): the confirm action never writes ids that did
 * not come back from this read, so an invented / placeholder / out-of-scope
 * sf_id can never be bound to a link. Excludes the households-as-clients
 * placeholder rows (sf_id = household_id), the lib/data/clients.ts idiom.
 * Runs inside the caller's tx (RLS-scoped). Empty id → null without querying.
 */
export async function resolveClientForLink(
  tx: Prisma.TransactionClient,
  clientSfId: string,
): Promise<ResolvedClient | null> {
  if (!clientSfId) return null;
  const rows = await tx.$queryRaw<
    { sf_id: string; household_id: string | null; cedar_ridge_user_id: string | null }[]
  >`
    SELECT sf_id, household_id, cedar_ridge_user_id
    FROM mirror.client
    WHERE sf_id = ${clientSfId}
      AND (household_id IS NULL OR sf_id <> household_id)
    LIMIT 1`;
  const r = rows[0];
  return r
    ? {
        clientSfId: r.sf_id,
        householdSfId: r.household_id,
        cedarRidgeUserId: r.cedar_ridge_user_id,
      }
    : null;
}

// ===========================================================================
// ACCOUNT-GRAIN review (P2.5, design §8.6). Beneath the folder queue: a folder
// row expands to its accounts, each showing account_holder → the multi-select
// owner control (recomputed live). The store has NO candidates column (the same
// "why recompute" rationale as the folder queue), so matchAccountOwners is re-run
// on read against the folder's CURRENT household members. Read-only, one
// withUserScope tx (ops RLS gates it — a non-ops role sees zero owner rows).
//
// PII (§6): the account NUMBER is masked to last-4 for display; the full value
// never enters the browser payload. account_holder + candidate names ARE
// returned to the ops-only UI (the review's whole purpose) but NEVER logged.
// ===========================================================================

/** One candidate owner for an account (recomputed live). */
export type AccountReviewCandidate = {
  clientSfId: string;
  name: string;
  householdSfId: string | null;
  cedarRidgeUserId: string | null;
  confidence: number;
  sharedTokens: number;
  preSelected: boolean;
  notInHousehold: boolean;
};

/** One account row under a folder, with its owner candidates. */
export type AccountReviewRow = {
  custodian: string;
  /** Opaque current mirror ID; null when the historical account is no longer live. */
  accountId: string | null;
  /** Raw durable keys must never cross the browser boundary. */
  accountNumber?: never;
  /** Account number masked to last-4 for display (§6). */
  accountNumberMasked: string;
  accountHolder: string | null;
  isEntity: boolean;
  status: MatchStatus;
  totalValue: number | null;
  role: AccountOwnerRole;
  candidates: AccountReviewCandidate[];
};

/** A folder grouping its accounts-to-attribute. */
export type FolderAccountReview = {
  sourceFolderId: string;
  householdName: string | null;
  householdSfId: string | null;
  /** True when the folder's household is bound (folder link CONFIRMED/AUTO_LINKED
   *  with a household). False = the matcher couldn't bind the household, so the
   *  account row carries the fold-in client picker (design "fold household
   *  resolution into the account row"). */
  folderResolved: boolean;
  /** Ranked client candidates for the fold-in pick on an UNRESOLVED folder
   *  (recomputed live via the folder matcher). Empty for a resolved folder — the
   *  household is already bound and the account picks from its members instead. */
  householdCandidates: ReviewCandidate[];
  accounts: AccountReviewRow[];
};

type MemberRow = {
  sf_id: string;
  household_id: string | null;
  first_name: string | null;
  last_name: string | null;
  cedar_ridge_user_id: string | null;
};
type LiveAccountReviewRow = {
  account_id: string;
  custodian: string | null;
  account_number: string | null;
  account_holder: string | null;
  total_value: unknown;
};

/** Mask an account number to its last 4 (design §6 — display masked; full value
 *  gated). Short/empty numbers render fully masked. */
function maskAccount(accountNumber: string): string {
  return accountNumber.length > 4 ? `••••${accountNumber.slice(-4)}` : "••••";
}

/** The folder's resolved household members — the account matcher's candidate pool
 *  (mirror.client scoped to one household, placeholders excluded). */
async function readHouseholdMembers(
  tx: Prisma.TransactionClient,
  householdSfId: string,
): Promise<ClientCandidate[]> {
  const rows = await tx.$queryRaw<MemberRow[]>`
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

/** Live accounts under a durable folder (the readLiveAccounts idiom). */
async function readLiveAccountsForReview(
  tx: Prisma.TransactionClient,
  sourceFolderId: string,
): Promise<Map<string, LiveAccountReviewRow>> {
  const rows = await tx.$queryRaw<LiveAccountReviewRow[]>`
    WITH live AS (
      SELECT DISTINCT ON (source_folder_id) source_folder_id, id
      FROM mirror.acat_asset_map_household
      WHERE superseded_by IS NULL
        AND source_folder_id IS NOT NULL
        AND source_folder_id = ${sourceFolderId}
      ORDER BY source_folder_id, processed_at DESC NULLS LAST, synced_at DESC, id
    )
    SELECT a.id AS account_id, a.custodian, a.account_number, a.account_holder, a.total_value
    FROM live
    JOIN mirror.acat_asset_map_account a ON a.household_id = live.id
    ORDER BY a.id`;
  const map = new Map<string, LiveAccountReviewRow>();
  for (const r of rows) {
    if (r.custodian != null && r.account_number != null) {
      const key = JSON.stringify([r.custodian, r.account_number]);
      if (!map.has(key)) map.set(key, r);
    }
  }
  return map;
}

/**
 * The account-grain ACTION queue — accounts that need a human decision:
 * NEEDS_REVIEW account rows under resolved folders, PLUS accounts under folders
 * the matcher couldn't bind (the fold-in). AUTO_LINKED (machine-decided) and
 * CONFIRMED accounts are NOT here — they live in the "already known" surface
 * (listKnownAccounts, S2), so the queue is only what the operator must act on.
 * One withUserScope read (ops RLS gates it). Accounts are keyed by the
 * folder-scoped (custodian, account_number) key; the number is masked for display.
 */
export async function listAccountReviewQueue(id: Identity): Promise<FolderAccountReview[]> {
  return withUserScope(id, async (tx) => {
    const [needsReview, unresolvedFolderLinks] = await Promise.all([
      listAccountLinksByStatus(tx, "NEEDS_REVIEW"),
      // Folders the matcher scored but couldn't bind (candidates found, no
      // household yet). These are the fold-in surface: the household pick now
      // lives on the account row, not a separate household card. UNMATCHED
      // folders (no candidate at all) are intentionally excluded — parity with
      // the retired household queue, which never surfaced UNMATCHED.
      listLinksByStatus(tx, "NEEDS_REVIEW"),
    ]);
    const queued = needsReview;
    const unresolved = unresolvedFolderLinks.filter((l) => l.householdSfId == null);

    // Distinct RESOLVED folders with queued account owner rows, first-seen order.
    const folderIds: string[] = [];
    const seen = new Set<string>();
    for (const r of queued) {
      if (!seen.has(r.sourceFolderId)) {
        seen.add(r.sourceFolderId);
        folderIds.push(r.sourceFolderId);
      }
    }
    if (folderIds.length === 0 && unresolved.length === 0) return [];

    const summaries = await readHouseholdSummaries(tx, [
      ...folderIds,
      ...unresolved.map((l) => l.sourceFolderId),
    ]);

    const out: FolderAccountReview[] = [];
    for (const sourceFolderId of folderIds) {
      const link = await getLink(tx, sourceFolderId);
      // Account grain only exists beneath a resolved household.
      if (!link || link.householdSfId == null) continue;
      const householdSfId = link.householdSfId;

      const [members, liveAccounts, allOwnerRows] = await Promise.all([
        readHouseholdMembers(tx, householdSfId),
        readLiveAccountsForReview(tx, sourceFolderId),
        listAccountLinksByFolder(tx, sourceFolderId),
      ]);

      // Group stored owner rows by account key; keep only accounts whose account-
      // level status is actionable (any NEEDS_REVIEW → NEEDS_REVIEW, else AUTO_LINKED).
      const byAccount = new Map<
        string,
        { custodian: string; accountNumber: string; status: MatchStatus; isEntity: boolean }
      >();
      for (const r of allOwnerRows) {
        // Action queue = NEEDS_REVIEW only. AUTO_LINKED (machine-decided) and
        // CONFIRMED/REJECTED (already decided) are excluded — AUTO_LINKED +
        // CONFIRMED surface in listKnownAccounts (the "already known" band).
        if (r.matchStatus !== "NEEDS_REVIEW") continue;
        const key = JSON.stringify([r.custodian, r.accountNumber]);
        const prev = byAccount.get(key);
        byAccount.set(key, {
          custodian: r.custodian,
          accountNumber: r.accountNumber,
          status: "NEEDS_REVIEW",
          isEntity: prev?.isEntity || r.isEntity,
        });
      }
      if (byAccount.size === 0) continue;

      const accounts: AccountReviewRow[] = [];
      for (const acct of byAccount.values()) {
        const key = JSON.stringify([acct.custodian, acct.accountNumber]);
        const live = liveAccounts.get(key);
        const accountHolder = live?.account_holder ?? null;
        const match = matchAccountOwners(accountHolder, members);
        const candidates: AccountReviewCandidate[] = match.candidates.map((c) => ({
          clientSfId: c.client.clientSfId,
          name: displayName(c.client),
          householdSfId: c.client.householdSfId,
          cedarRidgeUserId: c.client.cedarRidgeUserId,
          confidence: c.score.score,
          sharedTokens: c.score.sharedTokens,
          preSelected: c.preSelected,
          notInHousehold: c.notInHousehold,
        }));
        const isEntity = acct.isEntity || match.isEntity;
        accounts.push({
          custodian: acct.custodian,
          accountId: live?.account_id ?? null,
          accountNumberMasked: maskAccount(acct.accountNumber),
          accountHolder,
          isEntity,
          status: acct.status,
          totalValue:
            live == null || live.total_value == null ? null : Number(live.total_value),
          role: isEntity ? "ENTITY" : match.owners.length >= 2 ? "JOINT" : "PRIMARY",
          candidates,
        });
      }

      out.push({
        sourceFolderId,
        householdName: summaries.get(sourceFolderId)?.client_name ?? null,
        householdSfId,
        folderResolved: true,
        householdCandidates: [],
        accounts,
      });
    }

    // UNRESOLVED folders (the fold-in): the matcher found candidates but bound no
    // household, so there is no member pool to rank account owners against yet.
    // Surface each folder's LIVE accounts as review rows (candidates empty) plus
    // the ranked household candidates recomputed live, so the reviewer picks the
    // client right on the account row — confirmAccountOwners resolves the folder
    // link and attributes the owner in one ops-scoped tx.
    if (unresolved.length > 0) {
      const clients = await readCandidateClients(tx);
      for (const link of unresolved) {
        const sourceFolderId = link.sourceFolderId;
        const liveAccounts = await readLiveAccountsForReview(tx, sourceFolderId);
        if (liveAccounts.size === 0) continue;

        const householdName = summaries.get(sourceFolderId)?.client_name ?? null;
        const match = matchHousehold(normalizeName(householdName), clients);
        const householdCandidates: ReviewCandidate[] = match.candidates.map((c) => ({
          clientSfId: c.client.clientSfId,
          householdSfId: c.client.householdSfId,
          cedarRidgeUserId: c.client.cedarRidgeUserId,
          name: displayName(c.client),
          confidence: c.score.score,
          sharedTokens: c.score.sharedTokens,
        }));

        const accounts: AccountReviewRow[] = [];
        for (const live of liveAccounts.values()) {
          if (live.custodian == null || live.account_number == null) continue;
          // No member pool → matchAccountOwners returns entity detection + empty
          // candidates. Owner picking happens after the fold-in resolves the folder.
          const m = matchAccountOwners(live.account_holder ?? null, []);
          accounts.push({
            custodian: live.custodian,
            accountId: live.account_id,
            accountNumberMasked: maskAccount(live.account_number),
            accountHolder: live.account_holder ?? null,
            isEntity: m.isEntity,
            status: "NEEDS_REVIEW",
            totalValue: live.total_value == null ? null : Number(live.total_value),
            role: m.isEntity ? "ENTITY" : "PRIMARY",
            candidates: [],
          });
        }
        if (accounts.length === 0) continue;

        out.push({
          sourceFolderId,
          householdName,
          householdSfId: null,
          folderResolved: false,
          householdCandidates,
          accounts,
        });
      }
    }

    return out;
  });
}

// ===========================================================================
// "ALREADY KNOWN" surface (S2, the acat-tracking grouped-by-status idiom). The
// accounts the operator does NOT have to act on: AUTO_LINKED (machine-decided,
// sign-off optional) and CONFIRMED (human-attributed). Read-only owner display —
// no live candidate recompute (the decision is made). Masked numbers (§6).
// ===========================================================================

/** One resolved owner on a known account (display + the sign-off write key). */
export type KnownOwner = {
  clientSfId: string | null;
  name: string | null;
  cedarRidgeUserId: string | null;
};

/** One already-known account (machine-linked or confirmed). */
export type KnownAccountRow = {
  custodian: string;
  /** Opaque current mirror ID; null for historical rows without a live account. */
  accountId: string | null;
  accountNumber?: never;
  accountNumberMasked: string;
  accountHolder: string | null;
  isEntity: boolean;
  /** CONFIRMED if any owner row for the account is confirmed, else AUTO_LINKED. */
  status: "AUTO_LINKED" | "CONFIRMED";
  totalValue: number | null;
  owners: KnownOwner[];
};

/** A folder grouping its already-known accounts. */
export type KnownFolder = {
  sourceFolderId: string;
  householdName: string | null;
  accounts: KnownAccountRow[];
};

/**
 * The already-known accounts: every folder with ≥1 account owner row in
 * AUTO_LINKED or CONFIRMED, grouped, each account showing its resolved owner(s).
 * One withUserScope read (ops RLS gates it). Names resolved from mirror.client;
 * numbers masked. REJECTED/UNMATCHED rows are excluded (not "known"). Read-only —
 * the account-grain decision is made, so no candidate recompute here.
 */
export async function listKnownAccounts(id: Identity): Promise<KnownFolder[]> {
  return withUserScope(id, async (tx) => {
    const [auto, confirmed] = await Promise.all([
      listAccountLinksByStatus(tx, "AUTO_LINKED"),
      listAccountLinksByStatus(tx, "CONFIRMED"),
    ]);
    const rows = [...auto, ...confirmed];
    if (rows.length === 0) return [];

    // Distinct folders, first-seen order (AUTO first, then CONFIRMED).
    const folderIds: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (!seen.has(r.sourceFolderId)) {
        seen.add(r.sourceFolderId);
        folderIds.push(r.sourceFolderId);
      }
    }

    const [summaries, clients] = await Promise.all([
      readHouseholdSummaries(tx, folderIds),
      readCandidateClients(tx),
    ]);
    const nameBy = new Map<string, string>();
    for (const c of clients) nameBy.set(c.clientSfId, displayName(c));

    const out: KnownFolder[] = [];
    for (const sourceFolderId of folderIds) {
      const [liveAccounts, ownerRows] = await Promise.all([
        readLiveAccountsForReview(tx, sourceFolderId),
        listAccountLinksByFolder(tx, sourceFolderId),
      ]);

      const byAccount = new Map<
        string,
        {
          custodian: string;
          accountNumber: string;
          status: "AUTO_LINKED" | "CONFIRMED";
          isEntity: boolean;
          owners: KnownOwner[];
        }
      >();
      for (const r of ownerRows) {
        if (r.matchStatus !== "AUTO_LINKED" && r.matchStatus !== "CONFIRMED") continue;
        const key = JSON.stringify([r.custodian, r.accountNumber]);
        const prev = byAccount.get(key);
        const status: "AUTO_LINKED" | "CONFIRMED" =
          prev?.status === "CONFIRMED" || r.matchStatus === "CONFIRMED"
            ? "CONFIRMED"
            : "AUTO_LINKED";
        const owners = prev?.owners ?? [];
        // A person owner (entity rows carry no client) → add to the display set.
        if (!r.isEntity && r.clientSfId) {
          owners.push({
            clientSfId: r.clientSfId,
            name: nameBy.get(r.clientSfId) ?? null,
            cedarRidgeUserId: r.cedarRidgeUserId,
          });
        }
        byAccount.set(key, {
          custodian: r.custodian,
          accountNumber: r.accountNumber,
          status,
          isEntity: (prev?.isEntity ?? false) || r.isEntity,
          owners,
        });
      }
      if (byAccount.size === 0) continue;

      const accounts: KnownAccountRow[] = [];
      for (const a of byAccount.values()) {
        const live = liveAccounts.get(JSON.stringify([a.custodian, a.accountNumber]));
        accounts.push({
          custodian: a.custodian,
          accountId: live?.account_id ?? null,
          accountNumberMasked: maskAccount(a.accountNumber),
          accountHolder: live?.account_holder ?? null,
          isEntity: a.isEntity,
          status: a.status,
          totalValue:
            live == null || live.total_value == null ? null : Number(live.total_value),
          owners: a.owners,
        });
      }

      out.push({
        sourceFolderId,
        householdName: summaries.get(sourceFolderId)?.client_name ?? null,
        accounts,
      });
    }
    return out;
  });
}

/**
 * Resolve a chosen client's sf_id → its ids AND assert it is a member of the
 * folder's resolved household (D-j membership enforcement, design §8.6/§8.7). The
 * SAFETY GATE for confirmAccountOwners: the confirm never binds an owner outside the
 * confirmed household — a cross-household holder is surfaced as a flag, never
 * silently bound. Excludes the households-as-clients placeholder rows. Runs inside
 * the caller's tx (RLS-scoped). Empty ids → null without querying.
 */
export async function resolveMemberForAccountLink(
  tx: Prisma.TransactionClient,
  clientSfId: string,
  householdSfId: string,
): Promise<ResolvedClient | null> {
  if (!clientSfId || !householdSfId) return null;
  const rows = await tx.$queryRaw<
    { sf_id: string; household_id: string | null; cedar_ridge_user_id: string | null }[]
  >`
    SELECT sf_id, household_id, cedar_ridge_user_id
    FROM mirror.client
    WHERE sf_id = ${clientSfId}
      AND household_id = ${householdSfId}
      AND (household_id IS NULL OR sf_id <> household_id)
    LIMIT 1`;
  const r = rows[0];
  return r
    ? {
        clientSfId: r.sf_id,
        householdSfId: r.household_id,
        cedarRidgeUserId: r.cedar_ridge_user_id,
      }
    : null;
}

/** Resolve the browser's opaque ID under the caller's user scope. The current
 * folder inventory is the same as readLiveAccountsForReview; superseded or
 * disappeared account IDs cannot write a durable ownership decision. */
export async function resolveAccountForReview(
  tx: Prisma.TransactionClient,
  accountId: string,
): Promise<{ sourceFolderId: string; custodian: string; accountNumber: string } | null> {
  if (typeof accountId !== "string" || !accountId.trim() || accountId.length > 256) return null;
  const rows = await tx.$queryRaw<{
    source_folder_id: string;
    custodian: string | null;
    account_number: string | null;
  }[]>`
    WITH live AS (
      SELECT DISTINCT ON (source_folder_id) source_folder_id, id
      FROM mirror.acat_asset_map_household
      WHERE superseded_by IS NULL AND source_folder_id IS NOT NULL
      ORDER BY source_folder_id, processed_at DESC NULLS LAST, synced_at DESC, id
    )
    SELECT live.source_folder_id, a.custodian, a.account_number
    FROM live
    JOIN mirror.acat_asset_map_account a ON a.household_id = live.id
    WHERE a.id = ${accountId}
      AND a.custodian IS NOT NULL AND a.custodian <> ''
      AND a.account_number IS NOT NULL AND a.account_number <> ''
    LIMIT 1`;
  const row = rows[0];
  return row?.source_folder_id && row.custodian && row.account_number
    ? { sourceFolderId: row.source_folder_id, custodian: row.custodian, accountNumber: row.account_number }
    : null;
}
