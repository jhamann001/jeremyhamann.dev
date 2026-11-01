import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));

import { businessDate, weeklySnapshot } from '../standIns/feeds.js';
import { firmMorning } from '../reset.js';

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe('stand-in feed dates', () => {
  it('business date: the previous weekday', () => {
    expect(ymd(businessDate(day('2026-10-21')))).toBe('2026-10-20'); // Wednesday -> Tuesday
    expect(ymd(businessDate(day('2026-10-26')))).toBe('2026-10-23'); // Monday -> Friday
    expect(ymd(businessDate(day('2026-10-25')))).toBe('2026-10-23'); // Sunday -> Friday
  });

  it('weekly snapshot: the newest Friday whose Sunday load is done', () => {
    expect(ymd(weeklySnapshot(day('2026-10-26')))).toBe('2026-10-23'); // Monday: last Friday loaded Sunday
    expect(ymd(weeklySnapshot(day('2026-10-24')))).toBe('2026-10-16'); // Saturday: this Friday not loaded yet
    expect(ymd(weeklySnapshot(day('2026-10-30')))).toBe('2026-10-23'); // Friday: still last week's
    for (const d of ['2026-10-26', '2026-10-24', '2026-10-30']) expect(weeklySnapshot(day(d)).getUTCDay()).toBe(5);
  });
});

describe('reset run times', () => {
  it('runs at 9:30 AM New York time, on either side of daylight saving', () => {
    expect(firmMorning(day('2026-10-23')).toISOString()).toBe('2026-10-23T13:30:00.000Z'); // EDT
    expect(firmMorning(day('2026-11-03')).toISOString()).toBe('2026-11-03T14:30:00.000Z'); // EST
  });

  it('uses the New York calendar day, not the UTC one', () => {
    // 02:00 UTC on the 26th is still the evening of the 25th in New York.
    expect(firmMorning(new Date('2026-10-26T02:00:00Z')).toISOString()).toBe('2026-10-25T13:30:00.000Z');
  });
});
