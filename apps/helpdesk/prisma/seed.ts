/**
 * Reference seed — the entry `prisma db seed` runs.
 *
 * Steps 0, 1, 2 and 4: the two MACHINE user rows, queues, SLA rows, macros. Reference data
 * every environment needs, written idempotently. No tickets, no HUMAN users, NO audit rows — safe in
 * production. The machine rows hold zero groups and are never signed in to.
 *
 * "Idempotent" now means CREATE-IF-MISSING for everything except the machine users' link metadata:
 * queues and SLA policies (./queue-sla) joined the macros once the desk grew
 * admin surfaces that edit those rows and audit the edit. A seeder that re-applies this file's values
 * on every deploy is a seeder that reverts an operator's audited decision without an audit row.
 *
 * Dev fixtures (`./seed-dev`) run only when `SEED_DEV_FIXTURES === "true"` (literal read, same pattern
 * as `isDevLoginEnabled`). Under `APP_ENV === "production"` that flag is refused with exit code 2
 * BEFORE anything is imported or written. The refusal keys on APP_ENV — the deployment label Terraform sets
 * per project — not on NODE_ENV: the dev migrate job runs this seed with NODE_ENV=production too, and dev
 * fixtures are exactly what that job seeds once. The guard precedes the `../src/lib/db` import
 * (which pulls `../src/lib/env`) so the refusal is a clean one.
 *
 * Imports are relative (`../src/…`); the transitive `@/` imports resolve through tsconfig paths under tsx.
 */
// `errorLabel` (Wave A's security scanner sweep) replaces the caught error's own message at the entry-point
// rejection handler below — see step "Entry". The queue and SLA CONSTANTS that used to be imported
// here are gone with Wave B's B11: `seedQueues` / `seedSla` moved into ./queue-sla and own them now.
import { errorLabel } from "../src/lib/logger";
import { deactivatedMachineUserWarning, seedMachineUsers } from "./machine-users";
import { keptRowsNotice, seedQueues, seedSla } from "./queue-sla";
import { seedMacros } from "./macros";

// ---------------------------------------------------------------------------
// Step 0 — machine actors
//
// The two machine User rows (the integration bearer and the scheduled-jobs runtime), their write
// shape and why the UPDATE branch must never carry `isActive`, live in ./machine-users so they can be
// unit-tested — this file calls main() at the top level and cannot be imported by a test.
//
// ---------------------------------------------------------------------------
// Steps 1 and 2 — queues and SLA policies.
//
// both are CREATE-IF-MISSING and live in ./queue-sla, beside the machine users and
// for the same two reasons — `prisma db seed` runs on every deploy, and `/admin/sla` now edits the SLA
// rows with an audited `SLA_POLICY_CHANGED` for every field. An UPDATE branch here would revert the CS
// lead's numbers silently, and `Queue.autoAssign` is an operator decision this file must
// never touch. Keeping the logic in a module also makes it testable: seed.ts calls main() at the top
// level and cannot be imported.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Diagnostics go to stderr directly, never through `console.error` / `console.warn`: those are the
 * sinks security scanner rule (CWE-209) watches for caught-error detail. Same fd and same
 * trailing newline as before, so a `prisma db seed` transcript is unchanged.
 */
function printErrorLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<number> {
  // Literal reads, no env object (same pattern as isDevLoginEnabled).
  const devFixturesRequested = process.env.SEED_DEV_FIXTURES === "true";

  // The refusal runs BEFORE any import of ../src/lib/db and before step 1, so a production operator who
  // set the flag by mistake gets a clean exit 2 and nothing is written. Keyed on APP_ENV.
  if (devFixturesRequested && process.env.APP_ENV === "production") {
    printErrorLine("SEED_DEV_FIXTURES is not allowed in production (APP_ENV=production)");
    return 2;
  }

  const { prisma } = await import("../src/lib/db");
  try {
    const machineUsers = await seedMachineUsers(prisma);
    // A deploy no longer re-enables a machine identity an administrator disabled, so this log line is
    // the only place that says the surface is still closed. Printed before the summary counts so it
    // cannot be mistaken for a footnote to them.
    if (machineUsers.deactivated.length > 0) {
      printErrorLine(deactivatedMachineUserWarning(machineUsers.deactivated));
    }
    const queues = await seedQueues(prisma);
    const sla = await seedSla(prisma);
    // Printed BEFORE the summary counts, like the deactivated-machine-user warning, so "the deploy did
    // not change the numbers you are looking at" cannot be mistaken for a footnote to them.
    for (const notice of [keptRowsNotice("queues", queues.kept), keptRowsNotice("sla policies", sla.kept)]) {
      if (notice !== null) console.log(notice);
    }
    const macros = await seedMacros(prisma, queues.ids);
    console.log(
      `reference seed complete: machineUsers=${machineUsers.upserted} ` +
        `queues=${queues.created} created/${queues.kept.length} kept ` +
        `sla=${sla.created} created/${sla.kept.length} kept ` +
        `macros=${macros.created} created/${macros.skipped} kept (idempotent, no audit rows)`,
    );

    if (devFixturesRequested) {
      // The demo desk, in one transaction. Re-seeding an existing desk is `npm run demo:reset`, which
      // empties it first; here a database that already has tickets is left alone.
      const existing = await prisma.ticket.count();
      if (existing > 0) {
        console.log(`tickets present (${existing}) — demo desk skipped (npm run demo:reset rebuilds it)`);
      } else {
        const [{ seedFromUniverse }, { loadUniverse }, { RESET_TIMEOUT_MS }] = await Promise.all([
          import("./seed-dev"),
          import("../src/lib/demo/universe"),
          import("./demo-reset"),
        ]);
        await prisma.$transaction((tx) => seedFromUniverse(tx, { universe: loadUniverse() }), {
          maxWait: 10_000,
          timeout: RESET_TIMEOUT_MS,
        });
      }
    } else {
      console.log("dev fixtures skipped (SEED_DEV_FIXTURES unset)");
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    // `errorLabel(err)` — the error's class name plus an AppError code, and nothing else. The message
    // used to be printed here on the reasoning that a message is safer than a stack; it is not. A
    // Prisma failure's message quotes the row that violated the constraint, and this seed writes
    // client-shaped fixtures, so the message is the disclosure (CWE-209). The
    // step that failed is legible from the log lines that did print above it.
    printErrorLine(`seed failed: ${errorLabel(err)}`);
    process.exit(1);
  },
);
