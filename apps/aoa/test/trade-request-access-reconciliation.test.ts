import { describe, expect, it } from "vitest";
import { computeReconciliation, type AoaAccount, type StandaloneIdentity } from "@/lib/trade-requests/access-reconciliation";

const ZERO = { standaloneActive: 0, matched: 0, missing: 0, roleConflicts: 0, ambiguous: 0, rosterMismatches: 0, exceptionCovered: 0, noStandaloneIdentities: 0 };
const NONE = new Set<string>();
const trader = (email: string, isActive = true): StandaloneIdentity => ({ email, role: "trader", isActive });
const advisor = (email: string, isActive = true): StandaloneIdentity => ({ email, role: "advisor", isActive });

const IDENTITIES = [trader("t1@example.test"), trader("t2@example.test"), advisor("a1@example.test")];
const ACCOUNTS: AoaAccount[] = [
  { email: "T1@example.test", role: "ADMIN" },
  { email: "t2@example.test", role: "OPERATIONS" },
  { email: "a1@example.test", role: "ADVISOR" },
];

describe("Trade Request access reconciliation", () => {
  it("passes when every active identity matches a role-consistent account", () => {
    expect(computeReconciliation(IDENTITIES, ACCOUNTS, NONE)).toEqual({ verdict: "passed", counts: { ...ZERO, standaloneActive: 3, matched: 3 } });
  });

  it("fails on a missing AOA account", () => {
    const r = computeReconciliation([...IDENTITIES, advisor("gone@example.test")], ACCOUNTS, NONE);
    expect(r.verdict).toBe("failed");
    expect(r.counts).toMatchObject({ standaloneActive: 4, matched: 3, missing: 1 });
  });

  it("counts a trader holding ADVISOR as a role conflict and a roster mismatch", () => {
    const r = computeReconciliation([trader("x@example.test")], [{ email: "x@example.test", role: "ADVISOR" }], NONE);
    expect(r).toEqual({ verdict: "failed", counts: { ...ZERO, standaloneActive: 1, matched: 1, roleConflicts: 1, rosterMismatches: 1 } });
  });

  it("counts an advisor holding OPERATIONS as a role conflict", () => {
    const r = computeReconciliation([advisor("y@example.test")], [{ email: "y@example.test", role: "OPERATIONS" }], NONE);
    expect(r).toEqual({ verdict: "failed", counts: { ...ZERO, standaloneActive: 1, matched: 1, roleConflicts: 1 } });
  });

  it("counts two AOA accounts on one normalized email as ambiguous", () => {
    const r = computeReconciliation(
      [advisor("dup@example.test")],
      [{ email: "Dup@example.test", role: "ADVISOR" }, { email: "dup@example.test", role: "ADVISOR" }],
      NONE,
    );
    expect(r).toEqual({ verdict: "failed", counts: { ...ZERO, standaloneActive: 1, ambiguous: 1 } });
  });

  it("passes when the only blocking identity is on the exception list", () => {
    const r = computeReconciliation([...IDENTITIES, advisor("gone@example.test")], ACCOUNTS, new Set(["gone@example.test"]));
    expect(r).toEqual({ verdict: "passed", counts: { ...ZERO, standaloneActive: 4, matched: 3, missing: 1, exceptionCovered: 1 } });
  });

  it("ignores inactive identities and matches a previously missing identity once its account exists", () => {
    const identities = [...IDENTITIES, advisor("old@example.test", false), advisor("new@example.test")];
    expect(computeReconciliation(identities, ACCOUNTS, NONE).counts).toMatchObject({ standaloneActive: 4, matched: 3, missing: 1 });
    const later = computeReconciliation(identities, [...ACCOUNTS, { email: " New@Example.test", role: "ADVISOR" }], NONE);
    expect(later).toEqual({ verdict: "passed", counts: { ...ZERO, standaloneActive: 4, matched: 4 } });
  });

  it("fails when there are no standalone identities", () => {
    expect(computeReconciliation([], ACCOUNTS, NONE)).toEqual({ verdict: "failed", counts: { ...ZERO, noStandaloneIdentities: 1 } });
  });

  it("fails when every standalone identity is inactive, even with an exception list", () => {
    const r = computeReconciliation([trader("t1@example.test", false), advisor("a1@example.test", false)], ACCOUNTS, new Set(["t1@example.test"]));
    expect(r).toEqual({ verdict: "failed", counts: { ...ZERO, noStandaloneIdentities: 1 } });
  });

  it("never includes a seeded email in the result", () => {
    const identities = [...IDENTITIES, advisor("gone@example.test"), trader("x@example.test")];
    const accounts: AoaAccount[] = [...ACCOUNTS, { email: "x@example.test", role: "VIEWER" }];
    const text = JSON.stringify(computeReconciliation(identities, accounts, new Set(["gone@example.test"]))).toLowerCase();
    for (const email of [...identities.map((i) => i.email), ...accounts.map((a) => a.email!)]) {
      expect(text).not.toContain(email.toLowerCase());
    }
    expect(text).not.toContain("@example.test");
  });
});
