import { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { transferBoardQuery, type TransferBoardRow, type TransferOpsStats } from "./transfers";
import { getDerivedReceivingAccountsWithinScope } from "./receiving-account-match";
import { toTransferBoardClientRow, type TransferBoardClientRow } from "./transfer-board-client";
import { checklistStageGateEnabled, hideDemoTransferCardsEnabled } from "@/lib/flags";
import type { TransferStage, SearchGroups } from "./transfer-types";
import type { TransferBoardQuery } from "@/lib/navigation/transfer-query";
import type { ProgressivePage } from "@/lib/navigation/progressive-page";

export type TransferDirectoryMeta = { lanes: Record<TransferStage, number>; hiddenCompleted: number; stats: TransferOpsStats };
type Envelope = { rows: TransferBoardRow[]; total: bigint; snapshot: string; lanes: Record<TransferStage, number>; hidden: bigint; stats: TransferOpsStats };

/**150 cards per page, interleaved by lane rank so large lanes cannot hide small ones. */
export async function getTransferDirectory(identity: Identity, query: TransferBoardQuery): Promise<ProgressivePage<TransferBoardClientRow, TransferDirectoryMeta>> {
  const base = transferBoardQuery({ currentStageChecklistOnly: checklistStageGateEnabled() });
  const showAll = query.completed || !!query.household || !!query.query;
  const sort = Prisma.sql`CASE stage::text WHEN 'DECISION' THEN ${query.sorts.DECISION} WHEN 'IN_TRANSFER' THEN ${query.sorts.IN_TRANSFER} ELSE ${query.sorts.FUNDED} END`;
  const pattern = `%${query.query.replace(/[\\%_]/g, "\\$&")}%`;
  return withUserScope(identity, async tx => {
    const [envelope] = await tx.$queryRaw<Envelope[]>(Prisma.sql`
      WITH board AS MATERIALIZED (${base}), focused AS MATERIALIZED (
        SELECT * FROM board
        WHERE (${query.owner} = '' OR owner_kind::text = ${query.owner})
          AND (${query.household} = '' OR household_sf_id = ${query.household} OR household_name = ${query.household})
          AND (${query.household} <> '' OR ${query.query} = '' OR (client_first_name || ' ' || client_last_name) ILIKE ${pattern} OR COALESCE(household_name, '') ILIKE ${pattern})
      ), visible AS MATERIALIZED (
        SELECT * FROM focused WHERE ${showAll} OR stage <> 'FUNDED' OR "tasksDone" < "tasksTotal"
      ), ranked AS (
        SELECT v.*, row_number() OVER (PARTITION BY stage ORDER BY
          CASE WHEN ${sort} = 'asc' THEN lower(client_last_name) END ASC,
          CASE WHEN ${sort} = 'asc' THEN lower(client_first_name) END ASC,
          CASE WHEN ${sort} = 'desc' THEN lower(client_last_name) END DESC,
          CASE WHEN ${sort} = 'desc' THEN lower(client_first_name) END DESC,
          stage_entered_at ASC, id) AS lane_rank FROM visible v
      ), page_rows AS (
        SELECT * FROM ranked ORDER BY lane_rank, stage, id LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}
      ), stats AS (
        SELECT jsonb_build_object('outstanding', COALESCE(sum(value) FILTER (WHERE stage <> 'FUNDED'), 0),
          'active', count(*) FILTER (WHERE stage <> 'FUNDED'),
          'bouncing', count(*) FILTER (WHERE stage <> 'FUNDED' AND owner_kind = 'ADVISOR')) AS value FROM board
      )
      SELECT (SELECT count(*) FROM visible) AS total,
        COALESCE((SELECT jsonb_agg(to_jsonb(p) - 'lane_rank' ORDER BY lane_rank, stage, id) FROM page_rows p), '[]'::jsonb) AS rows,
        jsonb_build_object('DECISION', (SELECT count(*) FROM visible WHERE stage = 'DECISION'),
          'IN_TRANSFER', (SELECT count(*) FROM visible WHERE stage = 'IN_TRANSFER'),
          'FUNDED', (SELECT count(*) FROM visible WHERE stage = 'FUNDED')) AS lanes,
        (SELECT count(*) FROM focused WHERE stage = 'FUNDED' AND "tasksDone" >= "tasksTotal") AS hidden,
        (SELECT value FROM stats) AS stats,
        md5(COALESCE((SELECT string_agg(md5((to_jsonb(v) - 'asset_map_account_number')::text), '' ORDER BY id) FROM visible v), '')
          || (SELECT value::text FROM stats)
          || (SELECT count(*)::text FROM focused WHERE stage = 'FUNDED' AND "tasksDone" >= "tasksTotal")
          || COALESCE((SELECT string_agg(md5(jsonb_build_array(c.client_sf_id, c.account_type, c.account_status, c.apex_account_number, c.source_present, c.balance_current)::text), '' ORDER BY c.custodian_account_id)
            FROM mirror.client_account_aum c WHERE c.client_sf_id IN (SELECT client_sf_id FROM visible)), '')) AS snapshot`);
    const rows = envelope.rows.map(row => ({ ...row, value: Number(row.value), tasksDone: Number(row.tasksDone), tasksTotal: Number(row.tasksTotal),
      daysInStage: Math.max(0, Math.floor((Date.now() - new Date(row.stage_entered_at).getTime()) / 86_400_000)),
      bouncing: row.owner_kind === "ADVISOR" && row.stage !== "FUNDED" }));
    const receiving = await getDerivedReceivingAccountsWithinScope(tx, rows.map(row => ({ transferId: row.id, clientSfId: row.client_sf_id, accountType: row.asset_map_account_type })));
    const total = Number(envelope.total);
    return { rows: rows.map(row => toTransferBoardClientRow(row, receiving[row.id] ?? null)), page: query.page, pageSize: query.pageSize,
      total, pageCount: Math.max(1, Math.ceil(total / query.pageSize)), snapshot: envelope.snapshot,
      meta: { lanes: envelope.lanes, hiddenCompleted: Number(envelope.hidden), stats: envelope.stats } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** Full-book search with bounded suggestions; household aggregates cover all matches. */
export async function searchTransferDirectory(identity: Identity, query: string): Promise<SearchGroups> {
  if (!query.trim() || query.length > 256) return { households: [], individuals: [] };
  const pattern = `%${query.trim().replace(/[\\%_]/g, "\\$&")}%`;
  const demo = hideDemoTransferCardsEnabled() ? Prisma.sql`t.id NOT LIKE 'DEMO-T-%' AND COALESCE(t.deal_sf_id, d.sf_deal_id, '') NOT LIKE 'DEMO-%'` : Prisma.sql`TRUE`;
  return withUserScope(identity, async tx => {
    const [result] = await tx.$queryRaw<SearchGroups[]>(Prisma.sql`
      WITH matched AS MATERIALIZED (
        SELECT t.id, t.client_first_name || ' ' || t.client_last_name AS name, t.household_name AS household,
          COALESCE(t.household_sf_id, t.household_name) AS household_key, t.stage, COALESCE(d.amount, t.value) AS value, t.transferring_firm AS contra
        FROM app.transfer t LEFT JOIN app.deal d ON d.id = t.deal_id
        WHERE t.archived_at IS NULL AND ${demo}
          AND ((t.client_first_name || ' ' || t.client_last_name) ILIKE ${pattern} OR COALESCE(t.household_name, '') ILIKE ${pattern})
      ), households AS (
        SELECT household_key AS key, min(household) AS name, count(*) AS count, sum(value) AS total FROM matched
        WHERE household_key IS NOT NULL AND household IS NOT NULL GROUP BY household_key ORDER BY min(household), household_key LIMIT 20
      ), individuals AS (SELECT id, name, stage, value, contra FROM matched ORDER BY name, id LIMIT 50)
      SELECT COALESCE((SELECT jsonb_agg(h) FROM households h), '[]'::jsonb) AS households,
        COALESCE((SELECT jsonb_agg(i) FROM individuals i), '[]'::jsonb) AS individuals`);
    return result;
  });
}
