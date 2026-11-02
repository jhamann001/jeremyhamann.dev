import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { listNavigationScope } from "@/lib/navigation/list-scope";

const user = { id: "synthetic-user-1", email: "advisor@example.test", role: "ADVISOR" };
const login = { strategy: "database" as const, key: "synthetic-session-token-one" };

describe("server navigation metadata scope", () => {
  it("is deterministic, opaque, and excludes raw identity", () => {
    const scope = listNavigationScope(user, login)!;
    expect(scope).toMatch(/^[a-f0-9]{64}$/);
    expect(scope).not.toContain(user.id);
    expect(scope).not.toContain(user.email);
    expect(scope).not.toContain(login.key);
    expect(listNavigationScope({ ...user }, { ...login })).toBe(scope);
  });

  it("changes with user ID, exact RLS email, and normalized role", () => {
    const scope = listNavigationScope(user, login);
    expect(listNavigationScope({ ...user, id: "synthetic-user-2" }, login)).not.toBe(scope);
    expect(listNavigationScope({ ...user, email: "other@example.test" }, login)).not.toBe(scope);
    expect(listNavigationScope({ ...user, email: "Advisor@example.test" }, login)).not.toBe(scope);
    expect(listNavigationScope({ ...user, role: "VIEWER" }, login)).not.toBe(scope);
  });

  it("normalizes roles using the same fail-closed RLS boundary", () => {
    const viewer = listNavigationScope({ ...user, role: "VIEWER" }, login);
    expect(listNavigationScope({ ...user, role: "unrecognized" }, login)).toBe(viewer);
    expect(listNavigationScope({ ...user, role: null }, login)).toBe(viewer);
    expect(listNavigationScope({ ...user, role: "HEAD_OF_ADVISORY" }, login))
      .toBe(listNavigationScope({ ...user, role: "OPERATIONS" }, login));
  });

  it.each([null, undefined, {}, { id: null, email: null }, { id: " ", email: " " }])(
    "does not give unidentified users a shared anonymous scope: %s", (input) => {
      expect(listNavigationScope(input, login)).toBeNull();
    },
  );

  it("supports authenticated email-only or ID-only sessions without exposing either", () => {
    expect(listNavigationScope({ email: user.email, role: user.role }, login)).toMatch(/^[a-f0-9]{64}$/);
    expect(listNavigationScope({ id: user.id, role: user.role }, login)).toMatch(/^[a-f0-9]{64}$/);
    expect(listNavigationScope({ id: user.id, role: user.role }, login))
      .not.toBe(listNavigationScope({ email: user.email, role: user.role }, login));
  });

  it("cannot conflate delimiter-containing identities", () => {
    expect(listNavigationScope({ id: "a:b", email: "c", role: "VIEWER" }, login))
      .not.toBe(listNavigationScope({ id: "a", email: "b:c", role: "VIEWER" }, login));
  });

  it("partitions new logins for the same user and separates the two auth strategies", () => {
    const scope = listNavigationScope(user, login);
    expect(listNavigationScope(user, { ...login, key: "synthetic-session-token-two" })).not.toBe(scope);
    expect(listNavigationScope(user, { ...login, strategy: "jwt" })).not.toBe(scope);
  });

  it("does not derive identity from sliding expiry or unrelated session metadata", () => {
    const first = { ...user, expires: "2026-09-14T12:00:00Z", displayName: "Before" };
    const renewed = { ...user, expires: "2026-09-14T16:00:00Z", displayName: "After" };
    expect(listNavigationScope(first, login)).toBe(listNavigationScope(renewed, login));
  });

  it.each([undefined, null, "", " ", 42, {}, "x".repeat(4097)])(
    "fails closed without a bounded server-issued login key: %s", (key) => {
      expect(listNavigationScope(user, { strategy: "database", key })).toBeNull();
    },
  );

  it("has no anonymous/legacy fallback when the login identity is absent", () => {
    expect(listNavigationScope(user, null)).toBeNull();
    expect(listNavigationScope(user, undefined)).toBeNull();
  });
});
