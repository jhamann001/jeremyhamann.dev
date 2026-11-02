import { PrismaClient } from "@prisma/client";

// Dedicated `ingest_rw` Prisma client — the SECOND client in the app, distinct
// from `lib/db.ts` (which is the `app_rw` client). This is the ONLY client that
// ever writes the `mirror` schema (TDD ADR-2). It is NEVER imported by any
// `app_rw`/`withUserScope` path, and no app screen/route reaches it — mirror
// writes exist only under `app/api/ingest/*` + `lib/ingest/*`. Keeping the two
// clients separate is what lets the `ingest_rw` DB role (upsert-only, no DELETE)
// be the sole writer of `mirror`, while `app_rw` stays read-only there.
//
// Same idiom as `lib/db.ts`: a bounded connection URL + a hot-reload singleton
// guard, so dev hot-reload does not leak connections. Not stored on globalThis
// in production (each Cloud Run instance starts a fresh client).

const globalForIngest = globalThis as unknown as {
  ingestPrisma?: PrismaClient;
};

// connection_limit=2 per instance (TDD §5 connection budget): 4 instances × 2 =
// 8 connections, inside the 10 reserved for `ingest_rw` at the DB. We only
// APPEND the pool size — no transaction-mode pooler, which would break the
// interactive-transaction semantics `withIngestScope` relies on (the lib/db.ts
// ADR-3 caveat). A URL that already sets connection_limit is left untouched.
const CONNECTION_LIMIT = 2;

function boundedIngestUrl(): string | undefined {
  const url = process.env.INGEST_DATABASE_URL;
  // Unset → return undefined so Prisma falls back to its env-based datasource
  // construction (matching lib/db.ts). Present-and-already-bounded → untouched.
  if (!url || url.includes("connection_limit")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}connection_limit=${CONNECTION_LIMIT}`;
}

function createIngestClient(): PrismaClient {
  const url = boundedIngestUrl();
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    // Only override the datasource when we actually have a URL to bound.
    ...(url ? { datasources: { db: { url } } } : {}),
  });
}

export const ingestPrisma = globalForIngest.ingestPrisma ?? createIngestClient();

if (process.env.NODE_ENV !== "production") globalForIngest.ingestPrisma = ingestPrisma;
