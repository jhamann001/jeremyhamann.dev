import "server-only";
import { prisma } from "@/lib/db";

// The stand-ins' records (demo.stand_in_record): one row per record of an outside service, kept as the JSON that
// service's API returns, in the service's own order (`position`). Reads and changes go through here; a change runs
// in one transaction with the row locked, so two visitors' edits to one record never interleave.

export type StandInStore = "tracker" | "pipeline" | "warehouse";

/**
 * The most records of one kind the demo keeps. Visitors add records (tracker transfers, pipeline destinations) and
 * nothing removes one before the nightly reset, so new ids stop here; every read is bounded by it too. The seed writes
 * at most 220 of a kind (the reset test holds it below this). The database keeps its own, lower total
 * (demo.stand_in_record_bounds), so no mix of kinds can fill the disk either.
 */
export const STAND_IN_KIND_CAP = 1_000;

export interface StoredRecord<T> {
  id: string;
  doc: T;
  updatedAt: Date;
}

type Row = { id: string; doc: unknown; updated_at: Date };

export async function listRecords<T>(service: StandInStore, kind: string): Promise<StoredRecord<T>[]> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, doc, updated_at FROM demo.stand_in_record
     WHERE service = ${service} AND kind = ${kind}
     ORDER BY position, id
     LIMIT ${STAND_IN_KIND_CAP}`;
  return rows.map((r) => ({ id: r.id, doc: r.doc as T, updatedAt: r.updated_at }));
}

export async function readRecord<T>(service: StandInStore, kind: string, id: string): Promise<StoredRecord<T> | null> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, doc, updated_at FROM demo.stand_in_record
     WHERE service = ${service} AND kind = ${kind} AND id = ${id}`;
  return rows[0] ? { id: rows[0].id, doc: rows[0].doc as T, updatedAt: rows[0].updated_at } : null;
}

/** Adds a record, or replaces one with the same id. New records go to the end of the service's order unless
 *  `position` says otherwise. "full", with nothing written, when `id` is new and the kind already holds
 *  STAND_IN_KIND_CAP records. */
export async function saveRecord<T extends object>(
  service: StandInStore,
  kind: string,
  id: string,
  doc: T,
  position?: number,
): Promise<"saved" | "full"> {
  const json = JSON.stringify(doc);
  const written = await prisma.$executeRaw`
    INSERT INTO demo.stand_in_record (service, kind, id, doc, position)
    SELECT ${service}::text, ${kind}::text, ${id}::text, ${json}::jsonb,
           COALESCE(${position ?? null}::integer,
                    (SELECT COALESCE(MAX(position), 0) + 1 FROM demo.stand_in_record WHERE service = ${service} AND kind = ${kind}))
     WHERE EXISTS (SELECT 1 FROM demo.stand_in_record WHERE service = ${service} AND kind = ${kind} AND id = ${id})
        OR (SELECT count(*) FROM demo.stand_in_record WHERE service = ${service} AND kind = ${kind}) < ${STAND_IN_KIND_CAP}::bigint
    ON CONFLICT (service, kind, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`;
  return written > 0 ? "saved" : "full";
}

/** Changes one record under a row lock. `change` returns the new record, or null to leave it as it is; the result is
 *  the record after the change, or null when there is no such record. */
export async function changeRecord<T extends object>(
  service: StandInStore,
  kind: string,
  id: string,
  change: (doc: T) => T | null,
): Promise<T | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      SELECT id, doc, updated_at FROM demo.stand_in_record
       WHERE service = ${service} AND kind = ${kind} AND id = ${id}
       FOR UPDATE`;
    if (!rows[0]) return null;
    const next = change(rows[0].doc as T);
    if (!next) return rows[0].doc as T;
    await tx.$executeRaw`
      UPDATE demo.stand_in_record SET doc = ${JSON.stringify(next)}::jsonb, updated_at = now()
       WHERE service = ${service} AND kind = ${kind} AND id = ${id}`;
    return next;
  });
}
