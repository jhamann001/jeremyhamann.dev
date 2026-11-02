import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "../../app/api/ingest/clients/route";
import * as scope from "../../lib/ingest/scope";
import { FX } from "./db-fixture";

// Pure (no-DB) clients-route cases. The DB-gated integration cases live in
// integration.test.ts (serial, shared-DB) to avoid cross-file races.
const TOKEN = "test-d2-secret-token";
const UID = FX.user1;

function post(body: unknown, opts: { auth?: string; url?: string; raw?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/ingest/clients", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

function client(over: Record<string, unknown> = {}) {
  return {
    cedar_ridge_user_id: UID,
    sf_contact_id: FX.c1,
    name: "Daniel Chen",
    household_name: "Chen Household",
    household_sf_id: FX.hh1,
    stage: "Prospect",
    lead_advisor_email: "avery@example.com",
    ...over,
  };
}

describe("POST /api/ingest/clients — pure (no DB)", () => {
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
    const items = new Array(5001).fill(client());
    const res = await route.POST(post({ source: "s", run_id: "r", items }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
  });

  it("C2: >5MB body → 413", async () => {
    // A single item with a huge string blows past 5 MB; caught by the byte proxy.
    const big = client({ name: "A".repeat(6 * 1024 * 1024) });
    const res = await route.POST(post({ source: "s", run_id: "r", items: [big] }));
    expect(res.status).toBe(413);
  });

  it("M1: non-POST verbs → 405 method_not_allowed on every verb", async () => {
    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const res = verb();
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("T1: tx failure → 500 internal, PII-free error line, no data leaked", async () => {
    // Inject a fake tx whose $executeRaw throws after the first upsert (the
    // deal-stage-write fake-tx precedent). The handler must return 500 and emit
    // ONE PII-free error line; nothing is committed (single tx). DB-free.
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
      post({ source: "s", run_id: "RUN-D2-T1", items: [client()] }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    // The audit row never got written (threw before writeAudit).
    expect(fakeCreate).not.toHaveBeenCalled();
    // PII-free error line: endpoint + run_id + marker only.
    const errLine = logs.find((l) => l.includes("tx_failed"));
    expect(errLine).toBeTruthy();
    expect(errLine).toContain("RUN-D2-T1");
    expect(errLine).not.toContain("Ada");
    expect(errLine).not.toContain("avery@example.com");
    spy.mockRestore();
  });

  it("B1: large client feeds use bounded bulk upserts, not one statement per row", async () => {
    const fakeCreate = vi.fn(async () => undefined);
    const fakeExec = vi.fn(async () => 1);
    const spy = vi.spyOn(scope, "withIngestScope").mockImplementation(async (fn) => {
      const tx = {
        $executeRaw: fakeExec,
        auditLog: { create: fakeCreate },
      } as unknown as Parameters<typeof fn>[0];
      return fn(tx);
    });

    const items = Array.from({ length: 1_201 }, (_, i) =>
      client({
        sf_contact_id: `SF-CONTACT-${i}`,
        household_sf_id: `SF-HOUSEHOLD-${i}`,
        household_name: `Test Household ${i}`,
      }),
    );
    const res = await route.POST(
      post({ source: "s", run_id: "RUN-BULK-CLIENTS", items }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).upserted).toBe(1_201);
    // 3 household batches + 3 client batches. The audit uses its own model
    // call and remains inside the same transaction.
    expect(fakeExec).toHaveBeenCalledTimes(6);
    expect(fakeCreate).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
