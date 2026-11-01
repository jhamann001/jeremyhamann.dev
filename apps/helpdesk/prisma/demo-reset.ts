/**
 * The demo's reset: empty every table and write the demo desk again, as ONE transaction, as the
 * database owner. The nightly workflow and each deploy run it through `npm run demo:reset`; the
 * container never does, because it connects as the app role, which can neither truncate a table nor
 * switch a trigger off (demo-reset.database.test.ts proves both).
 *
 * The ledger and eighteen other tables refuse UPDATE and DELETE through their own triggers, which is the
 * point of them. Inside this transaction the owner switches every table's user triggers off, truncates,
 * switches them back on and restarts the ledger's sequence, so the new chain starts at GENESIS. The
 * reference rows and the demo desk are then written with every trigger live again, and the chain is
 * verified before the commit. Any failure rolls all of it back, so a failed reset leaves yesterday's
 * desk intact. While it runs, the app's queries wait on the table locks rather than see a half-built desk.
 */
import type { Db, DbTx } from "../src/lib/db";
import { loadUniverse } from "../src/lib/demo/universe";
import type { Universe } from "../src/lib/demo/universe";
import { seedMacros } from "./macros";
import { seedMachineUsers } from "./machine-users";
import { seedQueues, seedSla } from "./queue-sla";
import { seedFromUniverse } from "./seed-dev";
import type { SeedSummary } from "./seed-dev";

/** Long enough for a cold database over a pooled connection; the seed itself takes well under a minute. */
export const RESET_TIMEOUT_MS = 10 * 60_000;

/**
 * Every table in `public` except Prisma's migration history: user triggers off, truncate, triggers back
 * on, ledger sequence restarted. Built from the catalog rather than a list, so a table a later migration
 * adds is emptied too.
 *
 * The ledger's sequence is not owned by its column, so the truncate does not restart it, and it is
 * restarted with ALTER SEQUENCE rather than setval: setval is not undone by a rollback, so a reset that
 * failed after it would leave yesterday's ledger with a sequence pointing back at row 1.
 */
export const WIPE_SQL = `DO $$
DECLARE
  t record;
  tables text;
BEGIN
  SELECT string_agg(format('public.%I', tablename), ', ' ORDER BY tablename) INTO tables
    FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations';
  FOR t IN SELECT DISTINCT c.relname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT g.tgisinternal LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', t.relname);
  END LOOP;
  EXECUTE 'TRUNCATE ' || tables || ' RESTART IDENTITY';
  FOR t IN SELECT DISTINCT c.relname FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT g.tgisinternal LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', t.relname);
  END LOOP;
  ALTER SEQUENCE audit_log_seq RESTART WITH 1;
END $$`;

export type ResetResult = SeedSummary & { seconds: number };

export async function runDemoReset(db: Db, opts: { universe?: Universe; now?: Date } = {}): Promise<ResetResult> {
  if (process.env.APP_ENV === "production") {
    throw new Error("demo reset refused: APP_ENV=production");
  }
  const universe = opts.universe ?? loadUniverse();
  const started = Date.now();
  const summary = await db.$transaction(
    async (tx: DbTx) => {
      await tx.$executeRawUnsafe(WIPE_SQL);
      await seedMachineUsers(tx);
      const queues = await seedQueues(tx);
      await seedSla(tx);
      await seedMacros(tx, queues.ids);
      return seedFromUniverse(tx, { universe, now: opts.now });
    },
    { maxWait: 10_000, timeout: RESET_TIMEOUT_MS },
  );
  return { ...summary, seconds: Math.round((Date.now() - started) / 100) / 10 };
}
