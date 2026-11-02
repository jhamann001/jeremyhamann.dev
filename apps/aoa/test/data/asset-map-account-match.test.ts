import { describe, it, expect } from "vitest";
import { matchAccountOwners } from "@/lib/data/asset-map-account-match";
import type { ClientCandidate } from "@/lib/data/asset-map-match";

// Pure matcher — plain values, no DB, no mocks (the asset-map-match.test.ts idiom).
// The matcher reuses the P2.1 normalizer + Jaccard scoring + tier() constants,
// scoped to the folder's household members.

const john: ClientCandidate = {
  clientSfId: "cJohn",
  householdSfId: "h1",
  cedarRidgeUserId: "eJohn",
  firstName: "John",
  lastName: "Smith",
};
const jane: ClientCandidate = {
  clientSfId: "cJane",
  householdSfId: "h1",
  cedarRidgeUserId: "eJane",
  firstName: "Willie",
  lastName: "Smith",
};
const household = [john, jane];

describe("multi-person split → two JOINT owners", () => {
  it("'John & Willie Smith' resolves both spouses, both pre-selected, role JOINT", () => {
    const r = matchAccountOwners("John & Willie Smith", household);
    expect(r.isEntity).toBe(false);
    expect(r.owners).toHaveLength(2);
    expect(r.owners.every((o) => o.role === "JOINT")).toBe(true);
    expect(r.owners.every((o) => o.preSelected)).toBe(true);
    expect(new Set(r.owners.map((o) => o.client.clientSfId))).toEqual(
      new Set(["cJohn", "cJane"]),
    );
    expect(r.status).toBe("AUTO_LINKED");
    expect(r.notInHousehold).toBe(false);
  });
});

describe("entity short-circuit", () => {
  it("'Smith Family Revocable Trust' → entity, NEEDS_REVIEW, no owners, residual candidates listed", () => {
    const r = matchAccountOwners("Smith Family Revocable Trust", household);
    expect(r.isEntity).toBe(true);
    expect(r.status).toBe("NEEDS_REVIEW"); // never AUTO
    expect(r.owners).toEqual([]); // entity pre-selects the "no person" option
    // Residual "smith" still lists the household members as pickable candidates.
    expect(r.candidates.length).toBeGreaterThan(0);
  });
});

describe("scoping to household members only", () => {
  it("a firm client outside the passed members pool is never a candidate", () => {
    const stranger: ClientCandidate = {
      clientSfId: "cStranger",
      householdSfId: "hX",
      cedarRidgeUserId: "eX",
      firstName: "John",
      lastName: "Smith",
    };
    // stranger is NOT in the pool — only the real household member is scored.
    const r = matchAccountOwners("John Smith", [john]);
    expect(r.candidates.map((c) => c.client.clientSfId)).not.toContain("cStranger");
    expect(r.candidates.every((c) => c.client.clientSfId === "cJohn")).toBe(true);
    void stranger;
  });
});

describe("tiering", () => {
  it("unambiguous single individual, ≥2 shared tokens → AUTO_LINKED, PRIMARY, one owner", () => {
    const r = matchAccountOwners("John Smith", [john]);
    expect(r.status).toBe("AUTO_LINKED");
    expect(r.owners).toHaveLength(1);
    expect(r.owners[0].role).toBe("PRIMARY");
    expect(r.owners[0].score.sharedTokens).toBeGreaterThanOrEqual(2);
  });

  it("lone single-token overlap → NEEDS_REVIEW (the shared-token gate blocks AUTO)", () => {
    const cher: ClientCandidate = {
      clientSfId: "cCher",
      householdSfId: "h1",
      cedarRidgeUserId: "eCher",
      firstName: "Cher",
      lastName: null,
    };
    const r = matchAccountOwners("Cher", [cher]);
    expect(r.status).toBe("NEEDS_REVIEW");
    expect(r.owners).toHaveLength(1);
    expect(r.owners[0].score.sharedTokens).toBe(1);
  });

  it("no member clears REVIEW_MIN → UNMATCHED, no owners", () => {
    const r = matchAccountOwners("Adan Nobody", [john]);
    expect(r.status).toBe("UNMATCHED");
    expect(r.owners).toEqual([]);
  });
});

describe("D-j — holder not in the resolved household", () => {
  it("a parsed person with no in-pool member → notInHousehold + NEEDS_REVIEW", () => {
    const r = matchAccountOwners("John Smith & Adan Bins", household);
    expect(r.notInHousehold).toBe(true);
    expect(r.status).toBe("NEEDS_REVIEW"); // forced off AUTO
    // The resolvable spouse is still an owner (mixed case).
    expect(r.owners.map((o) => o.client.clientSfId)).toEqual(["cJohn"]);
  });
});

describe("role derivation", () => {
  it("1 → PRIMARY, 2 → JOINT, entity → ENTITY; CUSTODIAN/BENEFICIARY never produced", () => {
    const one = matchAccountOwners("John Smith", [john]);
    expect(one.owners[0].role).toBe("PRIMARY");

    const two = matchAccountOwners("John & Willie Smith", household);
    expect(two.owners.every((o) => o.role === "JOINT")).toBe(true);

    const ent = matchAccountOwners("Smith Family Trust", household);
    expect(ent.isEntity).toBe(true);

    // No derived role is ever CUSTODIAN or BENEFICIARY.
    const allRoles = [
      ...one.owners,
      ...two.owners,
      ...one.candidates,
      ...two.candidates,
      ...ent.candidates,
    ].map((c) => c.role);
    expect(allRoles).not.toContain("CUSTODIAN");
    expect(allRoles).not.toContain("BENEFICIARY");
  });
});

describe("determinism", () => {
  it("candidate order does not change the verdict (stable sort)", () => {
    const a = matchAccountOwners("John & Willie Smith", [john, jane]);
    const b = matchAccountOwners("John & Willie Smith", [jane, john]);
    expect(b.status).toBe(a.status);
    expect(new Set(b.owners.map((o) => o.client.clientSfId))).toEqual(
      new Set(a.owners.map((o) => o.client.clientSfId)),
    );
  });
});
