// The shared synthetic universe (synthetic/out/universe.json) and the rules that map it onto the
// Transfer Tracker: staff personas, client ids, account types and the firm's calendar. The demo seed
// and the stand-ins both read through here, so a person or account carries the same id everywhere.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UserRole } from "@prisma/client";
import { isAcatsBusinessDay } from "../transfer-analytics";

// ─── Universe shape (only the parts this app reads) ──────────────────────────

export interface UniverseCustodian {
  id: string;
  name: string;
  transferType: "ACAT" | "Non-ACAT";
}
export interface UniverseStaff { id: string; name: string; role: string; title: string }
export interface UniverseSecurity { symbol: string; name: string; assetClass: string; vehicle: string; price: number }
export interface UniverseHousehold { id: string; name: string; advisor: string; model: string; story: boolean }
export interface UniversePerson { id: string; household: string; first: string; last: string; email: string }
export interface UniverseAccount { id: string; number: string; household: string; type: string; custodian: string; value: number }
export interface UniverseHolding { account: string; symbol: string; quantity: number; value: number }
export interface UniverseTransferStory {
  id: string;
  household: string;
  from: string;
  value: number;
  stage: "paperwork" | "submitted" | "in-transfer" | "completed" | "exception";
  daysInStage?: number;
  completed?: string;
  control?: string;
  flag?: string;
  statement?: string;
}
export interface UniverseStatementPosition { symbol: string; quantity: string; value: number }
export interface UniverseStatement {
  id: string;
  household: string;
  custodian: string;
  periodEnd: string;
  accounts?: Array<{ label: string; suffix: string; total: number; positions: UniverseStatementPosition[] }>;
}
export interface Universe {
  meta: { asOf: string };
  firm: { name: string; shortName: string };
  clearingFirm: { id: string; name: string };
  custodians: UniverseCustodian[];
  staff: UniverseStaff[];
  securities: UniverseSecurity[];
  households: UniverseHousehold[];
  people: UniversePerson[];
  accounts: UniverseAccount[];
  holdings: UniverseHolding[];
  stories: { transfers: UniverseTransferStory[]; statements: UniverseStatement[] };
}

/** Reads the universe. DEMO_UNIVERSE_PATH overrides the repo location (the container sets it). */
export function loadUniverse(path = process.env.DEMO_UNIVERSE_PATH): Universe {
  const file = path ?? join(process.cwd(), "../../synthetic/out/universe.json");
  return JSON.parse(readFileSync(file, "utf8")) as Universe;
}

// ─── Deterministic draws ──────────────────────────────────────────────────────

/** A well-mixed draw in [0, 1) for a key. The same key always gives the same value. */
export function seeded(key: string): number {
  return createHash("sha256").update(key).digest().readUInt32BE(0) / 2 ** 32;
}

/** An integer in [min, max] for a key. */
export const seededInt = (key: string, min: number, max: number): number =>
  min + Math.floor(seeded(key) * (max - min + 1));

export function pick<T>(key: string, items: readonly T[]): T {
  return items[Math.floor(seeded(key) * items.length)];
}

// ─── People and staff ─────────────────────────────────────────────────────────

export const staffEmail = (s: UniverseStaff): string => `${s.name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;

// Staff roles in this app. Operations runs it, the transfer specialist works the queue, and advisors
// get the read-only advisor view. The three demo sign-in personas come first.
const STAFF_ROLE: Record<string, UserRole> = {
  operations: "ADMIN",
  transfers: "USER",
  "client-service": "USER",
  compliance: "USER",
  trader: "USER",
  advisor: "ADVISOR",
};
export const PERSONA_STAFF_IDS = ["marco-ferreira", "jordan-reyes", "rachel-moss"] as const;
export const staffRole = (s: UniverseStaff): UserRole => STAFF_ROLE[s.role] ?? "USER";

/** The firm's client id for a universe person, in the directory's `user-<uuid>` form. */
export function clientUserId(personId: string): string {
  const hex = createHash("sha256").update(`person:${personId}`).digest("hex");
  return `user-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The advisor's first name, as the tracker's advisor field stores it. */
export function advisorFirstName(universe: Universe, householdId: string): string {
  const advisorId = universe.households.find((h) => h.id === householdId)?.advisor;
  return universe.staff.find((s) => s.id === advisorId)?.name.split(" ")[0] ?? "None";
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

export const ACCOUNT_TYPE: Record<string, string> = {
  "joint-taxable": "Joint Account (JTWROS - Rights of Survivorship)",
  individual: "Brokerage / Individual",
  trust: "Other",
  "traditional-ira": "Traditional IRA",
  "rollover-ira": "Traditional IRA",
  "sep-ira": "Traditional IRA",
  "roth-ira": "Roth IRA",
};

export const isJointAccount = (a: UniverseAccount): boolean => a.type === "joint-taxable";
export const isRetirementAccount = (a: UniverseAccount): boolean => a.type.endsWith("-ira");

/** Account owners: everyone in the household for a joint account, otherwise the first member. */
export function accountOwners(universe: Universe, a: UniverseAccount): UniversePerson[] {
  const members = universe.people.filter((p) => p.household === a.household);
  return isJointAccount(a) ? members : members.slice(0, 1);
}

/** "Lucia Alvarez & Daniel Alvarez", or the single owner's name. */
export function ownerNames(owners: UniversePerson[]): string {
  return owners.map((p) => `${p.first} ${p.last}`).join(" & ");
}

// ─── The firm's calendar ──────────────────────────────────────────────────────

const FIRM_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/** Today's date in New York, YYYY-MM-DD. */
export const firmToday = (now: Date): string => FIRM_DAY.format(now);

const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

export const isBusinessDay = (day: string): boolean => isAcatsBusinessDay(utc(day));

/** The business day on or before `day`. */
export function businessDayOnOrBefore(day: string): string {
  const cursor = utc(day);
  while (!isAcatsBusinessDay(cursor)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  return iso(cursor);
}

/** `n` business days after `day` (before it when negative), counting only market days. */
export function addBusinessDays(day: string, n: number): string {
  const cursor = utc(day);
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0; ) {
    cursor.setUTCDate(cursor.getUTCDate() + step);
    if (isAcatsBusinessDay(cursor)) left--;
  }
  return iso(cursor);
}

/** How many business days `later` is after `earlier` (0 when the same day). */
export function businessDaysBetween(earlier: string, later: string): number {
  let count = 0;
  for (let cursor = utc(earlier); iso(cursor) < later; ) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isAcatsBusinessDay(cursor)) count++;
  }
  return count;
}

/** A New York business day at a working-hours time, as an instant. */
export function businessInstant(day: string, key: string): Date {
  const hour = seededInt(`${key}:hour`, 9, 16);
  const minute = seededInt(`${key}:minute`, 0, 59);
  // 13:00 UTC is 9 AM in New York during daylight saving and 8 AM outside it; close enough for history.
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hour + 4, minute));
}

/**
 * A business instant that is never after `now`. When the reset runs before the working day, today's
 * working hours haven't happened yet; they are squeezed into the time since midnight in New York,
 * in the same order, so the day still reads as history.
 */
export function pastBusinessInstant(day: string, key: string, now: Date): Date {
  const at = businessInstant(day, key);
  if (at.getTime() <= now.getTime()) return at;
  const [y, m, d] = [Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))];
  const midnight = Date.UTC(y, m, d, 4); // midnight in New York during daylight saving; close enough
  const open = Date.UTC(y, m, d, 13);
  const close = Date.UTC(y, m, d, 21);
  const room = Math.max(0, now.getTime() - midnight - 60_000);
  return new Date(Math.min(now.getTime(), Math.round(midnight + ((at.getTime() - open) / (close - open)) * room)));
}

/** Calendar days from `earlier` to `later` (YYYY-MM-DD). */
export const calendarDaysBetween = (earlier: string, later: string): number =>
  Math.round((utc(later).getTime() - utc(earlier).getTime()) / 86_400_000);
