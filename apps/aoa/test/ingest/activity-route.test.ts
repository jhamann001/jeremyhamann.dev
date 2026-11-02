import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "../../app/api/ingest/activity/route";
import * as scope from "../../lib/ingest/scope";
import { FX } from "./db-fixture";

// Pure (no-DB) activity-route cases. Mirrors emails-route.test.ts — same auth,
// envelope, cap, verb, and tx-failure coverage, plus dryRun / happy-path /
// rejected assertions via a fake withIngestScope tx (no DB).
const TOKEN = "test-d2-secret-token";

function post(body: unknown, opts: { auth?: string; url?: string; raw?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/ingest/activity", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

function activity(over: Record<string, unknown> = {}) {
  return {
    sf_id: "00T000000000001",
    household_sf_id: FX.hh1,
    subject: "Call: Q3 check-in",
    note: "Talked through the rebalance and confirmed the next review date.",
    activity_at: "2026-07-01T12:00:00Z",
    owner_name: "Avery Advisor",
    last_modified_at: "2026-07-01T12:05:00Z",
    ...over,
  };
}

// Fake withIngestScope: a tx whose $executeRaw + auditLog.create succeed,
// so the DB-free happy/dryRun paths exercise the real handler counting logic.
function stubScope() {
  const exec = vi.fn(async () => 1);
  const create = vi.fn(async () => undefined);
  const spy = vi.spyOn(scope, "withIngestScope").mockImplementation(async (fn) => {
    const tx = {
      $executeRaw: exec,
      auditLog: { create },
    } as unknown as Parameters<typeof fn>[0];
    return fn(tx);
  });
  return { exec, create, spy };
}

describe("POST /api/ingest/activity — pure (no DB)", () => {
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
    const res = await route.POST(post({ source: "s", run_id: "RUN-D2-A1", items: [] }));
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
    const items = new Array(5001).fill(activity());
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

  it("H1: happy path → 200 upserted count = accepted items; one upsert per distinct sf_id", async () => {
    const { exec, create, spy } = stubScope();
    const items = [
      activity({ sf_id: "00T000000000001" }),
      activity({ sf_id: "00T000000000002" }),
    ];
    const res = await route.POST(post({ source: "s", run_id: "RUN-D2-H1", items }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ upserted: 2, rejected: [], run_id: "RUN-D2-H1" });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("R1: mixed validity → invalid items rejected, valid upserted", async () => {
    const { exec, spy } = stubScope();
    const items = [
      activity(), // 0 valid
      { subject: "orphan, no ids" }, // 1 sf_id_missing
      activity({ sf_id: "00T000000000003", household_sf_id: "" }), // 2 household_sf_id_missing
    ];
    const res = await route.POST(post({ source: "s", run_id: "RUN-D2-R1", items }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toBe(1);
    expect(body.rejected).toEqual([
      { index: 1, reason: "sf_id_missing" },
      { index: 2, reason: "household_sf_id_missing" },
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("D1: dryRun → would_upsert count, NO mirror write, audit-only", async () => {
    const { exec, create, spy } = stubScope();
    const res = await route.POST(
      post(
        { source: "s", run_id: "RUN-D2-D1", items: [activity()] },
        { url: "https://x/api/ingest/activity?dryRun=1" },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ would_upsert: 1, rejected: [], run_id: "RUN-D2-D1" });
    // No mirror upsert on the dry path; the audit row still writes.
    expect(exec).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("T1: tx failure → 500 internal, PII-free error line, no data leaked", async () => {
    // Inject a fake tx whose $executeRaw throws on the first upsert (the
    // emails-route T1 precedent). The handler must return 500 and emit ONE
    // PII-free error line; nothing is committed (single tx). DB-free.
    let calls = 0;
    const fakeCreate = vi.fn(async () => undefined);
    const fakeExec = vi.fn(async () => {
      calls += 1;
      if (calls >= 1) throw new Error("boom");
      return 1;
    });
    const spy = vi.spyOn(scope, "withIngestScope").mockImplementation(async (fn) => {
      const tx = {
        $executeRaw: fakeExec,
        auditLog: { create: fakeCreate },
      } as unknown as Parameters<typeof fn>[0];
      return fn(tx);
    });

    const res = await route.POST(
      post({ source: "s", run_id: "RUN-D2-T1", items: [activity()] }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    // The audit row never got written (threw before writeAudit).
    expect(fakeCreate).not.toHaveBeenCalled();
    // PII-free error line: endpoint + run_id + marker only.
    const errLine = logs.find((l) => l.includes("tx_failed"));
    expect(errLine).toBeTruthy();
    expect(errLine).toContain("RUN-D2-T1");
    expect(errLine).not.toContain("Q3 check-in");
    spy.mockRestore();
  });
});
