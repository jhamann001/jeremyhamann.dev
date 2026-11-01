/**
 * Staff-account reads — node, layer L4.
 *
 * The desk is not a user directory: Okta is. What this module answers is the one question Okta
 * cannot — "who here still holds open work, and is their account still live in the desk?" — which is
 * what an offboarding needs before `deactivateUser` runs.
 *
 * Rows carry staff directory data and counters only, never record content, so nothing here is a read
 * of client material (§e "What counts as a view") and no view row is written. The capability check is
 * still made, because `user:admin` is the narrowest grant in the app and I5 says the
 * server re-checks whatever the page already checked.
 */
import type { OktaGroup, RequestContext, UserRef, Viewer } from "@/types/domain";
import { OPEN_STATUSES } from "@/types/domain";
import { actorFromViewer, machineActorEmails, recordDenied } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { ForbiddenError } from "@/lib/errors";
import { canAdminUsers } from "@/lib/rbac";

/** One row of `/admin/users`. `openAssignments` is what a deactivation would hand back to the queue. */
export type StaffUserRow = UserRef & {
  groups: OktaGroup[];
  isActive: boolean;
  /** Tickets assigned to this user whose status is in OPEN_STATUSES (a CLOSED or RESOLVED ticket keeps its historical owner). */
  openAssignments: number;
};

export type StaffUserQuery = {
  /** Case-insensitive substring over name and email. Trimmed; empty means "no search". */
  search?: string;
  /** Unset means both. */
  isActive?: boolean;
};

/**
 * The seeded machine identities (`prisma/seed.ts` step 0). They are
 * real `User` rows so `AuditLog.actorId` stays a foreign key, but they are not people: they never
 * appear in the staff list, and `deactivateUser` / `reactivateUser` refuse them — deactivating the
 * integration row would break every machine write path with no signal beyond a 500.
 *
 * A deployment that points `JOB_ACTOR_EMAIL` at a differently named row makes THAT row the jobs
 * identity, so it is listed too: otherwise it would stay in `/admin/users` as an ordinary staff account
 * that `deactivateUser` would happily disable — and the jobs would keep running as it.
 *
 * `machineActorEmails` (`@/lib/audit`) is the single definition `src/jobs/run.ts` resolves the runtime
 * identity with, so the two lists cannot drift apart. It is pure, so `env` is read here, at the call
 * site, and the jobs runtime stays out of this page's server bundle.
 */
export const MACHINE_ACTOR_EMAILS: readonly string[] = machineActorEmails(env.JOB_ACTOR_EMAIL);

const STAFF_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
  groups: true,
  isActive: true,
} as const;

/**
 * Staff accounts, alphabetical by display name with email as the tiebreak — an offboarding starts
 * from a name, not from a recency ranking.
 *
 * `ctx` is a compatible extension to the contract signature: when the caller has a request context
 * the denial is recorded as `AUTHZ_DENIED` before the throw, exactly like `listMacros` (Decision
 * #29). Without it the throw still happens and the caller's own gate or `runAction` writes the row.
 */
export async function listStaffUsers(
  viewer: Viewer,
  query: StaffUserQuery,
  ctx?: RequestContext,
): Promise<StaffUserRow[]> {
  const what = "user:admin list";
  if (!canAdminUsers(viewer.groups)) {
    if (ctx) await recordDenied(actorFromViewer(viewer), ctx, what);
    throw new ForbiddenError(`Forbidden: ${what}`);
  }

  const search = query.search?.trim() ?? "";
  const rows = await prisma.user.findMany({
    where: {
      email: { notIn: [...MACHINE_ACTOR_EMAILS] },
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(search.length === 0
        ? {}
        : {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { email: { contains: search, mode: "insensitive" as const } },
            ],
          }),
    },
    select: STAFF_SELECT,
    orderBy: [{ name: "asc" }, { email: "asc" }],
  });
  if (rows.length === 0) return [];

  const counts = await prisma.ticket.groupBy({
    by: ["assigneeId"],
    where: { assigneeId: { in: rows.map((r) => r.id) }, status: { in: [...OPEN_STATUSES] } },
    _count: { _all: true },
  });
  const openByUser = new Map(counts.map((c) => [c.assigneeId, c._count._all] as const));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    image: r.image,
    groups: r.groups,
    isActive: r.isActive,
    openAssignments: openByUser.get(r.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * `setUserActiveSchema` lives in `src/server/validation.ts` with every other zod schema, so
 * `validation.test.ts` holds its `z.output` ↔ `SetUserActiveInput` parity assertion alongside the
 * rest. It is RE-EXPORTED here because CONTRACT §10 S8 pins it to this module's surface.
 */
export { setUserActiveSchema } from "@/server/validation";
