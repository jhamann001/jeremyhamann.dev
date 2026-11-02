import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "../../app/api/ingest/crm-parents/route";
import * as scope from "../../lib/ingest/scope";

const TOKEN = "test-crm-parent-token";

function post(body: unknown, opts: { auth?: string; url?: string; raw?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/ingest/crm-parents", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

function parent(over: Record<string, unknown> = {}) {
  return {
    parent_type: "HOUSEHOLD",
    source_key: "001288867315530AAA",
    ...over,
  };
}

function stubScope(opts: { fail?: boolean } = {}) {
  const execute = vi.fn(async () => {
    if (opts.fail) throw new Error("database contained 001SECRET");
    return 1;
  });
  const create = vi.fn(async () => undefined);
  const spy = vi.spyOn(scope, "withIngestScope").mockImplementation(async (fn) => {
    const tx = {
      $executeRaw: execute,
      auditLog: { create },
    } as unknown as Parameters<typeof fn>[0];
    return fn(tx);
  });
  return { execute, create, spy };
}

describe("POST /api/ingest/crm-parents", () => {
  const original = process.env.INGEST_TOKEN;
  let logs: string[];

  beforeEach(() => {
    logs = [];
    process.env.INGEST_TOKEN = TOKEN;
    vi.spyOn(console, "warn").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => logs.push(args.join(" ")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = original;
  });

  it("fails closed on missing configuration or an invalid bearer", async () => {
    delete process.env.INGEST_TOKEN;
    const unset = await route.POST(post({ source: "s", run_id: "r", items: [] }));
    expect(unset.status).toBe(401);
    expect(logs.some((line) => line.includes("INGEST_TOKEN not configured"))).toBe(true);

    process.env.INGEST_TOKEN = TOKEN;
    const wrong = await route.POST(post(
      { source: "s", run_id: "r", items: [] },
      { auth: "Bearer wrong" },
    ));
    expect(wrong.status).toBe(401);
  });

  it("returns the shared 405 body for non-POST verbs", async () => {
    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const response = verb();
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("rejects malformed JSON/envelopes and over-cap batches", async () => {
    expect((await route.POST(post(null, { raw: "{" }))).status).toBe(400);
    expect((await route.POST(post({ source: 1, run_id: "r" }))).status).toBe(400);
    const items = new Array(5001).fill(parent());
    const tooLarge = await route.POST(post({ source: "s", run_id: "r", items }));
    expect(tooLarge.status).toBe(413);
  });

  it("batch-upserts accepted parents once and returns PII-free rejection codes", async () => {
    const { execute, create } = stubScope();
    const response = await route.POST(post({
      source: "crm",
      run_id: "RUN-CRM-PARENT-1",
      items: [
        parent(),
        parent({ source_key: "001288867315530" }),
        parent({ parent_type: "CONTACT", source_key: "003288867315530AAA" }),
        parent({ parent_type: "CONTACT", source_key: "001BADBADBADBAD" }),
      ],
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      upserted: 2,
      rejected: [{ index: 3, reason: "source_key_invalid" }],
      run_id: "RUN-CRM-PARENT-1",
    });
    // Both widths of the first Account collapse in memory, and all distinct
    // parents still travel through one jsonb_to_recordset statement.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("dry-run validates and audits without writing the mirror table", async () => {
    const { execute, create } = stubScope();
    const response = await route.POST(post(
      { source: "crm", run_id: "RUN-CRM-PARENT-DRY", items: [parent()] },
      { url: "https://x/api/ingest/crm-parents?dryRun=1" },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      would_upsert: 1,
      rejected: [],
      run_id: "RUN-CRM-PARENT-DRY",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("sanitizes transaction failures and never logs source keys", async () => {
    const { create } = stubScope({ fail: true });
    const response = await route.POST(post({
      source: "crm",
      run_id: "RUN-CRM-PARENT-FAIL\nforged",
      items: [parent()],
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(create).not.toHaveBeenCalled();
    const output = logs.join(" ");
    expect(output).toContain("[ingest] crm-parents tx_failed");
    expect(output).not.toContain("RUN-CRM-PARENT-FAIL");
    expect(output).not.toContain("001SECRET");
    expect(output).not.toContain("001288867315530AAA");
  });
});
