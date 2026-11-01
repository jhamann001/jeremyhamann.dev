import pool from '../db/pool.js';
import logger from '../lib/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { runAssetLocationEngine as engineRun, verifyExecutionPlans as engineVerify } from './assetLocationEngine.js';

export type EngineCaller = 'mcp' | 'service';
type Outcome = 'ran' | 'refused';
type Counts = { ran: number; refused: number };

/** Plan generation is on unless EXECUTION_PLAN_GENERATION is exactly "off". */
export function planGenerationEnabled(): boolean {
  return process.env.EXECUTION_PLAN_GENERATION !== 'off';
}

const FIRM_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/** Calendar day in the firm's time zone, YYYY-MM-DD. */
export function engineUseDay(now: Date = new Date()): string {
  return FIRM_DAY.format(now);
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const pending = new Map<string, number>();
let flushInterval: NodeJS.Timeout | null = null;

function buffer(day: string, caller: EngineCaller, outcome: Outcome, n = 1): void {
  const key = `${day}|${caller}|${outcome}`;
  pending.set(key, (pending.get(key) ?? 0) + n);
}

async function writeCount(day: string, caller: EngineCaller, outcome: Outcome, n: number): Promise<void> {
  await pool.query(
    `INSERT INTO engine_use_daily (day, caller_class, outcome, count) VALUES ($1, $2, $3, $4)
     ON CONFLICT (day, caller_class, outcome) DO UPDATE SET count = engine_use_daily.count + EXCLUDED.count, updated_at = NOW()`,
    [day, caller, outcome, n],
  );
}

/** Write buffered counts. Failed entries are put back so they are retried, never dropped. Returns the number still pending. */
export async function flushEngineUse(): Promise<number> {
  const entries = [...pending.entries()];
  pending.clear();
  for (const [key, n] of entries) {
    const [day, caller, outcome] = key.split('|') as [string, EngineCaller, Outcome];
    try {
      await writeCount(day, caller, outcome, n);
    } catch (err) {
      buffer(day, caller, outcome, n);
      logger.error(
        {
          event: 'engine_use_count_failed',
          caller,
          outcome,
          message: err instanceof Error ? err.message : String(err),
        },
        'engine-use count write failed; kept for retry',
      );
    }
  }
  return pending.size;
}

/**
 * Called once from the server's listen callback. Starts the periodic flush first, so a failed start-up
 * write cannot stop it, then records the counting start and whether plan generation is off. Not called by
 * tests that import routes.
 */
export async function startEngineUseCounting(now: Date = new Date()): Promise<void> {
  if (!flushInterval) {
    flushInterval = setInterval(() => void flushEngineUse(), 60_000);
    flushInterval.unref();
  }
  const today = engineUseDay(now);
  await pool.query(
    `INSERT INTO engine_use_meta (id, counting_started) VALUES (TRUE, $1::date) ON CONFLICT (id) DO NOTHING`,
    [today],
  );
  if (planGenerationEnabled()) {
    await pool.query(`UPDATE engine_use_meta SET plan_generation_off_since = NULL WHERE id`);
  } else {
    await pool.query(
      `UPDATE engine_use_meta SET plan_generation_off_since = COALESCE(plan_generation_off_since, $1::date) WHERE id`,
      [today],
    );
  }
}

export class EngineRefusedError extends AppError {
  constructor() {
    super(409, 'Execution plans are no longer generated for trade requests.');
  }
}

export class EngineUseUnavailableError extends AppError {
  constructor() {
    super(503, 'Engine-use count unavailable; try again shortly.');
  }
}

/**
 * Refuse a non-MCP engine entry while plan generation is off. The refusal is the decision-relevant event, so it is
 * written before the response and never buffered: if the write fails the caller gets a 503 (the engine still does
 * not run) and a later attempt is counted once the database answers.
 */
export async function refuseIfPlansOff(caller: EngineCaller): Promise<void> {
  if (caller === 'service' && !planGenerationEnabled()) {
    try {
      await writeCount(engineUseDay(), caller, 'refused', 1);
    } catch (err) {
      logger.error(
        {
          event: 'engine_use_count_failed',
          caller,
          outcome: 'refused',
          message: err instanceof Error ? err.message : String(err),
        },
        'engine-use refusal write failed',
      );
      throw new EngineUseUnavailableError();
    }
    throw new EngineRefusedError();
  }
}

export async function runEngine(
  caller: EngineCaller,
  input: Parameters<typeof engineRun>[0],
): Promise<ReturnType<typeof engineRun>> {
  await refuseIfPlansOff(caller);
  const result = engineRun(input);
  buffer(engineUseDay(), caller, 'ran');
  return result;
}

/** Stored-plan verification for reads. Undefined for a non-MCP caller while generation is off. */
export function verifyStoredPlans(
  caller: EngineCaller,
  ...args: Parameters<typeof engineVerify>
): ReturnType<typeof engineVerify> | undefined {
  if (caller === 'service' && !planGenerationEnabled()) return undefined;
  const result = engineVerify(...args);
  buffer(engineUseDay(), caller, 'ran');
  return result;
}

export interface EngineUseDayCounts {
  day: string;
  mcp: Counts;
  service: Counts;
}

export interface EngineUseReport {
  planGeneration: 'on' | 'off';
  windowDays: number;
  /** Complete days in the window after both the counting start and the switch-off date. 0 while on. */
  coveredDays: number;
  countingStarted: string | null;
  planGenerationOffSince: string | null;
  /** The `windowDays` complete days before today, oldest first. */
  days: EngineUseDayCounts[];
  /** Today's counts so far (partial day, never covered). */
  today: EngineUseDayCounts;
}

/** Fails (throws) if this instance still holds unwritten counts, so a reader never sees a falsely clean report. */
export async function engineUseReport(windowDays: number, now: Date = new Date()): Promise<EngineUseReport> {
  const stillPending = await flushEngineUse();
  if (stillPending > 0) throw new AppError(503, 'Engine-use counts could not be written; report unavailable.');
  const today = engineUseDay(now);
  const first = addDays(today, -windowDays);
  const { rows: metaRows } = await pool.query<{ counting_started: string; off_since: string | null }>(
    `SELECT to_char(counting_started, 'YYYY-MM-DD') AS counting_started,
            to_char(plan_generation_off_since, 'YYYY-MM-DD') AS off_since
       FROM engine_use_meta WHERE id`,
  );
  const started = metaRows[0]?.counting_started ?? null;
  const offSince = metaRows[0]?.off_since ?? null;
  const { rows } = await pool.query<{ day: string; caller_class: EngineCaller; outcome: Outcome; count: number }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, caller_class, outcome, count
       FROM engine_use_daily
      WHERE day >= $1::date AND day <= $2::date`,
    [first, today],
  );
  const empty = (day: string): EngineUseDayCounts => ({
    day,
    mcp: { ran: 0, refused: 0 },
    service: { ran: 0, refused: 0 },
  });
  const byDay = new Map<string, EngineUseDayCounts>();
  for (let i = windowDays; i >= 1; i--) {
    const key = addDays(today, -i);
    byDay.set(key, empty(key));
  }
  const todayCounts = empty(today);
  for (const r of rows) {
    const entry = r.day === today ? todayCounts : byDay.get(r.day);
    if (entry) entry[r.caller_class][r.outcome] = Number(r.count);
  }
  const days = [...byDay.values()];
  const off = !planGenerationEnabled();
  const coveredDays = off && started && offSince ? days.filter((d) => d.day > started && d.day > offSince).length : 0;
  return {
    planGeneration: off ? 'off' : 'on',
    windowDays,
    coveredDays,
    countingStarted: started,
    planGenerationOffSince: offSince,
    days,
    today: todayCounts,
  };
}
