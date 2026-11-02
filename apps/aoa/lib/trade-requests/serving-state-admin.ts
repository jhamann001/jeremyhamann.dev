import type { Prisma, PrismaClient } from "@prisma/client";
import type { StandaloneChange, StandaloneState } from "./standalone-control";

// The only writer of trade_request.serving_state, trade_request.serving_state_transitions and
// trade_request.standalone_transitions (ticket).
// Every other module reads through lib/trade-requests/serving-state.ts; test/trade-request-cutover-structure.test.ts
// fails if another source file writes either table. No `server-only` import: the cutover CLI runs under tsx.

export type Side = "standalone" | "aoa";
export type ServingStateRecord = { servingSource: Side; digestSender: Side; driftSender: Side };
export type ServingStateChange = Partial<ServingStateRecord>;
export type ServingStateChangeResult = { from: ServingStateRecord; to: ServingStateRecord; changed: boolean };

type Db = PrismaClient | Prisma.TransactionClient;
type Row = { serving_source: Side; digest_sender: Side; drift_sender: Side };

export class ServingStateRefused extends Error {}

/**
 * A copy run's three transactions are each bounded at 30 minutes (copy-engine TX_OPTIONS), so a copy-back row
 * still open after 95 minutes belongs to a process that died; younger open rows count as in progress.
 */
export const COPY_BACK_IN_PROGRESS_MINUTES = 95;

const SELECT_STATE = `SELECT serving_source, digest_sender, drift_sender FROM trade_request.serving_state WHERE id`;
/**
 * Shared surface with ticket: every native write takes this key shared and re-reads the serving source in its own
 * transaction; this writer takes it exclusively, so a change waits for in-flight writes and no write straddles it.
 */
export const SERVING_STATE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('trade_request.serving_state'))";
/** Native writes hold the shared key for at most 15 s (their transaction timeout), so wait longer than that. */
const CHANGE_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

const toRecord = (r: Row): ServingStateRecord => ({
  servingSource: r.serving_source,
  digestSender: r.digest_sender,
  driftSender: r.drift_sender,
});

/** Reads the serving-state row. Unlike the application reader, a missing row is an error: the controller fails closed. */
export async function readServingStateRecord(db: Db): Promise<ServingStateRecord> {
  const rows = await db.$queryRawUnsafe<Row[]>(SELECT_STATE);
  if (!rows[0]) throw new ServingStateRefused("trade_request.serving_state row is missing");
  return toRecord(rows[0]);
}

export async function copyBackInProgress(db: Db): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM trade_request.copy_runs
      WHERE mode = 'copy_back' AND finished_at IS NULL
        AND started_at > NOW() - make_interval(mins => ${COPY_BACK_IN_PROGRESS_MINUTES})`,
  );
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * Changes the serving state and appends one transition, in one transaction holding the exclusive serving-state
 * advisory lock and the row lock. The serving source never changes while a copy-back is in progress (ticket's
 * copy-back does not lock this row).
 */
export async function changeServingState(
  db: PrismaClient,
  change: ServingStateChange,
  actor: string,
  reason: string,
): Promise<ServingStateChangeResult> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(SERVING_STATE_LOCK_SQL);
    const rows = await tx.$queryRawUnsafe<Row[]>(`${SELECT_STATE} FOR UPDATE`);
    if (!rows[0]) throw new ServingStateRefused("trade_request.serving_state row is missing");
    const from = toRecord(rows[0]);
    const to: ServingStateRecord = {
      servingSource: change.servingSource ?? from.servingSource,
      digestSender: change.digestSender ?? from.digestSender,
      driftSender: change.driftSender ?? from.driftSender,
    };
    const changed =
      to.servingSource !== from.servingSource || to.digestSender !== from.digestSender || to.driftSender !== from.driftSender;
    if (!changed) return { from, to, changed };
    if (to.servingSource !== from.servingSource && (await copyBackInProgress(tx))) {
      throw new ServingStateRefused("the serving source cannot change while a copy-back is in progress");
    }
    await tx.$executeRaw`
      UPDATE trade_request.serving_state
         SET serving_source = ${to.servingSource}, digest_sender = ${to.digestSender}, drift_sender = ${to.driftSender},
             updated_at = NOW(), updated_by = ${actor}
       WHERE id`;
    await tx.$executeRaw`
      INSERT INTO trade_request.serving_state_transitions (actor, from_state, to_state, reason)
      VALUES (${actor}, ${JSON.stringify(from)}::jsonb, ${JSON.stringify(to)}::jsonb, ${reason})`;
    return { from, to, changed };
  }, CHANGE_TX_OPTIONS);
}

/**
 * Logs a lever the controller turned on the standalone service; the standalone service keeps its own history too.
 * Never in serving_state_transitions: the copy engine treats every row there as an AOA serving-state change and
 * refuses forward copies after it, so a freeze logged there would refuse the cutover's own change copy.
 */
export async function recordStandaloneTransition(
  db: PrismaClient,
  actor: string,
  before: StandaloneState,
  requested: StandaloneChange,
  after: StandaloneState,
  reason: string,
): Promise<void> {
  const pick = (s: StandaloneState) => ({ mode: s.mode, digestSender: s.digestSender, driftSender: s.driftSender });
  await db.$executeRaw`
    INSERT INTO trade_request.standalone_transitions (actor, from_state, to_state, reason)
    VALUES (${actor}, ${JSON.stringify({ standalone: pick(before) })}::jsonb,
            ${JSON.stringify({ standalone: pick(after), requested })}::jsonb, ${`${STANDALONE_REASON_PREFIX}${reason}`})`;
}

const STANDALONE_REASON_PREFIX = "standalone: ";
/** The reason of the forward cutover's freeze; a freeze is a forward one only when it carries this reason. */
export const CUTOVER_FREEZE_REASON = "cutover: freeze";

/** DB time of the most recent standalone freeze recorded by the controller, or null. */
export async function lastStandaloneFreezeAt(db: Db): Promise<Date | null> {
  return (await lastStandaloneFreeze(db))?.at ?? null;
}

/** The most recent recorded standalone freeze and whether this controller's forward cutover recorded it. */
export async function lastStandaloneFreeze(db: Db): Promise<{ at: Date; byCutover: boolean } | null> {
  const rows = await db.$queryRawUnsafe<Array<{ at: Date; reason: string }>>(
    `SELECT at, reason FROM trade_request.standalone_transitions
      WHERE to_state->'standalone'->>'mode' = 'frozen' AND from_state->'standalone'->>'mode' IS DISTINCT FROM 'frozen'
      ORDER BY at DESC LIMIT 1`,
  );
  const row = rows[0];
  return row ? { at: row.at, byCutover: row.reason === `${STANDALONE_REASON_PREFIX}${CUTOVER_FREEZE_REASON}` } : null;
}

/** The most recent change of the serving source, or null when it has never changed. */
export async function lastServingSourceChange(db: Db): Promise<{ at: Date; to: Side } | null> {
  const rows = await db.$queryRawUnsafe<Array<{ at: Date; to: Side }>>(
    `SELECT at, to_state->>'servingSource' AS "to" FROM trade_request.serving_state_transitions
      WHERE to_state ? 'servingSource' AND to_state->>'servingSource' IS DISTINCT FROM from_state->>'servingSource'
      ORDER BY at DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}
