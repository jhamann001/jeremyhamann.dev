// The shared synthetic universe (synthetic/out/universe.json): the invented firm whose households every demo shows.
// The demo seed reads it through here, and every id it gives a person, household or account is the id the other
// demos give the same record, so a link from one demo to another lands on the same thing:
//   person     user-<uuid> from the person's id   (the Transfer Tracker demo's client directory)
//   account    01SYNTH…  from the account's id     (the clearing firm's account id in the Trade Request demo)
// and the CRM ids AoA keys on are the CRM's own 18-character form (households 001…, contacts 003…, users 005…).
// Pure: no database, no clock.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface UniverseCustodian { id: string; name: string; transferType: "ACAT" | "Non-ACAT" }
export interface UniverseStaff { id: string; name: string; role: string; title: string }
export interface UniverseSecurity { symbol: string; name: string; assetClass: string; vehicle: string; price: number }
export interface UniverseModel { id: string; name: string; weights: Record<string, number> }
export interface UniverseHousehold { id: string; name: string; advisor: string; model: string; story?: boolean }
export interface UniversePerson { id: string; household: string; first: string; last: string; email: string; phone: string }
export interface UniverseAccount {
  id: string;
  number: string;
  household: string;
  type: string;
  custodian: string;
  model: string;
  value: number;
}
export interface UniverseHolding { account: string; symbol: string; quantity: number; value: number }

export interface UniverseHelpdeskStory {
  id: string;
  household: string;
  requester: string;
  queue: string;
  priority: string;
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
  model?: string;
  links?: string[];
}
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
export interface UniverseStatementPosition { symbol: string; description?: string; quantity: string; value: number }
export interface UniverseStatement {
  id: string;
  household: string;
  custodian: string;
  periodEnd: string;
  precheck: string;
  accounts?: Array<{ label: string; suffix: string; total: number; positions: UniverseStatementPosition[] }>;
  accountKinds?: string[];
}

export interface Universe {
  meta: { seed: number; asOf: string };
  firm: { name: string; shortName: string };
  clearingFirm: { id: string; name: string };
  modelProvider: { id: string; name: string };
  custodians: UniverseCustodian[];
  staff: UniverseStaff[];
  securities: UniverseSecurity[];
  models: UniverseModel[];
  households: UniverseHousehold[];
  people: UniversePerson[];
  accounts: UniverseAccount[];
  holdings: UniverseHolding[];
  stories: {
    helpdesk: UniverseHelpdeskStory[];
    trade: UniverseTradeStory[];
    transfers: UniverseTransferStory[];
    statements: UniverseStatement[];
  };
}

/** Reads the universe. DEMO_UNIVERSE_PATH overrides the repo location (the container sets it). */
export function loadUniverse(path = process.env.DEMO_UNIVERSE_PATH): Universe {
  const file = path ?? join(process.cwd(), "../../synthetic/out/universe.json");
  return JSON.parse(readFileSync(file, "utf8")) as Universe;
}

// --- deterministic draws (the Transfer Tracker demo's, so ported plans draw the same numbers) ---

/** A well-mixed draw in [0, 1) for a key. The same key always gives the same value. */
export function seeded(key: string): number {
  return createHash("sha256").update(key).digest().readUInt32BE(0) / 2 ** 32;
}

/** An integer in [min, max] for a key. */
export const seededInt = (key: string, min: number, max: number): number => min + Math.floor(seeded(key) * (max - min + 1));

export function pick<T>(key: string, items: readonly T[]): T {
  return items[Math.floor(seeded(key) * items.length)];
}

/** The Trade Request demo's FNV-1a hash (its plan draws with it). */
export function fnv(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** A lowercase, version-4-shaped UUID that is the same for the same key. */
export function demoUuid(key: string): string {
  const hex = createHash("sha256").update(`demo-uuid:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// --- ids shared with the other demos ---

const SF_CHECKSUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

/**
 * A CRM record id in the CRM's own 18-character form: a key prefix (001 household account, 003 contact, 005 user,
 * 006 opportunity), "DM", a 10-digit number, and the case checksum. AoA keys on these (it folds to the first 15).
 */
export function crmId(prefix: string, n: number): string {
  const base = `${prefix}DM${String(n).padStart(10, "0")}`;
  let suffix = "";
  for (let chunk = 0; chunk < 3; chunk++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) if (/[A-Z]/.test(base[chunk * 5 + i])) bits |= 1 << i;
    suffix += SF_CHECKSUM[bits];
  }
  return base + suffix;
}

/** The household's CRM id (a household account, 001…), numbered 1001 onward in universe order. */
export function householdIds(universe: Universe): Map<string, string> {
  return new Map(universe.households.map((h, i) => [h.id, crmId("001", 1001 + i)]));
}

/** The person's CRM contact id (003…), numbered 1001 onward in universe order. */
export function personIds(universe: Universe): Map<string, string> {
  return new Map(universe.people.map((p, i) => [p.id, crmId("003", 1001 + i)]));
}

/**
 * The person's id at the clearing firm (AoA's `cedar_ridge_user_id`): the Transfer Tracker demo's client-directory
 * id for the same person.
 */
export function cedarRidgeUserId(personId: string): string {
  const hex = createHash("sha256").update(`person:${personId}`).digest("hex");
  return `user-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The clearing firm's 26-character account id, as the Trade Request demo and its warehouse stand-in give it. */
export function accountUlid(accountId: string): string {
  const bytes = createHash("sha256").update(`account:${accountId}`).digest();
  let tail = "";
  for (let i = 0; i < 19; i++) tail += CROCKFORD[bytes[i] % 32];
  return `01SYNTH${tail}`;
}

/** first.last@example.com, as every demo spells a staff member's email. */
export const staffEmail = (s: Pick<UniverseStaff, "name">): string => `${s.name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;

/** A staff member's CRM user id (005…), numbered by their place in the universe's staff list. */
export const staffSfId = (universe: Universe, staffId: string): string =>
  crmId("005", 101 + universe.staff.findIndex((s) => s.id === staffId));

/** The advisor's CRM user id. */
export const advisorSfId = (universe: Universe, staffId: string): string => staffSfId(universe, staffId);

/** A cuid-shaped id (c and 24 base-36 characters), the same for the same key: app.transfer's own id shape. */
export function demoCuid(key: string): string {
  const hex = createHash("sha256").update(`demo-cuid:${key}`).digest("hex");
  return `c${BigInt(`0x${hex}`).toString(36).slice(0, 24).padStart(24, "0")}`;
}

// Story records carry production's id shapes, not DEMO- ones: the app reads DEMO- ids as its old development seed and
// leaves them out of reporting (lib/data/crm-reporting.ts).

/** AoA's transfer id for a universe transfer story (T-298), cuid-shaped. */
export const storyTransferId = (storyId: string): string => demoCuid(`story:${storyId}`);

/** The Transfer Tracker demo's record id for a universe transfer story (T-298 → tr-t298). */
export const storyTrackerId = (storyId: string): string => `tr-${storyId.toLowerCase().replace("-", "")}`;

/** The CRM opportunity a universe transfer story came from (T-298 → 006… numbered 1298). */
export const storyDealId = (storyId: string): string => crmId("006", 1000 + Number(storyId.replace(/\D/g, "")));

/** The Trade Request demo's request id for a universe trade story (TR-1046 → REQ-00001046). */
export const storyTradeRequestId = (storyId: string): string => `REQ-${storyId.replace(/\D/g, "").padStart(8, "0")}`;

// --- lookups ---

export function householdOf(universe: Universe, id: string): UniverseHousehold {
  const household = universe.households.find((h) => h.id === id);
  if (!household) throw new Error(`universe household ${id} not found`);
  return household;
}

export const membersOf = (universe: Universe, householdId: string): UniversePerson[] =>
  universe.people.filter((p) => p.household === householdId);

export const accountsOf = (universe: Universe, householdId: string): UniverseAccount[] =>
  universe.accounts.filter((a) => a.household === householdId);

export function staffOf(universe: Universe, id: string): UniverseStaff {
  const staff = universe.staff.find((s) => s.id === id);
  if (!staff) throw new Error(`universe staff ${id} not found`);
  return staff;
}
