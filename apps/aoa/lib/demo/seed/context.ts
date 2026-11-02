// What every part of the demo seed works with: the universe, the seed's clock, the two database logins it writes
// as (production's own split: the owner for app-owned data, the ingest login for the CRM mirror), and what earlier
// parts hand to later ones so records link up (a transfer to its tracker record, an asset map to its transfer).

import type { PrismaClient } from "@prisma/client";
import { insertRows } from "./batch";
import { businessDayOnOrBefore, firmToday, pastBusinessInstant } from "./calendar";
import { householdIds, personIds, type Universe } from "./universe";

export type StandInService = "tracker" | "pipeline" | "warehouse";

/** One outside service's record: its kind, id, the JSON its API returns, and where it sits in the service's order. */
export interface StandInRecord {
  kind: string;
  id: string;
  doc: object;
  position: number;
}

/** One story transfer's tracker record, as the tracker part planned it. */
export interface TrackerStoryRecord {
  storyId: string;
  trackerId: string;
  acatTransferId: string | null;
  controlNumber: string | null;
  status: string;
  custodianId: string | null;
  custodianName: string;
  requestDay: string;
  submissionDay: string | null;
  completionDay: string | null;
}

/** What one part hands to the parts after it. Each part fills its own key. */
export interface SeedShared {
  deals?: {
    /** The deal id by CRM opportunity id. */
    ids: Map<string, string>;
  };
  tracker?: {
    /** By universe story id (T-298). */
    stories: Map<string, TrackerStoryRecord>;
    /** AoA custodian authority id by custodian name. */
    custodianIds: Map<string, string>;
    records: number;
  };
  assetMaps?: {
    /** The live asset-map run id by universe household id. */
    runs: Map<string, string>;
  };
  tradeRequests?: {
    /** By universe story id (TR-1046). */
    stories: Map<string, string>;
    requests: number;
  };
}

export interface SeedContext {
  universe: Universe;
  /** The seed's clock. Every date it writes is relative to this. */
  now: Date;
  /** The business day on or before today in New York. */
  today: string;
  /** The owner login: app-owned data, the audit trail, the stand-ins, the trade-request and pipeline schemas. */
  owner: PrismaClient;
  /** The ingest login: the CRM mirror (the only login past its forced row security). */
  ingest: PrismaClient;
  /** CRM ids by universe id. */
  householdId: Map<string, string>;
  personId: Map<string, string>;
  /** A working-hours instant on `day`, never after `now`; the same key always lands at the same time of day. */
  at(day: string, key: string): Date;
  /** Writes outside services' records (demo.stand_in_record), all of `service`'s in one statement. A record written
   *  twice keeps the later one, as one write after another would. */
  standIns(service: StandInService, records: StandInRecord[]): Promise<void>;
  shared: SeedShared;
}

export function createSeedContext(universe: Universe, owner: PrismaClient, ingest: PrismaClient, now = new Date()): SeedContext {
  return {
    universe,
    now,
    today: businessDayOnOrBefore(firmToday(now)),
    owner,
    ingest,
    householdId: householdIds(universe),
    personId: personIds(universe),
    at: (day, key) => pastBusinessInstant(day, key, now),
    async standIns(service, records) {
      const latest = new Map(records.map((r) => [`${r.kind}\u0000${r.id}`, r]));
      await insertRows(owner, "demo.stand_in_record",
        [...latest.values()].map((r) => ({ service, kind: r.kind, id: r.id, doc: r.doc, position: r.position, updated_at: now })),
        `ON CONFLICT (service, kind, id) DO UPDATE
           SET doc = EXCLUDED.doc, position = EXCLUDED.position, updated_at = EXCLUDED.updated_at`);
    },
    shared: {},
  };
}
