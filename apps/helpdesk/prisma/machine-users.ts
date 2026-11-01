/**
 * Step 0 of the reference seed (`prisma/seed.ts`) — the machine actors.
 *
 * Every audited row needs an actor, and Wave A introduces two kinds of caller that are not people:
 * the integration bearer (ingest / export / outbox) and the scheduled-jobs runtime. Both are REAL
 * User rows so `AuditLog.actorId` stays a foreign key and "who did this" survives; both hold ZERO
 * groups, so neither can be granted anything by the RBAC matrix — what a machine caller may do is
 * decided by the route or job it runs in, never by a group it holds.
 *
 * They are reference data, safe in production, and idempotent like everything else in the seed.
 *
 * Lives in its own module rather than inside `prisma/seed.ts` because that file calls `main()` at the
 * top level (it IS the `prisma db seed` entry point) and so cannot be imported by a test without
 * running a seed and calling `process.exit`. Everything here is pure or takes its client as an
 * argument, so `machine-users.test.ts` can prove the write shape against an in-memory table.
 */
import type { DbTx } from "../src/lib/db";

export type MachineUserSeed = { id: string; email: string; name: string };

/**
 * Ids are fixed and human-readable so an audit CSV reads plainly and so a migration or a fixture can
 * reference them. Emails match the constants in src/lib/audit.ts (INTEGRATION_ACTOR_EMAIL,
 * JOB_ACTOR_EMAIL) — changing one without the other breaks attribution, so keep them together.
 */
export const MACHINE_USER_SEED: readonly MachineUserSeed[] = [
  {
    id: "svc_integration",
    email: "integration@wm-helpdesk.local",
    name: "Integration (machine)",
  },
  {
    id: "svc_jobs",
    email: "jobs@wm-helpdesk.local",
    name: "Scheduled jobs (machine)",
  },
];

/**
 * The CREATE branch — the only place `isActive` may be set.
 *
 * A row that does not exist yet has no operator decision attached to it, so it is born enabled:
 * `getViewer()` and the sign-in hook refuse inactive rows, and these accounts are never signed in to
 * (no Okta identity, no password, no persona), so there is nothing to sign in AS — the row exists
 * purely to be pointed at.
 */
export function machineUserCreateData(u: MachineUserSeed) {
  return { id: u.id, email: u.email, name: u.name, groups: [], isActive: true, emailVerified: null };
}

/**
 * The UPDATE branch — deliberately WITHOUT `isActive`.
 *
 * `prisma db seed` runs on every deploy. Disabling `svc_integration` is the only lever there is for
 * closing the machine surface: `loadTarget` in src/server/users.actions.ts refuses to deactivate a
 * machine identity through the audited admin path, and `integrationActor` in src/lib/integration-auth.ts
 * reads `isActive` to fail that whole surface closed. If this branch forced `isActive: true`, the next
 * deployment would silently reverse that operator decision — no `USER_REACTIVATED` row, nothing in the
 * hash-chained ledger explaining why the integration bearer started working again. That is the one
 * thing the ledger exists to make impossible, and it is the same defect that was fixed in
 * `devPersonaProvider.authorize`.
 *
 * So a deliberate re-enable is an explicit, audited admin action, never a side effect of a deploy.
 *
 * `groups: []` IS on both branches, and that is not the same call: a group grant on a machine row is
 * never legitimate (the comment above says why), so a hand-edit that added one must not survive the
 * next seed. `isActive: false` is the opposite — a legitimate operator decision worth preserving.
 *
 * **Both machine surfaces now honour it.** `integrationActor` (src/lib/integration-auth.ts) reads
 * `isActive` and refuses an inactive row, closing ingest / export / outbox; since fix round 2
 * `jobActor` (src/jobs/run.ts) does the same, so the SLA sweep, the event alerts and the nightly
 * duplicate copy stop as well — each run throws, records `ok: false` on its `JOB_RUN` row and exits
 * non-zero, which shows in Cloud Run Jobs as a failed execution. Before that, `deactivatedMachineUserWarning`
 * printed "the matching machine surface stays closed" for `svc_jobs` and it was not true.
 * The corollary: the jobs actor row must be ACTIVE for a working deployment, and `JOB_ACTOR_EMAIL`
 * designates a machine identity in every sense — hidden from `/admin/users`, refused by
 * `deactivateUser` (`machineActorEmails` in src/lib/audit.ts is the one definition both sides use).
 */
export function machineUserUpdateData(u: MachineUserSeed) {
  return { email: u.email, name: u.name, groups: [] };
}

export type MachineUserSeedResult = {
  /** How many rows were upserted (always every row in `MACHINE_USER_SEED`). */
  upserted: number;
  /** Ids left deactivated by this run, in seed order — the machine surfaces that stay closed. */
  deactivated: readonly string[];
};

/**
 * Upserts both machine rows and reports which ones are sitting deactivated.
 *
 * The report is the point of the `select`: with the reactivation removed, a deploy no longer re-opens
 * a surface an operator closed, and the deploy log is then the only place that says so. Silence would
 * otherwise read as "the seed did its job" while ingest 401s.
 */
export async function seedMachineUsers(db: DbTx): Promise<MachineUserSeedResult> {
  const deactivated: string[] = [];
  let upserted = 0;
  for (const u of MACHINE_USER_SEED) {
    const row = await db.user.upsert({
      where: { id: u.id },
      create: machineUserCreateData(u),
      update: machineUserUpdateData(u),
      select: { id: true, isActive: true },
    });
    upserted++;
    if (!row.isActive) deactivated.push(row.id);
  }
  return { upserted, deactivated };
}

/**
 * The line the seed prints when a machine identity is deactivated — one line, ids only, no hint that
 * the seeder might fix it (it must not).
 */
export function deactivatedMachineUserWarning(deactivated: readonly string[]): string {
  const plural = deactivated.length === 1 ? "identity is" : "identities are";
  return (
    `machine ${plural} DEACTIVATED and left that way by this seed: ${deactivated.join(", ")} — ` +
    `the matching machine surface stays closed until an administrator re-enables it deliberately`
  );
}
