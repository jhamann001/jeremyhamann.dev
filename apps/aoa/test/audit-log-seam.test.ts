import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// listAuditLog seam (tkt-audit-events-ingest-rollup). No DB: withUserScope is
// mocked so we exercise the fail-closed role gate, the ingest ROLLUP query shape
// (UNION of individual non-ingest events + one aggregated row per ingest
// action+day, dry-runs excluded), the pagination/COUNT over the COLLAPSED set,
// and the BigInt/Date coercion + row mapping. Follows the row-changes-seam.test.ts
// vi.hoisted mock idiom. The actual SQL AGGREGATION (SUM/GROUP BY/dry-run
// filtering) runs against real Postgres 16 — proven in the isolated-DB
// screenshots — because CI (npm run test) has no database; here we assert the
// query TEXT encodes those rules and that pre-aggregated raw rows map correctly.

const { scopeSpy } = vi.hoisted(() => ({ scopeSpy: vi.fn() }));

// Only @/lib/rls is mocked; the seam itself stays real.
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));

import { listAuditLog } from "@/lib/data/audit-log";

type Sql = Prisma.Sql;

// A fake tx whose $queryRaw returns queued responses in call order
// (COUNT → rows → DISTINCT actions → DISTINCT actors) and records each Sql
// argument for shape assertions.
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

// A raw EVENT row as the seam's union arm A yields it (non-ingest, run_count 1).
const EVENT_RAW = {
  kind: "event" as const,
  row_key: "123",
  at: new Date("2026-07-10T14:30:00Z"),
  actorEmail: "ops@example.com",
  actorRole: "OPERATIONS",
  action: "deal.stage_change",
  entityType: "deal",
  entityId: "DEAL-1",
  detail: JSON.stringify({ from: "POTENTIAL", to: "COMMITTED" }),
  run_count: 1n,
  upserted: 0n,
  rejected: 0n,
  source_as_of_max: null,
};

// A raw INGEST-DAY row as union arm B yields it (already aggregated by Postgres:
// synthetic key, service actor, summed counts, run count).
const INGEST_DAY_RAW = {
  kind: "ingest_day" as const,
  row_key: "ingest:ingest.deals:2026-07-10",
  at: new Date("2026-07-10T09:15:00Z"),
  actorEmail: null,
  actorRole: "INGEST",
  action: "ingest.deals",
  entityType: "ingest_run",
  entityId: null,
  detail: null,
  run_count: 3n,
  upserted: 1240n,
  rejected: 2n,
  source_as_of_max: "2026-07-09",
};

function wireOk(
  rows: unknown[],
  total: bigint,
  vocab?: { actions?: { action: string }[]; actors?: { actorEmail: string | null }[] },
) {
  const tx = fakeTx([
    [{ total, snapshot: "a".repeat(32) }],
    rows,
    vocab?.actions ?? [{ action: "deal.create" }, { action: "ingest.deals" }],
    vocab?.actors ?? [{ actorEmail: "ops@example.com" }],
  ]);
  scopeSpy.mockImplementation(async (...args: unknown[]) => {
    const fn = args[1] as (tx: unknown) => Promise<unknown>;
    return fn(tx);
  });
  return tx;
}

describe("listAuditLog — fail-closed role gate", () => {
  beforeEach(() => { scopeSpy.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("non-ADMIN/OPS role → { ok: false, forbidden } and NEVER touches the DB", async () => {
    for (const role of ["VIEWER", "ADVISOR", "CLIENT_SERVICE", "HEAD_OF_ADVISORY", null]) {
      const r = await listAuditLog({ role, email: "x@y.com" });
      expect(r).toEqual({ ok: false, reason: "forbidden" });
    }
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("ADMIN and OPERATIONS pass the gate", async () => {
    wireOk([], 0n);
    expect((await listAuditLog({ role: "ADMIN", email: "a@y.com" })).ok).toBe(true);
    wireOk([], 0n);
    expect((await listAuditLog(OPS)).ok).toBe(true);
  });
});

describe("listAuditLog — rollup query shape", () => {
  beforeEach(() => { scopeSpy.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("rows query UNIONs individual non-ingest events with per-day ingest aggregates", async () => {
    const tx = wireOk([EVENT_RAW], 1n);
    await listAuditLog(OPS);
    const rowsSql = tx.calls[1].text;
    // Two arms: individual non-ingest events + aggregated ingest days.
    expect(rowsSql).toContain("UNION ALL");
    expect(rowsSql).toContain("action NOT LIKE"); // arm A: non-ingest pass-through
    expect(rowsSql).toContain("action LIKE"); // arm B: ingest only
    expect(rowsSql).toContain("GROUP BY action"); // collapse per action + day
    // Summed counts + run count feed the summary row.
    expect(rowsSql).toContain("SUM");
    expect(rowsSql).toContain("COUNT(*)");
    expect(rowsSql).toContain("'upserted'");
    expect(rowsSql).toContain("'rejected'");
    expect(rowsSql).toContain("'as_of_max'");
    expect(rowsSql).toContain("source_as_of_max");
  });

  it("excludes dry-run ingest rows and guards every jsonb access", async () => {
    const tx = wireOk([EVENT_RAW], 1n);
    await listAuditLog(OPS);
    const rowsSql = tx.calls[1].text;
    expect(rowsSql).toContain("'dry_run'");
    expect(rowsSql).toContain("NOT ("); // WHERE ... AND NOT (dry_run case)
    // 1. Non-JSON detail can never abort the query — the jsonb cast is gated.
    expect(rowsSql).toContain("pg_input_is_valid");
    // 2. dry_run is a case-insensitive string compare, not a ::boolean cast, so a
    //    wrong-typed value can't throw; a missing key COALESCEs to false (included).
    expect(rowsSql).toContain("lower(detail::jsonb ->> 'dry_run') = 'true'");
    expect(rowsSql).not.toContain("'dry_run')::boolean");
    // 3. Numeric counts are only cast to int when the extracted text is all-digits,
    //    so a well-formed-but-non-integer value degrades to 0 rather than aborting.
    expect(rowsSql).toContain("~ '^[0-9]+$'");
    expect(rowsSql).not.toContain("'upserted')::int, 0"); // old un-guarded COALESCE(...::int,0) form
    // Source dates are likewise read only inside the JSON-validity CASE and
    // reduced to a timezone-safe YYYY-MM-DD value.
    expect(rowsSql).toContain("left(detail::jsonb ->> 'as_of_max', 10)");
  });

  it("binds the ingest prefix 'ingest.%' in both union arms", async () => {
    const tx = wireOk([EVENT_RAW], 1n);
    await listAuditLog(OPS);
    // Unfiltered rows query: the LIKE literal appears once per arm, filters bind NULL.
    expect(tx.calls[1].values).toEqual([
      "ingest.%", null, null, null, null, // arm A: LIKE + (action,action,actor,actor)
      "ingest.%", null, null, null, null, // arm B: LIKE + (action,action,actor,actor)
      50, 0, // LIMIT, OFFSET (page 1)
    ]);
  });

  it("counts displayed event/day grain while versioning the underlying append-only population", async () => {
    const tx = wireOk([EVENT_RAW], 7n);
    await listAuditLog(OPS);
    const countSql = tx.calls[0].text;
    expect(countSql).toContain("COUNT(*)");
    expect(countSql).toContain("COUNT(DISTINCT (action, (at AT TIME ZONE 'UTC')::date))");
    expect(countSql).toContain("MAX(id)");
    expect(countSql).toContain("'dry_run'");
    expect(countSql).not.toContain("to_jsonb");
    expect(countSql).not.toContain("string_agg");
    expect(countSql).not.toContain("LIMIT");
    expect(tx.calls[0].values).toEqual([
      "ingest.%", "ingest.%", "ingest.%", null, null, null, null,
    ]);
  });

  it("threads LIMIT 50 and the correct OFFSET; orders newest-first with sort_id tiebreak", async () => {
    const tx = wireOk([EVENT_RAW], 300n);
    await listAuditLog(OPS, { page: 3 });
    const rowsSql = tx.calls[1];
    expect(rowsSql.values.slice(-2)).toEqual([50, 100]); // page 3 → offset (3-1)*50
    expect(rowsSql.text).toContain("ORDER BY at DESC, sort_id DESC");
  });

  it("action / actor filters bind their values into both arms", async () => {
    const tx = wireOk([EVENT_RAW], 1n);
    await listAuditLog(OPS, { action: "ingest.deals", actor: "ops@example.com" });
    const a = "ingest.deals";
    const e = "ops@example.com";
    expect(tx.calls[1].values).toEqual([
      "ingest.%", a, a, e, e,
      "ingest.%", a, a, e, e,
      50, 0,
    ]);
  });

  it("trims blank filters back to NULL", async () => {
    const tx = wireOk([EVENT_RAW], 1n);
    await listAuditLog(OPS, { action: "   ", actor: "" });
    expect(tx.calls[0].values).toEqual([
      "ingest.%", "ingest.%", "ingest.%", null, null, null, null,
    ]);
  });
});

describe("listAuditLog — row mapping & coercion", () => {
  beforeEach(() => { scopeSpy.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("maps an individual non-ingest event through unchanged (kind=event, counts 0)", async () => {
    wireOk([EVENT_RAW], 1n);
    const r = await listAuditLog(OPS);
    if (!r.ok) throw new Error("expected ok");
    expect(r.rows[0]).toEqual({
      id: "123",
      at: "2026-07-10T14:30:00.000Z",
      actorEmail: "ops@example.com",
      actorRole: "OPERATIONS",
      action: "deal.stage_change",
      entityType: "deal",
      entityId: "DEAL-1",
      detail: JSON.stringify({ from: "POTENTIAL", to: "COMMITTED" }),
      kind: "event",
      runCount: 1,
      upserted: 0,
      rejected: 0,
      sourceAsOfMax: null,
    });
  });

  it("maps an aggregated ingest-day row (synthetic key, summed counts, run count)", async () => {
    wireOk([INGEST_DAY_RAW], 1n);
    const r = await listAuditLog(OPS);
    if (!r.ok) throw new Error("expected ok");
    expect(r.rows[0]).toEqual({
      id: "ingest:ingest.deals:2026-07-10", // synthetic per (action, day) key
      at: "2026-07-10T09:15:00.000Z", // MAX(at) that day
      actorEmail: null, // uniform service identity
      actorRole: "INGEST",
      action: "ingest.deals",
      entityType: "ingest_run",
      entityId: null,
      detail: null,
      kind: "ingest_day",
      runCount: 3, // COUNT(*) of the day's runs, BigInt → number
      upserted: 1240, // SUM(detail.upserted), BigInt → number
      rejected: 2,
      sourceAsOfMax: "2026-07-09",
    });
  });

  it("passes malformed / null event detail straight through without throwing", async () => {
    wireOk(
      [
        { ...EVENT_RAW, row_key: "9", detail: "{not valid json" },
        { ...EVENT_RAW, row_key: "10", detail: null },
      ],
      2n,
    );
    const r = await listAuditLog(OPS);
    if (!r.ok) throw new Error("expected ok");
    expect(r.rows[0].detail).toBe("{not valid json");
    expect(r.rows[1].detail).toBeNull();
  });

  it("keeps a mix in order and reports the collapsed total", async () => {
    wireOk([INGEST_DAY_RAW, EVENT_RAW], 2n);
    const r = await listAuditLog(OPS);
    if (!r.ok) throw new Error("expected ok");
    expect(r.rows.map((x) => x.kind)).toEqual(["ingest_day", "event"]);
    expect(r.total).toBe(2);
  });
});

describe("listAuditLog — pagination math & vocab", () => {
  beforeEach(() => { scopeSpy.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("computes pageCount from the collapsed total and clamps a NaN/<1 page to 1", async () => {
    wireOk([EVENT_RAW], 125n);
    const r = await listAuditLog(OPS, { page: 0 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(50);
    expect(r.pageCount).toBe(3); // ceil(125 / 50)
    expect(r.total).toBe(125);
  });

  it("empty result still reports pageCount ≥ 1", async () => {
    wireOk([], 0n);
    const r = await listAuditLog(OPS);
    if (!r.ok) throw new Error("expected ok");
    expect(r.pageCount).toBe(1);
    expect(r.total).toBe(0);
  });

  it("maps DISTINCT action/actor vocab and drops null actors", async () => {
    wireOk([], 0n, {
      actions: [{ action: "deal.create" }, { action: "ingest.deals" }],
      actors: [{ actorEmail: "a@y.com" }, { actorEmail: null }, { actorEmail: "b@y.com" }],
    });
    const r = await listAuditLog(OPS);
    if (!r.ok) throw new Error("expected ok");
    expect(r.actions).toEqual(["deal.create", "ingest.deals"]);
    expect(r.actors).toEqual(["a@y.com", "b@y.com"]);
  });
});
