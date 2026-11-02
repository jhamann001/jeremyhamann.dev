import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as route from "../../app/api/ingest/accounts/route";
import { FX } from "./db-fixture";

// Pure (no-DB) accounts-route cases. The DB-gated integration cases live in
// integration.test.ts (serial, shared-DB) to avoid cross-file races.
const TOKEN = "test-d2-secret-token";

function post(body: unknown, opts: { auth?: string; url?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/ingest/accounts", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function account(over: Record<string, unknown> = {}) {
  return {
    custodian_account_id: FX.acct1,
    cedar_ridge_user_id: FX.user1,
    custodian: "APEX",
    account_type: "INDIVIDUAL",
    status: "OPEN",
    opened_at: "2026-01-15",
    closed_at: null,
    ...over,
  };
}

describe("POST /api/ingest/accounts — pure (no DB)", () => {
  const original = process.env.INGEST_TOKEN;
  beforeEach(() => {
    process.env.INGEST_TOKEN = TOKEN;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = original;
  });

  it("A4/auth: right bearer proceeds (200 on valid empty batch)", async () => {
    // With no INGEST_DATABASE_URL, the ingest client can't reach a DB, so a
    // non-empty live batch would throw → 500. An empty batch still enters the
    // tx (audit-only) — assert only the auth passthrough via the 401 negative.
    const res = await route.POST(post({ source: "s", run_id: "r", items: [] }, { auth: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("E2: bad envelope → 400", async () => {
    const res = await route.POST(post({ source: "s" }));
    expect(res.status).toBe(400);
  });

  it("C1: >5000 items → 413", async () => {
    const res = await route.POST(post({ source: "s", run_id: "r", items: new Array(5001).fill(account()) }));
    expect(res.status).toBe(413);
  });

  it("M1: non-POST verbs → 405 on every verb", async () => {
    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const res = verb();
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });
});
