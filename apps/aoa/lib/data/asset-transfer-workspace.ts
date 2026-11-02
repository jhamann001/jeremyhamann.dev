import { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { hideDemoTransferCardsEnabled } from "@/lib/flags";
import { ASSET_MAPPER_TITLE, STATEMENTS_TITLE, type FundingType, type TransferStage } from "./transfer-types";
import { getDerivedReceivingAccountsWithinScope } from "./receiving-account-match";
import { partialAcatQueueTasks, readPartialAcatTasks } from "@/lib/data/partial-acat-workspace-tasks";
import { outcomeRecordsEnabled } from "@/lib/transfers/outcomes";
import { followUpRecordsEnabled } from "@/lib/transfers/follow-up";
import { connectedIdentity } from "@/lib/transfers/connections";
import {
  effectiveTaskStatus,
  taskTeam,
  type WorkspaceActivity,
  type WorkspaceRejection,
  type WorkspaceTransfer,
} from "@/lib/transfers/workspace-queue";

// Read-only Asset Transfer workspace read (ATW-01). Runs inside withUserScope,
// so app.transfer RLS decides which movements, tasks, and audit rows appear.
// Audit rows are joined to visible transfers and expose the actor role only.
// Account numbers leave this module as their last four characters only.

const ACTIVITY_LIMIT = 300;

type TransferRow = {
  id: string; client_first_name: string; client_last_name: string; client_sf_id: string | null; household_sf_id: string | null;
  household_name: string | null; stage: TransferStage; funding_type: FundingType | null;
  transferring_firm: string | null; asset_map_custodian: string | null; asset_map_account_type: string | null;
  asset_map_account_number: string | null; value: Prisma.Decimal | number;
  source_account_type: string | null; source_account_last4: string | null; source_account_title: string | null;
  receiving_account_type: string | null; receiving_account_title: string | null;
  deal_id: string | null; deal_name: string | null; deal_ref: string | null;
  deal_client_first_name: string | null; deal_client_last_name: string | null;
  deal_household_name: string | null; deal_household_sf_id: string | null;
  dir_client_sf_id: string | null; dir_first_name: string | null; dir_last_name: string | null;
  dir_household_sf_id: string | null; dir_household_name: string | null;
};
type TaskRow = {
  id: string; transfer_id: string; title: string; sort_order: number; status: string; team: string | null;
  assigned_to: string | null; follow_up_on: Date | null; done: boolean;
};
type AuditRow = { id: bigint; at: Date; actorRole: string | null; action: string; entityId: string };
type AccountRow = { transfer_id: string; label: string; status: string };
type MatchRow = { transfer_id: string; receiving_account_type: string };
type StatementRow = { transfer_id: string; accepted: boolean; created_at: Date };
type OutcomeRow = { transfer_id: string; outcome: string; resumed: boolean };
type RejectionRow = { transfer_id: string; follow_up_owner: string; response: string | null; awaiting_operations_review: boolean; created_at: Date };
type LatestAtRow = { transfer_id: string; created_at: Date };
type CountRow = { transfer_id: string; count: bigint | number };

export type AssetTransferWorkspace = { transfers: WorkspaceTransfer[]; activity: WorkspaceActivity[] };

export function lastFour(value: string | null | undefined): string | null {
  const compact = (value ?? "").replace(/[^A-Za-z0-9]/g, "");
  return compact ? compact.slice(-4) : null;
}

function byTransfer<T extends { transfer_id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map(row => [row.transfer_id, row]));
}

/** An unaccepted rejection, or an accepted one with no newer submission, still blocks the movement. */
export function activeRejection(row: RejectionRow | undefined, latestSubmissionAt: Date | undefined): WorkspaceRejection | null {
  if (!row) return null;
  if (row.response === null) return { owner: row.follow_up_owner, status: "open" };
  if (row.awaiting_operations_review) return { owner: row.follow_up_owner, status: "returned" };
  if (latestSubmissionAt && latestSubmissionAt.getTime() > row.created_at.getTime()) return null;
  return { owner: row.follow_up_owner, status: "resolved" };
}

/** `householdSfIds` narrows to one household's Salesforce sources, matched on the 15-character id. */
export async function getAssetTransferWorkspace(identity: Identity, options: { householdSfIds?: readonly string[] } = {}): Promise<AssetTransferWorkspace> {
  const household = options.householdSfIds
    ? Prisma.sql`left(t.household_sf_id, 15) = ANY(${[...new Set(options.householdSfIds.map(id => id.slice(0, 15)))]}::text[])`
    : Prisma.sql`TRUE`;
  const demo = hideDemoTransferCardsEnabled()
    ? Prisma.sql`(t.id NOT LIKE 'DEMO-T-%' AND COALESCE(t.deal_sf_id, d.sf_deal_id, '') NOT LIKE 'DEMO-%')`
    : Prisma.sql`TRUE`;
  const outcomes = outcomeRecordsEnabled();
  const followUps = followUpRecordsEnabled();
  return withUserScope(identity, async tx => {
    const transfers = await tx.$queryRaw<TransferRow[]>(Prisma.sql`
      SELECT t.id, t.client_first_name, t.client_last_name, t.client_sf_id, t.household_sf_id, t.household_name, t.stage,
             t.funding_type, t.transferring_firm, t.asset_map_custodian, t.asset_map_account_type, t.asset_map_account_number,
             t.source_account_type, t.source_account_last4, t.source_account_title, t.receiving_account_type, t.receiving_account_title,
             COALESCE(d.amount, t.value) AS value, t.deal_id, d.name AS deal_name, COALESCE(t.deal_sf_id, d.sf_deal_id) AS deal_ref,
             d.client_first_name AS deal_client_first_name, d.client_last_name AS deal_client_last_name,
             d.household_name AS deal_household_name, d.household_sf_id AS deal_household_sf_id,
             c.sf_id AS dir_client_sf_id, c.first_name AS dir_first_name, c.last_name AS dir_last_name,
             h.sf_id AS dir_household_sf_id, h.name AS dir_household_name
      FROM app.transfer t LEFT JOIN app.deal d ON d.id = t.deal_id
      LEFT JOIN LATERAL (
        SELECT mc.sf_id, mc.first_name, mc.last_name, mc.household_id FROM mirror.client mc
        WHERE t.client_sf_id IS NOT NULL
          AND (mc.sf_id = t.client_sf_id OR (length(t.client_sf_id) = 15 AND left(mc.sf_id, 15) = t.client_sf_id))
          AND (mc.household_id IS NULL OR mc.sf_id <> mc.household_id)
        ORDER BY mc.sf_id LIMIT 1
      ) c ON TRUE
      LEFT JOIN mirror.household h ON h.sf_id = c.household_id
      WHERE t.archived_at IS NULL AND ${demo} AND ${household}
      ORDER BY lower(t.client_last_name), lower(t.client_first_name), t.id`);
    const ids = transfers.map(row => row.id);
    if (!ids.length) return { transfers: [], activity: [] };
    const tasks = await tx.$queryRaw<TaskRow[]>(Prisma.sql`
      SELECT k.id, k.transfer_id, k.title, k.sort_order, k.status, k.team, k.assigned_to, k.follow_up_on,
             CASE k.title
               WHEN ${STATEMENTS_TITLE} THEN COALESCE(k.override_done, d.statements, k.done)
               WHEN ${ASSET_MAPPER_TITLE} THEN COALESCE(k.override_done, d.asset_mapped, k.done)
               ELSE k.done
             END AS done
      FROM app.transfer_task k JOIN app.transfer t ON t.id = k.transfer_id
      LEFT JOIN app.deal d ON d.id = t.deal_id
      WHERE k.transfer_id = ANY(${ids}::text[])`);
    const audit = await tx.$queryRaw<AuditRow[]>(Prisma.sql`
      SELECT a.id, a.at, a."actorRole", a.action, a."entityId"
      FROM audit."AuditLog" a
      WHERE a."entityType" = 'transfer' AND a."entityId" = ANY(${ids}::text[])
      ORDER BY a.at DESC, a.id DESC LIMIT ${ACTIVITY_LIMIT}`);
    const accounts = await tx.$queryRaw<AccountRow[]>(Prisma.sql`
      SELECT transfer_id, label, status::text AS status FROM app.transfer_account
      WHERE transfer_id = ANY(${ids}::text[]) ORDER BY transfer_id, created_at, id`);
    const matches = await tx.$queryRaw<MatchRow[]>(Prisma.sql`
      SELECT DISTINCT ON (transfer_id) transfer_id, receiving_account_type FROM app.transfer_account_match
      WHERE transfer_id = ANY(${ids}::text[]) ORDER BY transfer_id, created_at DESC, id DESC`);
    const statements = await tx.$queryRaw<StatementRow[]>(Prisma.sql`
      SELECT DISTINCT ON (transfer_id) transfer_id, accepted, created_at FROM app.transfer_statement
      WHERE transfer_id = ANY(${ids}::text[]) ORDER BY transfer_id, created_at DESC, id DESC`);
    const authorizations = await tx.$queryRaw<{ transfer_id: string }[]>(Prisma.sql`
      SELECT DISTINCT transfer_id FROM app.transfer_app_authorization WHERE transfer_id = ANY(${ids}::text[])`);
    const receipts = await tx.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT transfer_id, count(*) AS count FROM app.transfer_receipt
      WHERE transfer_id = ANY(${ids}::text[]) GROUP BY transfer_id`);
    const latestOutcomes = outcomes ? await tx.$queryRaw<OutcomeRow[]>(Prisma.sql`
      SELECT DISTINCT ON (transfer_id) transfer_id, outcome, resumed FROM app.transfer_outcome
      WHERE transfer_id = ANY(${ids}::text[]) ORDER BY transfer_id, created_at DESC, id DESC`) : [];
    const rejections = followUps ? await tx.$queryRaw<RejectionRow[]>(Prisma.sql`
      SELECT DISTINCT ON (transfer_id) transfer_id, follow_up_owner, response, awaiting_operations_review, created_at
      FROM app.transfer_acat_rejection
      WHERE transfer_id = ANY(${ids}::text[]) ORDER BY transfer_id, created_at DESC, id DESC`) : [];
    const submissions = rejections.length ? await tx.$queryRaw<LatestAtRow[]>(Prisma.sql`
      SELECT DISTINCT ON (transfer_id) transfer_id, created_at FROM app.transfer_submission
      WHERE transfer_id = ANY(${rejections.map(row => row.transfer_id)}::text[]) ORDER BY transfer_id, created_at DESC, id DESC`) : [];
    const derived = await getDerivedReceivingAccountsWithinScope(tx, transfers.map(row => ({
      transferId: row.id, clientSfId: row.client_sf_id, accountType: row.asset_map_account_type,
    })));

    const partialByTransfer = partialAcatQueueTasks(
      await readPartialAcatTasks(tx, ids),
      new Map(transfers.map(row => [row.id, row.funding_type])),
    );
    const tasksByTransfer = new Map<string, WorkspaceTransfer["tasks"]>();
    for (const task of tasks) {
      const list = tasksByTransfer.get(task.transfer_id) ?? [];
      list.push({ id: task.id, transferId: task.transfer_id, title: task.title, sortOrder: task.sort_order,
        status: effectiveTaskStatus(task.done, task.status), team: taskTeam(task.team),
        assignedTo: task.assigned_to, followUpOn: task.follow_up_on?.toISOString().slice(0, 10) ?? null });
      tasksByTransfer.set(task.transfer_id, list);
    }
    for (const [transferId, partial] of partialByTransfer) {
      tasksByTransfer.set(transferId, [...(tasksByTransfer.get(transferId) ?? []), ...partial]);
    }
    const accountsByTransfer = new Map<string, AccountRow[]>();
    for (const account of accounts) accountsByTransfer.set(account.transfer_id, [...(accountsByTransfer.get(account.transfer_id) ?? []), account]);
    const matchBy = byTransfer(matches), statementBy = byTransfer(statements), outcomeBy = byTransfer(latestOutcomes);
    const rejectionBy = byTransfer(rejections), submissionBy = byTransfer(submissions), receiptBy = byTransfer(receipts);
    const authorized = new Set(authorizations.map(row => row.transfer_id));

    return {
      transfers: transfers.map(row => {
        const own = accountsByTransfer.get(row.id) ?? [];
        const match = derived[row.id];
        const statement = statementBy.get(row.id);
        const outcome = outcomeBy.get(row.id);
        const connected = connectedIdentity(row,
          row.dir_client_sf_id ? {
            sfId: row.dir_client_sf_id,
            name: `${row.dir_first_name?.trim() ?? ""} ${row.dir_last_name?.trim() ?? ""}`.trim(),
            householdSfId: row.dir_household_sf_id,
            householdName: row.dir_household_name,
          } : null,
          row.deal_id && row.deal_client_first_name != null ? {
            clientFirstName: row.deal_client_first_name,
            clientLastName: row.deal_client_last_name ?? "",
            householdName: row.deal_household_name,
            householdSfId: row.deal_household_sf_id,
          } : null);
        return {
          id: row.id, clientName: connected.name,
          clientFirstName: row.client_first_name, clientLastName: row.client_last_name, clientSfId: row.client_sf_id,
          householdSfId: connected.householdSfId, householdName: connected.householdName, stage: row.stage,
          fundingType: row.funding_type, transferringFirm: row.transferring_firm, receivingAccount: row.asset_map_account_type,
          value: Number(row.value), dealId: row.deal_id, dealName: row.deal_name, dealRef: row.deal_ref,
          source: {
            institution: row.transferring_firm ?? row.asset_map_custodian,
            type: row.asset_map_account_type ?? row.source_account_type,
            last4: lastFour(row.asset_map_account_number) ?? row.source_account_last4,
            title: row.source_account_title,
          },
          destination: {
            type: match?.registrationType ?? matchBy.get(row.id)?.receiving_account_type ?? row.receiving_account_type ?? own[0]?.label ?? null,
            title: row.receiving_account_title,
            last4: lastFour(match?.apexAccountMasked),
            opening: match ? match.status === "TO_OPEN" : own[0]?.status === "TO_OPEN",
          },
          receivingAccounts: own.map(account => ({ label: account.label, open: account.status === "OPEN" })),
          appAuthorized: authorized.has(row.id),
          statement: statement ? { accepted: statement.accepted, recordedOn: statement.created_at.toISOString().slice(0, 10) } : null,
          outcome: outcome && !outcome.resumed ? outcome.outcome : null,
          rejection: activeRejection(rejectionBy.get(row.id), submissionBy.get(row.id)?.created_at),
          receipts: Number(receiptBy.get(row.id)?.count ?? 0),
          tasks: tasksByTransfer.get(row.id) ?? [],
        };
      }),
      activity: audit.map(row => ({ id: String(row.id), at: row.at.toISOString(), actor: row.actorRole, action: row.action, transferId: row.entityId })),
    };
  });
}
