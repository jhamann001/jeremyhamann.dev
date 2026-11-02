import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { coverageSpy, diagnosticsSpy, reconcileSpy, flagSpy, writesFlagSpy } = vi.hoisted(() => ({
  coverageSpy: vi.fn(async () => ({
    summary: {
      source_rows: 12,
      mapped_sources: 10,
      unmapped_sources: 2,
      stale_mappings: 1,
      inactive_mappings: 0,
      open_exceptions: 3,
      coverage_percent: 83.33,
      newest_source_at: "2026-08-06T12:00:00.000Z",
      oldest_unmapped_at: "2026-08-05T12:00:00.000Z",
    },
    by_source: [{
      identity_type: "TASK",
      source_system: "CRM",
      source_namespace: "task",
      source_rows: 4,
      mapped_sources: 2,
      unmapped_sources: 2,
      stale_mappings: 1,
      inactive_mappings: 0,
      open_exceptions: 1,
      newest_source_at: "2026-08-06T12:00:00.000Z",
      oldest_unmapped_at: "2026-08-05T12:00:00.000Z",
    }],
  })),
  diagnosticsSpy: vi.fn(async () => ({
    summary: {
      unresolved_records: 4,
      would_open: 4,
      would_reopen: 0,
      already_open: 0,
      would_resolve: 0,
      no_parent_key_records: 1,
      distinct_unresolved_household_keys: 1,
      distinct_unresolved_contact_keys: 0,
    },
    by_source: [{
      identity_type: "EMAIL",
      source_system: "CRM",
      source_namespace: "email",
      exception_action: "WOULD_OPEN",
      parent_issue: "HOUSEHOLD_PARENT_UNRESOLVED",
      records: 3,
      distinct_household_keys: 1,
      distinct_contact_keys: 0,
    }],
    household_key_findings: [{
      exception_action: "WOULD_OPEN",
      finding: "VALID_ACCOUNT_KEY_ABSENT",
      records: 3,
      distinct_keys: 1,
    }],
    contact_key_findings: [],
    freshness: [{
      exception_action: "WOULD_OPEN",
      freshness: "LAST_24_HOURS",
      records: 4,
    }],
    household_cross_domain: [{
      exception_action: "WOULD_OPEN",
      coverage: "EMAIL_ONLY",
      records: 3,
      distinct_keys: 1,
    }],
  })),
  reconcileSpy: vi.fn(async (_runId: string, _dryRun: boolean) => ({
    sourcesSeen: 12,
    identitiesCreated: 2,
    mappingsCreated: 3,
    mappingsRefreshed: 10,
    exceptionsOpened: 1,
    exceptionsReopened: 0,
    exceptionsResolved: 4,
    duplicateSignalsSeen: 2,
    duplicateMode: "persisted" as const,
    duplicateCandidatesOpened: 1,
    duplicateCandidatesRefreshed: 1,
    duplicateCandidatesInactivated: 0,
  })),
  flagSpy: vi.fn(() => true),
  writesFlagSpy: vi.fn(() => true),
}));

vi.mock("@/lib/crm/reconcile", () => ({
  CRM_RECONCILIATION_BUSY_ERROR: "crm_reconciliation_already_running",
  runCrmIdentityReconciliation: reconcileSpy,
}));
vi.mock("@/lib/crm/parent-diagnostics", () => ({
  runCrmMissingParentDiagnostics: diagnosticsSpy,
}));
vi.mock("@/lib/crm/coverage", () => ({
  runCrmIdentityCoverageDiagnostics: coverageSpy,
}));
vi.mock("@/lib/flags", () => ({
  crmIdentityReconciliationEnabled: flagSpy,
  crmIdentityReconciliationWritesEnabled: writesFlagSpy,
}));

import * as route from "../../app/api/cron/crm-identity/route";

const TOKEN = "test-crm-identity-token";

function post(opts: { auth?: string; url?: string } = {}) {
  const headers = new Headers();
  const auth = "auth" in opts ? opts.auth : `Bearer ${TOKEN}`;
  if (auth !== undefined) headers.set("authorization", auth);
  return new Request(opts.url ?? "https://x/api/cron/crm-identity", {
    method: "POST",
    headers,
  });
}

describe("POST /api/cron/crm-identity", () => {
  const originalToken = process.env.INGEST_TOKEN;

  beforeEach(() => {
    process.env.INGEST_TOKEN = TOKEN;
    diagnosticsSpy.mockClear();
    coverageSpy.mockClear();
    reconcileSpy.mockClear();
    flagSpy.mockReset();
    flagSpy.mockReturnValue(true);
    writesFlagSpy.mockReset();
    writesFlagSpy.mockReturnValue(true);
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.INGEST_TOKEN;
    else process.env.INGEST_TOKEN = originalToken;
    vi.restoreAllMocks();
  });

  it("fails closed before the flag or reconciler when bearer auth is invalid", async () => {
    const response = await route.POST(post({ auth: "Bearer wrong" }));
    expect(response.status).toBe(401);
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("returns the shared explicit 405 posture for every non-POST verb", async () => {
    for (const verb of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      const response = verb();
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("does no database work while the independent writer flag is off", async () => {
    flagSpy.mockReturnValue(false);
    const response = await route.POST(post());
    expect(await response.json()).toEqual({ reconciled: 0, skipped: "flag_off" });
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(diagnosticsSpy).not.toHaveBeenCalled();
    expect(coverageSpy).not.toHaveBeenCalled();
  });

  it("runs a live counts-only sweep", async () => {
    const response = await route.POST(post());
    expect(response.status).toBe(200);
    expect(reconcileSpy).toHaveBeenCalledOnce();
    expect(reconcileSpy.mock.calls[0][1]).toBe(false);
    expect(reconcileSpy.mock.calls[0][0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await response.json()).toEqual({
      sources_seen: 12,
      identities_created: 2,
      mappings_created: 3,
      mappings_refreshed: 10,
      exceptions_opened: 1,
      exceptions_reopened: 0,
      exceptions_resolved: 4,
      duplicate_signals_seen: 2,
      duplicate_mode: "persisted",
      duplicate_candidates_opened: 1,
      duplicate_candidates_refreshed: 1,
      duplicate_candidates_inactivated: 0,
      dry_run: false,
      source: "approved_crm_namespaces",
    });
  });

  it("permits reviewed dry runs while the independent mutation gate is off", async () => {
    writesFlagSpy.mockReturnValue(false);
    const preview = await route.POST(post({
      url: "https://x/api/cron/crm-identity?dryRun=1",
    }));
    expect(preview.status).toBe(200);
    expect(reconcileSpy.mock.calls[0][1]).toBe(true);

    reconcileSpy.mockClear();
    const live = await route.POST(post());
    expect(live.status).toBe(409);
    expect(await live.json()).toEqual({ error: "writes_disabled" });
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("labels rollback counts as preview outcomes instead of committed writes", async () => {
    reconcileSpy.mockResolvedValueOnce({
      sourcesSeen: 12,
      identitiesCreated: 2,
      mappingsCreated: 3,
      mappingsRefreshed: 10,
      exceptionsOpened: 1,
      exceptionsReopened: 0,
      exceptionsResolved: 4,
      duplicateSignalsSeen: 2,
      duplicateMode: "preview",
      duplicateCandidatesWouldOpen: 1,
      duplicateCandidatesWouldRefresh: 1,
      duplicateCandidatesWouldInactivate: 0,
    } as never);
    const response = await route.POST(post({
      url: "https://x/api/cron/crm-identity?dryRun=1",
    }));
    expect(response.status).toBe(200);
    expect(reconcileSpy.mock.calls[0][1]).toBe(true);
    const body = await response.json();
    expect(body).toMatchObject({
      dry_run: true,
      duplicate_mode: "preview",
      duplicate_candidates_would_open: 1,
      duplicate_candidates_would_refresh: 1,
      duplicate_candidates_would_inactivate: 0,
    });
    expect(body).not.toHaveProperty("duplicate_candidates_opened");
  });

  it("runs aggregate missing-parent diagnostics only in explicit dry-run mode", async () => {
    writesFlagSpy.mockReturnValue(false);
    const response = await route.POST(post({
      url: "https://x/api/cron/crm-identity?dryRun=1&diagnostics=missing_parents",
    }));

    expect(response.status).toBe(200);
    expect(diagnosticsSpy).toHaveBeenCalledOnce();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      diagnostic: "missing_parents",
      dry_run: true,
      source: "approved_crm_namespaces",
      missing_parent_diagnostics: {
        summary: {
          unresolved_records: 4,
          would_open: 4,
          distinct_unresolved_household_keys: 1,
        },
        household_key_findings: [{
          finding: "VALID_ACCOUNT_KEY_ABSENT",
          records: 3,
          distinct_keys: 1,
        }],
      },
    });
  });

  it("runs aggregate identity coverage diagnostics only in explicit dry-run mode", async () => {
    writesFlagSpy.mockReturnValue(false);
    const response = await route.POST(post({
      url: "https://x/api/cron/crm-identity?dryRun=1&diagnostics=coverage",
    }));

    expect(response.status).toBe(200);
    expect(coverageSpy).toHaveBeenCalledOnce();
    expect(diagnosticsSpy).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      diagnostic: "coverage",
      dry_run: true,
      source: "approved_crm_namespaces",
      identity_coverage: {
        summary: {
          source_rows: 12,
          unmapped_sources: 2,
          coverage_percent: 83.33,
        },
        by_source: [{
          identity_type: "TASK",
          source_namespace: "task",
          unmapped_sources: 2,
        }],
      },
    });
  });

  it("rejects diagnostics without dry-run and rejects unknown diagnostic names", async () => {
    const live = await route.POST(post({
      url: "https://x/api/cron/crm-identity?diagnostics=missing_parents",
    }));
    expect(live.status).toBe(400);
    expect(await live.json()).toEqual({ error: "diagnostics_require_dry_run" });

    const unsupported = await route.POST(post({
      url: "https://x/api/cron/crm-identity?dryRun=1&diagnostics=raw_keys",
    }));
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toEqual({ error: "unsupported_diagnostic" });
    expect(diagnosticsSpy).not.toHaveBeenCalled();
    expect(coverageSpy).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("returns a counts-free coverage error without exposing database details", async () => {
    coverageSpy.mockRejectedValueOnce(new Error("source key CRM-COVERAGE-SECRET"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await route.POST(post({
      url: "https://x/api/cron/crm-identity?dryRun=1&diagnostics=coverage",
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(log.mock.calls.flat().join(" ")).not.toContain("CRM-COVERAGE-SECRET");
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("returns a counts-free diagnostic error and never logs database details", async () => {
    diagnosticsSpy.mockRejectedValueOnce(new Error("missing source key 001SECRET"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await route.POST(post({
      url: "https://x/api/cron/crm-identity?dryRun=1&diagnostics=missing_parents",
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(log.mock.calls.flat().join(" ")).not.toContain("001SECRET");
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("returns a counts-free internal error and never exposes database details", async () => {
    reconcileSpy.mockRejectedValueOnce(new Error("source key CRM-SECRET-123"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await route.POST(post());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(log.mock.calls.flat().join(" ")).not.toContain("CRM-SECRET-123");
  });

  it("acknowledges an overlapping sweep without making the scheduler retry", async () => {
    reconcileSpy.mockRejectedValueOnce(new Error("crm_reconciliation_already_running"));
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await route.POST(post());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ reconciled: 0, skipped: "already_running" });
    expect(log.mock.calls.flat().join(" ")).toContain("already_running");
  });

  it("distinguishes missing machine configuration without exposing a URL", async () => {
    reconcileSpy.mockRejectedValueOnce(new Error("crm_reconciler_not_configured"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await route.POST(post());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "config_error" });
  });
});
