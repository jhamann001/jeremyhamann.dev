import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// listRowChanges seam (tkt-audit-row-change-ui). No DB: withUserScope is mocked
// so we exercise the fail-closed role gate, the filter/pagination SQL shape, the
// BigInt/Date coercion, and the `changed` jsonb pass-through. Follows the
// aum-freshness-route.test.ts / account-aum-route.test.ts vi.hoisted mock idiom.

const { scopeSpy } = vi.hoisted(() => ({ scopeSpy: vi.fn() }));

// Only @/lib/rls is mocked; @/lib/data/audit-log stays real so the shared
// canReadAudit gate is exercised for real.
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));

import { listRowChanges } from "@/lib/data/row-changes";

type Sql = Prisma.Sql;

// A fake tx whose $queryRaw returns the queued responses in call order
// (combined metadata → rows) and records
// each Sql argument for shape assertions.
function fakeTx(responses: unknown[]) {
  const calls: Sql[] = [];
  const queue = [...responses];
  const $queryRaw = vi.fn(async (sql: Sql) => {
    calls.push(sql);
    return queue.shift();
  });
  return { calls, $queryRaw, $executeRaw: vi.fn().mockResolvedValue(1) };
}

const OPS = { role: "OPERATIONS", email: "ops@example.com" };

const ROW = {
  id: 42n,
  at: new Date("2026-07-10T14:30:00Z"),
  actor_email: "ops@example.com",
  actor_role: "OPERATIONS",
  db_role: "app_rw",
  table_name: "deal",
  op: "UPDATE",
  row_pk: "DEAL-1",
  changed: { stage: { from: "POTENTIAL", to: "COMMITTED" } },
};

function wireOk(rows: unknown[], total: bigint, vocab?: {
  tables?: { table_name: string }[];
  ops?: { op: string }[];
  actors?: { actor_email: string | null }[];
}) {
  const tx = fakeTx([
    [{ total, snapshot: "a".repeat(32),
      tables: (vocab?.tables ?? [{ table_name: "deal" }, { table_name: "transfer" }]).map(row => row.table_name),
      ops: (vocab?.ops ?? [{ op: "INSERT" }, { op: "UPDATE" }, { op: "DELETE" }]).map(row => row.op),
      actors: (vocab?.actors ?? [{ actor_email: "ops@example.com" }]).map(row => row.actor_email).filter(value => value !== null),
    }],
    rows,
  ]);
  scopeSpy.mockImplementation(async (...args: unknown[]) => {
    const fn = args[1] as (tx: unknown) => Promise<unknown>;
    return fn(tx);
  });
  return tx;
}

describe("listRowChanges — fail-closed role gate", () => {
  beforeEach(() => {
    scopeSpy.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("non-ADMIN/OPS role → { ok: false, forbidden } and NEVER touches the DB", async () => {
    for (const role of ["VIEWER", "ADVISOR", "CLIENT_SERVICE", "HEAD_OF_ADVISORY", null]) {
      const r = await listRowChanges({ role, email: "x@y.com" });
      expect(r).toEqual({ ok: false, reason: "forbidden" });
    }
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("ADMIN and OPERATIONS are allowed through the gate", async () => {
    wireOk([], 0n);
    const admin = await listRowChanges({ role: "ADMIN", email: "a@y.com" });
    expect(admin.ok).toBe(true);
    wireOk([], 0n);
    const ops = await listRowChanges(OPS);
    expect(ops.ok).toBe(true);
  });
});

describe("listRowChanges — coercion & pass-through", () => {
  beforeEach(() => {
    scopeSpy.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("coerces BigInt id → string, Date at → ISO, passes `changed` through", async () => {
    wireOk([ROW], 1n);
    const r = await listRowChanges(OPS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]).toEqual({
      id: "42",
      at: "2026-07-10T14:30:00.000Z",
      actorEmail: "ops@example.com",
      actorRole: "OPERATIONS",
      dbRole: "app_rw",
      table: "deal",
      op: "UPDATE",
      rowPk: "DEAL-1",
      changed: { stage: { from: "POTENTIAL", to: "COMMITTED" } },
    });
  });

  it("guards a null / non-object `changed` into an empty object", async () => {
    wireOk([{ ...ROW, changed: null }, { ...ROW, id: 43n, changed: "nope" }], 2n);
    const r = await listRowChanges(OPS);
    if (!r.ok) throw new Error("expected ok");
    expect(r.rows[0].changed).toEqual({});
    expect(r.rows[1].changed).toEqual({});
  });

  it("maps DISTINCT vocab and drops null actors", async () => {
    wireOk([], 0n, {
      tables: [{ table_name: "deal" }, { table_name: "transfer" }],
      ops: [{ op: "DELETE" }, { op: "INSERT" }, { op: "UPDATE" }],
      actors: [{ actor_email: "a@y.com" }, { actor_email: null }, { actor_email: "b@y.com" }],
    });
    const r = await listRowChanges(OPS);
    if (!r.ok) throw new Error("expected ok");
    expect(r.tables).toEqual(["deal", "transfer"]);
    expect(r.ops).toEqual(["DELETE", "INSERT", "UPDATE"]);
    expect(r.actors).toEqual(["a@y.com", "b@y.com"]);
  });
});

describe("listRowChanges — pagination math", () => {
  beforeEach(() => {
    scopeSpy.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes pageCount from total and clamps a NaN/<1 page to 1", async () => {
    wireOk([ROW], 125n);
    const r = await listRowChanges(OPS, { page: 0 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(50);
    expect(r.pageCount).toBe(3); // ceil(125 / 50)
    expect(r.total).toBe(125);
  });

  it("threads LIMIT 50 and the correct OFFSET into the rows query", async () => {
    const tx = wireOk([ROW], 125n);
    await listRowChanges(OPS, { page: 3 });
    // calls[1] is the rows SELECT. Trailing bound values are LIMIT then OFFSET.
    const values = tx.calls[1].values;
    expect(values.slice(-2)).toEqual([50, 100]); // page 3 → offset (3-1)*50
    expect(tx.calls[1].text).toContain("LIMIT");
    expect(tx.calls[1].text).toContain("OFFSET");
    expect(tx.calls[1].text).toContain("ORDER BY at DESC, id DESC");
  });

  it("empty result still reports pageCount ≥ 1", async () => {
    wireOk([], 0n);
    const r = await listRowChanges(OPS);
    if (!r.ok) throw new Error("expected ok");
    expect(r.pageCount).toBe(1);
    expect(r.total).toBe(0);
  });
});

describe("listRowChanges — filter SQL shape", () => {
  beforeEach(() => {
    scopeSpy.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no filters → the WHERE binds NULL for every filter (no narrowing)", async () => {
    const tx = wireOk([ROW], 1n);
    await listRowChanges(OPS);
    // COUNT query is calls[0]; its bound values are the 3 filters × 2 each.
    const values = tx.calls[0].values;
    expect(values).toEqual([null, null, null, null, null, null]);
    expect(tx.calls).toHaveLength(2);
    expect(tx.calls[0].text.match(/FROM audit\.row_change/g)).toHaveLength(1);
    expect(tx.calls[0].text).toContain("GROUP BY table_name, op, actor_email");
  });

  it("table / op / actor filters bind their values and reference the columns", async () => {
    const tx = wireOk([ROW], 1n);
    await listRowChanges(OPS, { table: "deal", op: "UPDATE", actor: "ops@example.com" });
    const count = tx.calls[0];
    expect(count.text).toContain("table_name =");
    expect(count.text).toContain("op =");
    expect(count.text).toContain("actor_email =");
    expect(count.values).toEqual([
      "deal",
      "deal",
      "UPDATE",
      "UPDATE",
      "ops@example.com",
      "ops@example.com",
    ]);
  });

  it("trims blank filters back to NULL (treated as no filter)", async () => {
    const tx = wireOk([ROW], 1n);
    await listRowChanges(OPS, { table: "   ", op: "", actor: "  " });
    expect(tx.calls[0].values).toEqual([null, null, null, null, null, null]);
  });
});
