import { PrismaClient, Prisma } from "@prisma/client";

// One Prisma client per worker, including production. Next compiles API routes,
// server components and middleware as separate module identities, so module
// caching alone does not share their connection pools. The process global also
// prevents duplicate clients during development hot reloads.
// NB: `prisma` below is a `$extends`-wrapped client (see the retry extension at
// the bottom), so the global cache is typed as the *extended* client type.
const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>;
};

// Bound the per-instance Prisma pool for Cloud Run (TDD ADR-3 / §5 connection
// budget). Each Cloud Run instance runs one Prisma client; with max_instances=4
// (infra/terraform) and connection_limit=5, the app draws at most 4×5=20 of
// Cloud SQL's ~100 max_connections (4×5 + migrate 5 + ingest_rw 10 + reserved 8
// = 43 < 100). We only APPEND the pool size to the datasource URL — we do NOT
// introduce any transaction-mode pooler, which would break the SET LOCAL RLS
// pattern in lib/rls.ts (ADR-3 caveat: interactive-transaction semantics must be
// preserved). Local dev / tests (no DATABASE_URL, or one already specifying
// connection_limit) are left untouched.
const CONNECTION_LIMIT = 5;

function boundedDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes("connection_limit")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}connection_limit=${CONNECTION_LIMIT}`;
}

// ticket (resilience half). Prisma's transient CONNECTION error codes. On
// Cloud Run, when an instance goes idle its Prisma→Cloud SQL (private-IP)
// sockets go stale; the FIRST request after idle fails with one of these before
// Prisma re-establishes the connection. We match ONLY these two — never query
// errors (P2xxx), validation errors, or actual query timeouts.
//   P1001  "Can't reach database server at …"
//   P1017  "Server has closed the connection."
// The code lands on DIFFERENT fields depending on which Prisma error class the
// engine raises (verified against @prisma/client 6.19.x):
//   - PrismaClientKnownRequestError → `.code`      (mid-query drops; P1017, and
//     P1001 when raised against an already-initialised engine)
//   - PrismaClientInitializationError → `.errorCode` (`.code` is undefined; the
//     class the engine uses when it cannot reach the server on (re)connect —
//     the exact P1001 symptom in the 2026-07-06 prod logs)
// so we read both fields rather than only `error.code`.
const TRANSIENT_CONNECTION_CODES = new Set(["P1001", "P1017"]);

/**
 * True iff `error` is a Prisma *transient connection* error (P1001 / P1017).
 * Exported for unit testing (test/db-retry.test.ts). Matches on the concrete
 * Prisma error classes and their respective code fields; anything else — a
 * P2xxx constraint/validation error, a plain Error, a non-object — is NOT
 * transient and must propagate unchanged.
 */
export function isTransientConnectionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return TRANSIENT_CONNECTION_CODES.has(error.code);
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return (
      error.errorCode !== undefined &&
      TRANSIENT_CONNECTION_CODES.has(error.errorCode)
    );
  }
  return false;
}

// ticket: the ONLY operations we retry are model READS. A retry re-issues the
// identical call — safe for an idempotent read, but NOT for a write: on a P1017
// ("server closed the connection") a write may have committed on the server
// before the socket dropped, so re-issuing it could double-apply. The path we
// must protect (the Auth.js session lookup, getSessionAndUser → session
// .findUnique) is a read and is covered; every write runs exactly once whether
// or not the connection blips. Raw ops ($queryRaw/$executeRaw) are intentionally
// excluded — they are opaque (could be writes) and the RLS ones run in a
// transaction anyway (skipped on that count too).
const RETRYABLE_READ_OPERATIONS = new Set<string>([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** True iff `operation` (a Prisma model-method name) is a retryable read. */
export function isReadOperation(operation: string): boolean {
  return RETRYABLE_READ_OPERATIONS.has(operation);
}

/**
 * True iff `params` — a Prisma `$allOperations` callback argument — represents
 * an operation running inside an interactive ('itx') or batch transaction. Read
 * from Prisma's runtime-only `__internalParams.transaction` field: present-but-
 * `undefined` for top-level ops, a descriptor object inside a transaction.
 *
 * This is the load-bearing transaction-safety check — retrying a single op
 * inside withUserScope's interactive tx would run outside its SET LOCAL RLS
 * scope. `__internalParams` is an UNTYPED, PRIVATE Prisma field, verified
 * against @prisma/client 6.19.3. If a Prisma upgrade renamed/removed it this
 * would silently read `false` and re-enable in-transaction retries — so
 * `test/db-retry-transaction.integration.test.ts` exercises the REAL runtime
 * (DB-gated) and fails loudly if this stops detecting a live transaction.
 * Re-verify on any @prisma/client major bump.
 */
export function operationIsInTransaction(params: unknown): boolean {
  const internal = (
    params as { __internalParams?: { transaction?: unknown } } | null
  )?.__internalParams;
  return Boolean(internal?.transaction);
}

/**
 * Core retry orchestration for ticket, factored out (and exported) so the
 * safety-critical behaviours can be unit-tested without a live DB
 * (test/db-retry.test.ts). Behaviour:
 *   - `skipRetry` true  → run `run` exactly once, never retry. The caller sets
 *     this for ops that must not be re-issued: anything inside a transaction
 *     (the tx is the atomicity / RLS boundary) AND any non-read (write) op.
 *   - `skipRetry` false → run `run`; on a transient connection error only
 *     (P1001 / P1017), `reconnect()` then run `run` exactly ONCE more. Any other
 *     error — and any second failure — propagates unchanged.
 * `run` MUST be the same thunk both times so the retry re-issues the identical
 * operation.
 */
export async function runWithConnectionRetry<T>(
  run: () => Promise<T>,
  skipRetry: boolean,
  reconnect: () => Promise<void>,
): Promise<T> {
  if (skipRetry) return run();
  try {
    return await run();
  } catch (error) {
    if (!isTransientConnectionError(error)) throw error;
    // One reconnect + one retry. Prisma re-establishes the socket on
    // reconnect(), so the single retry almost always succeeds. If it too fails
    // (transient or otherwise), we let that error propagate — no loop, no
    // backoff.
    await reconnect();
    return run();
  }
}

function createPrismaClient() {
  const url = boundedDatabaseUrl();
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    // Only override the datasource when we actually have a URL to bound; falling
    // back to Prisma's default (env-based) construction otherwise.
    ...(url ? { datasources: { db: { url } } } : {}),
  });

  // ticket: transparently retry a top-level operation ONCE when it fails with
  // a transient connection error, after forcing a reconnect. This is
  // defense-in-depth alongside the keep-warm infra change (#92): a stale-socket
  // drop after idle is re-established on the retry instead of bubbling up
  // through the Auth.js session lookup (getSessionAndUser → session.findUnique)
  // and logging the user out to Okta.
  //
  // RETRY SCOPE (two independent guards — either one disables the retry):
  //   1. TRANSACTION SAFETY (hard constraint — see lib/rls.ts withUserScope):
  //      `$allOperations` fires for BOTH top-level client calls AND ops run via
  //      an interactive-transaction `tx` client. Retrying a single op inside a
  //      transaction is unsafe: if the connection drops the whole tx is aborted,
  //      so a lone retry would run OUTSIDE the SET LOCAL RLS scope. operation
  //      IsInTransaction() reads Prisma's transaction tag, so an in-tx op is
  //      never retried — the retry is structurally impossible inside a tx.
  //   2. READS ONLY: we only retry idempotent reads (isReadOperation). A write
  //      re-issued after a P1017 could double-apply, so writes run exactly once.
  //   The protected path — the non-transactional adapter session lookup
  //   (session.findUnique, a read) — satisfies both and is retried; nothing else.
  return base.$extends({
    name: "retry-transient-connection",
    query: {
      async $allOperations(params) {
        const { args, query, operation } = params;
        const skipRetry =
          operationIsInTransaction(params) || !isReadOperation(operation);
        return runWithConnectionRetry(
          () => query(args),
          skipRetry,
          () => base.$connect(),
        );
      },
    },
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

globalForPrisma.prisma = prisma;
