import { describe, it, expect, vi } from "vitest";
import {
  processJwtRefresh,
  IDLE_TIMEOUT_SEC,
  type ProcessJwtDeps,
  type AppRole,
} from "./auth-jwt";

function makeDeps(overrides: Partial<ProcessJwtDeps> = {}): ProcessJwtDeps {
  return {
    now: () => 1_000_000,
    findAllowedUser: vi.fn(async () => ({
      active: true,
      role: "USER" as const,
    })),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe("processJwtRefresh", () => {
  it("initializes activity + role markers on first sign-in", async () => {
    const deps = makeDeps();
    const result = await processJwtRefresh(
      { email: "user@example.com" },
      { email: "user@example.com" },
      "signIn",
      deps
    );
    expect(result).not.toBeNull();
    expect(result!.lastActivityAt).toBe(1_000_000);
    expect(result!.lastRoleCheckAt).toBe(1_000_000);
    expect(result!.role).toBe("USER");
    expect(deps.findAllowedUser).toHaveBeenCalledOnce();
  });

  it("returns null when user is no longer in allow-list", async () => {
    const deps = makeDeps({
      findAllowedUser: vi.fn(async () => null),
    });
    const result = await processJwtRefresh(
      { email: "revoked@example.com" },
      { email: "revoked@example.com" },
      "signIn",
      deps
    );
    expect(result).toBeNull();
  });

  it("returns null when user is deactivated", async () => {
    const deps = makeDeps({
      findAllowedUser: vi.fn(async () => ({ active: false, role: "USER" as const })),
    });
    const result = await processJwtRefresh(
      {
        email: "deactivated@example.com",
        lastActivityAt: 999_000,
        lastRoleCheckAt: 0,
      },
      undefined,
      undefined,
      deps
    );
    expect(result).toBeNull();
  });

  it("returns null after idle timeout", async () => {
    const deps = makeDeps({ now: () => 2_000_000 });
    const result = await processJwtRefresh(
      {
        email: "user@example.com",
        role: "USER",
        lastActivityAt: 2_000_000 - IDLE_TIMEOUT_SEC - 1,
        lastRoleCheckAt: 2_000_000 - 60,
      },
      undefined,
      undefined,
      deps
    );
    expect(result).toBeNull();
    expect(deps.findAllowedUser).not.toHaveBeenCalled();
  });

  it("checks the current role even when the cookie was just refreshed", async () => {
    const deps = makeDeps({ now: () => 2_000_000 });
    const lastCheck = 2_000_000;
    const result = await processJwtRefresh(
      {
        email: "user@example.com",
        role: "ADMIN",
        lastActivityAt: 2_000_000 - 10,
        lastRoleCheckAt: lastCheck,
      },
      undefined,
      undefined,
      deps
    );
    expect(result).not.toBeNull();
    expect(deps.findAllowedUser).toHaveBeenCalledOnce();
    expect(result!.role).toBe("USER");
    expect(result!.lastActivityAt).toBe(2_000_000);
  });

  it("refreshes a legacy cookie with an expired role-check marker", async () => {
    const now = 3_000_000;
    const deps = makeDeps({
      now: () => now,
      findAllowedUser: vi.fn(async () => ({ active: true, role: "USER" as const })),
    });
    const result = await processJwtRefresh(
      {
        email: "former-admin@example.com",
        role: "ADMIN",
        lastActivityAt: now - 10,
        lastRoleCheckAt: now - 301,
      },
      undefined,
      undefined,
      deps
    );
    expect(result).not.toBeNull();
    expect(deps.findAllowedUser).toHaveBeenCalledOnce();
    expect(result!.role).toBe("USER");
    expect(result!.lastRoleCheckAt).toBe(now);
  });

  it("invalidates session if no email is available on refresh", async () => {
    const deps = makeDeps();
    const result = await processJwtRefresh({}, undefined, undefined, deps);
    expect(result).toBeNull();
  });

  it.each([0, 301])("invalidates a cookie checked %i seconds ago when the DB lookup fails", async (age) => {
    const now = 3_000_000;
    const deps = makeDeps({
      now: () => now,
      findAllowedUser: vi.fn(async () => {
        throw new Error("Database unavailable");
      }),
    });
    const input = {
      email: "user@example.com",
      role: "ADMIN" as const,
      lastActivityAt: now - 10,
      lastRoleCheckAt: now - age,
    };
    const result = await processJwtRefresh(input, undefined, undefined, deps);

    expect(result).toBeNull();
    expect(deps.findAllowedUser).toHaveBeenCalledOnce();
    expect(deps.log!.warn).toHaveBeenCalled();
  });

  it.each([0, 301])("denies a deactivated user with a role-check marker %i seconds old", async (age) => {
    const now = 3_000_000;
    const deps = makeDeps({
      now: () => now,
      findAllowedUser: vi.fn(async () => ({ active: false, role: "USER" as const })),
    });
    const result = await processJwtRefresh(
      {
        email: "user@example.com",
        role: "USER",
        lastActivityAt: now - 10,
        lastRoleCheckAt: now - age,
      },
      undefined,
      undefined,
      deps
    );
    expect(result).toBeNull();
  });

  it("denies a deleted user even with a freshly issued cookie", async () => {
    const now = 3_000_000;
    const deps = makeDeps({
      now: () => now,
      findAllowedUser: vi.fn(async () => null),
    });
    const result = await processJwtRefresh(
      { email: "user@example.com", role: "USER", lastActivityAt: now, lastRoleCheckAt: now },
      undefined,
      undefined,
      deps
    );
    expect(result).toBeNull();
  });

  it.each([
    ["USER", "ADVISOR"],
    ["ADVISOR", "USER"],
    ["USER", "ADMIN"],
    ["ADMIN", "ADVISOR"],
  ] as const)("uses the current %s → %s role for a fresh cookie", async (oldRole, currentRole) => {
    const now = 3_000_000;
    const deps = makeDeps({
      now: () => now,
      findAllowedUser: vi.fn(async () => ({ active: true, role: currentRole })),
    });
    const result = await processJwtRefresh(
      { email: "User@example.com", role: oldRole, lastActivityAt: now, lastRoleCheckAt: now },
      undefined,
      undefined,
      deps
    );
    expect(deps.findAllowedUser).toHaveBeenCalledWith("user@example.com");
    expect(result?.role).toBe(currentRole);
    expect(result?.lastRoleCheckAt).toBe(now);
  });

  it("does not trust a cached role when the cookie has no identity", async () => {
    const now = 3_000_000;
    const deps = makeDeps({ now: () => now });
    const result = await processJwtRefresh(
      { role: "ADMIN", lastActivityAt: now, lastRoleCheckAt: now },
      undefined,
      undefined,
      deps
    );
    expect(result).toBeNull();
    expect(deps.findAllowedUser).not.toHaveBeenCalled();
  });

  it("denies an unrecognized role instead of granting default ops access", async () => {
    const deps = makeDeps({
      findAllowedUser: vi.fn(async () => ({ active: true, role: "NEW_ROLE" as AppRole })),
    });
    const result = await processJwtRefresh(
      { email: "user@example.com", role: "USER" },
      undefined,
      undefined,
      deps
    );
    expect(result).toBeNull();
    expect(deps.log?.warn).toHaveBeenCalled();
  });

  it("does not accept session updates as a way to bypass idle expiry", async () => {
    const now = 3_000_000;
    const deps = makeDeps({ now: () => now });
    const result = await processJwtRefresh(
      { email: "user@example.com", role: "USER", lastActivityAt: now - IDLE_TIMEOUT_SEC - 1 },
      undefined,
      "update",
      deps
    );
    expect(result).toBeNull();
    expect(deps.findAllowedUser).not.toHaveBeenCalled();
  });
});
