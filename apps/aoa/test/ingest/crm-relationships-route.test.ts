import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runSpy, flagSpy, writesFlagSpy, continuousFlagSpy } = vi.hoisted(() => ({
  runSpy: vi.fn(async (
    _runId: string,
    _dryRun: boolean,
    _completeness: { contact: boolean; deal: boolean; transfer: boolean },
  ) => [
    {
      derivation: "CRM_CONTACT_HOUSEHOLD",
      snapshotComplete: true,
      candidates: 10,
      created: 8,
      refreshed: 1,
      reactivated: 0,
      inactivated: 0,
      missingEndpoint: 1,
      ambiguousEndpoint: 0,
      rejectedType: 0,
    },
    {
      derivation: "AOA_DEAL_HOUSEHOLD",
      snapshotComplete: true,
      candidates: 4,
      created: 4,
      refreshed: 0,
      reactivated: 0,
      inactivated: 0,
      missingEndpoint: 0,
      ambiguousEndpoint: 0,
      rejectedType: 0,
    },
    {
      derivation: "AOA_TRANSFER_HOUSEHOLD",
      snapshotComplete: false,
      candidates: 3,
      created: 2,
      refreshed: 0,
      reactivated: 0,
      inactivated: 0,
      missingEndpoint: 1,
      ambiguousEndpoint: 0,
      rejectedType: 0,
    },
  ]),
  flagSpy: vi.fn(() => true),
  writesFlagSpy: vi.fn(() => true),
  continuousFlagSpy: vi.fn(() => false),
}));

vi.mock("@/lib/crm/relationships", () => ({
  runCrmRelationshipSnapshot: runSpy,
}));
vi.mock("@/lib/flags", () => ({
  crmRelationshipContinuousRefreshEnabled: continuousFlagSpy,
  crmRelationshipReconciliationEnabled: flagSpy,
  crmRelationshipReconciliationWritesEnabled: writesFlagSpy,
}));

import * as route from "../../app/api/cron/crm-relationships/route";

const TOKEN = "test-crm-relationship-token";

function post(opts: { auth?: string; url?: string } = {}) {
  const headers = new Headers();
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/cron/crm-relationships", {
    method: "POST",
    headers,
  });
}

describe("POST /api/cron/crm-relationships", () => {
  const originalToken = process.env.INGEST_TOKEN;

  beforeEach(() => {
    process.env.INGEST_TOKEN = TOKEN;
    runSpy.mockClear();
    flagSpy.mockReset();
    flagSpy.mockReturnValue(true);
    writesFlagSpy.mockReset();
    writesFlagSpy.mockReturnValue(true);
    continuousFlagSpy.mockReset();
    continuousFlagSpy.mockReturnValue(false);
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = originalToken;
    vi.restoreAllMocks();
  });

  it("fails closed before flags or database work when auth is invalid", async () => {
    const response = await route.POST(post({ auth: "Bearer wrong" }));
    expect(response.status).toBe(401);
    expect(flagSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("returns a consistent 405 for non-POST verbs", async () => {
    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const response = verb();
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("does no database work while the independent feature gate is off", async () => {
    flagSpy.mockReturnValue(false);
    const response = await route.POST(post());
    expect(await response.json()).toEqual({ reconciled: 0, skipped: "flag_off" });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("allows a counts-only preview while live writes are disabled", async () => {
    writesFlagSpy.mockReturnValue(false);
    const response = await route.POST(post({
      url: "https://x/api/cron/crm-relationships?dryRun=1&contactComplete=1&dealComplete=1",
    }));
    expect(response.status).toBe(200);
    expect(runSpy).toHaveBeenCalledOnce();
    expect(runSpy.mock.calls[0][1]).toBe(true);
    expect(runSpy.mock.calls[0][2]).toEqual({
      contact: true,
      deal: true,
      transfer: false,
    });
    const body = await response.json();
    expect(body).toMatchObject({
      dry_run: true,
      continuous: false,
      completeness: { contact: true, deal: true, transfer: false },
    });
    expect(body.derivations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        derivation: "CRM_CONTACT_HOUSEHOLD",
        candidates: 10,
        created: 8,
        missing_endpoint: 1,
      }),
    ]));
  });

  it("rejects live execution until the separate mutation gate is enabled", async () => {
    writesFlagSpy.mockReturnValue(false);
    const response = await route.POST(post());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "writes_disabled" });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("rejects a recurring caller until the independent continuous gate is enabled", async () => {
    const response = await route.POST(post({
      url: "https://x/api/cron/crm-relationships?continuous=1&contactComplete=1&dealComplete=1&transferComplete=1",
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "continuous_refresh_disabled" });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("runs one complete live snapshot for an explicitly enabled recurring caller", async () => {
    continuousFlagSpy.mockReturnValue(true);
    const response = await route.POST(post({
      url: "https://x/api/cron/crm-relationships?continuous=1&contactComplete=1&dealComplete=1&transferComplete=1",
    }));
    expect(response.status).toBe(200);
    expect(runSpy).toHaveBeenCalledOnce();
    expect(runSpy.mock.calls[0][1]).toBe(false);
    expect(runSpy.mock.calls[0][2]).toEqual({
      contact: true,
      deal: true,
      transfer: true,
    });
    expect(await response.json()).toMatchObject({
      continuous: true,
      dry_run: false,
    });
  });

  it("rejects malformed recurring-caller declarations instead of guessing", async () => {
    const response = await route.POST(post({
      url: "https://x/api/cron/crm-relationships?continuous=true",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_continuous" });
    expect(continuousFlagSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed completeness declarations instead of guessing", async () => {
    const response = await route.POST(post({
      url: "https://x/api/cron/crm-relationships?dryRun=1&contactComplete=true",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_completeness" });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("returns sanitized errors without database details", async () => {
    runSpy.mockRejectedValueOnce(new Error("source key 001SECRET"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await route.POST(post({
      url: "https://x/api/cron/crm-relationships?dryRun=1",
    }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(log.mock.calls.flat().join(" ")).not.toContain("001SECRET");
  });

  it("distinguishes missing machine configuration without exposing its URL", async () => {
    runSpy.mockRejectedValueOnce(new Error("crm_reconciler_not_configured"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await route.POST(post({
      url: "https://x/api/cron/crm-relationships?dryRun=1",
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "config_error" });
  });
});
