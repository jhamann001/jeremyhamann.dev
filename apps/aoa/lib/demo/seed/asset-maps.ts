// Demo seed part: the statement pipeline's runs and the asset-map mirror. The Statement Analyzer demo's runs go into
// the pipeline's stand-in (asset-maps-snapshot.ts); then everything after happens through the app's own code, the way
// production gets there:
//   1. the asset-map import pulls the runs into the mirror (lib/data/asset-map-import.ts, the scheduled pull): its own
//      page pull, flattening and run identities, with its row-by-row upserts written a table at a time (importRuns);
//   2. the matcher scores each client folder against the CRM's clients (the asset-map-match job; asset-maps-match.ts
//      says how the seed runs it);
//   3. Jordan Reyes (operations) confirms the story households' folders in the review queue, the matcher's next run
//      scores those folders' accounts, and Jordan confirms the accounts' owners; the other folders keep the
//      matcher's verdict, so the review queue has work;
//   4. Jordan links each story transfer to the statement account it moves (the transfer's "Link asset map" step).
// The confirmations and links write through the review queue's and the transfer workspace's own data functions under
// the operations login, with their audit rows dated when they happened; each step is one transaction, as one sitting
// of Jordan's would be, so the step costs its writes and not a transaction's setup per decision. It needs the app's database settings
// (DATABASE_URL and INGEST_DATABASE_URL on the seeded database) and demo mode, so the import's calls to the pipeline
// are answered by the stand-in.

import type { Prisma } from "@prisma/client";
import { ASSET_MAP_ACCOUNT_CONFIRM, ASSET_MAP_LINK_CONFIRM, INGEST_ASSET_MAP, TRANSFER_ASSET_MAP_LINK, writeAudit } from "@/lib/audit";
import { assetMapBaseUrl, fetchHouseholdsPage, flattenHouseholds } from "@/lib/data/asset-map";
import { replaceAccountOwnerDecision, type AccountOwner } from "@/lib/data/asset-map-account-link";
import { applyRunIdentities, buildIdentityCensus, runIdentityMode, type CensusPage } from "@/lib/data/asset-map-run-identity/sync";
import { getLink, updateLinkDecision } from "@/lib/data/asset-map-link";
import { resolveAccountForReview, resolveClientForLink, resolveMemberForAccountLink } from "@/lib/data/asset-map-review";
import { resolveAssignableAssetMapAccount } from "@/lib/data/transfer-asset-map";
import { demoMode } from "@/lib/demo/mode";
import { assetMappingEditsEnabled } from "@/lib/flags";
import { withIngestScope } from "@/lib/ingest/scope";
import { withUserScope, type Identity } from "@/lib/rls";
import { insertRows } from "./batch";
import { runSeedMatcher } from "./asset-maps-match";
import { folderHousehold, planStatementRuns } from "./asset-maps-snapshot";
import type { SeedContext } from "./context";
import { demoUuid, membersOf, staffEmail, staffOf, storyTransferId, type Universe } from "./universe";

/** The story households whose folders operations has already confirmed. */
const CONFIRMED_FOLDERS = [
  "sample-okafor", "sample-lindqvist", "sample-brennan", "sample-rossi", "sample-morgan", "sample-alvarez", "sample-nakamura",
];

// Without a statement named on the story, a statement account is the one a transfer moves when it is at the
// transfer's delivering firm and its value is within this share of the transfer's.
const VALUE_TOLERANCE = 0.1;

type AuditEntry = { action: string; entityType: string; entityId: string; detail: Record<string, unknown> };

/** writeAudit's row, dated when the decision was made. A step collects its rows and writes them together at its end,
 *  in the order its decisions made them (nothing else writes the audit log meanwhile). */
const auditAt = (identity: Identity, entry: AuditEntry, at: Date): Prisma.AuditLogCreateManyInput => ({
  actorEmail: identity.email ?? null,
  actorRole: identity.role ?? null,
  action: entry.action,
  entityType: entry.entityType,
  entityId: entry.entityId,
  detail: JSON.stringify(entry.detail),
  at,
});

// The import's page size and page ceiling (lib/data/asset-map-import.ts).
const IMPORT_PER_PAGE = 200;
const IMPORT_MAX_PAGES = 50;
const IMPORT_SOURCE = "statement-pipeline";
const IMPORT_ENDPOINT = "/api/v1/households";

const json = (text: string | null) => (text == null ? null : (JSON.parse(text) as unknown));

/**
 * The scheduled asset-map import (runAssetMapImport) as the seed runs it: the same page pull from the pipeline (the
 * stand-in answers), the same flattening, the same rows and counts-only audit row in one ingest transaction under the
 * import's lock, and the same run-identity census and writes after it. The one difference: the import upserts each
 * household, account and position on its own, about 900 statements in one transaction, which a distant database
 * can't finish inside the transaction's limit; here each table goes in as one statement. The seed's database is
 * freshly emptied, so every upsert is an insert.
 */
async function importRuns(runId: string): Promise<{ households: number; accounts: number; positions: number }> {
  const baseUrl = assetMapBaseUrl();
  if (!baseUrl) throw new Error("The asset-map seed needs STATEMENT_PIPELINE_URL (demo-config.json sets it).");
  const identityMode = runIdentityMode();
  const raw: unknown[] = [];
  const censusPages: CensusPage[] = [];
  let pages = 0;
  let page = 1;
  for (; page <= IMPORT_MAX_PAGES; page++) {
    const pd = await fetchHouseholdsPage(baseUrl, page, IMPORT_PER_PAGE);
    pages += 1;
    raw.push(...pd.households);
    if (identityMode !== "off") censusPages.push({ requestedPage: page, requestedPerPage: IMPORT_PER_PAGE, envelope: pd.envelope, households: pd.households });
    if (pd.households.length === 0 || raw.length >= pd.total) break;
  }
  const flat = flattenHouseholds(raw, undefined, { transferringText: assetMappingEditsEnabled() });
  const counts = { households: flat.households.length, accounts: flat.accounts.length, positions: flat.positions.length };
  await withIngestScope(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('aoa:asset-map-import', 0))`;
    await insertRows(tx, "mirror.acat_asset_map_household", flat.households.map((h) => ({ ...h, status_tallies: json(h.status_tallies) })));
    await insertRows(tx, "mirror.acat_asset_map_account", flat.accounts.map((a) => ({
      ...a, validation_issues: json(a.validation_issues), custodian_intel: json(a.custodian_intel),
    })));
    await insertRows(tx, "mirror.acat_asset_map_position", flat.positions.map((p) => ({
      ...p, notion_check: json(p.notion_check), lots: json(p.lots), is_deleted: false,
    })));
    await writeAudit(tx, { role: "INGEST", email: null }, {
      action: INGEST_ASSET_MAP, entityType: "ingest_run", entityId: runId,
      detail: {
        source: IMPORT_SOURCE, endpoint: IMPORT_ENDPOINT, pages, households: counts.households, accounts: counts.accounts,
        positions: counts.positions, upserted: counts.households + counts.accounts + counts.positions, rejected: flat.rejected.length,
        superseded: flat.households.filter((h) => h.superseded_by != null).length, dry_run: false,
      },
    });
  });
  // The import's identity phase in write mode (preview mode only reads).
  if (identityMode === "write") {
    const census = buildIdentityCensus(censusPages, { truncated: page > IMPORT_MAX_PAGES, maxPages: IMPORT_MAX_PAGES });
    const outcome = await applyRunIdentities(census, { runId, source: IMPORT_SOURCE, endpoint: IMPORT_ENDPOINT });
    if (outcome.status === "failed") throw new Error(`The asset-map import's run identities failed: ${outcome.reason}`);
  }
  return counts;
}

interface LiveAccount {
  id: string;
  source_folder_id: string;
  custodian: string | null;
  account_number: string | null;
  account_type: string | null;
  account_holder: string | null;
  total_value: number | null;
}

async function liveAccounts(ctx: SeedContext): Promise<LiveAccount[]> {
  return ctx.ingest.$queryRaw<LiveAccount[]>`
    SELECT a.id, h.source_folder_id, a.custodian, a.account_number, a.account_type, a.account_holder,
           a.total_value::float8 AS total_value
    FROM mirror.acat_asset_map_household h
    JOIN mirror.acat_asset_map_account a ON a.household_id = h.id
    WHERE h.superseded_by IS NULL AND h.source_folder_id IS NOT NULL
    ORDER BY h.source_folder_id, a.custodian, a.account_number`;
}

/** The household members an account holder names ("Kofi Okafor, Ada Okafor"; "Marisol Delgado, Trustee"). */
function holdersOf(universe: Universe, householdId: string, holder: string | null) {
  const text = (holder ?? "").toLowerCase();
  return membersOf(universe, householdId).filter((p) => text.includes(`${p.first} ${p.last}`.toLowerCase()));
}

export async function seedAssetMaps(ctx: SeedContext): Promise<Record<string, number>> {
  const { universe, now } = ctx;
  if (!demoMode()) throw new Error("The asset-map seed runs in demo mode only: its import must reach the stand-in.");
  if (!process.env.DATABASE_URL || !process.env.INGEST_DATABASE_URL) {
    throw new Error("The asset-map seed needs DATABASE_URL and INGEST_DATABASE_URL on the seeded database.");
  }

  // 0. The Statement Analyzer's runs, destinations, roster and fund list, in the pipeline's stand-in.
  const plan = planStatementRuns(universe, now);
  await ctx.standIns("pipeline", [
    ...plan.households.map((h, i) => ({ kind: "household", id: h.id, doc: h, position: i + 1 })),
    ...plan.destinations.map((d, i) => ({ kind: "destination", id: d.id, doc: d, position: i + 1 })),
    ...plan.roster.map((r, i) => ({ kind: "roster", id: String(i + 1).padStart(3, "0"), doc: r, position: i + 1 })),
    ...plan.fundRestrictions.map((f, i) => ({ kind: "fund_restriction", id: f.symbol, doc: f, position: i + 1 })),
  ]);

  // 1. The scheduled import.
  const upserted = await importRuns(demoUuid(`asset-map-import:${ctx.today}`));
  if (upserted.households !== plan.households.length) {
    throw new Error(`The asset-map import didn't take the stand-in's runs (is DATABASE_URL the seeded database?): ${JSON.stringify(upserted)}`);
  }

  // 2. The matcher's first pass over the folders.
  await runSeedMatcher(demoUuid(`asset-map-match:${ctx.today}:1`));

  // 3. Operations confirms the story folders; the matcher's next pass scores their accounts; operations confirms
  //    the accounts' owners.
  const jordan: Identity = { role: "OPERATIONS", email: staffEmail(staffOf(universe, "jordan-reyes")) };
  const latestRun = new Map<string, { id: string; processedAt: Date }>();
  for (const h of plan.households) {
    if (!h.superseded_by && h.source_folder_id) latestRun.set(h.source_folder_id, { id: h.id, processedAt: new Date(h.processed_at) });
  }
  const decidedAt = (folder: string, hours: number) =>
    new Date(Math.min(latestRun.get(folder)!.processedAt.getTime() + hours * 3_600_000, now.getTime() - 60_000));

  await withUserScope(jordan, async (tx) => {
    const audit: Prisma.AuditLogCreateManyInput[] = [];
    for (const folder of CONFIRMED_FOLDERS) {
      const householdId = folderHousehold(folder)!;
      const primary = membersOf(universe, householdId)[0];
      const at = decidedAt(folder, 2);
      const client = await resolveClientForLink(tx, ctx.personId.get(primary.id)!);
      const n = client && (await getLink(tx, folder)) ? await updateLinkDecision(tx, {
        sourceFolderId: folder, matchStatus: "CONFIRMED", clientSfId: client.clientSfId,
        cedarRidgeUserId: client.cedarRidgeUserId, householdSfId: client.householdSfId,
        confirmedBy: jordan.email ?? null, confirmedAt: at,
      }) : 0;
      if (!client || n === 0) throw new Error(`Couldn't confirm the asset-map folder ${folder}`);
      audit.push(auditAt(jordan, {
        action: ASSET_MAP_LINK_CONFIRM, entityType: "asset_map_link", entityId: folder,
        detail: { status: "CONFIRMED", clientSfId: client.clientSfId, householdSfId: client.householdSfId },
      }, at));
    }
    await tx.auditLog.createMany({ data: audit });
  }, { timeout: 120_000 });

  await runSeedMatcher(demoUuid(`asset-map-match:${ctx.today}:2`));

  let owners = 0;
  const accounts = await liveAccounts(ctx);
  await withUserScope(jordan, async (tx) => {
    const audit: Prisma.AuditLogCreateManyInput[] = [];
    for (const folder of CONFIRMED_FOLDERS) {
      const householdId = folderHousehold(folder)!;
      const at = decidedAt(folder, 3);
      for (const account of accounts.filter((a) => a.source_folder_id === folder && a.custodian && a.account_number)) {
        const isEntity = /trust/i.test(account.account_type ?? "");
        const holders = holdersOf(universe, householdId, account.account_holder);
        if (!isEntity && holders.length === 0) continue;
        const key = await resolveAccountForReview(tx, account.id);
        if (!key) throw new Error(`Couldn't resolve an asset-map account in ${folder}`);
        const chosen: AccountOwner[] = [];
        for (const person of isEntity ? [] : holders) {
          const member = await resolveMemberForAccountLink(tx, ctx.personId.get(person.id)!, ctx.householdId.get(householdId)!);
          if (!member) throw new Error(`An account holder in ${folder} isn't in the household`);
          chosen.push({
            cedarRidgeUserId: member.cedarRidgeUserId, clientSfId: member.clientSfId,
            ownershipRole: holders.length >= 2 ? "JOINT" : "PRIMARY",
          });
        }
        const n = await replaceAccountOwnerDecision(tx, {
          ...key, owners: chosen, isEntity, confirmedBy: jordan.email ?? null, confirmedAt: at,
        });
        if (n === 0 || (!isEntity && n < chosen.length)) throw new Error(`Couldn't confirm an account's owners in ${folder}`);
        audit.push(auditAt(jordan, {
          action: ASSET_MAP_ACCOUNT_CONFIRM, entityType: "asset_map_account_link", entityId: folder,
          detail: {
            status: "CONFIRMED", custodian: key.custodian, ownerCount: chosen.length, isEntity,
            clientSfIds: chosen.map((o) => o.clientSfId), householdSfId: ctx.householdId.get(householdId),
          },
        }, at));
        owners++;
      }
    }
    await tx.auditLog.createMany({ data: audit });
  }, { timeout: 120_000 });

  // 4. Each story transfer linked to the statement account it moves.
  const firstRun = new Map<string, Date>();
  for (const h of plan.households) {
    if (!h.source_folder_id) continue;
    const at = new Date(h.processed_at);
    const seen = firstRun.get(h.source_folder_id);
    if (!seen || at < seen) firstRun.set(h.source_folder_id, at);
  }
  const custodianName = new Map(universe.custodians.map((c) => [c.id, c.name]));
  let transfers = 0;
  await withUserScope(jordan, async (tx) => {
    const audit: Prisma.AuditLogCreateManyInput[] = [];
    for (const story of universe.stories.transfers) {
      const folder = [...latestRun.keys()].find((f) => folderHousehold(f) === story.household);
      if (!folder) continue;
      const candidates = accounts.filter((a) => a.source_folder_id === folder && a.custodian === custodianName.get(story.from));
      const suffix = universe.stories.statements.find((s) => s.id === story.statement)?.accounts?.[0]?.suffix;
      const account = suffix
        ? candidates.find((a) => a.account_number?.endsWith(suffix))
        : candidates.find((a) => a.total_value != null && Math.abs(a.total_value - story.value) <= story.value * VALUE_TOLERANCE);
      if (!account) continue;
      const transferId = storyTransferId(story.id);
      const transfer = await tx.transfer.findUnique({ where: { id: transferId }, select: { created_at: true, updated_at: true } });
      if (!transfer) continue;
      const key = await resolveAssignableAssetMapAccount(tx, account.id);
      if (!key) throw new Error(`The asset-map account for ${story.id} isn't assignable`);
      // Linked in Preparation, once both the transfer and the client's folder existed (the link is to the folder's
      // account, which every later run of the folder keeps).
      const at = new Date(Math.min(
        Math.max(firstRun.get(folder)!.getTime(), transfer.created_at.getTime()) + 2 * 3_600_000, now.getTime() - 60_000));
      await tx.transfer.update({
        where: { id: transferId },
        data: {
          asset_map_folder_id: key.sourceFolderId,
          asset_map_custodian: key.custodian,
          asset_map_account_number: key.accountNumber,
          asset_map_account_type: key.accountType,
          // The link is history: the transfer's last change stays when it was.
          updated_at: new Date(Math.max(transfer.updated_at.getTime(), at.getTime())),
        },
      });
      audit.push(auditAt(jordan, {
        action: TRANSFER_ASSET_MAP_LINK, entityType: "transfer", entityId: transferId,
        detail: {
          folderId: key.sourceFolderId, custodian: key.custodian, accountType: key.accountType,
          accountLast4: key.accountNumber ? key.accountNumber.slice(-4) : null,
        },
      }, at));
      transfers++;
    }
    await tx.auditLog.createMany({ data: audit });
  }, { timeout: 120_000 });

  // The live run for each universe household, for the parts after this one.
  const runs = new Map<string, string>();
  for (const [folder, run] of latestRun) {
    const householdId = folderHousehold(folder);
    if (householdId) runs.set(householdId, run.id);
  }
  ctx.shared.assetMaps = { runs };

  const tiers = await ctx.ingest.$queryRaw<Array<{ match_status: string; n: bigint }>>`
    SELECT match_status, count(*) AS n FROM mirror.acat_asset_map_link GROUP BY match_status`;
  const tier = (s: string) => Number(tiers.find((t) => t.match_status === s)?.n ?? 0);
  return {
    runs: plan.households.length,
    liveRuns: latestRun.size,
    accounts: upserted.accounts,
    positions: upserted.positions,
    destinations: plan.destinations.length,
    roster: plan.roster.length,
    foldersConfirmed: tier("CONFIRMED"),
    foldersAutoLinked: tier("AUTO_LINKED"),
    foldersNeedingReview: tier("NEEDS_REVIEW"),
    foldersUnmatched: tier("UNMATCHED"),
    accountOwnersConfirmed: owners,
    transfersLinked: transfers,
  };
}
