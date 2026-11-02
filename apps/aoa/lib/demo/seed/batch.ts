// How the demo seed writes many rows in few round trips. The nightly reset reaches its database over the internet,
// where every statement costs a round trip of tens of milliseconds, so a part writes each table's rows in one
// statement (insertRows), and where the order of writes across tables matters (the row-change trail and the audit
// log number their rows as they arrive, and row security reads the acting person's settings at each write) it hands
// the whole sequence to the database to run in that order (runInOrder). Rows are keyed by column name and go in
// through jsonb_populate_recordset, so each value is read by its column's own type, as a single INSERT would read it.

import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** A row as its table's columns name it ("created_at", "actorEmail"). Dates go in as ISO instants. */
export type Row = Record<string, unknown>;

/** One statement for runInOrder: SQL whose `$1` is `params` as jsonb. */
export interface Write {
  sql: string;
  params: unknown;
}

const column = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** One INSERT of `rows` into `table`, in the order given; `tail` is an ON CONFLICT clause. A column one row lacks goes
 *  in as NULL for that row. */
export function insertWrite(table: string, rows: Row[], tail = ""): Write {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].map(column).join(", ");
  return {
    sql: `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb) ${tail}`,
    params: rows,
  };
}

/** Writes `rows` into `table` in one statement. Returns the rows written. */
export async function insertRows(db: Db, table: string, rows: Row[], tail = ""): Promise<number> {
  if (rows.length === 0) return 0;
  const write = insertWrite(table, rows, tail);
  return db.$executeRawUnsafe(write.sql, JSON.stringify(write.params));
}

/** The settings withUserScope sets for the person the next writes are made as (the row policies read them). */
export function actAsWrite(role: string, email: string | null): Write {
  return {
    sql: "SELECT set_config('app.user_role', $1->>'role', true), set_config('app.user_email', $1->>'email', true)",
    params: { role, email: email ?? "" },
  };
}

/**
 * Runs `writes` inside the caller's transaction, one after another, in two round trips: the list goes into a
 * transaction-local setting and one DO block executes each statement with its rows. Triggers, sequences and row
 * security see the same statements in the same order as if each were sent on its own.
 */
export async function runInOrder(tx: Prisma.TransactionClient, writes: Write[]): Promise<void> {
  if (writes.length === 0) return;
  await tx.$executeRaw`SELECT set_config('demo.seed_writes', ${JSON.stringify(writes)}, true)`;
  await tx.$executeRawUnsafe(`
    DO $writes$
    DECLARE w jsonb;
    BEGIN
      FOR w IN SELECT value FROM jsonb_array_elements(current_setting('demo.seed_writes')::jsonb) WITH ORDINALITY ORDER BY ordinality LOOP
        EXECUTE w->>'sql' USING w->'params';
      END LOOP;
      PERFORM set_config('demo.seed_writes', '', true);
    END
    $writes$`);
}
