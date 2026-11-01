/**
 * `prisma/machine-users.ts` — step 0 of the reference seed.
 *
 * The regression under test: `seedMachineUsers` used to force `isActive: true` on the UPDATE branch.
 * `prisma db seed` runs on deploy, so an administrator who disabled `svc_integration` — the only lever
 * that closes the machine surface, since `loadTarget` (src/server/users.actions.ts) refuses to
 * deactivate a machine identity through the audited path — had that decision reverted by the next
 * deployment, with no `USER_REACTIVATED` row and nothing in the hash-chained ledger explaining why the
 * integration bearer started working again. Same defect as the dev-persona provider, second location.
 *
 * `db.user.upsert` is faked with an in-memory table that applies EXACTLY the fields a write names, so a
 * column the write omits keeps its stored value — which is the whole point. Every write is recorded so
 * the assertions can be about the write shape, not just the end state.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/lib/db";
import {
  MACHINE_USER_SEED,
  deactivatedMachineUserWarning,
  machineUserCreateData,
  machineUserUpdateData,
  seedMachineUsers,
} from "./machine-users";

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  groups: string[];
  isActive: boolean;
  emailVerified: Date | null;
};

type UpsertArgs = {
  where: { id: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
  select?: Record<string, boolean>;
};

type WriteRecord = { op: "create" | "update"; id: string; data: Record<string, unknown> };

type Fake = { db: Db; rows: Map<string, UserRow>; writes: WriteRecord[] };

function makeDb(seeded: readonly Partial<UserRow>[] = []): Fake {
  const rows = new Map<string, UserRow>();
  for (const r of seeded) {
    const id = r.id ?? "";
    rows.set(id, {
      id,
      email: r.email ?? `${id}@wm-helpdesk.local`,
      name: r.name ?? id,
      groups: r.groups ? [...r.groups] : [],
      isActive: r.isActive ?? true,
      emailVerified: r.emailVerified ?? null,
    });
  }
  const writes: WriteRecord[] = [];

  const db = {
    user: {
      upsert: async (args: UpsertArgs) => {
        const id = args.where.id;
        const existing = rows.get(id);
        if (existing) {
          writes.push({ op: "update", id, data: args.update });
          // Apply ONLY the named fields, as Postgres does: an omitted column keeps its stored value.
          Object.assign(existing, args.update);
          return project(existing, args.select);
        }
        writes.push({ op: "create", id, data: args.create });
        const created = { ...(args.create as unknown as UserRow) };
        rows.set(id, created);
        return project(created, args.select);
      },
    },
  } as unknown as Db;

  return { db, rows, writes };
}

function project(row: UserRow, select?: Record<string, boolean>): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [k, on] of Object.entries(select)) {
    if (on) out[k] = (row as unknown as Record<string, unknown>)[k];
  }
  return out;
}

describe("MACHINE_USER_SEED", () => {
  it("holds exactly the two Wave A machine identities, with fixed ids", () => {
    expect(MACHINE_USER_SEED.map((u) => u.id)).toEqual(["svc_integration", "svc_jobs"]);
  });

  it("keeps the emails in step with src/lib/audit.ts, which is what resolves the actor rows", () => {
    // Read as text rather than imported: `@/lib/audit` pulls `@/lib/env`, which this unit test has no
    // business booting. A drift here silently breaks attribution, so it is still worth asserting.
    const auditSrc = readFileSync(fileURLToPath(new URL("../src/lib/audit.ts", import.meta.url)), "utf8");
    const integration = /INTEGRATION_ACTOR_EMAIL\s*=\s*"([^"]+)"/.exec(auditSrc)?.[1];
    const job = /JOB_ACTOR_EMAIL\s*=\s*"([^"]+)"/.exec(auditSrc)?.[1];
    expect(integration).toBe(MACHINE_USER_SEED[0].email);
    expect(job).toBe(MACHINE_USER_SEED[1].email);
  });
});

describe("machineUserCreateData / machineUserUpdateData", () => {
  const u = MACHINE_USER_SEED[0];

  it("creates an enabled row with zero groups and no verified email", () => {
    expect(machineUserCreateData(u)).toEqual({
      id: "svc_integration",
      email: u.email,
      name: u.name,
      groups: [],
      isActive: true,
      emailVerified: null,
    });
  });

  it("NEVER names isActive on the update branch — a deploy may not re-enable a disabled identity", () => {
    const update = machineUserUpdateData(u);
    expect(Object.keys(update).sort()).toEqual(["email", "groups", "name"]);
    expect("isActive" in update).toBe(false);
  });

  it("still resets groups on the update branch — a grant on a machine row is never legitimate", () => {
    expect(machineUserUpdateData(u).groups).toEqual([]);
  });
});

describe("seedMachineUsers", () => {
  it("creates both rows on an empty database, enabled", async () => {
    const f = makeDb();
    const result = await seedMachineUsers(f.db);

    expect(result.upserted).toBe(2);
    expect(result.deactivated).toEqual([]);
    expect(f.writes.map((w) => w.op)).toEqual(["create", "create"]);
    expect([...f.rows.values()].every((r) => r.isActive)).toBe(true);
    expect([...f.rows.values()].every((r) => r.groups.length === 0)).toBe(true);
  });

  it("leaves a deactivated machine identity deactivated (the regression)", async () => {
    const f = makeDb([{ id: "svc_integration", isActive: false }, { id: "svc_jobs", isActive: true }]);

    const result = await seedMachineUsers(f.db);

    expect(f.rows.get("svc_integration")?.isActive).toBe(false);
    expect(result.deactivated).toEqual(["svc_integration"]);
  });

  it("issues no write that names isActive when the rows already exist", async () => {
    const f = makeDb([{ id: "svc_integration", isActive: false }, { id: "svc_jobs", isActive: false }]);

    await seedMachineUsers(f.db);

    expect(f.writes).toHaveLength(2);
    for (const w of f.writes) {
      expect(w.op).toBe("update");
      expect(Object.keys(w.data)).not.toContain("isActive");
    }
  });

  it("reports every deactivated identity, in seed order", async () => {
    const f = makeDb([{ id: "svc_integration", isActive: false }, { id: "svc_jobs", isActive: false }]);

    const result = await seedMachineUsers(f.db);

    expect(result.deactivated).toEqual(["svc_integration", "svc_jobs"]);
  });

  it("repairs a hand-added group grant while preserving the deactivation", async () => {
    const f = makeDb([{ id: "svc_integration", isActive: false, groups: ["ops_team"] }]);

    await seedMachineUsers(f.db);

    const row = f.rows.get("svc_integration");
    expect(row?.groups).toEqual([]);
    expect(row?.isActive).toBe(false);
  });

  it("refreshes a drifted email and name on the existing row", async () => {
    const f = makeDb([{ id: "svc_jobs", email: "stale@example.invalid", name: "Stale" }]);

    await seedMachineUsers(f.db);

    expect(f.rows.get("svc_jobs")?.email).toBe("jobs@wm-helpdesk.local");
    expect(f.rows.get("svc_jobs")?.name).toBe("Scheduled jobs (machine)");
  });

  it("is idempotent: a second run changes no stored value", async () => {
    const f = makeDb();
    await seedMachineUsers(f.db);
    const after1 = JSON.stringify([...f.rows.values()]);

    const result = await seedMachineUsers(f.db);

    expect(JSON.stringify([...f.rows.values()])).toBe(after1);
    expect(result.upserted).toBe(2);
    expect(result.deactivated).toEqual([]);
  });
});

describe("deactivatedMachineUserWarning", () => {
  it("names the ids and says the surface stays closed", () => {
    const line = deactivatedMachineUserWarning(["svc_integration"]);
    expect(line).toContain("svc_integration");
    expect(line).toContain("identity is DEACTIVATED");
    expect(line).toContain("stays closed");
  });

  it("reads correctly for more than one id", () => {
    const line = deactivatedMachineUserWarning(["svc_integration", "svc_jobs"]);
    expect(line).toContain("identities are DEACTIVATED");
    expect(line).toContain("svc_integration, svc_jobs");
  });
});
