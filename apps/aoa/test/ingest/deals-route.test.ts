import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "../../app/api/ingest/deals/route";
import * as scope from "../../lib/ingest/scope";
import { mergeStage } from "../../lib/ingest/deal-merge";
import type { StageHistoryEntry } from "../../lib/data/deal-types";

// Pure (no-DB) deals-route cases. Mirrors activity-route.test.ts — same auth,
// envelope, cap, verb, and tx-failure coverage — plus dryRun / happy-path /
// rejected assertions AND explicit stage-MERGE-RULE coverage (route-level via a
// stubbed existing-stage map, and the pure `mergeStage` helper directly), via a
// fake withIngestScope tx (no DB). ALL fixture data is INVENTED (PII rule).
const TOKEN = "test-d2-secret-token";

function post(body: unknown, opts: { auth?: string; url?: string; raw?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/ingest/deals", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

// A RAW CRM report row — an object keyed by the report's CSV column
// headers, exactly as n8n's extractFromFile (headerRow:true) emits (values are
// strings). Header strings are the canonical REPORT_HEADERS aliases from
// lib/deals/import-csv.ts. The endpoint MAPS this → DealInput via the shared
// importer (source=IMPORT, stage label → enum key, "$"/comma amounts coerced)
// before validating. Stage carries the real feed's DISPLAY label ("Potential"
// / "Funded" / "Lost"). All fixture data is INVENTED (PII rule).
function row(over: Record<string, unknown> = {}) {
  return {
    "Deal: ID": "SF-DEAL-1",
    "Deal: Deal Name": "Sample Client - Fidelity - Roth IRA - 1234",
    "Person: First Name": "Sample",
    "Person: Last Name": "Client",
    AUM: "100000",
    "AoA - New Stage": "Potential",
    "Deal: Created Date": "2026-01-01",
    ...over,
  };
}

type ExistingRow = { sf_deal_id: string; stage: string; stage_history: unknown };

// Fake withIngestScope: a tx whose deal.findMany returns the seeded existing
// rows and deal.upsert / auditLog.create succeed, so the DB-free paths exercise
// the real handler merge + counting logic.
function stubScope(existing: ExistingRow[] = []) {
  const findMany = vi.fn(async () => existing);
  const upsert = vi.fn(async (_args: unknown) => ({}));
  const create = vi.fn(async () => undefined);
  const spy = vi.spyOn(scope, "withIngestScope").mockImplementation(async (fn) => {
    const tx = {
      deal: { findMany, upsert },
      auditLog: { create },
    } as unknown as Parameters<typeof fn>[0];
    return fn(tx);
  });
  return { findMany, upsert, create, spy };
}

describe("POST /api/ingest/deals — pure (no DB)", () => {
  const original = process.env.INGEST_TOKEN;
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "warn").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => logs.push(a.join(" ")));
    process.env.INGEST_TOKEN = TOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = original;
  });

  it("A1: token unset → 401 unauthorized + config warn", async () => {
    delete process.env.INGEST_TOKEN;
    const res = await route.POST(post({ source: "s", run_id: "RUN-A1", items: [] }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(logs.some((l) => l.includes("INGEST_TOKEN not configured"))).toBe(true);
  });

  it("A2: no Authorization header → 401, no config log", async () => {
    const res = await route.POST(post({ source: "s", run_id: "r", items: [] }, { auth: undefined }));
    expect(res.status).toBe(401);
    expect(logs.some((l) => l.includes("not configured"))).toBe(false);
  });

  it("A3: wrong bearer → 401", async () => {
    const res = await route.POST(post({ source: "s", run_id: "r", items: [] }, { auth: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("E1: malformed JSON → 400 bad_request", async () => {
    const res = await route.POST(post(null, { raw: "{" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("E2: envelope not {source,run_id,items[]} → 400", async () => {
    const res = await route.POST(post({ source: 1, run_id: "r" }));
    expect(res.status).toBe(400);
  });

  it("C1: >5000 items → 413 too_large (before per-item work)", async () => {
    const items = new Array(5001).fill(row());
    const res = await route.POST(post({ source: "s", run_id: "r", items }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
  });

  it("M1: non-POST verbs → 405 method_not_allowed on every verb", async () => {
    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const res = verb();
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("H1: happy path → 200 upserted count = accepted items; one upsert per item", async () => {
    const { findMany, upsert, create, spy } = stubScope([]);
    const items = [
      row({ "Deal: ID": "SF-1" }),
      row({ "Deal: ID": "SF-2" }),
    ];
    const res = await route.POST(post({ source: "crm", run_id: "RUN-H1", items }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ upserted: 2, rejected: [], run_id: "RUN-H1" });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("H2: non-string JSON cells (numeric AUM + boolean columns) ingest fine", async () => {
    // n8n's extractFromFile can emit JSON numbers/booleans, not just strings.
    // reportRecordFromObject's String() coercion must let such a row through:
    // it upserts like any other (the coercion is the capability this change
    // exists for). The mapped values themselves are asserted in the mapper unit
    // test; here we only prove the route accepts the row end-to-end.
    const { upsert, spy } = stubScope([]);
    const res = await route.POST(
      post({
        source: "crm",
        run_id: "RUN-H2",
        items: [
          row({
            "Deal: ID": "SF-NUM",
            AUM: 100000,
            Statements: false,
            "Plaid Linked": true,
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ upserted: 1, rejected: [], run_id: "RUN-H2" });
    expect(upsert).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("R1: mixed validity → invalid items rejected, valid upserted", async () => {
    const { upsert, spy } = stubScope([]);
    const items = [
      row({ "Deal: ID": "SF-OK" }), // 0 valid
      42, // 1 item_malformed (not an object)
      row({ "Deal: ID": "SF-BAD", AUM: "-1" }), // 2 deal_invalid (negative amount)
    ];
    const res = await route.POST(post({ source: "s", run_id: "RUN-R1", items }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toBe(1);
    expect(body.rejected).toEqual([
      { index: 1, reason: "item_malformed" },
      { index: 2, reason: "deal_invalid" },
    ]);
    expect(upsert).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("R2: report row missing the deal-id column → item_malformed (upsert key mandatory), not upserted", async () => {
    // The deal-id column ("Deal: ID") is the MANDATORY upsert key. A row that
    // omits it maps to sf_deal_id=null and must be a clean per-item rejection,
    // never a tx.deal.upsert({where:{ sf_deal_id: undefined }}) that 500s the
    // whole batch. Guarded independently of validateDealInput's source rule.
    const Bartell = row();
    delete (Bartell as Record<string, unknown>)["Deal: ID"];
    const { findMany, upsert, spy } = stubScope([]);
    const res = await route.POST(
      post({ source: "s", run_id: "RUN-R2", items: [Bartell] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toBe(0);
    expect(body.rejected).toEqual([{ index: 0, reason: "item_malformed" }]);
    // No ok items → the id set is empty → the route skips the read AND the
    // upsert; only the counts-only audit row is written.
    expect(findMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("D1: dryRun → would_upsert count, NO read + NO upsert, audit-only", async () => {
    const { findMany, upsert, create, spy } = stubScope([]);
    const res = await route.POST(
      post(
        { source: "s", run_id: "RUN-D1", items: [row()] },
        { url: "https://x/api/ingest/deals?dryRun=1" },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ would_upsert: 1, rejected: [], run_id: "RUN-D1" });
    expect(findMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("T1: tx failure → 500 internal, PII-free error line, no data leaked", async () => {
    const create = vi.fn(async () => undefined);
    const upsert = vi.fn(async () => {
      throw new Error("boom");
    });
    const findMany = vi.fn(async () => []);
    const spy = vi.spyOn(scope, "withIngestScope").mockImplementation(async (fn) => {
      const tx = {
        deal: { findMany, upsert },
        auditLog: { create },
      } as unknown as Parameters<typeof fn>[0];
      return fn(tx);
    });

    const res = await route.POST(
      post({ source: "s", run_id: "RUN-T1", items: [row()] }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(create).not.toHaveBeenCalled(); // threw before writeAudit
    const errLine = logs.find((l) => l.includes("tx_failed"));
    expect(errLine).toBeTruthy();
    expect(errLine).toContain("RUN-T1");
    expect(errLine).not.toContain("Sample Client"); // PII-free
    spy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // MERGE RULE — route-level (stubbed existing-stage map). Assert what the
  // single upsert call writes: update.stage (effective) + whether stage_history
  // is appended (only on a real change / insert).
  // -------------------------------------------------------------------------
  type UpsertBranch = {
    stage?: string;
    stage_history?: StageHistoryEntry[];
  } & Record<string, unknown>;

  // `incomingLabel` is the report's DISPLAY label ("Potential"/"Funded"/"Lost")
  // — the shared importer maps it to the enum key before the merge runs.
  async function runOne(
    existing: ExistingRow[],
    incomingLabel: string,
  ): Promise<{ create: UpsertBranch; update: UpsertBranch }> {
    const { upsert, spy } = stubScope(existing);
    const res = await route.POST(
      post({
        source: "crm",
        run_id: "RUN-MERGE",
        items: [row({ "Deal: ID": "SF-1", "AoA - New Stage": incomingLabel })],
      }),
    );
    expect(res.status).toBe(200);
    const args = (upsert.mock.calls[0] as unknown[])[0] as {
      create: UpsertBranch;
      update: UpsertBranch;
    };
    spy.mockRestore();
    return { create: args.create, update: args.update };
  }

  it('MR-a: existing COMMITTED + incoming "Potential" → preserved (no stage change, no history)', async () => {
    const { update } = await runOne(
      [{ sf_deal_id: "SF-1", stage: "COMMITTED", stage_history: [] }],
      "Potential",
    );
    expect(update.stage).toBe("COMMITTED");
    expect("stage_history" in update).toBe(false);
  });

  it('MR-b: existing COMMITTED + incoming "Funded" → overwritten to WON, history appended', async () => {
    const { update } = await runOne(
      [{ sf_deal_id: "SF-1", stage: "COMMITTED", stage_history: [] }],
      "Funded",
    );
    expect(update.stage).toBe("WON");
    expect(update.stage_history).toHaveLength(1);
    expect(update.stage_history?.[0]).toMatchObject({
      stage: "WON",
      from: "COMMITTED",
      by: "crm",
    });
  });

  it('MR-c: new deal + incoming "Potential" → POTENTIAL, opening history entry', async () => {
    const { create } = await runOne([], "Potential");
    expect(create.stage).toBe("POTENTIAL");
    expect(create.stage_history).toHaveLength(1);
    expect(create.stage_history?.[0]).toMatchObject({
      stage: "POTENTIAL",
      from: null,
      by: "crm",
    });
  });

  it('MR-d: existing POTENTIAL + incoming "Lost" → LOST, history appended (from prior)', async () => {
    const existingHist: StageHistoryEntry[] = [
      { stage: "POTENTIAL", from: null, at: "x", by: "seed" },
    ];
    const { update } = await runOne(
      [{ sf_deal_id: "SF-1", stage: "POTENTIAL", stage_history: existingHist }],
      "Lost",
    );
    expect(update.stage).toBe("LOST");
    expect(update.stage_history).toHaveLength(2); // prior + new
    expect(update.stage_history?.[1]).toMatchObject({ stage: "LOST", from: "POTENTIAL" });
  });
});

// -------------------------------------------------------------------------
// MERGE RULE — the pure helper, unit-tested directly.
// -------------------------------------------------------------------------
describe("mergeStage (pure merge decision)", () => {
  // Signature is mergeStage(incoming, existing): first arg = the import's stage,
  // second arg = the STORED stage.
  it("a: non-terminal incoming never downgrades a stored stage", () => {
    expect(mergeStage("POTENTIAL", "COMMITTED")).toEqual({ stage: "COMMITTED", changed: false });
    expect(mergeStage("FUNDING", "COMMITTED")).toEqual({ stage: "COMMITTED", changed: false });
  });

  it("a2: a stale POTENTIAL re-import never un-advances a stored WON / FUNDING", () => {
    // The high-value regression guard: a non-terminal import must NOT downgrade
    // an already-advanced stored stage — no stage change, no history entry.
    expect(mergeStage("POTENTIAL", "WON")).toEqual({ stage: "WON", changed: false });
    expect(mergeStage("POTENTIAL", "FUNDING")).toEqual({ stage: "FUNDING", changed: false });
  });

  it("b: terminal incoming always overwrites, marking changed", () => {
    expect(mergeStage("WON", "COMMITTED")).toEqual({ stage: "WON", changed: true });
    expect(mergeStage("LOST", "COMMITTED")).toEqual({ stage: "LOST", changed: true });
  });

  it("c: a brand-new deal uses the incoming stage (changed = insert)", () => {
    expect(mergeStage("POTENTIAL", null)).toEqual({ stage: "POTENTIAL", changed: true });
    expect(mergeStage("POTENTIAL", undefined)).toEqual({ stage: "POTENTIAL", changed: true });
  });

  it("d: existing POTENTIAL + incoming LOST → LOST, changed", () => {
    expect(mergeStage("LOST", "POTENTIAL")).toEqual({ stage: "LOST", changed: true });
  });

  it("terminal re-import that matches the stored terminal stage is a no-op change", () => {
    expect(mergeStage("WON", "WON")).toEqual({ stage: "WON", changed: false });
  });
});
