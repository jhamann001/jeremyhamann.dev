/**
 * The shared synthetic universe (synthetic/out/universe.json) and the firm calendar the demo seed dates
 * tickets by. Only the seed reads it; the running app never opens the file.
 *
 * Every person, household and number in the universe is invented: emails use example.com, phones the
 * reserved 555-01xx range. The same ids appear in the Trade Request and Transfer Tracker demos, which is
 * what lets a help desk ticket point at `TR-1046` or `T-305`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firmInstant, firmWallClock } from "@/lib/firm-time";

// ---------------------------------------------------------------------------
// Shape (only the parts the help desk reads)
// ---------------------------------------------------------------------------

export interface UniverseStaff {
  id: string;
  name: string;
  role: string;
  title: string;
}
export interface UniverseHousehold {
  id: string;
  name: string;
  advisor: string;
  model: string;
  story: boolean;
}
export interface UniversePerson {
  id: string;
  household: string;
  first: string;
  last: string;
  email: string;
  phone: string;
}
export interface UniverseAccount {
  id: string;
  number: string;
  household: string;
  type: string;
  custodian: string;
  value: number;
}
export interface UniverseHelpdeskStory {
  id: string;
  household: string;
  requester: string;
  queue: string;
  priority: "urgent" | "high" | "normal" | "low";
  subject: string;
  assignee: string | null;
  links?: string[];
}
export interface UniverseTradeStory {
  id: string;
  household: string;
  type: string;
  amount: number | null;
  status: string;
  advisor: string;
  links?: string[];
}
export interface UniverseTransferStory {
  id: string;
  household: string;
  from: string;
  value: number;
  stage: string;
  daysInStage?: number;
  completed?: string;
  control?: string;
  flag?: string;
  statement?: string;
}
export interface UniverseStatement {
  id: string;
  household: string;
  custodian: string;
  periodEnd: string;
  accounts?: Array<{ label: string; suffix: string; total: number; positions: Array<{ symbol: string; quantity: string; value: number }> }>;
}
export interface Universe {
  meta: { asOf: string };
  firm: { name: string; shortName: string };
  custodians: Array<{ id: string; name: string }>;
  staff: UniverseStaff[];
  households: UniverseHousehold[];
  people: UniversePerson[];
  accounts: UniverseAccount[];
  stories: {
    helpdesk: UniverseHelpdeskStory[];
    trade: UniverseTradeStory[];
    transfers: UniverseTransferStory[];
    statements: UniverseStatement[];
  };
}

/** Reads the universe. DEMO_UNIVERSE_PATH overrides the repo location (the image and the reset set it). */
export function loadUniverse(path = process.env.DEMO_UNIVERSE_PATH): Universe {
  const file = path ?? join(process.cwd(), "../../synthetic/out/universe.json");
  return JSON.parse(readFileSync(file, "utf8")) as Universe;
}

export function findPerson(universe: Universe, household: string, first: string): UniversePerson {
  const p = universe.people.find((x) => x.household === household && x.first === first);
  if (!p) throw new Error(`universe: no person ${first} in household ${household}`);
  return p;
}

export function findPersonByName(universe: Universe, name: string): UniversePerson {
  const p = universe.people.find((x) => `${x.first} ${x.last}` === name);
  if (!p) throw new Error(`universe: no person named ${name}`);
  return p;
}

export const personName = (p: UniversePerson): string => `${p.first} ${p.last}`;

/** "(206) 555-0100" → "+12065550100", the E.164 form `Ticket.requesterPhone` stores. */
export const e164 = (phone: string): string => `+1${phone.replace(/\D/g, "")}`;

// ---------------------------------------------------------------------------
// Deterministic draws: the same key always gives the same value, so every reset writes the same desk
// ---------------------------------------------------------------------------

/** A well-mixed draw in [0, 1) for a key. */
export function seeded(key: string): number {
  return createHash("sha256").update(key).digest().readUInt32BE(0) / 2 ** 32;
}

/** An integer in [min, max] for a key. */
export const seededInt = (key: string, min: number, max: number): number => min + Math.floor(seeded(key) * (max - min + 1));

export function pick<T>(key: string, items: readonly T[]): T {
  if (items.length === 0) throw new Error(`pick(${key}): empty list`);
  return items[Math.floor(seeded(key) * items.length)] as T;
}

// ---------------------------------------------------------------------------
// The firm's calendar: New York business days
// ---------------------------------------------------------------------------

/**
 * NYSE closures. A year past the list counts weekends only, which is a degraded calendar rather than a
 * failed reset; `universe.test.ts` fails a year before the list runs out so it gets extended in time.
 */
export const MARKET_HOLIDAYS: ReadonlySet<string> = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  // New Year's Day 2028 is a Saturday, which the exchange does not move to the Friday.
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
  "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);

const pad = (n: number): string => String(n).padStart(2, "0");

/** `at`'s date in New York, YYYY-MM-DD. */
export function firmDay(at: Date): string {
  const wc = firmWallClock(at);
  if (wc === null) throw new Error("firmDay: invalid instant");
  return `${wc.year}-${pad(wc.month)}-${pad(wc.day)}`;
}

function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isBusinessDay(day: string): boolean {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !MARKET_HOLIDAYS.has(day);
}

export function businessDayOnOrBefore(day: string): string {
  let cursor = day;
  while (!isBusinessDay(cursor)) cursor = shiftDay(cursor, -1);
  return cursor;
}

/** `n` business days after `day` (before it when negative). */
export function addBusinessDays(day: string, n: number): string {
  let cursor = day;
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0; ) {
    cursor = shiftDay(cursor, step);
    if (isBusinessDay(cursor)) left--;
  }
  return cursor;
}

/** A wall-clock time on a New York date, as an instant (daylight saving handled by firmInstant). */
export function atFirmTime(day: string, hour: number, minute = 0): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return firmInstant(y, m, d, hour, minute, 0);
}

export const DESK_OPENS = { hour: 9, minute: 0 } as const;
export const DESK_CLOSES = { hour: 17, minute: 30 } as const;

/** Staff hours, a little wider than the desk's posted hours: people answer before opening and after close. */
const WORK_STARTS = { hour: 8, minute: 0 } as const;
const WORK_ENDS = { hour: 18, minute: 30 } as const;

/** Whether `at` falls in staff hours on its New York date (any day of the week). */
export function inStaffHours(at: Date): boolean {
  const day = firmDay(at);
  const t = at.getTime();
  return (
    t >= atFirmTime(day, WORK_STARTS.hour, WORK_STARTS.minute).getTime() &&
    t <= atFirmTime(day, WORK_ENDS.hour, WORK_ENDS.minute).getTime()
  );
}

/** The same wall-clock time on the next business day on or after `at`'s date. */
export function sameTimeNextBusinessDay(at: Date): Date {
  const wc = firmWallClock(at);
  if (wc === null) throw new Error("sameTimeNextBusinessDay: invalid instant");
  let day = firmDay(at);
  while (!isBusinessDay(day)) day = shiftDay(day, 1);
  return atFirmTime(day, wc.hour, wc.minute);
}

/**
 * An instant in [from, to] that falls in staff hours on a business day, drawn by `key`, to the minute. When
 * the range holds no working time at all, the first working minutes after `from` (which may be after `to`:
 * a reply that could not have happened on time).
 */
export function workingInstantBetween(from: Date, to: Date, key: string): Date {
  const spans: Array<[number, number]> = [];
  let total = 0;
  let day = firmDay(from);
  for (let guard = 0; guard < 60; guard++, day = shiftDay(day, 1)) {
    const start = atFirmTime(day, WORK_STARTS.hour, WORK_STARTS.minute).getTime();
    const end = atFirmTime(day, WORK_ENDS.hour, WORK_ENDS.minute).getTime();
    if (start > to.getTime()) break;
    if (!isBusinessDay(day)) continue;
    const a = Math.max(start, from.getTime());
    const b = Math.min(end, to.getTime());
    if (b > a) {
      spans.push([a, b]);
      total += b - a;
    }
  }
  if (total === 0) {
    for (day = firmDay(from); ; day = shiftDay(day, 1)) {
      if (!isBusinessDay(day)) continue;
      const end = atFirmTime(day, WORK_ENDS.hour, WORK_ENDS.minute).getTime();
      if (end <= from.getTime()) continue;
      const start = Math.max(atFirmTime(day, WORK_STARTS.hour, WORK_STARTS.minute).getTime(), from.getTime());
      return new Date(start + seededInt(key, 2, 45) * 60_000);
    }
  }
  let at = Math.floor(seeded(key) * total);
  for (const [a, b] of spans) {
    if (at < b - a) return new Date(a + Math.floor(at / 60_000) * 60_000);
    at -= b - a;
  }
  return new Date(spans[spans.length - 1]![1]);
}

/**
 * The desk's most recent working moment: `now` during working hours, otherwise the last business day's
 * close. The hand-written tickets are dated back from here, so their threads read as the desk's own
 * working day rather than as replies sent at 3 a.m. when the reset happened to run.
 */
export function lastDeskClose(now: Date): Date {
  let day = firmDay(now);
  for (let guard = 0; guard < 15; guard++, day = shiftDay(day, -1)) {
    if (!isBusinessDay(day)) continue;
    const opens = atFirmTime(day, DESK_OPENS.hour, DESK_OPENS.minute);
    const closes = atFirmTime(day, DESK_CLOSES.hour, DESK_CLOSES.minute);
    if (now.getTime() >= closes.getTime()) return closes;
    if (now.getTime() >= opens.getTime()) return now;
  }
  throw new Error("lastDeskClose: no business day in the last two weeks");
}

/**
 * When the first visitor after a reset is likely to look: the next 9 a.m. in New York, or `now` when the
 * reset ran between 9 a.m. and the desk's close. Any day of the week, since visitors come at weekends
 * too; the desk's own activity stays on business days (`lastDeskClose`). The seed aims each open ticket's
 * resolution clock at this window, so the board a visitor sees has clocks running through the day rather
 * than a wall of overnight breaches.
 */
export function viewingStart(now: Date): Date {
  const day = firmDay(now);
  const opens = atFirmTime(day, DESK_OPENS.hour, DESK_OPENS.minute);
  const closes = atFirmTime(day, DESK_CLOSES.hour, DESK_CLOSES.minute);
  if (now.getTime() < opens.getTime()) return opens;
  if (now.getTime() < closes.getTime()) return now;
  return atFirmTime(shiftDay(day, 1), DESK_OPENS.hour, DESK_OPENS.minute);
}
