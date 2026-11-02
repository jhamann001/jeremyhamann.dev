import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import { crmCanonicalHouseholdSourceKeys } from "@/lib/crm/resolve";
import { isHouseholdHistoryId, type HouseholdHistoryKind } from "@/lib/navigation/household-history-query";
import type { ProgressivePage } from "@/lib/navigation/progressive-page";
import type { HouseholdTaskHistoryRow, HouseholdEmail, HouseholdActivity, Identity } from "./types";
import { EMAIL_BODY_WITHOUT_BCC } from "./email-body";
import { householdTaskAssignees, type HouseholdTaskAssigneeOption, type HouseholdTaskAssigneeSource } from "./household-task-assignees";

export type HouseholdHistoryMeta = { openCount: number; completedCount: number; assigneeOptions?: HouseholdTaskAssigneeOption[] };
export type HouseholdHistoryRows = { tasks: HouseholdTaskHistoryRow; email: HouseholdEmail; activity: HouseholdActivity };
export type HouseholdHistoryPage<Kind extends HouseholdHistoryKind> = ProgressivePage<HouseholdHistoryRows[Kind], HouseholdHistoryMeta>;

// Identifiers are code-owned SQL fragments. No table/column identifier comes from
// a request. Legacy meeting-preparation reads intentionally retain their contract.
const SOURCES = {
  tasks: {
    table: Prisma.sql`mirror.task`,
    select: Prisma.sql`sf_id, subject, status, priority, description, source_modified_at,
      assignment_state, assignee_type, assignee_name`,
    order: Prisma.sql`(lower(trim(coalesce(status, ''))) = 'completed') ASC, source_modified_at DESC NULLS LAST, sf_id ASC`,
  },
  email: {
    table: Prisma.sql`mirror.email`,
    select: Prisma.sql`sf_id, subject, ${EMAIL_BODY_WITHOUT_BCC} AS body, sent_at, source_modified_at, email_envelope`,
    order: Prisma.sql`sent_at DESC NULLS LAST, sf_id ASC`,
  },
  activity: {
    table: Prisma.sql`mirror.activity`,
    select: Prisma.sql`sf_id, subject, note, activity_at, owner_name, source_modified_at`,
    order: Prisma.sql`coalesce(activity_at, source_modified_at) DESC NULLS LAST, sf_id ASC`,
  },
} satisfies Record<HouseholdHistoryKind, { table: Prisma.Sql; select: Prisma.Sql; order: Prisma.Sql }>;

export async function getHouseholdHistoryPage<Kind extends HouseholdHistoryKind>(
  identity: Identity,
  householdId: string,
  kind: Kind,
  { page = 1, pageSize = 100, includeCompleted = false, assigneeFilter }: {
    page?: number; pageSize?: number; includeCompleted?: boolean; assigneeFilter?: string;
  } = {},
): Promise<HouseholdHistoryPage<Kind> | null> {
  if (!isHouseholdHistoryId(householdId) || !Object.hasOwn(SOURCES, kind)) return null;
  // Never trust source IDs from the browser or reuse the detail render's old
  // canonical group. Every append resolves the group again, then rechecks RLS.
  const resolved = await crmCanonicalHouseholdSourceKeys(identity, householdId);
  const keys = [...new Set(resolved.filter(Boolean).map(key => key.slice(0, 15)))].sort();
  if (!keys.length || keys.length > 16) return null;
  const size = Number.isFinite(pageSize) ? Math.max(100, Math.min(200, Math.trunc(pageSize))) : 100;
  const requestedPage = Number.isFinite(page) ? Math.max(1, Math.min(1_000_000, Math.trunc(page))) : 1;
  const source = SOURCES[kind];
  return withUserScope(identity, async tx => {
    const visible = await tx.$queryRaw<Array<{ sf_id: string }>>(Prisma.sql`
      SELECT sf_id FROM mirror.household WHERE left(sf_id, 15) IN (${Prisma.join(keys)}) ORDER BY sf_id`);
    if (!visible.length) return null;
    const visibleKeys = [...new Set(visible.map(row => row.sf_id.slice(0, 15)))].sort();
    const where = Prisma.sql`left(household_sf_id, 15) IN (${Prisma.join(visibleKeys)})`;
    const completed = kind === "tasks" ? Prisma.sql`lower(trim(coalesce(status, ''))) = 'completed'` : Prisma.sql`false`;
    // Resolve owners only from this household's full authorized task population,
    // before pagination or the completed toggle. Prefer the newest readable
    // source name when historical observations differ for the same owner.
    const ownerSources = kind === "tasks" ? await tx.$queryRaw<HouseholdTaskAssigneeSource[]>(Prisma.sql`
      SELECT DISTINCT ON (assignee_type, left(assignee_sf_id, 15))
        left(assignee_sf_id, 15) AS source_id, assignee_type, btrim(assignee_name) AS assignee_name
      FROM mirror.task WHERE ${where} AND assignment_state = 'ASSIGNED'
        AND assignee_type IN ('USER', 'QUEUE') AND nullif(btrim(assignee_name), '') IS NOT NULL
      ORDER BY assignee_type, left(assignee_sf_id, 15), assignment_observed_at DESC NULLS LAST,
        source_modified_at DESC NULLS LAST, sf_id ASC`) : [];
    // The resolver returns the canonical survivor first; aliases and 15/18-char
    // source IDs therefore produce the same household-scoped option identity.
    const owners = householdTaskAssignees(resolved[0], ownerSources);
    let assignment = Prisma.sql`true`;
    if (kind === "tasks" && assigneeFilter !== undefined) {
      if (assigneeFilter === "unassigned") assignment = Prisma.sql`assignment_state = 'UNASSIGNED'`;
      else if (assigneeFilter === "unavailable") assignment = Prisma.sql`(assignment_state = 'UNAVAILABLE'
        OR (assignment_state = 'ASSIGNED' AND nullif(btrim(assignee_name), '') IS NULL))`;
      else {
        const owner = owners.find(option => option.token === assigneeFilter);
        // Unknown or foreign-household tokens always fail closed to no rows.
        assignment = owner ? Prisma.sql`assignment_state = 'ASSIGNED'
          AND assignee_type = ${owner.type} AND left(assignee_sf_id, 15) = ${owner.sourceId}` : Prisma.sql`false`;
      }
    }
    // Hash compact MVCC row versions, not historical note/email bodies. Every
    // update changes xmin even if a feed retains its source_modified_at value.
    const [counts] = await tx.$queryRaw<Array<{ total: bigint; completed: bigint; version: string }>>(Prisma.sql`
      SELECT count(*) FILTER (WHERE ${assignment})::bigint AS total,
        count(*) FILTER (WHERE ${assignment} AND ${completed})::bigint AS completed,
        md5(coalesce(string_agg(sf_id || ':' || xmin::text, ',' ORDER BY sf_id), '')) AS version
      FROM ${source.table} WHERE ${where}`);
    const totalRows = Number(counts?.total ?? 0);
    const completedCount = Number(counts?.completed ?? 0);
    const total = kind === "tasks" && !includeCompleted ? totalRows - completedCount : totalRows;
    const pageCount = Math.max(1, Math.ceil(total / size));
    const currentPage = Math.min(requestedPage, pageCount);
    const rows = await tx.$queryRaw<HouseholdHistoryRows[Kind][]>(Prisma.sql`
      SELECT ${source.select} FROM ${source.table}
      WHERE ${where} AND (${assignment}) ${kind === "tasks" && !includeCompleted ? Prisma.sql`AND NOT (${completed})` : Prisma.empty}
      ORDER BY ${source.order} LIMIT ${size} OFFSET ${(currentPage - 1) * size}`);
    const snapshot = createHash("sha256").update(JSON.stringify({
      kind, includeCompleted: kind === "tasks" && includeCompleted, assigneeFilter: kind === "tasks" ? assigneeFilter ?? null : null, sourceKeys: keys,
      visibleKeys, totalRows, completedCount, version: counts?.version ?? "",
    })).digest("hex");
    return { rows, page: currentPage, pageSize: size, total, pageCount, snapshot,
      meta: { openCount: kind === "tasks" ? totalRows - completedCount : 0, completedCount,
        ...(kind === "tasks" ? { assigneeOptions: owners.map(({ token, label, type }) => ({ token, label, type })) } : {}) } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
