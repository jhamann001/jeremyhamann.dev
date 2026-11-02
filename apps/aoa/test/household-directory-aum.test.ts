import { describe, expect, it } from "vitest";
import { directoryAumState } from "@/components/households/directory-aum";

describe("household directory AUM rollout state", () => {
  it("withholds only the employee-excluded figure for unresolved household-held ownership", () => {
    const split = { total: 125, firm: 25, employee: 20, available: true, employeeScopeComplete: false };
    expect(directoryAumState(split).total).toBe(100);
    expect(directoryAumState(split, true).available).toBe(false);
  });
  it("keeps an empty or non-current aggregate unavailable rather than coercing it to $0", () => {
    expect(directoryAumState({ total: null, firm: null, employee: null, available: false }, true)).toEqual({
      available: false, total: null, firm: null, employee: null,
    });
  });

  it("always excludes corporate funds and includes employees by default", () => {
    expect(directoryAumState({ total: 125, firm: 25, employee: 20, available: true })).toEqual({
      available: true, total: 100, firm: 25, employee: 20,
    });
  });

  it("subtracts active employee funds once when the toggle is selected", () => {
    expect(directoryAumState({ total: 125, firm: 25, employee: 20, available: true }, true).total).toBe(80);
  });

  it("retains pennies and the sign of negative balances", () => {
    expect(directoryAumState({ total: 100.03, firm: 10.01, employee: 0.01, available: true }, true).total).toBe(90.01);
    expect(directoryAumState({ total: 100, firm: -25, employee: -20, available: true }, true).total).toBe(145);
    expect(directoryAumState({ total: -100, firm: 25, employee: 20, available: true }, true).total).toBe(-145);
  });

  it("does not treat missing employee classification totals as zero", () => {
    expect(directoryAumState({ total: 125, firm: 25, employee: null, available: true }, true).available).toBe(false);
  });
});
