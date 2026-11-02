import { describe, expect, it } from "vitest";
import {
  allocationTotal,
  growthProjection,
  illustrationSnapshot,
  projectedEndingValue,
  rebalanceIllustration,
  retirementIncomeIllustration,
} from "@/lib/client-experience";
import {
  clientExperienceFixtures,
  developmentClientExperienceScenarios,
  initialDevelopmentScenarioId,
} from "@/lib/mock/client-experiences";
import { DEMO_CLIENT_IDS } from "@/lib/data/demo-data-audit";

describe("client portrait experience fixtures", () => {
  it("has valid 100% allocation models for every configured client", () => {
    for (const fixture of Object.values(clientExperienceFixtures)) {
      if (!fixture) continue;
      expect(allocationTotal(fixture.illustration.allocation)).toBe(100);
    }
  });

  it("does not provide a default or unknown-client fallback", () => {
    expect(clientExperienceFixtures.default).toBeUndefined();
    expect(clientExperienceFixtures["REAL-CLIENT-ID"]).toBeUndefined();
  });

  it("configures both experiences for every seeded development client", () => {
    for (const clientId of DEMO_CLIENT_IDS) {
      expect(clientExperienceFixtures[clientId], clientId).toBeDefined();
    }
  });

  it("provides complete synthetic previews for any development client shell", () => {
    const scenarios = developmentClientExperienceScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(4);
    for (const scenario of scenarios) {
      expect(scenario.fixture.dualView.realTime.length).toBeGreaterThan(0);
      expect(scenario.fixture.dualView.historical.length).toBeGreaterThan(0);
      expect(scenario.fixture.dualView.insights.length).toBeGreaterThan(0);
      expect(scenario.accounts.apex.length + scenario.accounts.ext.length).toBeGreaterThan(0);
      expect(allocationTotal(scenario.fixture.illustration.allocation)).toBe(100);
    }
  });

  it("chooses a stable preview without interpreting the CRM client id", () => {
    expect(initialDevelopmentScenarioId("UNKNOWN-DEV-ID"))
      .toBe(initialDevelopmentScenarioId("UNKNOWN-DEV-ID"));
    expect(developmentClientExperienceScenarios().map((scenario) => scenario.id))
      .toContain(initialDevelopmentScenarioId("UNKNOWN-DEV-ID"));
  });
});

describe("illustration calculations", () => {
  it("uses visible Apex and linked external balances for the starting value", () => {
    expect(
      illustrationSnapshot(
        {
          apex: [
            { type: "Brokerage", num: "1", status: "OPEN", value: 1_000_000 },
            { type: "IRA", num: "2", status: "OPEN", value: null },
          ],
          ext: [{ inst: "Bank", type: "Savings", num: "3", balance: 250_000 }],
          bene: [],
          plaidLinked: true,
        },
        900_000,
      ),
    ).toEqual({ apexValue: 1_000_000, externalValue: 250_000, startingValue: 1_250_000 });
  });

  it("uses the configured fallback when no account value is available", () => {
    expect(
      illustrationSnapshot(
        { apex: [], ext: [], bene: [], plaidLinked: false },
        875_000,
      ).startingValue,
    ).toBe(875_000);
  });

  it("compounds deterministically and includes year zero", () => {
    const points = growthProjection(100_000, 6, 10);
    expect(points).toHaveLength(11);
    expect(points[0]).toEqual({ year: 0, value: 100_000 });
    expect(points.at(-1)?.value).toBeCloseTo(179_084.77, 2);
    expect(projectedEndingValue(100_000, 6, 10)).toBeCloseTo(179_084.77, 2);
  });

  it("caps the projection horizon at 50 years", () => {
    expect(growthProjection(100, 5, 99)).toHaveLength(51);
  });

  it("models the retirement-income sample with bounded QCD values", () => {
    const result = retirementIncomeIllustration({
      iraBalance: 3_200_000,
      age: 76,
      qcdAmount: 200_000,
      marginalRatePercent: 24,
    });
    expect(result.rmd).toBeCloseTo(135_021.1, 1);
    expect(result.qcd).toBe(108_000);
    expect(result.taxableRmd).toBeCloseTo(27_021.1, 1);
    expect(result.estimatedTaxSaved).toBe(25_920);
  });

  it("uses incoming cash to reduce drift before modeling taxable rebalance sales", () => {
    const input = {
      portfolioValue: 3_200_000,
      newCash: 500_000,
      current: { Equity: 78, Bonds: 12, Alternatives: 5, Cash: 5 },
      target: { Equity: 65, Bonds: 23, Alternatives: 7, Cash: 5 },
      estimatedTaxRatePercent: 18,
    };
    const cashOnly = rebalanceIllustration({ ...input, moveTowardTargetPercent: 0 });
    const full = rebalanceIllustration({ ...input, moveTowardTargetPercent: 100 });
    expect(cashOnly.taxableSales).toBe(0);
    expect(full.drift).toBeCloseTo(0, 6);
    expect(full.taxableSales).toBeGreaterThan(0);
    expect(full.estimatedTax).toBeCloseTo(full.taxableSales * 0.18, 6);
  });
});
