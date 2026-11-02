import { describe, expect, it } from "vitest";
import {
  globalSearch,
  hrefFor,
  likePattern,
  MIN_QUERY_LENGTH,
} from "@/lib/data/search";

// Pure unit tests for the global-search seam helpers + the length guard. No DB:
// the guard cases short-circuit BEFORE withUserScope opens a transaction, so a
// throwing stub identity proves the query never runs. The DB-backed behavior
// (RLS scoping, ILIKE matching, archived/placeholder exclusion) is covered by
// test/search.integration.test.ts.

describe("likePattern", () => {
  it("wraps an ordinary term in %…%", () => {
    expect(likePattern("smith")).toBe("%smith%");
  });

  it("escapes LIKE metacharacters so they match literally", () => {
    expect(likePattern("50%")).toBe("%50\\%%");
    expect(likePattern("a_b")).toBe("%a\\_b%");
    expect(likePattern("back\\slash")).toBe("%back\\\\slash%");
  });
});

describe("hrefFor", () => {
  it("routes each type to its detail page", () => {
    expect(hrefFor("household", "HH1")).toBe("/households/HH1");
    expect(hrefFor("client", "CL1")).toBe("/client-portrait/CL1");
    expect(hrefFor("deal", "D1")).toBe("/deals/D1");
    expect(hrefFor("transfer", "T1")).toBe("/asset-transfer/T1");
  });
});

describe("globalSearch length guard", () => {
  // If the guard ever regresses, withUserScope would run and this identity
  // would throw — turning a silent whole-book dump into a loud test failure.
  const trapIdentity = new Proxy(
    {},
    {
      get() {
        throw new Error("globalSearch opened a transaction for a short query");
      },
    },
  ) as never;

  it("returns [] for an empty query without querying", async () => {
    await expect(globalSearch(trapIdentity, "")).resolves.toEqual([]);
  });

  it("returns [] for a whitespace-only query", async () => {
    await expect(globalSearch(trapIdentity, "   ")).resolves.toEqual([]);
  });

  it(`returns [] below MIN_QUERY_LENGTH (${MIN_QUERY_LENGTH})`, async () => {
    await expect(globalSearch(trapIdentity, "a")).resolves.toEqual([]);
  });
});
