import { Prisma, type PrismaClient } from "@prisma/client";

const ids = (kind: string, count: number) => Array.from({ length: count }, (_, i) => `PN-${kind}-${String(i + 1).padStart(4, "0")}`);
export const compactTaskId = "00TSYN000000006";
export const compactTaskTitle = "PN History Fixture Task 6 — " +
  "Review the synthetic household follow-up, confirm the document request, and prepare the next conversation ".repeat(4);
export const compactTaskBody = "Synthetic confidential task body — detailed follow-up instructions.\n" +
  "This invented detail must remain available on expansion without filling the collapsed household task list.\n".repeat(8);
const taskIds = ids("TASK", 230).map((id, index) => index === 5 ? compactTaskId : id);
const emailIds = ids("EMAIL", 205), activityIds = ids("CALL", 205);
const ticketId = "PN-HYDRATION-TICKET", commentId = "PN-HYDRATION-COMMENT";

/** Only exact invented IDs in the same dedicated browser-test database. */
export async function setupHouseholdHistoryFixture(owner: PrismaClient) {
  const [target] = await owner.$queryRaw<Array<{ db: string; role: string; host: string }>>`
    SELECT current_database() AS db, current_user AS role, inet_server_addr()::text AS host`;
  if (target?.db !== "aoa_pagination_synthetic" || target.role !== "aoa" || !["127.0.0.1/32", "127.0.0.1", "::1/128", "::1"].includes(target.host)) {
    throw new Error("isolated_household_history_fixture_required");
  }
  for (const [table, keys] of [[Prisma.sql`mirror.task`, taskIds], [Prisma.sql`mirror.email`, emailIds], [Prisma.sql`mirror.activity`, activityIds]] as const) {
    const [collision] = await owner.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*) AS count FROM ${table} WHERE sf_id IN (${Prisma.join(keys)})
        AND (household_sf_id IS DISTINCT FROM 'PN-HH-0350' OR subject NOT LIKE 'PN History Fixture%')`);
    if (Number(collision?.count)) throw new Error("household_history_fixture_collision");
  }
  const [ticketCollision] = await owner.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM mirror.zendesk_ticket WHERE zendesk_ticket_id = ${ticketId}
      AND (household_sf_id IS DISTINCT FROM 'PN-HH-0350' OR subject IS DISTINCT FROM 'PN History Fixture Ticket')`;
  const [commentCollision] = await owner.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM mirror.zendesk_ticket_comment WHERE zendesk_comment_id = ${commentId}
      AND (zendesk_ticket_id IS DISTINCT FROM ${ticketId} OR body IS DISTINCT FROM 'Synthetic hydration comment')`;
  if (Number(ticketCollision?.count) || Number(commentCollision?.count)) throw new Error("household_hydration_fixture_collision");
  const cleanup = async () => {
    await owner.$executeRaw`DELETE FROM mirror.zendesk_ticket_comment WHERE zendesk_comment_id = ${commentId}`;
    await owner.$executeRaw`DELETE FROM mirror.zendesk_ticket WHERE zendesk_ticket_id = ${ticketId}`;
    await owner.$executeRaw(Prisma.sql`DELETE FROM mirror.task WHERE sf_id IN (${Prisma.join(taskIds)})`);
    await owner.$executeRaw(Prisma.sql`DELETE FROM mirror.email WHERE sf_id IN (${Prisma.join(emailIds)})`);
    await owner.$executeRaw(Prisma.sql`DELETE FROM mirror.activity WHERE sf_id IN (${Prisma.join(activityIds)})`);
  };
  await cleanup();
  await owner.$executeRaw`
    INSERT INTO mirror.task (sf_id, household_sf_id, subject, status, description, source_modified_at)
    SELECT CASE WHEN i = 6 THEN ${compactTaskId} ELSE 'PN-TASK-' || lpad(i::text, 4, '0') END,
      'PN-HH-0350', 'PN History Fixture Task ' || i,
      CASE WHEN i > 205 THEN 'Completed' ELSE 'Not Started' END, 'Synthetic confidential task body',
      '2026-09-01T02:30:00Z'::timestamptz - i * interval '1 second' FROM generate_series(1, 230) i`;
  await owner.$executeRaw`
    UPDATE mirror.task SET subject = ${compactTaskTitle}, description = ${compactTaskBody}, priority = 'High'
    WHERE sf_id = ${compactTaskId}`;
  // Initial, appended and completed pages each exercise source-confirmed
  // assignment. Other rows retain the migration's unavailable legacy default.
  await owner.$executeRaw`
    UPDATE mirror.task SET assignment_state = 'ASSIGNED', assignee_sf_id = '005SYN000000001',
      assignee_type = 'USER', assignee_name = 'PN Synthetic Avery',
      assignment_observed_at = '2026-09-24T12:00:00Z'::timestamptz
    WHERE sf_id IN ('PN-TASK-0001', 'PN-TASK-0101', 'PN-TASK-0226')`;
  await owner.$executeRaw`
    UPDATE mirror.task SET assignment_state = 'ASSIGNED', assignee_sf_id = '00GSYN000000001',
      assignee_type = 'QUEUE', assignee_name = 'PN Synthetic Operations',
      assignment_observed_at = '2026-09-24T12:00:00Z'::timestamptz
    WHERE sf_id IN ('PN-TASK-0002', 'PN-TASK-0102', 'PN-TASK-0227')`;
  await owner.$executeRaw`
    UPDATE mirror.task SET assignment_state = 'UNASSIGNED',
      assignment_observed_at = '2026-09-24T12:00:00Z'::timestamptz
    WHERE sf_id IN ('PN-TASK-0003', 'PN-TASK-0103', 'PN-TASK-0228')`;
  await owner.$executeRaw`
    UPDATE mirror.task SET assignment_state = 'ASSIGNED', assignee_sf_id = '005SYN000000002',
      assignee_type = 'USER', assignee_name = NULL,
      assignment_observed_at = '2026-09-24T12:00:00Z'::timestamptz
    WHERE sf_id IN ('PN-TASK-0005', 'PN-TASK-0105', 'PN-TASK-0230')`;
  // These owners do not appear on the first 100 open tasks. Filter choices
  // must come from the complete authorized population, including completed.
  await owner.$executeRaw`
    UPDATE mirror.task SET assignment_state = 'ASSIGNED', assignee_sf_id = '00GSYN000000003',
      assignee_type = 'QUEUE', assignee_name = 'PN Synthetic Later Queue',
      assignment_observed_at = '2026-09-24T12:00:00Z'::timestamptz
    WHERE sf_id IN ('PN-TASK-0151', 'PN-TASK-0211')`;
  await owner.$executeRaw`
    UPDATE mirror.task SET assignment_state = 'ASSIGNED', assignee_sf_id = '005SYN000000004',
      assignee_type = 'USER', assignee_name = 'PN Synthetic Completed Only',
      assignment_observed_at = '2026-09-24T12:00:00Z'::timestamptz
    WHERE sf_id = 'PN-TASK-0212'`;
  await owner.$executeRaw`
    INSERT INTO mirror.email (sf_id, household_sf_id, subject, body, sent_at, source_modified_at)
    SELECT 'PN-EMAIL-' || lpad(i::text, 4, '0'), 'PN-HH-0350', 'PN History Fixture Email ' || i,
      'Synthetic confidential email body', '2026-09-01T02:30:00Z'::timestamptz - i * interval '1 second',
      '2026-09-01T02:30:00Z'::timestamptz FROM generate_series(1, 205) i`;
  await owner.$executeRaw`
    INSERT INTO mirror.activity (sf_id, household_sf_id, subject, note, activity_at, source_modified_at)
    SELECT 'PN-CALL-' || lpad(i::text, 4, '0'), 'PN-HH-0350', 'PN History Fixture Call ' || i,
      'Synthetic confidential activity body', '2026-09-01T02:30:00Z'::timestamptz - i * interval '1 second',
      '2026-09-01T02:30:00Z'::timestamptz FROM generate_series(1, 205) i`;
  await owner.$executeRaw`
    INSERT INTO mirror.zendesk_ticket (zendesk_ticket_id, requester_id, household_sf_id,
      match_method, subject, status, ticket_url, created_at, source_updated_at)
    VALUES (${ticketId}, 'PN-HYDRATION-REQUESTER', 'PN-HH-0350', 'CEDAR_RIDGE_USER_ID',
      'PN History Fixture Ticket', 'open', 'https://example.invalid/tickets/synthetic',
      '2026-09-01T02:30:00Z'::timestamptz, '2026-09-01T02:30:00Z'::timestamptz)`;
  await owner.$executeRaw`
    INSERT INTO mirror.zendesk_ticket_comment (zendesk_comment_id, zendesk_ticket_id, author_id, body, created_at)
    VALUES (${commentId}, ${ticketId}, 'PN-HYDRATION-REQUESTER', 'Synthetic hydration comment',
      '2026-09-01T02:30:00Z'::timestamptz)`;
  return cleanup;
}
