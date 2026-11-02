import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AumFreshnessResult } from "@/lib/data/feed-health";

// Pure (no-DB) freshness-monitor route cases. `checkAumFreshness` (the DB
// composer) is mocked so we exercise auth, method-gating, 200/503 mapping, the
// stale-only audit write, and the best-effort Slack path — all without a
// database. Follows the account-aum-route.test.ts mock idiom.

const { checkSpy, scopeSpy, writeAuditSpy } = vi.hoisted(() => ({
  checkSpy: vi.fn(),
  scopeSpy: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  writeAuditSpy: vi.fn(async () => {}),
}));

vi.mock("@/lib/data/feed-health", () => ({ checkAumFreshness: checkSpy }));
vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: scopeSpy }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditSpy };
});

import * as route from "../app/api/cron/health/aum-freshness/route";

const TOKEN = "test-freshness-token";

function req(opts: { auth?: string } = {}) {
  const headers = new Headers();
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request("https://x/api/cron/health/aum-freshness", {
    method: "GET",
    headers,
  });
}

const OK_RESULT: AumFreshnessResult & { maxSyncedAt: Date | null } = {
  ok: true,
  reason: "ok",
  expectedMinAsOf: "2026-07-06",
  maxAsOf: "2026-07-06",
  maxSyncedAt: new Date("2026-07-07T10:00:00Z"),
  staleByTradingDays: 0,
  rowCount: 100,
  syncAgeHours: 1,
  openAccountCount: 96,
  currentOpenAccountCount: 96,
  corporateCurrentCount: 4,
  missingCloseDateCount: 0,
  reconciliationFailureCount: 0,
  expectedRowCount: 100,
};

const STALE_RESULT: AumFreshnessResult & { maxSyncedAt: Date | null } = {
  ok: false,
  reason: "stale_as_of",
  expectedMinAsOf: "2026-07-06",
  maxAsOf: "2026-07-01",
  maxSyncedAt: new Date("2026-07-02T10:00:00Z"),
  staleByTradingDays: 2,
  rowCount: 100,
  syncAgeHours: 1,
  openAccountCount: 96,
  currentOpenAccountCount: 96,
  corporateCurrentCount: 4,
  missingCloseDateCount: 0,
  reconciliationFailureCount: 0,
  expectedRowCount: 100,
};

describe("GET/POST /api/cron/health/aum-freshness", () => {
  const originalToken = process.env.INGEST_TOKEN;
  const originalWebhook = process.env.SLACK_ALERT_WEBHOOK_URL;

  beforeEach(() => {
    process.env.INGEST_TOKEN = TOKEN;
    delete process.env.SLACK_ALERT_WEBHOOK_URL;
    checkSpy.mockReset();
    scopeSpy.mockClear();
    writeAuditSpy.mockClear();
    global.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
  });
  afterEach(() => {
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    restore("INGEST_TOKEN", originalToken);
    restore("SLACK_ALERT_WEBHOOK_URL", originalWebhook);
    vi.restoreAllMocks();
  });

  it("wrong bearer → 401, never runs the check", async () => {
    const res = await route.GET(req({ auth: "Bearer wrong" }));
    expect(res.status).toBe(401);
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it("missing bearer → 401", async () => {
    const res = await route.POST(req({ auth: undefined }));
    expect(res.status).toBe(401);
  });

  it("non-GET/POST verbs → 405", async () => {
    for (const verb of [route.PUT, route.PATCH, route.DELETE]) {
      const res = verb();
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("ok verdict → 200 with the freshness payload (GET and POST)", async () => {
    checkSpy.mockResolvedValue(OK_RESULT);
    for (const verb of [route.GET, route.POST]) {
      const res = await verb(req());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        ok: true,
        feed: "account-aum",
        reason: "ok",
        expectedMinAsOf: "2026-07-06",
        maxAsOf: "2026-07-06",
        maxSyncedAt: "2026-07-07T10:00:00.000Z",
        staleByTradingDays: 0,
        rowCount: 100,
        syncAgeHours: 1,
      });
    }
    // No audit row on a healthy feed.
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("stale verdict → 503 and writes a counts/reason-only audit row", async () => {
    checkSpy.mockResolvedValue(STALE_RESULT);
    const res = await route.GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("stale_as_of");
    expect(body.staleByTradingDays).toBe(2);
    expect(scopeSpy).toHaveBeenCalledTimes(1);
    expect(writeAuditSpy).toHaveBeenCalledTimes(1);
    const [, identity, entry] = writeAuditSpy.mock.calls[0] as unknown[] as [
      unknown,
      { role: string; email: null },
      { action: string; detail: Record<string, unknown> },
    ];
    expect(identity).toEqual({ role: "INGEST", email: null });
    expect(entry.action).toBe("feed.health");
    // Detail is counts/reason only — no PII, no secrets.
    expect(entry.detail).toEqual({
      feed: "account-aum",
      reason: "stale_as_of",
      maxAsOf: "2026-07-01",
      expectedMinAsOf: "2026-07-06",
      staleByTradingDays: 2,
      rowCount: 100,
      openAccountCount: 96,
      currentOpenAccountCount: 96,
      corporateCurrentCount: 4,
      missingCloseDateCount: 0,
      reconciliationFailureCount: 0,
      expectedRowCount: 100,
    });
  });

  it("DB/check failure → 500 (distinct from a 503 stale verdict)", async () => {
    checkSpy.mockRejectedValue(new Error("db down"));
    const res = await route.GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  it("stale + webhook set → best-effort Slack fetch is called", async () => {
    process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.test/abc";
    checkSpy.mockResolvedValue(STALE_RESULT);
    const res = await route.GET(req());
    expect(res.status).toBe(503);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://hooks.slack.test/abc");
  });

  it("stale + webhook unset → no Slack fetch", async () => {
    checkSpy.mockResolvedValue(STALE_RESULT);
    const res = await route.GET(req());
    expect(res.status).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("Slack throw → still 503, not 500", async () => {
    process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.test/abc";
    checkSpy.mockResolvedValue(STALE_RESULT);
    global.fetch = vi.fn(async () => {
      throw new Error("slack down");
    }) as unknown as typeof fetch;
    const res = await route.GET(req());
    expect(res.status).toBe(503);
  });

  it("audit-write failure → still 503 (verdict not masked)", async () => {
    checkSpy.mockResolvedValue(STALE_RESULT);
    writeAuditSpy.mockRejectedValueOnce(new Error("audit db down"));
    const res = await route.GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, reason: "stale_as_of" });
  });
});
