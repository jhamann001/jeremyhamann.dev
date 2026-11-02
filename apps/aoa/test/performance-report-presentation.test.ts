import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HouseholdAccountsTable } from "@/components/twr/HouseholdAccountsTable";
import {
  PresentationRoundingDisclosure,
  RiskDisclosure,
  RiskReturnPanel,
  TransferredAccountAnalyticsNote,
} from "@/components/twr/report-shared";
import {
  maskedAccountNumber,
  PRESENTATION_ROUNDING_DISCLOSURE,
  signedMetricTone,
} from "@/lib/twr/report-presentation";
import type { TwrRisk } from "@/lib/twr/engine";

const RISK: TwrRisk = {
  annReturn: -5.74,
  periodBasis: "cumulative",
  vol: 23.09,
  sharpe: null,
  sharpeEligible: false,
  sampleFrom: "2025-12-24",
  sampleTo: "2026-07-30",
  maxDrawdown: -16.75,
  bestDay: 2.93,
  worstDay: -13.77,
  positiveDays: 54.5,
  neutralizedDays: 4,
  riskSampleSize: 146,
};

describe("performance report presentation hardening", () => {
  it("uses the actual sign for return tone, including a neutral zero", () => {
    expect(signedMetricTone(7)).toBe("pos");
    expect(signedMetricTone(-5.74)).toBe("neg");
    expect(signedMetricTone(0)).toBeUndefined();
  });

  it("renders a negative cumulative return with the negative tone", () => {
    const html = renderToStaticMarkup(
      React.createElement(RiskReturnPanel, { risk: RISK }),
    );
    expect(html).toMatch(/class="[^"]*neg[^"]*">-5\.74%<\/span>/);
  });

  it("masks custodian account numbers to a fixed last-four display", () => {
    expect(maskedAccountNumber(" XFYGZRN ")).toBe("••••GZRN");
    expect(maskedAccountNumber("12")).toBe("••••12");
    expect(maskedAccountNumber(null)).toBe("••••");
  });

  it("never renders a full account number in the household table", () => {
    const html = renderToStaticMarkup(
      React.createElement(HouseholdAccountsTable, {
        members: [
          {
            apexAcct: "XFYGZRN",
            label: "Joint Brokerage",
            endingValue: 1_069_664.6,
            weightPct: 88,
            sinceInceptionTwr: 0.1,
            costBasisExcluded: false,
          },
        ],
      }),
    );
    expect(html).toContain("••••GZRN");
    expect(html).not.toContain(">XFYGZRN<");
  });

  it("renders the standard rounding disclosure", () => {
    expect(
      renderToStaticMarkup(React.createElement(PresentationRoundingDisclosure)),
    ).toBe(PRESENTATION_ROUNDING_DISCLOSURE);
  });

  it("states the daily-native Sharpe convention when a Sharpe ratio is shown", () => {
    const html = renderToStaticMarkup(
      React.createElement(RiskDisclosure, {
        risk: {
          ...RISK,
          periodBasis: "annualized",
          sharpe: 1.46,
          sharpeEligible: true,
        },
        rf: {
          from: "2025-07-02",
          to: "2026-08-07",
          tenor: "3M",
          source: "us-treasury-daily-par-yield",
          observations: 275,
          expectedBusinessDays: 288,
          coverage: 275 / 288,
          meanPct: 3.89,
          rfAnnual: 0.0389,
          sufficient: true,
        },
      }),
    );
    expect(html).toContain("mean daily excess return");
    expect(html).toContain("annualized using 252 trading days");
  });

  it("explains why transferred-account lot analytics are omitted", () => {
    const html = renderToStaticMarkup(
      React.createElement(TransferredAccountAnalyticsNote),
    );
    expect(html).toContain("Account substantially transferred or closed");
    expect(html).toContain("Use the household report for continuous performance");
  });
});
