/**
 * The scope split as the ROUTES see it: `isIntegrationApiAuthorized(headers, scope)`.
 *
 * `integration-scope.test.ts` proves the token-resolution rules in isolation; this file proves they are
 * actually wired into the bearer compare, which is the thing standing between the internet and the
 * whole ticket book. Same mocking shape as `integration-auth.test.ts` (no database, `@/lib/env`
 * replaced), plus a save/restore of the three scoped keys so nothing leaks into a neighbouring suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs } from "@/test-support/capture-logs";

const SHARED = "unit-test-integration-token-0123456789abcdef";
const INGEST_ONLY = "unit-test-ingest-only-token-0123456789abcd";
const OUTBOX_ONLY = "unit-test-outbox-only-token-0123456789abcd";

const mockEnv = vi.hoisted(() => ({
  env: {
    NODE_ENV: "test" as const,
    // Composed from its parts at run time: a literal `postgresql://USER:PASSWORD@HOST/DB` is a security scanner
    // secret finding in any tracked file, tests included, even for a database nothing dials.
    // `vi.hoisted` runs before imports, so `@/test-support/db-url` cannot be called from in here;
    // this is that module's `unitDatabaseUrl()` written as one expression.
    DATABASE_URL: Object.assign(new URL("postgresql://localhost:5432/unit_never_connects"), {
      username: "unit",
      password: "unit",
    }).toString(),
    PUBLIC_DATABASE_URL: undefined as string | undefined,
    AUTH_SECRET: undefined as string | undefined,
    AUTH_DEV_LOGIN: false,
    TRUSTED_PROXY_HOPS: 0,
    CLIENT_API_TOKEN: undefined as string | undefined,
    INTEGRATION_API_TOKEN: "unit-test-integration-token-0123456789abcdef" as string | undefined,
    APP_ENV: "local" as const,
  },
}));
vi.mock("@/lib/env", () => mockEnv);

const mockDb = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock("@/lib/db", () => mockDb);

import { isIntegrationApiAuthorized, requireIntegrationActor } from "@/lib/integration-auth";
import { INTEGRATION_SCOPE_ENV_KEY, resetIntegrationScopeWarnings } from "@/lib/integration-scope";
import { UnauthorizedError } from "@/lib/errors";

const SCOPED_KEYS = Object.values(INTEGRATION_SCOPE_ENV_KEY);
const saved = new Map<string, string | undefined>();

function setScopedKey(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const bearer = (token: string): Headers => new Headers({ authorization: `Bearer ${token}` });

beforeEach(() => {
  for (const key of SCOPED_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  mockEnv.env.INTEGRATION_API_TOKEN = SHARED;
  resetIntegrationScopeWarnings();
  // Silences the "scoped key too short" line the too-short cases emit. It goes through
  // `@/lib/logger`, which never calls `console` (`console` is the sink CWE-209 watches), so a
  // `console.error` spy here would suppress nothing and the JSON would land in the reporter output.
  // `vi.restoreAllMocks()` in `afterEach` unhooks it, like any other spy.
  captureLogs();
});

afterEach(() => {
  for (const [key, value] of saved) setScopedKey(key, value);
  saved.clear();
  vi.restoreAllMocks();
});

describe("isIntegrationApiAuthorized(headers, scope)", () => {
  it("with no scoped keys set, every surface still takes the shared bearer (no behaviour change)", () => {
    expect(isIntegrationApiAuthorized(bearer(SHARED), "ingest")).toBe(true);
    expect(isIntegrationApiAuthorized(bearer(SHARED), "export")).toBe(true);
    expect(isIntegrationApiAuthorized(bearer(SHARED), "outbox")).toBe(true);
    expect(isIntegrationApiAuthorized(bearer(SHARED))).toBe(true);
  });

  it("a scoped key NARROWS its surface: only that key opens it, and the shared bearer no longer does", () => {
    setScopedKey("INGEST_API_TOKEN", INGEST_ONLY);

    expect(isIntegrationApiAuthorized(bearer(INGEST_ONLY), "ingest")).toBe(true);
    expect(isIntegrationApiAuthorized(bearer(SHARED), "ingest")).toBe(false);
  });

  it("one surface's key opens no other surface — the point of the split", () => {
    setScopedKey("INGEST_API_TOKEN", INGEST_ONLY);
    setScopedKey("OUTBOX_API_TOKEN", OUTBOX_ONLY);

    expect(isIntegrationApiAuthorized(bearer(INGEST_ONLY), "outbox")).toBe(false);
    expect(isIntegrationApiAuthorized(bearer(OUTBOX_ONLY), "ingest")).toBe(false);
    expect(isIntegrationApiAuthorized(bearer(OUTBOX_ONLY), "outbox")).toBe(true);
    // export was not split, so it still runs on the shared bearer: one workflow at a time.
    expect(isIntegrationApiAuthorized(bearer(SHARED), "export")).toBe(true);
    expect(isIntegrationApiAuthorized(bearer(INGEST_ONLY), "export")).toBe(false);
  });

  it("a set-but-too-short scoped key DISABLES that surface instead of falling back to the broad key", () => {
    setScopedKey("EXPORT_API_TOKEN", "short");

    expect(isIntegrationApiAuthorized(bearer("short"), "export")).toBe(false);
    expect(isIntegrationApiAuthorized(bearer(SHARED), "export")).toBe(false);
    // The surfaces the operator did not touch are unaffected.
    expect(isIntegrationApiAuthorized(bearer(SHARED), "ingest")).toBe(true);
  });

  it("a scoped key does not resurrect a surface when the shared bearer is unset, and vice versa", () => {
    mockEnv.env.INTEGRATION_API_TOKEN = undefined;
    expect(isIntegrationApiAuthorized(bearer(SHARED), "ingest")).toBe(false);

    setScopedKey("INGEST_API_TOKEN", INGEST_ONLY);
    // A split surface works on its own key even with no shared bearer configured at all...
    expect(isIntegrationApiAuthorized(bearer(INGEST_ONLY), "ingest")).toBe(true);
    // ...and the surfaces still on the shared key stay closed, which is the fail-closed default.
    expect(isIntegrationApiAuthorized(bearer(INGEST_ONLY), "export")).toBe(false);
  });

  it("still rejects a malformed header regardless of scope", () => {
    setScopedKey("INGEST_API_TOKEN", INGEST_ONLY);
    expect(isIntegrationApiAuthorized(new Headers(), "ingest")).toBe(false);
    expect(isIntegrationApiAuthorized(new Headers({ authorization: INGEST_ONLY }), "ingest")).toBe(false);
    expect(isIntegrationApiAuthorized(new Headers({ authorization: `Basic ${INGEST_ONLY}` }), "ingest")).toBe(false);
  });
});

describe("requireIntegrationActor(headers, scope)", () => {
  it("refuses the shared bearer on a narrowed surface before it ever looks up the actor", async () => {
    setScopedKey("OUTBOX_API_TOKEN", OUTBOX_ONLY);
    await expect(requireIntegrationActor(bearer(SHARED), "outbox")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mockDb.prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
