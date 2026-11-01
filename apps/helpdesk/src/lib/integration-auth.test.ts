/**
 * integration-auth.ts unit tests — no database.
 *
 * Covers the four things the machine surface stands on: a constant-time bearer that is FALSE whenever
 * `INTEGRATION_API_TOKEN` is unset (fail-closed), an actor that is the seeded User row and refuses
 * to be invented when that row is missing or deactivated, a post-authentication denial that is one
 * audited row, and an unauthenticated denial that is COALESCED so an internet-reachable probe cannot
 * grow the hash-chained ledger — or hold the global chain lock — one insert at a time.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@/types/domain";
import { captureLogs } from "@/test-support/capture-logs";

const TOKEN = "unit-test-integration-token-0123456789abcdef";

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
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
      createMany: vi.fn(async (args: { data: Record<string, unknown>[] }) => ({ count: args.data.length })),
    },
  },
}));
vi.mock("@/lib/db", () => mockDb);

import { DENIAL_WINDOW_MS, denialThrottleKey, denialThrottleSize, resetDenialThrottle } from "@/lib/denial-throttle";
import { AppError, UnauthorizedError } from "@/lib/errors";
import { RATE_LIMIT_PER_WINDOW, resetRateLimit } from "@/lib/rate-limit";
import {
  ANONYMOUS_INTEGRATION_ACTOR,
  COALESCED_INTEGRATION_DENIAL_REASONS,
  INTEGRATION_ACTOR_ID,
  INTEGRATION_DENIAL_UNAUTHENTICATED,
  type MachineAuthorization,
  integrationActor,
  integrationDenialThrottleKey,
  isIntegrationApiAuthorized,
  machineAuthMetadata,
  machineAuthTokenId,
  recordIntegrationDenied,
  recordUnauthenticatedIntegrationDenial,
  requireIntegrationActor,
  enforceMachineRateLimit,
} from "@/lib/integration-auth";

/** A verified per-consumer credential, and the shared env bearer it is replacing. */
const TOKEN_AUTH: MachineAuthorization = { kind: "token", tokenId: "tok_nightly_sync", scopes: ["INTEGRATION_INGEST"] };
const LEGACY_AUTH: MachineAuthorization = { kind: "legacy" };

const CTX: RequestContext = {
  ipAddress: "203.0.113.11",
  userAgent: "n8n/1.0",
  requestId: "req-machine-0001",
  isPrefetch: false,
};

const SEEDED_ROW = { id: "svc_integration", email: "integration@wm-helpdesk.local", isActive: true };

/** The `data` of the nth audited insert, typed so the assertions below read plainly. */
function auditRow(index: number): Record<string, unknown> {
  const call = mockDb.prisma.auditLog.create.mock.calls[index];
  expect(call, `no audit insert at index ${index}`).toBeDefined();
  return call[0].data;
}

const T0 = new Date("2026-09-19T12:00:00.000Z");
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

beforeEach(() => {
  mockEnv.env.INTEGRATION_API_TOKEN = TOKEN;
  mockDb.prisma.user.findUnique.mockReset();
  mockDb.prisma.auditLog.create.mockReset();
  mockDb.prisma.auditLog.create.mockResolvedValue({});
  // The throttle map is module-global and shared with the client API, so every case starts clean.
  resetDenialThrottle();
  resetRateLimit();
  // Silences the suppressed-denial and suppressed-refusal lines. They go through `@/lib/logger`,
  // which never calls `console` (`console` is the sink CWE-209 watches), so a `console.warn` spy
  // here would suppress nothing. The tests that assert on those lines take their own capture.
  // `vi.restoreAllMocks()` in `afterEach` unhooks it, like any other spy.
  captureLogs();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDenialThrottle();
  resetRateLimit();
});

describe("isIntegrationApiAuthorized", () => {
  it("accepts the exact token, case-insensitively on the scheme", () => {
    expect(isIntegrationApiAuthorized(new Headers({ authorization: `Bearer ${TOKEN}` }))).toBe(true);
    expect(isIntegrationApiAuthorized(new Headers({ Authorization: `bearer ${TOKEN}` }))).toBe(true);
    expect(isIntegrationApiAuthorized(new Headers({ authorization: `  Bearer ${TOKEN}  ` }))).toBe(true);
  });

  it("rejects a wrong, truncated, differently-schemed or missing bearer", () => {
    expect(isIntegrationApiAuthorized(new Headers({ authorization: "Bearer nope" }))).toBe(false);
    expect(isIntegrationApiAuthorized(new Headers({ authorization: `Bearer ${TOKEN.slice(0, -1)}X` }))).toBe(false);
    expect(isIntegrationApiAuthorized(new Headers({ authorization: `Bearer ${TOKEN.slice(0, -1)}` }))).toBe(false);
    expect(isIntegrationApiAuthorized(new Headers({ authorization: `Basic ${TOKEN}` }))).toBe(false);
    expect(isIntegrationApiAuthorized(new Headers({ authorization: TOKEN }))).toBe(false);
    expect(isIntegrationApiAuthorized(new Headers({ authorization: "Bearer " }))).toBe(false);
    expect(isIntegrationApiAuthorized(new Headers())).toBe(false);
  });

  it("is FALSE whenever the key is unset or empty — an unset key disables the surface, never opens it", () => {
    mockEnv.env.INTEGRATION_API_TOKEN = undefined;
    expect(isIntegrationApiAuthorized(new Headers({ authorization: `Bearer ${TOKEN}` }))).toBe(false);
    expect(isIntegrationApiAuthorized(new Headers({ authorization: "Bearer " }))).toBe(false);
    mockEnv.env.INTEGRATION_API_TOKEN = "";
    expect(isIntegrationApiAuthorized(new Headers({ authorization: "Bearer " }))).toBe(false);
  });

  it("does not leak the token's length through an early return", () => {
    // A shorter and a longer candidate both reach the digest compare (equal-length buffers).
    mockEnv.env.INTEGRATION_API_TOKEN = TOKEN;
    expect(isIntegrationApiAuthorized(new Headers({ authorization: "Bearer a" }))).toBe(false);
    expect(isIntegrationApiAuthorized(new Headers({ authorization: `Bearer ${TOKEN}${TOKEN}` }))).toBe(false);
  });
});

describe("integrationActor", () => {
  it("is the seeded row, with ZERO groups — a machine caller holds no RBAC grant of its own", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue(SEEDED_ROW);
    const actor = await integrationActor();
    expect(actor).toEqual({ id: INTEGRATION_ACTOR_ID, email: "integration@wm-helpdesk.local", groups: [] });
    expect(mockDb.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "integration@wm-helpdesk.local" },
      select: { id: true, email: true, isActive: true },
    });
  });

  it("refuses when the row is missing (seed has not run) rather than inventing an actor", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue(null);
    await expect(integrationActor()).rejects.toBeInstanceOf(AppError);
    await expect(integrationActor()).rejects.toMatchObject({ code: "INTERNAL", status: 500 });
  });

  it("refuses a deactivated identity", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue({ ...SEEDED_ROW, isActive: false });
    await expect(integrationActor()).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("is re-read on every call, so a retired identity stops being usable immediately", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue(SEEDED_ROW);
    await integrationActor();
    await integrationActor();
    expect(mockDb.prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("requireIntegrationActor", () => {
  it("resolves the actor for a good bearer", async () => {
    mockDb.prisma.user.findUnique.mockResolvedValue(SEEDED_ROW);
    await expect(requireIntegrationActor(new Headers({ authorization: `Bearer ${TOKEN}` }))).resolves.toEqual({
      id: INTEGRATION_ACTOR_ID,
      email: "integration@wm-helpdesk.local",
      groups: [],
    });
  });

  it("throws UnauthorizedError for a bad bearer and never touches the database", async () => {
    await expect(requireIntegrationActor(new Headers({ authorization: "Bearer nope" }))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(mockDb.prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("recordIntegrationDenied — post-authentication denials, one row each", () => {
  it("writes ONE AUTHZ_DENIED row against the ENDPOINT, with via and the route", async () => {
    await recordIntegrationDenied(CTX, "/api/ingest/tickets", "integration:not-found");
    expect(mockDb.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const row = auditRow(0);
    expect(row.action).toBe("AUTHZ_DENIED");
    expect(row.entityType).toBe("ENDPOINT");
    expect(row.entityId).toBe("/api/ingest/tickets");
    expect(row.ticketId).toBeNull();
    expect(row.fieldChanged).toBe("capability");
    expect(row.newValue).toBe("integration:not-found");
    expect(row.actorId).toBeNull();
    expect(row.actorEmail).toBe(ANONYMOUS_INTEGRATION_ACTOR.email);
    expect(row.metadata).toMatchObject({ via: "api", route: "/api/ingest/tickets" });
  });

  it("is never coalesced — a verified caller's denials each get their own row", async () => {
    for (let i = 0; i < 5; i++) {
      await recordIntegrationDenied(CTX, "/api/integrations/outbox/[id]", "integration:invalid-delivery-id");
    }
    expect(mockDb.prisma.auditLog.create).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) expect(auditRow(i).action).toBe("AUTHZ_DENIED");
    // Nothing about a post-authentication denial touches the throttle map.
    expect(denialThrottleSize()).toBe(0);
  });

  it("points at the ticket when one was addressed, and only sets the FK when it exists", async () => {
    await recordIntegrationDenied(CTX, "/api/ingest/tickets/[id]/messages", "integration:ticket-not-found", {
      ticketId: "tkt_missing",
      ticketExists: false,
    });
    const row = auditRow(0);
    expect(row.entityType).toBe("TICKET");
    expect(row.entityId).toBe("tkt_missing");
    expect(row.ticketId).toBeNull();
  });

  it("sets the FK when the ticket does exist", async () => {
    await recordIntegrationDenied(CTX, "/api/ingest/tickets/[id]/messages", "integration:forbidden", {
      ticketId: "tkt_real",
      ticketExists: true,
    });
    const row = auditRow(0);
    expect(row.ticketId).toBe("tkt_real");
  });

  it("propagates a failed ledger write — an unaudited 401 is never served", async () => {
    mockDb.prisma.auditLog.create.mockRejectedValueOnce(new Error("ledger unavailable"));
    await expect(recordIntegrationDenied(CTX, "/api/ingest/tickets", "integration:not-found")).rejects.toThrow(
      "ledger unavailable",
    );
  });

  it("takes the uncoalesced path when a coalescing reason carries caller-specific detail", async () => {
    // An actor, a ticket or supplementary metadata says something about THIS request; a coalesced row
    // would drop it, so those never coalesce even on a coalescing reason.
    await recordIntegrationDenied(CTX, "/api/ingest/tickets", INTEGRATION_DENIAL_UNAUTHENTICATED, {
      metadata: { tokenPrefixSeen: "abc" },
    });
    await recordIntegrationDenied(CTX, "/api/ingest/tickets", INTEGRATION_DENIAL_UNAUTHENTICATED, {
      ticketId: "tkt_real",
      ticketExists: true,
    });
    expect(mockDb.prisma.auditLog.create).toHaveBeenCalledTimes(2);
    expect(auditRow(0).action).toBe("AUTHZ_DENIED");
    expect(auditRow(1).action).toBe("AUTHZ_DENIED");
    expect(denialThrottleSize()).toBe(0);
  });
});

describe("recordIntegrationDenied — unauthenticated denials are coalesced", () => {
  it("routes the unauthenticated reason to ONE AUTHZ_DENIED_COALESCED row", async () => {
    await recordIntegrationDenied(CTX, "/api/ingest/tickets", INTEGRATION_DENIAL_UNAUTHENTICATED);
    expect(mockDb.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const row = auditRow(0);
    expect(row.action).toBe("AUTHZ_DENIED_COALESCED");
    expect(row.entityType).toBe("ENDPOINT");
    expect(row.entityId).toBe("/api/ingest/tickets");
    expect(row.ticketId).toBeNull();
    expect(row.fieldChanged).toBe("capability");
    expect(row.newValue).toBe("integration:unauthenticated x1");
    expect(row.actorId).toBeNull();
    expect(row.actorEmail).toBe(ANONYMOUS_INTEGRATION_ACTOR.email);
    expect(row.metadata).toMatchObject({ via: "api", route: "/api/ingest/tickets", count: 1 });
  });

  it("a flood of probes from one source writes ONE row, not one per probe", async () => {
    for (let i = 0; i < 500; i++) {
      await recordIntegrationDenied(CTX, "/api/ingest/tickets", INTEGRATION_DENIAL_UNAUTHENTICATED);
    }
    // 500 inserts against a globally chain-locked, append-only ledger would have been 500 advisory-lock
    // acquisitions that every staff write also queues behind.
    expect(mockDb.prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
});

describe("recordUnauthenticatedIntegrationDenial", () => {
  it("records the first denial of a window and suppresses the rest", async () => {
    await recordUnauthenticatedIntegrationDenial(CTX, "/api/export/tickets", at(0));
    await recordUnauthenticatedIntegrationDenial(CTX, "/api/export/tickets", at(1));
    await recordUnauthenticatedIntegrationDenial(CTX, "/api/export/tickets", at(DENIAL_WINDOW_MS - 1));
    expect(mockDb.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(auditRow(0).newValue).toBe("integration:unauthenticated x1");
  });

  it("carries the suppressed count forward, so ONE row states the true number", async () => {
    await recordUnauthenticatedIntegrationDenial(CTX, "/api/export/tickets", at(0));
    for (let i = 1; i <= 9; i++) {
      await recordUnauthenticatedIntegrationDenial(CTX, "/api/export/tickets", at(i));
    }
    await recordUnauthenticatedIntegrationDenial(CTX, "/api/export/tickets", at(DENIAL_WINDOW_MS));
    expect(mockDb.prisma.auditLog.create).toHaveBeenCalledTimes(2);
    // 9 suppressed since the last recorded row, plus this one.
    expect(auditRow(1).newValue).toBe("integration:unauthenticated x10");
    expect(auditRow(1).metadata).toMatchObject({ count: 10, windowStartedAt: at(DENIAL_WINDOW_MS).toISOString() });
  });

  it("windows per route AND per IP — one probed route never suppresses another's first row", async () => {
    await recordUnauthenticatedIntegrationDenial(CTX, "/api/ingest/tickets", at(0));
    await recordUnauthenticatedIntegrationDenial(CTX, "/api/ingest/email", at(1));
    await recordUnauthenticatedIntegrationDenial({ ...CTX, ipAddress: "198.51.100.4" }, "/api/ingest/tickets", at(2));
    expect(mockDb.prisma.auditLog.create).toHaveBeenCalledTimes(3);
    expect(auditRow(0).entityId).toBe("/api/ingest/tickets");
    expect(auditRow(1).entityId).toBe("/api/ingest/email");
    expect(auditRow(2).entityId).toBe("/api/ingest/tickets");
  });

  it("keys into its own namespace, so the client API's window is untouched", () => {
    // The client key is `<route><US><ip>` (denial-throttle.ts uses a 0x1f unit separator); the machine
    // key is that, prefixed. Built from the shared helper so the two can never silently diverge.
    const clientKey = denialThrottleKey("/api/ingest/tickets", "203.0.113.11");
    expect(integrationDenialThrottleKey("/api/ingest/tickets", "203.0.113.11")).toBe(`integration:${clientKey}`);
    expect(integrationDenialThrottleKey("/api/ingest/tickets", "203.0.113.11")).not.toBe(clientKey);
  });

  it("propagates a failed ledger write — an unaudited 401 is never served", async () => {
    mockDb.prisma.auditLog.create.mockRejectedValueOnce(new Error("ledger unavailable"));
    await expect(recordUnauthenticatedIntegrationDenial(CTX, "/api/ingest/tickets", at(0))).rejects.toThrow(
      "ledger unavailable",
    );
  });

  it("logs the suppressed denials instead of dropping them silently", async () => {
    // `integration-auth.ts` now suppresses through `@/lib/logger`, which never calls `console` —
    // `console` is the sink CWE-209 watches — so the line is captured off the stream it is written
    // to. The assertion is stricter than the old `console.warn` spy: severity, logScope, event and
    // the named fields, not a joined string.
    const logs = captureLogs();
    try {
      await recordUnauthenticatedIntegrationDenial(CTX, "/api/ingest/tickets", at(0));
      await recordUnauthenticatedIntegrationDenial(CTX, "/api/ingest/tickets", at(1));
      expect(logs.err).toHaveLength(1);
      expect(logs.err[0]).toMatchObject({
        severity: "WARNING",
        logScope: "integration-api",
        event: "unauthenticated_denial_suppressed",
        route: "/api/ingest/tickets",
        requestId: CTX.requestId,
      });
      expect(logs.out).toEqual([]);
    } finally {
      logs.restore();
    }
  });
});

describe("machineAuthTokenId / machineAuthMetadata — which consumer did this", () => {
  it("names the credential a per-consumer token authenticated", () => {
    expect(machineAuthTokenId(TOKEN_AUTH)).toBe("tok_nightly_sync");
    expect(machineAuthMetadata(TOKEN_AUTH)).toEqual({ tokenId: "tok_nightly_sync" });
  });

  it("contributes NOTHING for the legacy env bearer — absence is the signal, not a placeholder", () => {
    // `MachineAuthorization`'s contract: the ABSENCE of metadata.tokenId is what marks a caller still
    // on the shared env bearer. A `tokenId: null` would make `metadata ? 'tokenId'` useless as the
    // migration's progress bar, and would change every row an env-only deployment writes.
    expect(machineAuthTokenId(LEGACY_AUTH)).toBeNull();
    expect(machineAuthMetadata(LEGACY_AUTH)).toEqual({});
    expect(Object.keys(machineAuthMetadata(LEGACY_AUTH))).toEqual([]);
    expect("tokenId" in machineAuthMetadata(LEGACY_AUTH)).toBe(false);
  });

  it("treats a missing or null authorization as the legacy case", () => {
    expect(machineAuthTokenId(undefined)).toBeNull();
    expect(machineAuthTokenId(null)).toBeNull();
    expect(machineAuthMetadata(undefined)).toEqual({});
    expect(machineAuthMetadata(null)).toEqual({});
  });

  it("returns a fresh object each call, so a caller cannot mutate the next row's metadata", () => {
    const first = machineAuthMetadata(TOKEN_AUTH);
    expect(machineAuthMetadata(TOKEN_AUTH)).not.toBe(first);
    expect(machineAuthMetadata(LEGACY_AUTH)).not.toBe(machineAuthMetadata(LEGACY_AUTH));
  });
});

describe("recordIntegrationDenied — the credential lands on the row", () => {
  it("carries metadata.tokenId when a per-consumer credential verified", async () => {
    await recordIntegrationDenied(CTX, "/api/ingest/tickets", "integration:not-found", { auth: TOKEN_AUTH });
    const row = auditRow(0);
    expect(row.metadata).toMatchObject({ via: "api", route: "/api/ingest/tickets", tokenId: "tok_nightly_sync" });
  });

  it("writes the pre-Wave-B row byte for byte when the caller is on the legacy bearer", async () => {
    await recordIntegrationDenied(CTX, "/api/ingest/tickets", "integration:not-found", { auth: LEGACY_AUTH });
    await recordIntegrationDenied(CTX, "/api/ingest/tickets", "integration:not-found");
    expect(auditRow(0).metadata).toEqual(auditRow(1).metadata);
    expect(auditRow(0).metadata).not.toHaveProperty("tokenId");
  });

  it("keeps the caller's own metadata beside the token id", async () => {
    await recordIntegrationDenied(CTX, "/api/ingest/tickets/[id]/messages", "integration:ticket-not-found", {
      ticketId: "tkt_missing",
      ticketExists: false,
      metadata: { attempted: "reply" },
      auth: TOKEN_AUTH,
    });
    expect(auditRow(0).metadata).toMatchObject({ attempted: "reply", tokenId: "tok_nightly_sync" });
    expect(auditRow(0).entityId).toBe("tkt_missing");
  });

  it("a named credential is caller-specific detail, so it never coalesces", async () => {
    // The reason IS in the coalescing set, but a verified consumer is few and attributable (§3 rule 4)
    // and a coalesced row would drop which one it was.
    await recordIntegrationDenied(CTX, "/api/ingest/tickets", INTEGRATION_DENIAL_UNAUTHENTICATED, {
      auth: TOKEN_AUTH,
    });
    expect(auditRow(0).action).toBe("AUTHZ_DENIED");
    expect(denialThrottleSize()).toBe(0);
  });

  it("a LEGACY authorization does not defeat the flood protection", async () => {
    // The whole point of the empty metadata: passing `auth` on a pre-authentication reason must not
    // turn 500 probes into 500 hash-chained inserts.
    for (let i = 0; i < 500; i++) {
      await recordIntegrationDenied(CTX, "/api/ingest/tickets", INTEGRATION_DENIAL_UNAUTHENTICATED, {
        auth: LEGACY_AUTH,
      });
    }
    expect(mockDb.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(auditRow(0).action).toBe("AUTHZ_DENIED_COALESCED");
  });
});

describe("enforceMachineRateLimit — the refusal row is findable by the same key", () => {
  const spend = async (auth: MachineAuthorization, surface: string) => {
    let last = null as Awaited<ReturnType<typeof enforceMachineRateLimit>>;
    for (let i = 0; i <= RATE_LIMIT_PER_WINDOW; i++) {
      last = await enforceMachineRateLimit(CTX, "/api/ingest/tickets", auth, surface, T0);
    }
    return last;
  };

  it("repeats the token id in metadata, so ONE predicate finds every row a credential caused", async () => {
    const refusal = await spend(TOKEN_AUTH, "ingest");
    expect(refusal).not.toBeNull();
    const row = auditRow(0);
    expect(row.entityId).toBe("tok_nightly_sync");
    expect(row.metadata).toMatchObject({ tokenId: "tok_nightly_sync", surface: "ingest", perInstance: true });
  });

  it("still carries no tokenId for the legacy bearer", async () => {
    const refusal = await spend(LEGACY_AUTH, "ingest");
    expect(refusal).not.toBeNull();
    expect(auditRow(0).entityType).toBe("ENDPOINT");
    expect(auditRow(0).metadata).not.toHaveProperty("tokenId");
  });
});

describe("every unauthenticated machine-route branch uses a coalescing reason", () => {
  /** Every `route.ts` under src/app/api, walked once. */
  function routeFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) routeFiles(full, out);
      else if (entry.name === "route.ts") out.push(full);
    }
    return out;
  }

  it("so no route can reach the uncoalesced path with an unauthenticated probe", () => {
    const files = routeFiles(join(process.cwd(), "src/app/api"));
    expect(files.length).toBeGreaterThan(0);

    // Two spellings of the same guard. Wave B's six machine routes open with
    // `const machineAuth = await authorizeMachineRequest(req.headers, SCOPE);` followed by
    // `if (machineAuth === null) {`; the pre-Wave-B shape is `if (!isIntegrationApiAuthorized(…)) {`.
    // Both are matched so this rule keeps counting branches through the transition and afterwards —
    // a route that stops recording a coalescing denial fails here whichever way it authenticates.
    const guard =
      /(?:!isIntegrationApiAuthorized\([^)]*\)\s*\)|machineAuth === null\))\s*\{([\s\S]{0,800}?)\n\s{2}\}/g;
    const denial = /recordIntegrationDenied\(\s*\w+\s*,\s*\w+\s*,\s*"([^"]+)"/;

    const problems: string[] = [];
    let branches = 0;
    for (const file of files) {
      const code = readFileSync(file, "utf8");
      for (const m of code.matchAll(guard)) {
        branches++;
        const found = denial.exec(m[1]);
        if (found === null) {
          problems.push(`${file}: unauthenticated branch records no denial`);
          continue;
        }
        if (!COALESCED_INTEGRATION_DENIAL_REASONS.has(found[1])) {
          problems.push(`${file}: unauthenticated branch uses uncoalesced reason "${found[1]}"`);
        }
      }
    }
    expect(problems).toEqual([]);
    // The six machine routes, seven guards (outbox/[id] has GET and POST).
    expect(branches).toBeGreaterThanOrEqual(6);
  });

  /**
   * The attribution rule, as a static assertion rather than a convention.
   *
   * `MachineAuthorization` exists so the ledger can answer "which consumer did this" as a query.
   * That is only true if the routes that RESOLVE an authorization also spend it on something that
   * reaches an audit row — and the failure mode is silent: a route that resolves `machineAuth`, spends
   * it on the rate limiter and drops it still compiles, still passes its own tests, and still writes a
   * ledger that says only `svc_integration`. Two things are pinned:
   *
   *  1. every route that authenticates with `authorizeMachineRequest` threads the result into the
   *     ledger (`machineAuthTokenId` into a call context, `machineAuthMetadata` into a metadata
   *     literal, or `auth:` into a denial), and
   *  2. every POST-authentication denial names the credential. A pre-authentication denial must NOT —
   *     no credential verified, there is nothing to name, and it is the coalesced row.
   */
  it("threads the authorization into the ledger wherever one was resolved", () => {
    const files = routeFiles(join(process.cwd(), "src/app/api")).filter((f) =>
      readFileSync(f, "utf8").includes("authorizeMachineRequest("),
    );
    // The three /api/ingest routes, /api/export/tickets and the two /api/integrations/outbox routes.
    expect(files.length).toBeGreaterThanOrEqual(6);

    const threaded = /machineAuthTokenId\(\s*machineAuth\s*\)|machineAuthMetadata\(\s*machineAuth\s*\)|auth:\s*machineAuth\b/;
    const denials = /recordIntegrationDenied\(\s*\w+\s*,\s*\w+\s*,\s*"([^"]+)"([\s\S]{0,400}?)\);/g;

    const problems: string[] = [];
    let checkedDenials = 0;
    for (const file of files) {
      const code = readFileSync(file, "utf8");
      if (!threaded.test(code)) {
        problems.push(`${file}: resolves machineAuth but never puts it on an audit row`);
      }
      for (const m of code.matchAll(denials)) {
        if (COALESCED_INTEGRATION_DENIAL_REASONS.has(m[1])) {
          // The mirror image: a pre-authentication denial has no credential to name, and naming one
          // would take it off the coalesced path and back onto one insert per probe.
          if (/auth:\s*machineAuth\b/.test(m[2])) {
            problems.push(`${file}: pre-authentication denial "${m[1]}" names a credential`);
          }
          continue;
        }
        checkedDenials++;
        if (!/auth:\s*machineAuth\b/.test(m[2])) {
          problems.push(`${file}: post-authentication denial "${m[1]}" is recorded without its credential`);
        }
      }
    }
    expect(problems).toEqual([]);
    // ingest/tickets, ingest/email, ingest/tickets/[id]/messages, outbox/[id].
    expect(checkedDenials).toBeGreaterThanOrEqual(4);
  });
});
