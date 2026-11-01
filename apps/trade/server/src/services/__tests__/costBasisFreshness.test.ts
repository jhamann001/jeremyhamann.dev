import { describe, it, expect } from 'vitest';
import { evaluateCostBasisFreshness, evaluateSourceFreshness } from '../costBasisFreshness.js';

const ASOF = new Date('2026-06-04T20:00:00Z');

describe('evaluateCostBasisFreshness', () => {
  it('reports ok when full is within the week and daily is the normal T-1', () => {
    // full 6d old (< 8), daily 1d old (T-1 is normal).
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: '2026-05-29',
      dailyRefreshLatest: '2026-06-03',
      asOf: ASOF,
    });
    expect(r.level).toBe('ok');
    expect(r.full.ageDays).toBe(6);
    expect(r.daily.ageDays).toBe(1);
  });

  // Content is Friday-dated and loads Sunday ~11:02, so a Friday 09:15 run
  // legitimately sees the prior week's snapshot at 7d — its own Friday snapshot
  // does not load until Sunday. That is the worst normal case, not a miss.
  it('stays ok when the full refresh is 7 days old (normal Friday 09:15 state)', () => {
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: '2026-05-28', // 7 days
      dailyRefreshLatest: '2026-06-03',
      asOf: ASOF,
    });
    expect(r.full.level).toBe('ok');
    expect(r.level).toBe('ok');
  });

  it('warns when the weekly full refresh is >= 8 days old (a weekly was missed)', () => {
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: '2026-05-27', // 8 days
      dailyRefreshLatest: '2026-06-03',
      asOf: ASOF,
    });
    expect(r.full.level).toBe('warn');
    expect(r.level).toBe('warn');
  });

  it('flags critical when the full refresh is >= 11 days old', () => {
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: '2026-05-24', // 11 days
      dailyRefreshLatest: '2026-06-03',
      asOf: ASOF,
    });
    expect(r.full.level).toBe('critical');
    expect(r.level).toBe('critical');
  });

  it('keeps the daily file ok at the normal 1-day (T-1) lag', () => {
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: '2026-05-29',
      dailyRefreshLatest: '2026-06-03', // 1 day
      asOf: ASOF,
    });
    expect(r.daily.level).toBe('ok');
  });

  // 2d is the NORMAL state for a 09:15 ET run: the day's Glue load lands ~11:02,
  // so the newest visible `process_date` is T-2, not T-1.
  it('stays ok when the daily file is 2 days old (normal for a 09:15 run)', () => {
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: '2026-05-29',
      dailyRefreshLatest: '2026-06-02', // 2 days
      asOf: ASOF,
    });
    expect(r.daily.level).toBe('ok');
    expect(r.level).toBe('ok');
  });

  it('warns when the daily file is 3 days old (a daily load was missed)', () => {
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: '2026-05-29',
      dailyRefreshLatest: '2026-06-01', // 3 days
      asOf: ASOF,
    });
    expect(r.daily.level).toBe('warn');
    expect(r.level).toBe('warn');
  });

  it('flags critical when the daily file is >= 4 days old', () => {
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: '2026-05-29',
      dailyRefreshLatest: '2026-05-31', // 4 days
      asOf: ASOF,
    });
    expect(r.daily.level).toBe('critical');
    expect(r.level).toBe('critical');
  });

  it('returns the worst level across the signals', () => {
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: '2026-05-24', // critical (11d)
      dailyRefreshLatest: '2026-06-03', // ok (1d)
      asOf: ASOF,
    });
    expect(r.level).toBe('critical');
  });

  it('treats a null latest date as missing', () => {
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: null,
      dailyRefreshLatest: '2026-06-03',
      asOf: ASOF,
    });
    expect(r.full.level).toBe('missing');
    expect(r.full.ageDays).toBeNull();
    expect(r.level).toBe('missing');
  });

  it('never reports a negative age for a future process_date', () => {
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: '2026-06-10',
      dailyRefreshLatest: '2026-06-10',
      asOf: ASOF,
    });
    expect(r.full.ageDays).toBe(0);
    expect(r.level).toBe('ok');
  });

  it('honors custom thresholds', () => {
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: '2026-05-29', // 6 days
      dailyRefreshLatest: '2026-06-03',
      asOf: ASOF,
      thresholds: { fullWarnDays: 5 },
    });
    expect(r.full.level).toBe('warn');
  });

  it('includes ages and dates in the message', () => {
    const r = evaluateCostBasisFreshness({
      fullRefreshLatest: '2026-05-24',
      dailyRefreshLatest: '2026-06-03',
      asOf: ASOF,
    });
    expect(r.message).toContain('critical');
    expect(r.message).toContain('2026-05-24');
  });

  describe('pipeline signal (gluerundatetime)', () => {
    it('stays ok and is omitted from the message when no gluerun timestamps are supplied', () => {
      const r = evaluateCostBasisFreshness({
        fullRefreshLatest: '2026-05-29',
        dailyRefreshLatest: '2026-06-03',
        asOf: ASOF,
      });
      expect(r.pipeline.level).toBe('ok');
      expect(r.pipeline.latest).toBeNull();
      expect(r.message).not.toContain('pipeline');
    });

    it('is ok when the loader ran today even though process_date is T-1', () => {
      const r = evaluateCostBasisFreshness({
        fullRefreshLatest: '2026-05-29',
        dailyRefreshLatest: '2026-06-03',
        dailyGlueRunLatest: '2026-06-04T11:02:00-04:00', // ran today
        asOf: ASOF,
      });
      expect(r.pipeline.level).toBe('ok');
      expect(r.pipeline.ageDays).toBe(0);
    });

    it('warns when the loader has not run in 2 days', () => {
      const r = evaluateCostBasisFreshness({
        fullRefreshLatest: '2026-05-29',
        dailyRefreshLatest: '2026-06-03',
        dailyGlueRunLatest: '2026-06-02T11:02:00-04:00', // 2 days
        asOf: ASOF,
      });
      expect(r.pipeline.level).toBe('warn');
      expect(r.level).toBe('warn');
    });

    it('flags critical when the loader has not run in >= 4 days', () => {
      const r = evaluateCostBasisFreshness({
        fullRefreshLatest: '2026-05-29',
        dailyRefreshLatest: '2026-06-03',
        dailyGlueRunLatest: '2026-05-31T11:02:00-04:00', // 4 days
        asOf: ASOF,
      });
      expect(r.pipeline.level).toBe('critical');
      expect(r.level).toBe('critical');
    });

    it('uses the FRESHEST gluerun across both tables', () => {
      const r = evaluateCostBasisFreshness({
        fullRefreshLatest: '2026-05-29',
        dailyRefreshLatest: '2026-06-03',
        fullGlueRunLatest: '2026-05-20T11:02:00-04:00', // stale
        dailyGlueRunLatest: '2026-06-04T11:02:00-04:00', // ran today
        asOf: ASOF,
      });
      expect(r.pipeline.ageDays).toBe(0);
      expect(r.pipeline.level).toBe('ok');
    });
  });
});

describe('evaluateSourceFreshness (per-source, multi-warehouse)', () => {
  const asOf = new Date('2026-08-27T09:15:00-04:00');

  it('flags the source with a dead weekly loader while the other is healthy', () => {
    // The real 2026-08-27 state: db 4's weekly open-lot loader had not run since
    // 08-15 (baseline stranded at 08-14) but its dailies were current; db 101
    // carried the 08-21 weekly but its dailies stopped at 08-25.
    const out = evaluateSourceFreshness(
      [
        { databaseId: 4, fullRefreshLatest: '2026-08-14', dailyRefreshLatest: '2026-08-26', baselineSource: false },
        { databaseId: 101, fullRefreshLatest: '2026-08-21', dailyRefreshLatest: '2026-08-25', baselineSource: true },
      ],
      asOf,
    );

    const four = out.find((s) => s.databaseId === 4)!;
    expect(four.fullAgeDays).toBe(13);
    expect(four.fullLevel).toBe('critical');
    expect(four.level).toBe('critical');
    expect(four.baselineSource).toBe(false);

    const oneOhOne = out.find((s) => s.databaseId === 101)!;
    expect(oneOhOne.fullAgeDays).toBe(6);
    expect(oneOhOne.fullLevel).toBe('ok');
    expect(oneOhOne.baselineSource).toBe(true);
  });

  it('takes the worst of the full and daily levels as the source verdict', () => {
    const [s] = evaluateSourceFreshness(
      [{ databaseId: 4, fullRefreshLatest: '2026-08-26', dailyRefreshLatest: '2026-08-14', baselineSource: true }],
      asOf,
    );
    expect(s.fullLevel).toBe('ok');
    expect(s.dailyLevel).toBe('critical');
    expect(s.level).toBe('critical');
  });

  it('reports missing when a source has no snapshot at all', () => {
    const [s] = evaluateSourceFreshness(
      [{ databaseId: 999, fullRefreshLatest: null, dailyRefreshLatest: null, baselineSource: false }],
      asOf,
    );
    expect(s.level).toBe('missing');
  });

  it('honors threshold overrides', () => {
    const [s] = evaluateSourceFreshness(
      [{ databaseId: 4, fullRefreshLatest: '2026-08-21', dailyRefreshLatest: '2026-08-26', baselineSource: true }],
      asOf,
      { fullWarnDays: 2, fullCriticalDays: 3 },
    );
    expect(s.fullLevel).toBe('critical');
  });
});
