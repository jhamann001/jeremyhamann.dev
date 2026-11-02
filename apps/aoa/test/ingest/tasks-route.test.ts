import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "../../app/api/ingest/tasks/route";
import * as scope from "../../lib/ingest/scope";
import { FX } from "./db-fixture";

// Pure (no-DB) tasks-route cases. Mirrors clients-route.test.ts — same auth,
// envelope, cap, verb, and tx-failure coverage.
const TOKEN = "test-d2-secret-token";

function post(body: unknown, opts: { auth?: string; url?: string; raw?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/ingest/tasks", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

function task(over: Record<string, unknown> = {}) {
  return {
    sf_id: "00T000000000001",
    household_sf_id: FX.hh1,
    subject: "Prep for annual review",
    status: "Open",
    priority: "High",
    description: "Pull the latest performance report before the meeting.",
    last_modified_at: "2026-07-01T12:00:00Z",
    ...over,
  };
}

describe("POST /api/ingest/tasks — pure (no DB)", () => {
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
    const items = new Array(5001).fill(task());
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

  it("T1: tx failure → 500 internal, PII-free error line, no data leaked", async () => {
    // Inject a fake tx whose $executeRaw throws on the first upsert (the
    // clients-route T1 precedent). The handler must return 500 and emit ONE
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
      post({ source: "s", run_id: "RUN-D2-T1", items: [task()] }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    // The audit row never got written (threw before writeAudit).
    expect(fakeCreate).not.toHaveBeenCalled();
    // PII-free error line: endpoint + run_id + marker only.
    const errLine = logs.find((l) => l.includes("tx_failed"));
    expect(errLine).toBeTruthy();
    expect(errLine).toContain("RUN-D2-T1");
    expect(errLine).not.toContain("Prep for annual review");
    spy.mockRestore();
  });
});
