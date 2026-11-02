import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "../../app/api/ingest/crm-parent-orphans/route";
import * as scope from "../../lib/ingest/scope";

const TOKEN = "test-crm-parent-orphan-token";

function post(body: unknown, opts: { auth?: string; url?: string; raw?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/ingest/crm-parent-orphans", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

function orphan(over: Record<string, unknown> = {}) {
  return {
    parent_type: "HOUSEHOLD",
    source_key: "001288867315530AAA",
    parent_state: "DELETED",
    ...over,
  };
}

function stubScope(opts: { fail?: boolean } = {}) {
  const execute = vi.fn(async () => {
    if (opts.fail) throw new Error("database contained 001SECRET");
    return 1;
  });
  const create = vi.fn(async (_args: unknown) => undefined);
  vi.spyOn(scope, "withIngestScope").mockImplementation(async (fn) => {
    const tx = {
      $executeRaw: execute,
      auditLog: { create },
    } as unknown as Parameters<typeof fn>[0];
    return fn(tx);
  });
  return { execute, create };
}

describe("POST /api/ingest/crm-parent-orphans", () => {
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

  it("fails closed on bad auth and non-POST verbs", async () => {
    const unauthorized = await route.POST(post(
      { source: "s", run_id: "r", items: [] },
      { auth: "Bearer wrong" },
    ));
    expect(unauthorized.status).toBe(401);

    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const response = verb();
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("rejects malformed JSON/envelopes and over-cap batches", async () => {
    expect((await route.POST(post(null, { raw: "{" }))).status).toBe(400);
    expect((await route.POST(post({ source: 1, run_id: "r" }))).status).toBe(400);
    const tooLarge = await route.POST(post({
      source: "s",
      run_id: "r",
      items: new Array(5001).fill(orphan()),
    }));
    expect(tooLarge.status).toBe(413);
  });

  it("batch-upserts canonical deleted/merged evidence and returns codes only", async () => {
    const { execute, create } = stubScope();
    const response = await route.POST(post({
      source: "crm",
      run_id: "RUN-CRM-ORPHAN-1",
      items: [
        orphan(),
        orphan({ source_key: "001288867315530" }),
        orphan({
          parent_type: "CONTACT",
          source_key: "003288867315530AAA",
          parent_state: "MERGED",
          replacement_key: "003092155893454AAA",
        }),
        orphan({ name: "must not cross seam" }),
      ],
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      upserted: 2,
      rejected: [{ index: 3, reason: "item_malformed" }],
      run_id: "RUN-CRM-ORPHAN-1",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    const audit = (create.mock.calls[0][0] as {
      data: { action: string; detail: string };
    }).data;
    expect(audit.action).toBe("ingest.crm_parent_orphans");
    expect(JSON.parse(audit.detail)).toEqual({
      source: "crm",
      endpoint: "crm-parent-orphans",
      received: 4,
      upserted: 2,
      rejected: 1,
      dry_run: false,
    });
    expect(audit.detail).not.toContain("001288867315530");
    expect(audit.detail).not.toContain("003288867315530");
  });

  it("dry-run audits counts without writing evidence", async () => {
    const { execute, create } = stubScope();
    const response = await route.POST(post(
      { source: "crm", run_id: "RUN-CRM-ORPHAN-DRY", items: [orphan()] },
      { url: "https://x/api/ingest/crm-parent-orphans?dryRun=1" },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      would_upsert: 1,
      rejected: [],
      run_id: "RUN-CRM-ORPHAN-DRY",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("sanitizes failures and never logs keys or run ids", async () => {
    const { create } = stubScope({ fail: true });
    const response = await route.POST(post({
      source: "crm",
      run_id: "RUN-CRM-ORPHAN-FAIL\nforged",
      items: [orphan()],
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(create).not.toHaveBeenCalled();
    const output = logs.join(" ");
    expect(output).toContain("[ingest] crm-parent-orphans tx_failed");
    expect(output).not.toContain("RUN-CRM-ORPHAN-FAIL");
    expect(output).not.toContain("001SECRET");
    expect(output).not.toContain("001288867315530AAA");
  });
});
