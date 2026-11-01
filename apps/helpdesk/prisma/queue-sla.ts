/**
 * Steps 1 and 2 of the reference seed — the queues and the SLA policies.
 *
 * **They are CREATE-IF-MISSING, not upserts.** That is the whole change, and the reason is the same one
 * that made the macros create-if-missing in Wave A: `prisma db seed` runs on every deploy, and
 * Wave B gave the desk an admin surface that edits these very rows.
 *
 *  - `/admin/sla` edits `firstResponseMinutes`, `resolutionMinutes` and `warningMinutes`, and
 *    writes an audited `SLA_POLICY_CHANGED` row for every field it changes. An UPDATE branch here would
 *    silently revert the CS lead's decision on the next deploy — no audit row, nothing in the
 *    hash-chained ledger explaining why the numbers moved back, and the operator's evidence that they
 *    changed them at all would now disagree with the database. That is the defect the machine-user
 *    seeder was fixed for (`prisma/machine-users.ts`), in a third location.
 *  - `Queue.autoAssign` is likewise an operator decision. Nothing in this file may turn
 *    auto-assignment on or off, ever.
 *
 * So the seed's job is narrowed to what it is actually for: making sure a fresh database HAS the three
 * queues and the four policies. What a running database already holds is what it keeps — and the seeder
 * says out loud which rows it left alone, because "the deploy did not change the numbers you are
 * looking at" is exactly what an operator needs to read in the job log.
 *
 * Lives in its own module rather than inside `prisma/seed.ts` for the reason `machine-users.ts` does:
 * that file calls `main()` at the top level (it IS the `prisma db seed` entry point) and so cannot be
 * imported by a test without running a seed and calling `process.exit`. Everything here takes its
 * client as an argument, so `queue-sla.test.ts` can prove the write shape against an in-memory table.
 */
import { DEFAULT_SLA_POLICIES, QUEUE_KEYS, TICKET_PRIORITIES } from "../src/types/domain";
import type { QueueKey, TicketPriority } from "../src/types/domain";
import type { DbTx } from "../src/lib/db";

export type QueueSeed = { key: QueueKey; name: string; description: string; sortOrder: number };

/**
 * The three queues. The RBAC matrix, the routing table and the queue counters
 * are all keyed on `QueueKey`, so this is the STARTING set for a database that has none — adding a
 * fourth queue is a schema change and a Decision, not a line in this array.
 */
export const QUEUE_SEED: readonly QueueSeed[] = [
  {
    key: "OPERATIONS",
    name: "Operations",
    description: "Wires, ACATs, custodian trade corrections, cash movements.",
    sortOrder: 1,
  },
  {
    key: "CLIENT_SERVICE",
    name: "Client Service",
    description: "Portal resets, tax documents / 1099s, address changes.",
    sortOrder: 2,
  },
  {
    key: "ADVICE",
    name: "Advice",
    description: "Rebalancing, planning updates, tax-loss harvesting.",
    sortOrder: 3,
  },
];

export type SeedOutcome = { created: number; kept: string[] };

/** The CREATE branch. `autoAssign` is deliberately absent: a new queue takes the column's default (false). */
export function queueCreateData(q: QueueSeed) {
  return { key: q.key, name: q.name, description: q.description, sortOrder: q.sortOrder };
}

/**
 * Queues, create-if-missing. Returns the ids every caller needs (the macro seeder keys off them) plus
 * what it created and what it left alone.
 */
export async function seedQueues(db: DbTx): Promise<{ ids: Record<QueueKey, string> } & SeedOutcome> {
  const ids = {} as Record<QueueKey, string>;
  const kept: string[] = [];
  let created = 0;

  for (const q of QUEUE_SEED) {
    const existing = await db.queue.findUnique({ where: { key: q.key }, select: { id: true } });
    if (existing !== null) {
      ids[q.key] = existing.id;
      kept.push(q.key);
      continue;
    }
    const row = await db.queue.create({ data: queueCreateData(q), select: { id: true } });
    ids[q.key] = row.id;
    created += 1;
  }

  for (const key of QUEUE_KEYS) {
    if (!ids[key]) throw new Error(`queue seed incomplete: ${key} missing`);
  }
  return { ids, created, kept };
}

/** The CREATE branch for one policy. `warningMinutes` takes the column default (30). */
export function slaCreateData(priority: TicketPriority) {
  const policy = DEFAULT_SLA_POLICIES[priority];
  return {
    priority,
    name: policy.name,
    firstResponseMinutes: policy.firstResponseMinutes,
    resolutionMinutes: policy.resolutionMinutes,
  };
}

/** SLA policies, create-if-missing. A row edited at `/admin/sla` is never written back. */
export async function seedSla(db: DbTx): Promise<SeedOutcome> {
  const kept: string[] = [];
  let created = 0;

  for (const priority of TICKET_PRIORITIES) {
    const existing = await db.sLA.findUnique({ where: { priority }, select: { priority: true } });
    if (existing !== null) {
      kept.push(priority);
      continue;
    }
    await db.sLA.create({ data: slaCreateData(priority) });
    created += 1;
  }
  return { created, kept };
}

/**
 * The line the seeder prints when it left rows alone. Named rather than counted: an operator reading a
 * deploy log needs to know WHICH policy the running database is using, not that "4 were skipped".
 * Null when there is nothing to say, so a fresh database's log stays quiet.
 */
export function keptRowsNotice(what: "queues" | "sla policies", kept: readonly string[]): string | null {
  if (kept.length === 0) return null;
  return (
    `${what}: kept ${kept.length} existing row${kept.length === 1 ? "" : "s"} unchanged ` +
    `(create-if-missing; edit SLA numbers at /admin/sla, which audits every change): ${[...kept].join(", ")}`
  );
}
