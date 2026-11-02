import type { Prisma } from "@prisma/client";

// The ported Trade Request drift code keeps the standalone `pool.query(sql, params)` call shape, answered by
// AOA's single Prisma client (ticket). No second database pool: the Cloud SQL connection budget is fixed.
// Prisma binds typed parameters, so text bound to date, uuid or timestamptz columns needs an explicit SQL cast.
export type QueryResult<T> = { rows: T[]; rowCount: number };
export interface PgCompat {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** One interactive transaction; a thrown error rolls every statement back. */
  transaction<T>(fn: (client: PgCompat) => Promise<T>): Promise<T>;
}
export type Pool = PgCompat;
export type PoolClient = PgCompat;

type RawClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};
type RootClient = RawClient & {
  $transaction<R>(fn: (tx: Prisma.TransactionClient) => Promise<R>, options?: { maxWait?: number; timeout?: number }): Promise<R>;
};

// A whole drift run's rows are written in one transaction; Prisma's 5 s default is too short.
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 120_000 };

function queryWith(client: RawClient): PgCompat["query"] {
  return async <T>(sql: string, params: readonly unknown[] = []) => {
    if (/^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql) && !/\bRETURNING\b/i.test(sql)) {
      return { rows: [] as T[], rowCount: await client.$executeRawUnsafe(sql, ...params) };
    }
    const rows = await client.$queryRawUnsafe<T[]>(sql, ...params);
    return { rows, rowCount: rows.length };
  };
}

export function pgCompatFromTransaction(tx: Prisma.TransactionClient): PgCompat {
  const self: PgCompat = { query: queryWith(tx as unknown as RawClient), transaction: (fn) => fn(self) };
  return self;
}

export function pgCompat(root: RootClient): PgCompat {
  return {
    query: queryWith(root),
    transaction: (fn) => root.$transaction((tx) => fn(pgCompatFromTransaction(tx)), TRANSACTION_OPTIONS),
  };
}

/** The application's Prisma client behind the pg call shape. Imported lazily so loading a module touches no database. */
export async function appPool(): Promise<PgCompat> {
  const { prisma } = await import("@/lib/db");
  return pgCompat(prisma as unknown as RootClient);
}
