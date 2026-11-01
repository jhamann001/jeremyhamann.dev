import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import pool from '../../db/pool.js';
import { engineUseDay, engineUseReport, refuseIfPlansOff, startEngineUseCounting } from '../engineUse.js';

const DATABASE_URL = process.env.DATABASE_URL;

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!DATABASE_URL)('engine-use counts and report (Postgres)', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE engine_use_daily');
    await pool.query('DELETE FROM engine_use_meta');
  });

  afterEach(() => {
    delete process.env.EXECUTION_PLAN_GENERATION;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('records the counting start and the switch-off date at start-up', async () => {
    process.env.EXECUTION_PLAN_GENERATION = 'off';
    const now = new Date();
    await startEngineUseCounting(now);
    const { rows } = await pool.query(
      `SELECT to_char(counting_started, 'YYYY-MM-DD') AS started,
              to_char(plan_generation_off_since, 'YYYY-MM-DD') AS off_since
         FROM engine_use_meta`,
    );
    expect(rows).toEqual([{ started: engineUseDay(now), off_since: engineUseDay(now) }]);
  });

  it('persists each refusal before answering 409', async () => {
    process.env.EXECUTION_PLAN_GENERATION = 'off';
    const countRows = async () =>
      (await pool.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, caller_class, outcome, count FROM engine_use_daily`))
        .rows;

    await expect(refuseIfPlansOff('service')).rejects.toMatchObject({ statusCode: 409 });
    expect(await countRows()).toEqual([{ day: engineUseDay(), caller_class: 'service', outcome: 'refused', count: 1 }]);

    await expect(refuseIfPlansOff('service')).rejects.toMatchObject({ statusCode: 409 });
    expect((await countRows())[0].count).toBe(2);
  });

  it('covers only complete days after the switch-off date', async () => {
    process.env.EXECUTION_PLAN_GENERATION = 'off';
    const today = engineUseDay();
    await pool.query(
      `INSERT INTO engine_use_meta (id, counting_started, plan_generation_off_since) VALUES (TRUE, $1::date, $2::date)`,
      [addDays(today, -10), addDays(today, -3)],
    );
    const report = await engineUseReport(7);
    expect(report.coveredDays).toBe(2);
  });

  it('clears the switch-off date when started with plan generation on', async () => {
    const today = engineUseDay();
    await pool.query(
      `INSERT INTO engine_use_meta (id, counting_started, plan_generation_off_since) VALUES (TRUE, $1::date, $2::date)`,
      [addDays(today, -10), addDays(today, -3)],
    );
    await startEngineUseCounting();
    const { rows } = await pool.query('SELECT plan_generation_off_since FROM engine_use_meta');
    expect(rows[0].plan_generation_off_since).toBeNull();

    const report = await engineUseReport(7);
    expect(report.coveredDays).toBe(0);
    expect(report.planGeneration).toBe('on');
  });
});
