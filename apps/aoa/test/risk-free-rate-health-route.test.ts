import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RiskFreeFreshnessResult } from "@/lib/data/risk-free-rate-health";

const { checkSpy, scopeSpy, writeAuditSpy } = vi.hoisted(() => ({
  checkSpy: vi.fn(),
  scopeSpy: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  writeAuditSpy: vi.fn(async () => {}),
}));

vi.mock("@/lib/data/risk-free-rate-health", () => ({
  checkRiskFreeFreshness: checkSpy,
}));
vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: scopeSpy }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, writeAudit: writeAuditSpy };
});

import * as route from "../app/api/cron/health/risk-free-rate/route";

const TOKEN = "test-health-token";
const OK: RiskFreeFreshnessResult = {
  ok: true,
  reason: "ok",
  expectedMinRateDate: "2026-07-06",
  maxRateDate: "2026-07-06",
  maxSyncedAt: new Date("2026-07-07T11:01:00Z"),
  staleByTradingDays: 0,
  rowCount: 2_900,
  syncAgeHours: 2.5,
};
const STALE: RiskFreeFreshnessResult = {
  ok: false,
  reason: "stale_rate_date",
  expectedMinRateDate: "2026-07-06",
  maxRateDate: "2026-07-01",
  maxSyncedAt: new Date("2026-07-07T11:01:00Z"),
  staleByTradingDays: 2,
  rowCount: 2_900,
  syncAgeHours: 2.5,
};

function req(auth = `Bearer ${TOKEN}`): Request {
  return new Request("https://x/api/cron/health/risk-free-rate", {
    headers: auth ? { authorization: auth } : {},
  });
}

describe("GET/POST /api/cron/health/risk-free-rate", () => {
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
    const restore = (key: string, value: string | undefined) =>
      value === undefined ? delete process.env[key] : (process.env[key] = value);
    restore("INGEST_TOKEN", originalToken);
    restore("SLACK_ALERT_WEBHOOK_URL", originalWebhook);
    vi.restoreAllMocks();
  });

  it("rejects a wrong bearer before checking the feed", async () => {
    expect((await route.GET(req("Bearer wrong"))).status).toBe(401);
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it("allows only GET and POST", async () => {
    for (const handler of [route.PUT, route.PATCH, route.DELETE]) {
      expect(handler().status).toBe(405);
    }
  });

  it("returns 200 and writes no event for a healthy feed", async () => {
    checkSpy.mockResolvedValue(OK);
    for (const handler of [route.GET, route.POST]) {
      const response = await handler(req());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        feed: "treasury-risk-free-rate",
        maxRateDate: "2026-07-06",
      });
    }
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  it("returns 503, writes a PII-free audit event, and alerts Slack when stale", async () => {
    process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.test/abc";
    checkSpy.mockResolvedValue(STALE);
    const response = await route.GET(req());
    expect(response.status).toBe(503);
    expect(writeAuditSpy).toHaveBeenCalledOnce();
    const [, , entry] = writeAuditSpy.mock.calls[0] as unknown[] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(entry).toMatchObject({
      action: "feed.health",
      entityType: "feed_health",
      entityId: "treasury-risk-free-rate",
      detail: {
        feed: "treasury-risk-free-rate",
        reason: "stale_rate_date",
        maxRateDate: "2026-07-01",
        expectedMinRateDate: "2026-07-06",
        staleByTradingDays: 2,
        rowCount: 2_900,
        syncAgeHours: 2.5,
      },
    });
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("does not mask stale status when Slack or audit writing fails", async () => {
    process.env.SLACK_ALERT_WEBHOOK_URL = "https://hooks.slack.test/abc";
    checkSpy.mockResolvedValue(STALE);
    writeAuditSpy.mockRejectedValueOnce(new Error("audit down"));
    global.fetch = vi.fn(async () => {
      throw new Error("slack down");
    }) as unknown as typeof fetch;
    expect((await route.POST(req())).status).toBe(503);
  });

  it("returns 500 when the health check itself cannot run", async () => {
    checkSpy.mockRejectedValue(new Error("db down"));
    const response = await route.GET(req());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
  });
});
