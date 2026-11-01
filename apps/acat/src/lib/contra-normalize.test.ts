import { describe, it, expect } from "vitest";
import { normalizeContra, ALIAS } from "./contra-normalize";

// The alias resolution used by the resolver + combobox: normalize the input,
// then map through ALIAS to the canonical display name.
function canonicalize(name: string): string {
  return ALIAS[normalizeContra(name)] ?? name;
}

describe("normalizeContra", () => {
  it("returns '' for null/undefined/empty", () => {
    expect(normalizeContra(null)).toBe("");
    expect(normalizeContra(undefined)).toBe("");
    expect(normalizeContra("   ")).toBe("");
  });

  it("trims, collapses internal whitespace, drops periods, and lowercases", () => {
    expect(normalizeContra("  E*TRADE  ")).toBe("e*trade");
    expect(normalizeContra("J. P.  Morgan")).toBe("j p morgan");
    expect(normalizeContra("American Enterprise Investment Services Inc."))
      .toBe("american enterprise investment services inc");
  });

  it("maps 'J. P. Morgan' and 'J P Morgan' to the same normalized key", () => {
    expect(normalizeContra("J. P. Morgan")).toBe(normalizeContra("J P Morgan"));
  });
});

describe("ALIAS canonicalization", () => {
  it("resolves 'E*Trade' → 'E*Trade'", () => {
    expect(canonicalize("E*Trade")).toBe("E*Trade");
  });

  it("resolves 'J. P. Morgan' → 'J.P. Morgan'", () => {
    expect(canonicalize("J. P. Morgan")).toBe("J.P. Morgan");
  });

  it("resolves 'American Enterprise Investment Services Inc.' → 'Ameriprise Financial Services'", () => {
    expect(canonicalize("American Enterprise Investment Services Inc."))
      .toBe("Ameriprise Financial Services");
  });

  it("resolves 'Sparrow Advisors' → 'Sparrow Growth Funds'", () => {
    expect(canonicalize("Sparrow Advisors")).toBe("Sparrow Growth Funds");
  });

  it("leaves an unknown name unchanged", () => {
    expect(canonicalize("Betterment")).toBe("Betterment");
  });
});
