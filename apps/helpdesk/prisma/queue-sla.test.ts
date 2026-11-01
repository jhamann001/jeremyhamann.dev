/**
 * `prisma/queue-sla.ts` — steps 1 and 2 of the reference seed.
 *
 * The regression under test is the one the machine-user seeder was fixed for and the macro seeder was
 * fixed for: `prisma db seed` runs on EVERY deploy, so a seeder that UPSERTS reference data reverts
 * whatever an operator changed at runtime — here, the SLA numbers the CS lead sets at `/admin/sla`
 * (which audits every field it changes) and `Queue.autoAssign`. This file proves that a
 * second run issues no write at all against an existing row.
 *
 * `db.queue` / `db.sLA` are faked with in-memory tables that record every call, so the assertions can
 * be about the WRITES rather than only about the end state — "the row still has the right value" would
 * also pass if the seeder had written the same value back over an operator's change.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SLA_POLICIES, QUEUE_KEYS, TICKET_PRIORITIES } from "../src/types/domain";
import type { Db } from "../src/lib/db";
import { QUEUE_SEED, keptRowsNotice, queueCreateData, seedQueues, seedSla, slaCreateData } from "./queue-sla";

type QueueRow = { id: string; key: string; name: string; description: string; sortOrder: number; autoAssign: boolean };
type SlaRow = {
  priority: string;
  name: string;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  warningMinutes: number;
};
type Write = { table: "queue" | "sla"; op: "create" | "update" | "upsert"; key: string };

type Fake = { db: Db; queues: Map<string, QueueRow>; slas: Map<string, SlaRow>; writes: Write[] };

function makeDb(seed: { queues?: Partial<QueueRow>[]; slas?: Partial<SlaRow>[] } = {}): Fake {
  const queues = new Map<string, QueueRow>();
  const slas = new Map<string, SlaRow>();
  const writes: Write[] = [];

  for (const q of seed.queues ?? []) {
    const key = q.key ?? "";
    queues.set(key, {
      id: q.id ?? `q_${key}`,
      key,
      name: q.name ?? key,
      description: q.description ?? "",
      sortOrder: q.sortOrder ?? 99,
      autoAssign: q.autoAssign ?? false,
    });
  }
  for (const s of seed.slas ?? []) {
    const priority = s.priority ?? "";
    slas.set(priority, {
      priority,
      name: s.name ?? priority,
      firstResponseMinutes: s.firstResponseMinutes ?? 0,
      resolutionMinutes: s.resolutionMinutes ?? 0,
      warningMinutes: s.warningMinutes ?? 30,
    });
  }

  const db = {
    queue: {
      findUnique: async ({ where }: { where: { key: string } }) => queues.get(where.key) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const key = String(data.key);
        writes.push({ table: "queue", op: "create", key });
        const row: QueueRow = {
          id: `q_${key}`,
          key,
          name: String(data.name),
          description: String(data.description),
          sortOrder: Number(data.sortOrder),
          autoAssign: false,
        };
        queues.set(key, row);
        return row;
      },
      update: async ({ where }: { where: { key: string } }) => {
        writes.push({ table: "queue", op: "update", key: where.key });
        return queues.get(where.key);
      },
      upsert: async ({ where }: { where: { key: string } }) => {
        writes.push({ table: "queue", op: "upsert", key: where.key });
        return queues.get(where.key);
      },
    },
    sLA: {
      findUnique: async ({ where }: { where: { priority: string } }) => slas.get(where.priority) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const priority = String(data.priority);
        writes.push({ table: "sla", op: "create", key: priority });
        const row: SlaRow = {
          priority,
          name: String(data.name),
          firstResponseMinutes: Number(data.firstResponseMinutes),
          resolutionMinutes: Number(data.resolutionMinutes),
          warningMinutes: 30,
        };
        slas.set(priority, row);
        return row;
      },
      update: async ({ where }: { where: { priority: string } }) => {
        writes.push({ table: "sla", op: "update", key: where.priority });
        return slas.get(where.priority);
      },
      upsert: async ({ where }: { where: { priority: string } }) => {
        writes.push({ table: "sla", op: "upsert", key: where.priority });
        return slas.get(where.priority);
      },
    },
  } as unknown as Db;

  return { db, queues, slas, writes };
}

describe("QUEUE_SEED", () => {
  it("covers every QueueKey exactly once, in a stable order", () => {
    expect(QUEUE_SEED.map((q) => q.key)).toEqual([...QUEUE_KEYS]);
    expect(new Set(QUEUE_SEED.map((q) => q.sortOrder)).size).toBe(QUEUE_SEED.length);
  });
});

describe("the CREATE branches", () => {
  it("a new queue never carries autoAssign — it takes the column default (Decision #98)", () => {
    for (const q of QUEUE_SEED) expect(Object.keys(queueCreateData(q))).toEqual(["key", "name", "description", "sortOrder"]);
  });

  it("a new SLA policy never carries warningMinutes — it takes the column default (Decision #99)", () => {
    for (const p of TICKET_PRIORITIES) {
      expect(Object.keys(slaCreateData(p))).toEqual(["priority", "name", "firstResponseMinutes", "resolutionMinutes"]);
      expect(slaCreateData(p).firstResponseMinutes).toBe(DEFAULT_SLA_POLICIES[p].firstResponseMinutes);
    }
  });
});

describe("seedQueues", () => {
  it("creates all three on an empty database and returns their ids", async () => {
    const fake = makeDb();
    const result = await seedQueues(fake.db);
    expect(result.created).toBe(3);
    expect(result.kept).toEqual([]);
    for (const key of QUEUE_KEYS) expect(result.ids[key]).toBeTruthy();
    expect(fake.writes.every((w) => w.op === "create")).toBe(true);
  });

  it("writes NOTHING on a second run — no update, no upsert", async () => {
    const fake = makeDb();
    await seedQueues(fake.db);
    fake.writes.length = 0;

    const second = await seedQueues(fake.db);
    expect(second.created).toBe(0);
    expect(second.kept).toEqual([...QUEUE_KEYS]);
    expect(fake.writes).toEqual([]);
  });

  it("leaves an operator's autoAssign flag and a renamed queue alone", async () => {
    const fake = makeDb({
      queues: [
        { key: "OPERATIONS", name: "Ops desk (renamed)", autoAssign: true, sortOrder: 5 },
        { key: "CLIENT_SERVICE" },
        { key: "ADVICE" },
      ],
    });
    await seedQueues(fake.db);
    expect(fake.writes).toEqual([]);
    expect(fake.queues.get("OPERATIONS")?.autoAssign).toBe(true);
    expect(fake.queues.get("OPERATIONS")?.name).toBe("Ops desk (renamed)");
  });

  it("fills a gap without touching the rows that are already there", async () => {
    const fake = makeDb({ queues: [{ key: "OPERATIONS" }] });
    const result = await seedQueues(fake.db);
    expect(result.created).toBe(2);
    expect(result.kept).toEqual(["OPERATIONS"]);
    expect(fake.writes.map((w) => w.key)).toEqual(["CLIENT_SERVICE", "ADVICE"]);
  });
});

describe("seedSla", () => {
  it("creates one policy per priority on an empty database", async () => {
    const fake = makeDb();
    const result = await seedSla(fake.db);
    expect(result.created).toBe(TICKET_PRIORITIES.length);
    expect(fake.slas.size).toBe(TICKET_PRIORITIES.length);
  });

  it("never writes back over numbers edited at /admin/sla", async () => {
    // The regression: the CS lead sets URGENT's first response to 10 minutes, audited, and the next
    // deploy silently restores 15 with nothing in the ledger to explain it.
    const fake = makeDb({
      slas: TICKET_PRIORITIES.map((p) => ({
        priority: p,
        firstResponseMinutes: 10,
        resolutionMinutes: 20,
        warningMinutes: 5,
      })),
    });
    const result = await seedSla(fake.db);
    expect(result.created).toBe(0);
    expect(result.kept).toEqual([...TICKET_PRIORITIES]);
    expect(fake.writes).toEqual([]);
    expect(fake.slas.get("URGENT")?.firstResponseMinutes).toBe(10);
    expect(fake.slas.get("URGENT")?.warningMinutes).toBe(5);
  });
});

describe("keptRowsNotice", () => {
  it("names what it left alone, and points at the audited way to change it", () => {
    const notice = keptRowsNotice("sla policies", ["URGENT", "HIGH"]);
    expect(notice).toContain("URGENT, HIGH");
    expect(notice).toContain("/admin/sla");
    expect(notice).toContain("create-if-missing");
  });

  it("is silent on a fresh database", () => {
    expect(keptRowsNotice("queues", [])).toBeNull();
  });
});
