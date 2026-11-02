import { describe, it, expect } from "vitest";
import {
  normalizeName,
  scoreCandidate,
  scoreHouseholdName,
  tier,
  matchHousehold,
  AUTO_LINK_MIN,
  AUTO_LINK_MIN_SHARED_TOKENS,
  REVIEW_MIN,
  AMBIGUITY_MARGIN,
  COHESION_BONUS,
  MAX_CANDIDATES,
  type ClientCandidate,
  type TierInput,
} from "@/lib/data/asset-map-match";

// lib/data/asset-map-match is PURE (no "server-only", no DB) — imported and
// exercised directly with plain values.

function client(over: Partial<ClientCandidate> = {}): ClientCandidate {
  return {
    clientSfId: "c1",
    householdSfId: "h1",
    cedarRidgeUserId: "e1",
    firstName: "John",
    lastName: "Smith",
    ...over,
  };
}

describe("normalizeName — multi-person split + shared-surname carry", () => {
  it('splits "A + B Surname" and carries the shared surname onto the first person', () => {
    const n = normalizeName("Alfreda + Reynold Hayes");
    expect(n.people.map((p) => p.tokens)).toEqual([
      ["alfreda", "hayes"],
      ["reynold", "hayes"],
    ]);
    expect(n.people[0]).toMatchObject({ first: "alfreda", last: "hayes" });
    expect(n.isEntity).toBe(false);
  });

  it('splits on "&", " and ", and "," too', () => {
    expect(normalizeName("Alfreda & Reynold Hayes").people.map((p) => p.tokens)).toEqual([
      ["alfreda", "hayes"],
      ["reynold", "hayes"],
    ]);
    expect(normalizeName("Alfreda and Reynold Hayes").people.map((p) => p.tokens)).toEqual([
      ["alfreda", "hayes"],
      ["reynold", "hayes"],
    ]);
    // Comma is a person delimiter per the design (§3.2).
    expect(normalizeName("Marisol Nguyen, Stacey Nguyen").people.map((p) => p.tokens)).toEqual([
      ["marisol", "nguyen"],
      ["stacey", "nguyen"],
    ]);
  });

  it("does NOT carry a surname when the first person already has two tokens", () => {
    const n = normalizeName("John Doe + Willie Roe");
    expect(n.people.map((p) => p.tokens)).toEqual([
      ["john", "doe"],
      ["willie", "roe"],
    ]);
  });
});

describe("normalizeName — suffix / honorific / entity stripping", () => {
  it("strips suffixes (Jr/Sr/III) and honorifics (Dr)", () => {
    expect(normalizeName("Dr. John Smith Jr.").people[0].tokens).toEqual(["john", "smith"]);
    expect(normalizeName("Abelardo Becker III").people[0].tokens).toEqual(["abelardo", "becker"]);
  });

  it("strips trust/entity boilerplate and flags isEntity", () => {
    const n = normalizeName("Smith Family Revocable Trust");
    expect(n.isEntity).toBe(true);
    expect(n.people).toEqual([{ first: "smith", last: null, tokens: ["smith"] }]);
  });

  it("drops punctuation, lowercases, collapses whitespace, handles apostrophes/hyphens", () => {
    // Apostrophes are removed (O'Brien → obrien); hyphens split to tokens
    // (Alexys-Anne → alexys, anne) per cleanTokens.
    expect(normalizeName("  Alexys-Anne   O'Brien  ").people[0].tokens).toEqual([
      "alexys",
      "anne",
      "obrien",
    ]);
  });

  it("null / empty / pure-boilerplate → no people", () => {
    expect(normalizeName(null).people).toEqual([]);
    expect(normalizeName("   ").people).toEqual([]);
    expect(normalizeName("The Trust LLC").people).toEqual([]);
    expect(normalizeName("The Trust LLC").isEntity).toBe(true);
  });
});

describe("scoreCandidate — token-set Jaccard (names primary)", () => {
  it("exact name match → 1.0, with the shared-token count", () => {
    const r = scoreCandidate(normalizeName("John Smith"), client());
    expect(r.nameSimilarity).toBe(1);
    expect(r.score).toBe(1);
    expect(r.sharedTokens).toBe(2); // john + smith
  });

  it("a lone-surname household shares only ONE token (Fix 1 gate input)", () => {
    // {hayes} vs client {hayes} → Jaccard 1.0 but only 1 shared token.
    const r = scoreCandidate(
      normalizeName("Hayes"),
      client({ firstName: "Hayes", lastName: null }),
    );
    expect(r.nameSimilarity).toBe(1);
    expect(r.sharedTokens).toBe(1);
  });

  it("partial overlap (shared surname only) → the Jaccard fraction", () => {
    // {john,smith} vs {willie,smith}: ∩ = {smith}=1, ∪ = 3 → 1/3.
    const r = scoreCandidate(normalizeName("John Smith"), client({ firstName: "Willie" }));
    expect(r.nameSimilarity).toBeCloseTo(1 / 3, 6);
  });

  it("no overlap → 0", () => {
    const r = scoreCandidate(
      normalizeName("John Smith"),
      client({ firstName: "Stacey", lastName: "Xavier" }),
    );
    expect(r.score).toBe(0);
  });

  it("multi-person household scores its BEST person against the client", () => {
    // "Alfreda + Reynold Hayes" vs client "Reynold Hayes" → the Reynold person is 1.0.
    const r = scoreCandidate(
      normalizeName("Alfreda + Reynold Hayes"),
      client({ firstName: "Reynold", lastName: "Hayes" }),
    );
    expect(r.nameSimilarity).toBe(1);
  });

  it("corroboration only NUDGES a name score, never carries it", () => {
    const base = scoreCandidate(normalizeName("John Smith"), client({ firstName: "Willie" }));
    const nudged = scoreCandidate(normalizeName("John Smith"), client({ firstName: "Willie" }), {
      corroboration: 1,
    });
    expect(nudged.score).toBeGreaterThan(base.score);
    // A pure-corroboration, zero-name match cannot reach the review floor.
    const noName = scoreCandidate(
      normalizeName("John Smith"),
      client({ firstName: "Stacey", lastName: "Xavier" }),
      { corroboration: 1 },
    );
    expect(noName.score).toBeLessThan(REVIEW_MIN);
  });
});

describe("scoreHouseholdName — coarse household-name corroborator", () => {
  it("matches a surname-only household name as a fraction of the people tokens", () => {
    // people {alfreda,reynold,hayes} vs hh {hayes} → 1/3.
    expect(scoreHouseholdName(normalizeName("Alfreda + Reynold Hayes"), "Hayes")).toBeCloseTo(
      1 / 3,
      6,
    );
  });

  it("empty household name → 0", () => {
    expect(scoreHouseholdName(normalizeName("John Smith"), null)).toBe(0);
  });
});

describe("tier — CONSERVATIVE auto-link policy", () => {
  // A clean auto-linkable base; each case overrides one facet of the conjunction.
  const t = (over: Partial<TierInput> = {}): ReturnType<typeof tier> =>
    tier({
      rawBest: 0.97,
      confidence: 0.97,
      runnerUpOtherHousehold: null,
      sharedTokens: 2,
      isEntity: false,
      ...over,
    });

  it("single near-exact, ≥2 shared tokens, no rival, not entity → AUTO_LINKED", () => {
    expect(t()).toBe("AUTO_LINKED");
    expect(t({ rawBest: AUTO_LINK_MIN, confidence: AUTO_LINK_MIN })).toBe("AUTO_LINKED");
  });

  it("a rival household within the RAW margin → NEEDS_REVIEW (never auto on ambiguity)", () => {
    // raw 0.97 vs 0.95 → margin 0.02 < AMBIGUITY_MARGIN → ambiguous.
    expect(t({ runnerUpOtherHousehold: 0.95 })).toBe("NEEDS_REVIEW");
  });

  it("a rival BEYOND the raw margin → AUTO_LINKED", () => {
    expect(t({ runnerUpOtherHousehold: 0.97 - AMBIGUITY_MARGIN })).toBe("AUTO_LINKED");
  });

  it("Fix 1 — a single shared token caps at NEEDS_REVIEW even at confidence 1.0", () => {
    expect(t({ rawBest: 1, confidence: 1, sharedTokens: 1 })).toBe("NEEDS_REVIEW");
    expect(t({ sharedTokens: AUTO_LINK_MIN_SHARED_TOKENS })).toBe("AUTO_LINKED");
  });

  it("Fix 2 — an entity household never AUTO_LINKS (caps at NEEDS_REVIEW)", () => {
    expect(t({ isEntity: true })).toBe("NEEDS_REVIEW");
  });

  it("Fix 3 — ambiguity uses the RAW score, not the cohesion-boosted confidence", () => {
    // Winner raw 0.80; cohesion lifts confidence to 0.95 (clears AUTO_LINK_MIN).
    // A rival at raw 0.78 → RAW margin 0.02 < AMBIGUITY_MARGIN → NEEDS_REVIEW.
    // (The old bug compared 0.95−0.78=0.17 and would have AUTO_LINKED.)
    expect(
      t({ rawBest: 0.8, confidence: 0.95, runnerUpOtherHousehold: 0.78 }),
    ).toBe("NEEDS_REVIEW");
    // Same lifted confidence, no rival → cohesion CAN carry it to AUTO_LINKED.
    expect(t({ rawBest: 0.8, confidence: 0.95, runnerUpOtherHousehold: null })).toBe(
      "AUTO_LINKED",
    );
  });

  it("mid-confidence → NEEDS_REVIEW; low → UNMATCHED", () => {
    expect(t({ rawBest: 0.7, confidence: 0.7 })).toBe("NEEDS_REVIEW");
    expect(t({ rawBest: REVIEW_MIN, confidence: REVIEW_MIN })).toBe("NEEDS_REVIEW");
    expect(t({ rawBest: 0.4, confidence: 0.4 })).toBe("UNMATCHED");
  });
});

describe("matchHousehold — normalize → score → cohesion → tier", () => {
  it("single unambiguous exact match → AUTO_LINKED with resolved ids", () => {
    const r = matchHousehold(normalizeName("John Smith"), [
      client({ clientSfId: "c1", householdSfId: "h1", cedarRidgeUserId: "e1" }),
    ]);
    expect(r.status).toBe("AUTO_LINKED");
    expect(r.confidence).toBe(1);
    expect(r).toMatchObject({ clientSfId: "c1", householdSfId: "h1", cedarRidgeUserId: "e1" });
  });

  it("two identical names in DIFFERENT households → ambiguous → NEEDS_REVIEW, ids NULL", () => {
    const r = matchHousehold(normalizeName("John Smith"), [
      client({ clientSfId: "c1", householdSfId: "h1" }),
      client({ clientSfId: "c2", householdSfId: "h2" }),
    ]);
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.clientSfId).toBeNull();
    expect(r.householdSfId).toBeNull();
    expect(r.cedarRidgeUserId).toBeNull();
    // Confidence is still reported for the queue/ordering.
    expect(r.confidence).toBe(1);
    expect(r.candidates).toHaveLength(2);
  });

  it("spouses in the SAME household are cohesion, NOT ambiguity → AUTO_LINKED", () => {
    const r = matchHousehold(normalizeName("Alfreda + Reynold Hayes"), [
      client({ clientSfId: "c1", householdSfId: "hB", firstName: "Alfreda", lastName: "Hayes" }),
      client({ clientSfId: "c2", householdSfId: "hB", firstName: "Reynold", lastName: "Hayes" }),
    ]);
    expect(r.status).toBe("AUTO_LINKED");
    expect(r.householdSfId).toBe("hB");
    expect(r.confidence).toBe(1);
  });

  it("mid-confidence single match → NEEDS_REVIEW with NULL ids", () => {
    // person {john,william,smith} vs client {john,smith} → 2/3 ≈ 0.667.
    const r = matchHousehold(normalizeName("John William Smith"), [
      client({ clientSfId: "c1", firstName: "John", lastName: "Smith" }),
    ]);
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.confidence).toBeCloseTo(2 / 3, 6);
    expect(r.clientSfId).toBeNull();
  });

  it("no candidates → UNMATCHED, confidence null", () => {
    const r = matchHousehold(normalizeName("John Smith"), []);
    expect(r.status).toBe("UNMATCHED");
    expect(r.confidence).toBeNull();
    expect(r.candidates).toEqual([]);
  });

  it("no parseable people → UNMATCHED, confidence null", () => {
    const r = matchHousehold(normalizeName("The Trust LLC"), [client()]);
    expect(r.status).toBe("UNMATCHED");
    expect(r.confidence).toBeNull();
  });

  it("candidates are ranked desc and capped at MAX_CANDIDATES", () => {
    const many: ClientCandidate[] = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) =>
      client({ clientSfId: `c${i}`, householdSfId: `h${i}`, firstName: "John", lastName: "Smith" }),
    );
    const r = matchHousehold(normalizeName("John Smith"), many);
    expect(r.candidates).toHaveLength(MAX_CANDIDATES);
    const scores = r.candidates.map((c) => c.score.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores); // already descending
  });
});
