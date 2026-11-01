/**
 * The client API's scope wiring, as a static assertion over the three route files.
 *
 * The finding this covers: `CLIENT_WRITE` was a scope NO route enforced. Both write surfaces
 * authenticated with `isClientApiAuthorized` — the shared, unrevocable, unattributable environment
 * bearer — while the admin sheet's help text promised "Open tickets and post client messages through
 * /api/client" for a credential that writes never saw. Two consequences followed: B8's per-consumer
 * credential migration could never complete on the client write path, and `machineAuthMetadata`'s
 * progress predicate ("absence of tokenId means still on the shared bearer") would have read true for
 * every POST forever.
 *
 * Static rather than behavioural on purpose. What is being pinned is that no client route can drift
 * BACK onto the legacy-only check, and that each surface asks for its own scope — a property of the
 * source, which a mocked request cannot prove absent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "src/app/api/client/tickets");

const ROUTES = {
  collection: join(ROOT, "route.ts"),
  byId: join(ROOT, "[id]/route.ts"),
  messages: join(ROOT, "[id]/messages/route.ts"),
  byNumber: join(ROOT, "by-number/[number]/route.ts"),
} as const;

function src(which: keyof typeof ROUTES): string {
  return readFileSync(ROUTES[which], "utf8");
}

describe("every /api/client route authenticates through the Wave B pair", () => {
  it("and none of them is still on the legacy-only check", () => {
    for (const which of Object.keys(ROUTES) as (keyof typeof ROUTES)[]) {
      const code = src(which);
      expect(code, `${which} does not use authorizeClientApiRequest`).toContain("authorizeClientApiRequest(");
      expect(code, `${which} still calls isClientApiAuthorized`).not.toContain("isClientApiAuthorized(");
    }
  });

  it("the two WRITE surfaces demand CLIENT_WRITE", () => {
    for (const which of ["collection", "messages"] as const) {
      expect(src(which), `${which} does not demand CLIENT_WRITE`).toMatch(
        /authorizeClientApiRequest\(\s*req\.headers,\s*email,\s*"CLIENT_WRITE"\s*\)/,
      );
    }
  });

  it("the READ surfaces demand no more than CLIENT_READ", () => {
    // The default argument. A read surface that asked for CLIENT_WRITE would refuse a read-only
    // credential — the failure would be closed, but it would make the scope pair meaningless.
    for (const which of ["byId", "byNumber"] as const) {
      expect(src(which)).not.toContain('"CLIENT_WRITE"');
    }
  });

  it("every surface spends the caller's rate-limit budget, so a per-consumer ceiling cannot be walked around", () => {
    expect(src("collection").match(/enforceMachineRateLimit\(/g)?.length).toBe(2); // GET and POST
    expect(src("messages")).toContain("enforceMachineRateLimit(");
    // G7 pins the by-id route to three module ids, so it reaches the limiter through client-view.
    expect(src("byId")).toContain("enforceClientApiRateLimit(");
  });

  it("the two WRITE surfaces thread the credential onto every row they write", () => {
    // `IngestCallContext.tokenId` — absent, never null, for the legacy env bearer, which is exactly
    // what `metadata ? 'tokenId'` reads as "this consumer has not been migrated yet".
    for (const which of ["collection", "messages"] as const) {
      expect(src(which), `${which} drops the tokenId`).toMatch(
        /tokenId:\s*auth\.kind === "token" \? auth\.tokenId : null/,
      );
    }
  });
});
