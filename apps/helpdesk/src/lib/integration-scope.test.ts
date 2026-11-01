/**
 * Unit tests for the per-surface machine credentials (src/lib/integration-scope.ts). The properties
 * that matter are the ones that make the split a NARROWING rather than an addition:
 *
 *  - a scope with its own key accepts only that key — the shared bearer stops opening it;
 *  - a scope without one behaves exactly as it did before the split;
 *  - a key that is set but too short DISABLES its surface rather than falling back to the broad key the
 *    operator was in the middle of retiring.
 *
 * The environment is injected, never mutated: these run beside DB-gated suites in the same process.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MIN_SECRET_LENGTH } from "@/lib/env";
import { captureLogs } from "@/test-support/capture-logs";
import {
  MIN_SCOPED_TOKEN_LENGTH,
  INTEGRATION_SCOPES,
  INTEGRATION_SCOPE_ENV_KEY,
  integrationScopeConfigured,
  integrationScopeForRoute,
  integrationTokenForScope,
  resetIntegrationScopeWarnings,
  resolveScopedIntegrationToken,
} from "@/lib/integration-scope";

const SHARED = "shared-integration-token-0123456789abcdef";
const SCOPED = "scoped-ingest-token-0123456789abcdefghij";
const SHORT = "too-short";

beforeEach(() => {
  resetIntegrationScopeWarnings();
});

describe("scope inventory", () => {
  it("is one scope per middleware-excluded machine prefix, each with its own key", () => {
    expect([...INTEGRATION_SCOPES]).toEqual(["ingest", "export", "outbox"]);
    expect(INTEGRATION_SCOPE_ENV_KEY).toEqual({
      ingest: "INGEST_API_TOKEN",
      export: "EXPORT_API_TOKEN",
      outbox: "OUTBOX_API_TOKEN",
    });
    // Three distinct keys: a shared name between two surfaces would silently re-merge the credential.
    expect(new Set(Object.values(INTEGRATION_SCOPE_ENV_KEY)).size).toBe(INTEGRATION_SCOPES.length);
  });

  it("holds scoped keys to exactly env.ts's shared-secret minimum (the duplication cannot drift)", () => {
    expect(MIN_SCOPED_TOKEN_LENGTH).toBe(MIN_SECRET_LENGTH);
  });
});

describe("integrationScopeForRoute", () => {
  it("maps every Wave A machine route to its surface", () => {
    expect(integrationScopeForRoute("/api/ingest/tickets")).toBe("ingest");
    expect(integrationScopeForRoute("/api/ingest/tickets/[id]/messages")).toBe("ingest");
    expect(integrationScopeForRoute("/api/ingest/email")).toBe("ingest");
    expect(integrationScopeForRoute("/api/export/tickets")).toBe("export");
    expect(integrationScopeForRoute("/api/integrations/outbox")).toBe("outbox");
    expect(integrationScopeForRoute("/api/integrations/outbox/[id]")).toBe("outbox");
  });

  it("claims nothing outside the machine prefixes", () => {
    for (const route of ["/api/tickets/export", "/api/client/tickets", "/api/attachments/x/upload", "/", "/api/exports"]) {
      expect(integrationScopeForRoute(route)).toBeNull();
    }
  });
});

describe("resolveScopedIntegrationToken", () => {
  it("reports an unset key as unset — including an empty or whitespace value", () => {
    expect(resolveScopedIntegrationToken("ingest", {})).toEqual({ kind: "unset" });
    expect(resolveScopedIntegrationToken("ingest", { INGEST_API_TOKEN: "" })).toEqual({ kind: "unset" });
    expect(resolveScopedIntegrationToken("ingest", { INGEST_API_TOKEN: "   " })).toEqual({ kind: "unset" });
  });

  it("returns the trimmed token when it is long enough", () => {
    expect(resolveScopedIntegrationToken("ingest", { INGEST_API_TOKEN: ` ${SCOPED} ` })).toEqual({
      kind: "ok",
      token: SCOPED,
    });
  });

  it("holds a scoped key to the same length rule as every other shared secret", () => {
    expect(SHORT.length).toBeLessThan(MIN_SCOPED_TOKEN_LENGTH);
    const logs = captureLogs();
    try {
      expect(resolveScopedIntegrationToken("outbox", { OUTBOX_API_TOKEN: SHORT })).toEqual({
        kind: "invalid",
        reason: "too_short",
      });
    } finally {
      logs.restore();
    }
  });

  it("logs a short key once per scope, not once per probe", () => {
    // `integration-scope.ts` reports through `@/lib/logger` now, which never calls `console`
    // (`console` is the sink CWE-209 watches), so the line is captured off the stream instead.
    const logs = captureLogs();
    try {
      const source = { OUTBOX_API_TOKEN: SHORT };
      resolveScopedIntegrationToken("outbox", source);
      resolveScopedIntegrationToken("outbox", source);
      resolveScopedIntegrationToken("outbox", source);
      expect(logs.err).toHaveLength(1);
      expect(logs.err[0]).toMatchObject({
        severity: "WARNING",
        logScope: "integration-scope",
        event: "scoped_token_too_short",
        scope: "outbox",
        key: "OUTBOX_API_TOKEN",
        effect: "scope_disabled",
      });
      // The two "scope"s are different things and the line now carries both: `logScope` is the
      // emitting surface (this module), `scope` is the INTEGRATION scope whose key is short. The
      // second one used to be dropped, because the logger's reserved identity key was itself named
      // `scope`; it is `logScope` since the security scanner follow-up, and this assertion is what would notice if
      // it were ever renamed back.
    } finally {
      logs.restore();
    }
  });

  it("never logs the token itself", () => {
    const logs = captureLogs();
    try {
      resolveScopedIntegrationToken("export", { EXPORT_API_TOKEN: SHORT });
      expect(logs.all()).toHaveLength(1);
      expect(JSON.stringify(logs.all())).not.toContain(SHORT);
    } finally {
      logs.restore();
    }
  });
});

describe("integrationScopeConfigured", () => {
  it("is false only when the key is absent", () => {
    // Captured, not spied on `console`: the too-short probe below emits a logger line, and leaving it
    // uncaptured would print one JSON line into the reporter's output for a case that asserts nothing
    // about logging.
    const logs = captureLogs();
    try {
      expect(integrationScopeConfigured("ingest", {})).toBe(false);
      expect(integrationScopeConfigured("ingest", { INGEST_API_TOKEN: SCOPED })).toBe(true);
      // Set-but-invalid still counts as configured: the operator meant to narrow this surface.
      expect(integrationScopeConfigured("ingest", { INGEST_API_TOKEN: SHORT })).toBe(true);
    } finally {
      logs.restore();
    }
  });
});

describe("integrationTokenForScope", () => {
  it("falls back to the shared bearer when the scope has no key of its own (today's behaviour)", () => {
    expect(integrationTokenForScope("ingest", SHARED, {})).toBe(SHARED);
    expect(integrationTokenForScope("export", SHARED, {})).toBe(SHARED);
    expect(integrationTokenForScope("outbox", SHARED, {})).toBe(SHARED);
    expect(integrationTokenForScope(undefined, SHARED, {})).toBe(SHARED);
  });

  it("prefers the scope's own key, and the shared bearer then no longer opens that surface", () => {
    const source = { INGEST_API_TOKEN: SCOPED };
    expect(integrationTokenForScope("ingest", SHARED, source)).toBe(SCOPED);
    expect(integrationTokenForScope("ingest", SHARED, source)).not.toBe(SHARED);
    // The surfaces that were NOT split keep working on the shared key — split one workflow at a time.
    expect(integrationTokenForScope("export", SHARED, source)).toBe(SHARED);
    expect(integrationTokenForScope("outbox", SHARED, source)).toBe(SHARED);
  });

  it("splitting one surface does not leak that surface's key to another", () => {
    const source = { OUTBOX_API_TOKEN: SCOPED };
    expect(integrationTokenForScope("outbox", SHARED, source)).toBe(SCOPED);
    expect(integrationTokenForScope("ingest", SHARED, source)).toBe(SHARED);
  });

  it("fails CLOSED on a set-but-too-short key: no token opens that surface, shared or otherwise", () => {
    const logs = captureLogs();
    try {
      expect(integrationTokenForScope("export", SHARED, { EXPORT_API_TOKEN: SHORT })).toBeUndefined();
    } finally {
      logs.restore();
    }
  });

  it("is undefined when nothing is configured at all — the surface is DISABLED, never open", () => {
    expect(integrationTokenForScope("ingest", undefined, {})).toBeUndefined();
    expect(integrationTokenForScope("ingest", "", {})).toBeUndefined();
    expect(integrationTokenForScope(undefined, undefined, {})).toBeUndefined();
  });
});
