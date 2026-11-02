import { describe, it, expect, afterEach, vi } from "vitest";

// DEV_LOGIN is the SINGLE switch that selects Credentials+JWT (persona dev
// login) vs Okta+database sessions for the whole app (auth.ts) and the sign-in
// entry points (app/page.tsx, app/login/route.ts). A wrong value is an auth
// bug — a `true` on real prod would swap Okta for the persona picker — so the
// truth table is pinned here. It's evaluated at module load from env, so each
// case resets modules + env and re-imports a fresh copy.
async function devLoginWith(nodeEnv: string, authDevLogin?: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("AUTH_DEV_LOGIN", authDevLogin); // undefined → unset
  const mod = await import("@/lib/auth/mode");
  return mod.DEV_LOGIN;
}

describe("DEV_LOGIN", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is FALSE on a prod build with the flag unset (the prod path)", async () => {
    expect(await devLoginWith("production", undefined)).toBe(false);
  });

  it("is FALSE on a prod build with AUTH_DEV_LOGIN=0", async () => {
    expect(await devLoginWith("production", "0")).toBe(false);
  });

  it("is TRUE on a prod build only with the explicit AUTH_DEV_LOGIN=1 opt-in (aoa-dev)", async () => {
    expect(await devLoginWith("production", "1")).toBe(true);
  });

  it("is TRUE locally regardless of the flag", async () => {
    expect(await devLoginWith("development", undefined)).toBe(true);
    expect(await devLoginWith("development", "0")).toBe(true);
  });
});
