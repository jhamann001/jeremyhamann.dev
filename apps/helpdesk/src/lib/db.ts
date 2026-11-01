/**
 * Prisma clients — node only, layer L2.
 *
 * `prisma`   — the application client. Its `booksAndRecords` extension refuses every in-app path that
 *              would mutate a books-and-records row: see BOOKS_AND_RECORDS_GUARDS below, which covers
 *              every table the migrations mark append-only or no-hard-delete (the DB triggers and the
 *              runtime role are the other two layers).
 * `publicDb` — a SEPARATE base client for the client-facing read path only. Its `publicReadOnly`
 *              extension limits top-level operations to reads on Ticket/Comment, forces
 *              `visibility: "PUBLIC"` on Comment reads, rejects relation includes/selects and unsafe raw
 *              access. LIMITATION (stated, not hidden): Prisma query extensions do not run for nested
 *              relation reads, so the hook protects TOP-LEVEL operations only; the include/select
 *              rejection here, guardrail G8, and the production SELECT-only role are what make the path
 *              read-only.
 *
 * Logging is warn/error only — never statement-level logging, which would echo bodies.
 */
import { PrismaClient } from "@prisma/client";
import { AuditImmutabilityError, IsolationViolationError } from "@/lib/errors";
import { env } from "@/lib/env";

/** Relation keys of Ticket: never selectable through publicDb. */
export const TICKET_RELATION_KEYS = ["queue", "createdBy", "assignee", "comments", "auditLogs"] as const;
/** Relation keys of Comment: never selectable through publicDb (defense in depth beyond the include check). */
const COMMENT_RELATION_KEYS = ["ticket", "author", "macro"] as const;

const PUBLIC_READ_OPERATIONS: ReadonlySet<string> = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
]);

function forbidden(operation: string): () => never {
  return () => {
    throw new AuditImmutabilityError(operation);
  };
}

function isolated(message: string): () => never {
  return () => {
    throw new IsolationViolationError(message);
  };
}

/**
 * Layer one of the three that hold "no books-and-records row is ever rewritten or removed"
 * (prisma/schema.prisma header): this extension, the Postgres triggers in
 * prisma/migrations/*_audit_immutability and *_wave_a_constraints, and REVOKE on the runtime role.
 *
 * Every table those migrations mark append-only (BEFORE UPDATE OR DELETE) is listed here with the
 * six mutating operations; every table marked no-hard-delete (BEFORE DELETE) is listed with the two
 * deleting ones. That coverage is not a convention — db.test.ts parses the migrations and fails if a
 * guarded table is missing from this map, so a new ledger cannot be added with only two layers.
 *
 * Why it matters even though the trigger would also refuse: this layer fires in-process, in unit
 * tests and at code-review time, and on a developer machine whose DATABASE_URL is the owning role
 * the trigger is the ONLY other layer standing — the REVOKE layer is not there at all.
 *
 * `upsert` counts as a mutation for the append-only tables because its update branch is one. Rows
 * are created with `create` / `createMany` (see sla-sweep's createMany and ingest's create).
 */
const BOOKS_AND_RECORDS_QUERY = {
  // Append-only ledgers: written once, never rewritten, never removed.
  auditLog: {
    update: forbidden("auditLog.update"),
    updateMany: forbidden("auditLog.updateMany"),
    updateManyAndReturn: forbidden("auditLog.updateManyAndReturn"),
    upsert: forbidden("auditLog.upsert"),
    delete: forbidden("auditLog.delete"),
    deleteMany: forbidden("auditLog.deleteMany"),
  },
  comment: {
    update: forbidden("comment.update"),
    updateMany: forbidden("comment.updateMany"),
    updateManyAndReturn: forbidden("comment.updateManyAndReturn"),
    upsert: forbidden("comment.upsert"),
    delete: forbidden("comment.delete"),
    deleteMany: forbidden("comment.deleteMany"),
  },
  ingestReceipt: {
    update: forbidden("ingestReceipt.update"),
    updateMany: forbidden("ingestReceipt.updateMany"),
    updateManyAndReturn: forbidden("ingestReceipt.updateManyAndReturn"),
    upsert: forbidden("ingestReceipt.upsert"),
    delete: forbidden("ingestReceipt.delete"),
    deleteMany: forbidden("ingestReceipt.deleteMany"),
  },
  slaAlert: {
    update: forbidden("slaAlert.update"),
    updateMany: forbidden("slaAlert.updateMany"),
    updateManyAndReturn: forbidden("slaAlert.updateManyAndReturn"),
    upsert: forbidden("slaAlert.upsert"),
    delete: forbidden("slaAlert.delete"),
    deleteMany: forbidden("slaAlert.deleteMany"),
  },
  // State tables: they transition (every transition audited), but a row is never removed.
  ticket: {
    delete: forbidden("ticket.delete"),
    deleteMany: forbidden("ticket.deleteMany"),
  },
  attachment: {
    delete: forbidden("attachment.delete"),
    deleteMany: forbidden("attachment.deleteMany"),
  },
  messageDelivery: {
    delete: forbidden("messageDelivery.delete"),
    deleteMany: forbidden("messageDelivery.deleteMany"),
  },
  suspendedIntake: {
    delete: forbidden("suspendedIntake.delete"),
    deleteMany: forbidden("suspendedIntake.deleteMany"),
  },

  // --- Wave B. Same two families, same reasons, and the same third layer: every table
  // below carries the matching Postgres trigger in 20260920000200_wave_b_constraints, and db.test.ts
  // reads those triggers and fails if this list falls behind them.
  //
  // Append-only: a row here is a statement about a moment, so a correction is a NEW row.
  commentRetraction: {
    update: forbidden("commentRetraction.update"),
    updateMany: forbidden("commentRetraction.updateMany"),
    updateManyAndReturn: forbidden("commentRetraction.updateManyAndReturn"),
    upsert: forbidden("commentRetraction.upsert"),
    delete: forbidden("commentRetraction.delete"),
    deleteMany: forbidden("commentRetraction.deleteMany"),
  },
  identityVerification: {
    update: forbidden("identityVerification.update"),
    updateMany: forbidden("identityVerification.updateMany"),
    updateManyAndReturn: forbidden("identityVerification.updateManyAndReturn"),
    upsert: forbidden("identityVerification.upsert"),
    delete: forbidden("identityVerification.delete"),
    deleteMany: forbidden("identityVerification.deleteMany"),
  },
  reviewStamp: {
    update: forbidden("reviewStamp.update"),
    updateMany: forbidden("reviewStamp.updateMany"),
    updateManyAndReturn: forbidden("reviewStamp.updateManyAndReturn"),
    upsert: forbidden("reviewStamp.upsert"),
    delete: forbidden("reviewStamp.delete"),
    deleteMany: forbidden("reviewStamp.deleteMany"),
  },
  followUpNudge: {
    update: forbidden("followUpNudge.update"),
    updateMany: forbidden("followUpNudge.updateMany"),
    updateManyAndReturn: forbidden("followUpNudge.updateManyAndReturn"),
    upsert: forbidden("followUpNudge.upsert"),
    delete: forbidden("followUpNudge.delete"),
    deleteMany: forbidden("followUpNudge.deleteMany"),
  },
  // The portfolio demo's Outbox (20261027000000_demo_outbox): what the stand-ins received stays as received.
  demoOutboxMessage: {
    update: forbidden("demoOutboxMessage.update"),
    updateMany: forbidden("demoOutboxMessage.updateMany"),
    updateManyAndReturn: forbidden("demoOutboxMessage.updateManyAndReturn"),
    upsert: forbidden("demoOutboxMessage.upsert"),
    delete: forbidden("demoOutboxMessage.delete"),
    deleteMany: forbidden("demoOutboxMessage.deleteMany"),
  },

  // No hard delete: they transition (every transition audited), but a row is never removed.
  notification: {
    delete: forbidden("notification.delete"),
    deleteMany: forbidden("notification.deleteMany"),
  },
  ticketFollower: {
    delete: forbidden("ticketFollower.delete"),
    deleteMany: forbidden("ticketFollower.deleteMany"),
  },
  ticketLink: {
    delete: forbidden("ticketLink.delete"),
    deleteMany: forbidden("ticketLink.deleteMany"),
  },
  webhookEndpoint: {
    delete: forbidden("webhookEndpoint.delete"),
    deleteMany: forbidden("webhookEndpoint.deleteMany"),
  },
  webhookDelivery: {
    delete: forbidden("webhookDelivery.delete"),
    deleteMany: forbidden("webhookDelivery.deleteMany"),
  },
  clientApiToken: {
    delete: forbidden("clientApiToken.delete"),
    deleteMany: forbidden("clientApiToken.deleteMany"),
  },
  requesterSuppression: {
    delete: forbidden("requesterSuppression.delete"),
    deleteMany: forbidden("requesterSuppression.deleteMany"),
  },

  // DELIBERATELY ABSENT, and this is the whole list: `composerDraft` (an unsent draft is not a record
  // and its owner must be able to discard it) and `pushSubscription` (a device-side artefact the push
  // service itself declares dead with HTTP 410, which we must then prune). Both are argued in full in
  // the migration's §2, and db.test.ts's "guards nothing the database leaves mutable" test is what
  // keeps this list from silently growing past what the triggers actually refuse.
} as const;

/**
 * The extension's coverage as plain data — model key → the operation names it refuses. Read by
 * db.test.ts, which checks it against the triggers the migrations actually declare.
 */
export const BOOKS_AND_RECORDS_GUARDS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries(BOOKS_AND_RECORDS_QUERY).map(([model, ops]) => [model, Object.freeze(Object.keys(ops))]),
  ),
);

function createPrismaClient() {
  return new PrismaClient({ log: ["warn", "error"] }).$extends({
    name: "booksAndRecords",
    query: BOOKS_AND_RECORDS_QUERY,
  });
}

export type Db = ReturnType<typeof createPrismaClient>;
/** The interactive-transaction client; `prisma` itself is assignable to it. */
export type DbTx = Omit<Db, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

type PublicArgs = {
  include?: unknown;
  select?: Record<string, unknown>;
  where?: Record<string, unknown>;
};

function createPublicDb() {
  // A separate base client (never the `prisma` singleton) so the datasource can be the SELECT-only role.
  return new PrismaClient({
    log: ["warn", "error"],
    datasourceUrl: env.PUBLIC_DATABASE_URL ?? env.DATABASE_URL,
  }).$extends({
    name: "publicReadOnly",
    query: {
      $executeRaw: isolated("publicDb: $executeRaw is not allowed"),
      $executeRawUnsafe: isolated("publicDb: $executeRawUnsafe is not allowed"),
      $queryRawUnsafe: isolated("publicDb: $queryRawUnsafe is not allowed"),
      // $queryRaw (tagged template) stays allowed: selectPublicComments uses it against the view.
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (model !== "Ticket" && model !== "Comment") {
            throw new IsolationViolationError(`publicDb: ${model} is not readable`);
          }
          if (!PUBLIC_READ_OPERATIONS.has(operation)) {
            throw new IsolationViolationError(`publicDb: ${operation} is not allowed`);
          }
          const a = args as PublicArgs;
          if (model === "Ticket") {
            if ("include" in a && a.include) {
              throw new IsolationViolationError("publicDb: ticket include is not allowed");
            }
            const sel = a.select;
            if (sel && TICKET_RELATION_KEYS.some((k) => k in sel)) {
              throw new IsolationViolationError("publicDb: ticket relation select is not allowed");
            }
          } else {
            if ("include" in a && a.include) {
              throw new IsolationViolationError("publicDb: comment include is not allowed");
            }
            const sel = a.select;
            if (sel && COMMENT_RELATION_KEYS.some((k) => k in sel)) {
              throw new IsolationViolationError("publicDb: comment relation select is not allowed");
            }
            // Force PUBLIC. findUnique/findUniqueOrThrow reject an AND-only unique `where` at validation
            // time (verified on Prisma 6.19.3), so they take the merged form — the forced key is written
            // last and therefore wins over any caller-supplied `visibility`.
            if (operation === "findUnique" || operation === "findUniqueOrThrow") {
              a.where = { ...(a.where ?? {}), visibility: "PUBLIC" };
            } else {
              a.where = { AND: [a.where ?? {}, { visibility: "PUBLIC" }] };
            }
          }
          return query(args);
        },
      },
    },
  });
}

export type PublicDb = ReturnType<typeof createPublicDb>;

const globalClients = globalThis as unknown as {
  __wmHelpdeskPrisma?: Db;
  __wmHelpdeskPublicDb?: PublicDb;
};

export const prisma: Db = globalClients.__wmHelpdeskPrisma ?? createPrismaClient();
export const publicDb: PublicDb = globalClients.__wmHelpdeskPublicDb ?? createPublicDb();

if (process.env.NODE_ENV !== "production") {
  globalClients.__wmHelpdeskPrisma = prisma;
  globalClients.__wmHelpdeskPublicDb = publicDb;
}

/** One interactive transaction per mutation; `writeAuditMany` must be its last statement. */
export function withTx<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { maxWait: 5000, timeout: 15000 });
}
