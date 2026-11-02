// The asset-map matcher (app/api/cron/asset-map-match/route.ts) as the demo seed runs it: the same two passes with
// the same scoring, in one ingest transaction with the same counts-only audit rows, with two differences. In
// production a client folder is named for its clients ("Kofi & Ada Okafor"), and the folder pass scores that name.
// The Statement Analyzer demo labels its folders by household ("Okafor Household"), which scores no person, so here
// each folder is scored by the account holders its statements print. And where the route reads and writes one folder
// and one account at a time (setLink, replaceAccountOwnerCandidates), the seed reads every folder's members, accounts
// and decided owners at once and writes each pass's links in one statement, with the same SQL; neither table has a
// trigger or an audit row of its own. The account pass's choices are the route's, unchanged.

import type { Prisma } from "@prisma/client";
import { INGEST_ASSET_MAP_ACCOUNT_LINK, INGEST_ASSET_MAP_MATCH, writeAudit } from "@/lib/audit";
import { resolveDeterministicOwners, type AccountOwner } from "@/lib/data/asset-map-account-link";
import { matchAccountOwners } from "@/lib/data/asset-map-account-match";
import { listLinksByStatus } from "@/lib/data/asset-map-link";
import { matchHousehold, normalizeName, type ClientCandidate } from "@/lib/data/asset-map-match";
import { withIngestScope } from "@/lib/ingest/scope";
import { insertRows, type Row } from "./batch";

const SOURCE = "acat-asset-map";

type ClientRow = {
  sf_id: string;
  household_id: string | null;
  first_name: string | null;
  last_name: string | null;
  cedar_ridge_user_id: string | null;
};

const candidate = (r: ClientRow): ClientCandidate => ({
  clientSfId: r.sf_id,
  householdSfId: r.household_id,
  cedarRidgeUserId: r.cedar_ridge_user_id,
  firstName: r.first_name,
  lastName: r.last_name,
});

/** "Kofi Okafor & Ada Okafor": every distinct person the folder's live statement accounts name, as a folder name. */
async function holderNames(tx: Prisma.TransactionClient): Promise<Map<string, string>> {
  const rows = await tx.$queryRaw<Array<{ source_folder_id: string; account_holder: string | null }>>`
    WITH live AS (
      SELECT DISTINCT ON (source_folder_id) source_folder_id, id
      FROM mirror.acat_asset_map_household
      WHERE superseded_by IS NULL AND source_folder_id IS NOT NULL
      ORDER BY source_folder_id, processed_at DESC NULLS LAST, synced_at DESC
    )
    SELECT live.source_folder_id, a.account_holder
    FROM live JOIN mirror.acat_asset_map_account a ON a.household_id = live.id
    ORDER BY live.source_folder_id, a.custodian, a.account_number`;
  const names = new Map<string, string[]>();
  for (const r of rows) {
    const people = names.get(r.source_folder_id) ?? [];
    for (const part of (r.account_holder ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!people.includes(part)) people.push(part);
    }
    names.set(r.source_folder_id, people);
  }
  return new Map([...names].map(([folder, people]) => [folder, people.join(" & ")]));
}

export type MatchCounts = Record<string, number>;

// setLink's and upsertAccountLink's upserts (lib/data/asset-map-link.ts, asset-map-account-link.ts) for many rows.
const SET_LINK = `ON CONFLICT (source_folder_id) DO UPDATE SET
  client_sf_id = EXCLUDED.client_sf_id, cedar_ridge_user_id = EXCLUDED.cedar_ridge_user_id,
  household_sf_id = EXCLUDED.household_sf_id, match_status = EXCLUDED.match_status, confidence = EXCLUDED.confidence,
  confirmed_by = EXCLUDED.confirmed_by, confirmed_at = EXCLUDED.confirmed_at, synced_at = now()`;
const UPSERT_ACCOUNT_LINK = `ON CONFLICT (source_folder_id, custodian, account_number, cedar_ridge_user_id) DO UPDATE SET
  client_sf_id = EXCLUDED.client_sf_id, ownership_role = EXCLUDED.ownership_role, is_entity = EXCLUDED.is_entity,
  match_status = EXCLUDED.match_status, confidence = EXCLUDED.confidence, synced_at = now()`;

/** One run of the matcher: the folder pass, then the account pass over the folders linked when the run began. The
 *  run id names the run in its audit rows (the route picks a random one). */
export async function runSeedMatcher(runId: string): Promise<MatchCounts> {
  return withIngestScope(async (tx) => {
    const households = await tx.$queryRaw<Array<{ source_folder_id: string; client_name: string | null }>>`
      SELECT DISTINCT ON (source_folder_id) source_folder_id, client_name
      FROM mirror.acat_asset_map_household
      WHERE superseded_by IS NULL AND source_folder_id IS NOT NULL
      ORDER BY source_folder_id, processed_at DESC NULLS LAST, synced_at DESC`;
    const clients = (await tx.$queryRaw<ClientRow[]>`
      SELECT sf_id, household_id, first_name, last_name, cedar_ridge_user_id
      FROM mirror.client
      WHERE household_id IS NULL OR sf_id <> household_id`).map(candidate);
    const names = await holderNames(tx);

    const [confirmed, rejected, autoLinkedFolders] = await Promise.all([
      listLinksByStatus(tx, "CONFIRMED"),
      listLinksByStatus(tx, "REJECTED"),
      listLinksByStatus(tx, "AUTO_LINKED"),
    ]);
    const preservedFolders = new Set([...confirmed, ...rejected].map((l) => l.sourceFolderId));

    const counts = { households_scored: 0, auto_linked: 0, needs_review: 0, unmatched: 0, preserved: 0 };
    const links: Row[] = [];
    for (const h of households) {
      if (preservedFolders.has(h.source_folder_id)) {
        counts.preserved += 1;
        continue;
      }
      counts.households_scored += 1;
      const match = matchHousehold(normalizeName(names.get(h.source_folder_id) ?? h.client_name), clients);
      if (match.status === "AUTO_LINKED") counts.auto_linked += 1;
      else if (match.status === "NEEDS_REVIEW") counts.needs_review += 1;
      else counts.unmatched += 1;
      links.push({
        source_folder_id: h.source_folder_id, client_sf_id: match.clientSfId ?? null, cedar_ridge_user_id: match.cedarRidgeUserId ?? null,
        household_sf_id: match.householdSfId ?? null, match_status: match.status, confidence: match.confidence ?? null,
        confirmed_by: null, confirmed_at: null,
      });
    }
    await insertRows(tx, "mirror.acat_asset_map_link", links, SET_LINK);
    await writeAudit(tx, { role: "INGEST", email: null }, {
      action: INGEST_ASSET_MAP_MATCH, entityType: "ingest_run", entityId: runId,
      detail: { source: SOURCE, ...counts, dry_run: false },
    });

    const accountCounts = {
      accounts_scored: 0, account_auto_linked: 0, account_needs_review: 0, account_unmatched: 0, accounts_preserved: 0,
      accounts_unkeyable: 0,
    };
    const unkeyable: Record<string, { both_null: number; custodian_null: number; number_null: number }> = {};
    const folders = [...autoLinkedFolders, ...confirmed].filter((l) => l.householdSfId != null);
    // Every folder's household members, live statement accounts and decided owners, read once for the whole pass.
    const allMembers = folders.length === 0 ? [] : await tx.$queryRaw<ClientRow[]>`
      SELECT sf_id, household_id, first_name, last_name, cedar_ridge_user_id
      FROM mirror.client
      WHERE household_id = ANY(${folders.map((f) => f.householdSfId!)}::text[]) AND (household_id IS NULL OR sf_id <> household_id)`;
    const allAccounts = folders.length === 0 ? [] : await tx.$queryRaw<Array<{
      source_folder_id: string; custodian: string | null; account_number: string | null; account_holder: string | null; account_type: string | null;
    }>>`
      WITH live AS (
        SELECT DISTINCT ON (source_folder_id) source_folder_id, id
        FROM mirror.acat_asset_map_household
        WHERE superseded_by IS NULL AND source_folder_id IS NOT NULL AND source_folder_id = ANY(${folders.map((f) => f.sourceFolderId)}::text[])
        ORDER BY source_folder_id, processed_at DESC NULLS LAST, synced_at DESC
      )
      SELECT live.source_folder_id, a.custodian, a.account_number, a.account_holder, a.account_type
      FROM live JOIN mirror.acat_asset_map_account a ON a.household_id = live.id`;
    const decided = new Set((await tx.$queryRaw<Array<{ key: string }>>`
      SELECT source_folder_id || ' ' || custodian || ' ' || account_number AS key
      FROM mirror.acat_asset_map_account_link
      WHERE match_status IN ('CONFIRMED', 'REJECTED')`).map((r) => r.key));
    const ownerRows: Row[] = [];
    const replaced: Row[] = [];
    for (const folder of folders) {
      const members = allMembers.filter((m) => m.household_id === folder.householdSfId).map(candidate);
      const accounts = allAccounts.filter((a) => a.source_folder_id === folder.sourceFolderId);
      for (const a of accounts) {
        if (a.custodian == null || a.account_number == null) {
          accountCounts.accounts_unkeyable += 1;
          const b = (unkeyable[a.account_type ?? "unknown"] ??= { both_null: 0, custodian_null: 0, number_null: 0 });
          if (a.custodian == null && a.account_number == null) b.both_null += 1;
          else if (a.custodian == null) b.custodian_null += 1;
          else b.number_null += 1;
          continue;
        }
        if (decided.has(`${folder.sourceFolderId} ${a.custodian} ${a.account_number}`)) {
          accountCounts.accounts_preserved += 1;
          continue;
        }
        if ((await resolveDeterministicOwners(tx, { custodian: a.custodian, accountNumber: a.account_number })).length > 0) continue;
        accountCounts.accounts_scored += 1;
        const m = matchAccountOwners(a.account_holder, members);
        if (m.status === "AUTO_LINKED") accountCounts.account_auto_linked += 1;
        else if (m.status === "NEEDS_REVIEW") accountCounts.account_needs_review += 1;
        else accountCounts.account_unmatched += 1;
        const owners: AccountOwner[] = m.isEntity
          ? [{ cedarRidgeUserId: null, clientSfId: null, ownershipRole: "ENTITY" }]
          : m.owners.map((o) => ({ cedarRidgeUserId: o.client.cedarRidgeUserId, clientSfId: o.client.clientSfId, ownershipRole: o.role }));
        // replaceAccountOwnerCandidates: each chosen owner upserted at the tier, then the account's stale machine rows
        // demoted (below, once every account's owners are in; each demotion touches only its own account's rows).
        for (const o of owners) {
          ownerRows.push({
            source_folder_id: folder.sourceFolderId, custodian: a.custodian, account_number: a.account_number,
            cedar_ridge_user_id: o.cedarRidgeUserId ?? null, client_sf_id: o.clientSfId ?? null, ownership_role: o.ownershipRole,
            is_entity: m.isEntity, match_status: m.status, confidence: m.confidence ?? null,
          });
        }
        replaced.push({
          source_folder_id: folder.sourceFolderId, custodian: a.custodian, account_number: a.account_number, is_entity: m.isEntity,
          chosen: owners.map((o) => o.cedarRidgeUserId).filter((id): id is string => id != null),
        });
      }
    }
    await insertRows(tx, "mirror.acat_asset_map_account_link", ownerRows, UPSERT_ACCOUNT_LINK);
    if (replaced.length) {
      await tx.$executeRaw`
        UPDATE mirror.acat_asset_map_account_link AS l SET
          match_status = 'UNMATCHED',
          client_sf_id = NULL,
          synced_at    = now()
        FROM jsonb_to_recordset(${JSON.stringify(replaced)}::jsonb)
          AS r(source_folder_id text, custodian text, account_number text, is_entity boolean, chosen text[])
        WHERE l.source_folder_id = r.source_folder_id
          AND l.custodian        = r.custodian
          AND l.account_number   = r.account_number
          AND l.match_status IN ('NEEDS_REVIEW', 'AUTO_LINKED', 'UNMATCHED')
          AND (
            (l.cedar_ridge_user_id IS NOT NULL AND l.cedar_ridge_user_id <> ALL(r.chosen))
            OR (l.cedar_ridge_user_id IS NULL AND r.is_entity = false)
          )`;
    }
    await writeAudit(tx, { role: "INGEST", email: null }, {
      action: INGEST_ASSET_MAP_ACCOUNT_LINK, entityType: "ingest_run", entityId: runId,
      detail: { source: SOURCE, ...accountCounts, unkeyable_breakdown: unkeyable, dry_run: false },
    });
    return { ...counts, ...accountCounts };
  });
}
