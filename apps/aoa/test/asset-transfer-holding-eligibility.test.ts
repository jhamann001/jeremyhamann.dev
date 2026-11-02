import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markCase } from "./acat-book-flywheel";

vi.mock("@/app/(authenticated)/asset-transfer/actions", () => ({
  setCashInFlight: vi.fn(),
  setChecklistFlag: vi.fn(),
}));

vi.mock("@/components/transfers/TransferPlanDraftProvider", () => ({
  useTransferPlanDraft: () => ({
    canEdit: true,
    pending: false,
    fundingType: null,
    setFundingType: vi.fn(),
  }),
}));

import { partialAcatInstructionsChanged } from "@/lib/data/transfer-plan-approval";
import { InstructionList } from "@/components/asset-transfer/mapping/InstructionList";
import {
  chooseFundingType,
  DecisionChecklistCard,
} from "@/components/transfers/DecisionChecklistCard";
import {
  eligibilityColumns,
  fullAcatRefused,
  includedInInstructions,
  type EligibilityHolding,
} from "@/lib/transfers/holding-eligibility";

const SUITE = "asset-transfer-holding-eligibility";

const mapped = (positions: unknown[]) => ({
  source: "asset-map",
  assetMap: { sourceAccountFingerprint: "a".repeat(64), statementDate: "2026-09-20" },
  positions,
});

const cardMarkup = (holdings: EligibilityHolding[], enabled: boolean) =>
  renderToStaticMarkup(createElement(DecisionChecklistCard, {
    transferId: "t-1",
    accountsOpenedAtApex: false,
    fundingInitiated: false,
    cashInFlight: false,
    canWrite: true,
    showReadiness: false,
    eligibilityEnabled: enabled,
    eligibilityHoldings: holdings,
  }));

const acatFullOptionDisabled = (markup: string) =>
  /<option value="ACAT_FULL" disabled=""/.test(markup);

describe("asset transfer holding eligibility", () => {
  it("leave-gift-off-instructions", () => {
    const holdings: EligibilityHolding[] = [
      { symbol: "SYN-IN", decision: "BRING_IN", isTransferring: true },
      { symbol: "SYN-GIFT", decision: "LEAVE_GIFT" },
      { symbol: "SYN-STAY", isTransferring: false },
    ];
    const markup = renderToStaticMarkup(createElement(InstructionList, { holdings, enabled: true }));
    expect(markup).toContain('data-symbol="SYN-IN"');
    expect(markup).not.toContain('data-symbol="SYN-GIFT"');
    expect(markup).not.toContain('data-symbol="SYN-STAY"');
    expect(includedInInstructions({ decision: "LEAVE_GIFT" })).toBe(false);
    expect(includedInInstructions({ isTransferring: false })).toBe(false);

    const rows = [
      { symbol: "SYN-A", isTransferring: true },
      { symbol: "SYN-B", isTransferring: false },
    ];
    expect(partialAcatInstructionsChanged(mapped(rows), mapped([...rows, { symbol: "SYN-C", isTransferring: false }]))).toBe(true);
    expect(partialAcatInstructionsChanged(mapped(rows), mapped([rows[0]]))).toBe(true);
    markCase(SUITE, "leave-gift-off-instructions");
  });

  it("in-kind-refuses-full-acat", () => {
    const ineligible: EligibilityHolding[] = [{ symbol: "SYN-X", isTransferring: true, ineligible: true }];
    const inKind: EligibilityHolding[] = [{ symbol: "SYN-Y", isTransferring: true, cannotTransferInKind: true }];
    expect(fullAcatRefused(true, ineligible)).toBe(true);
    expect(fullAcatRefused(true, inKind)).toBe(true);
    expect(fullAcatRefused(true, [{ symbol: "SYN-Y", decision: "LEAVE_GIFT", cannotTransferInKind: true }])).toBe(false);

    const list = renderToStaticMarkup(createElement(InstructionList, { holdings: inKind, enabled: true }));
    expect(list).toContain('data-refused="ACAT_FULL"');
    expect(acatFullOptionDisabled(cardMarkup(inKind, true))).toBe(true);

    const setFundingType = vi.fn();
    const setError = vi.fn();
    chooseFundingType("ACAT_FULL", true, setFundingType, setError);
    expect(setFundingType).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(expect.stringContaining("Full ACAT is unavailable"));
    chooseFundingType("ACAT_PARTIAL", true, setFundingType, setError);
    expect(setFundingType).toHaveBeenCalledWith("ACAT_PARTIAL");
    markCase(SUITE, "in-kind-refuses-full-acat");
  });

  it("liquidation-keeps-ineligible", () => {
    expect(eligibilityColumns(" liquidate ")).toEqual({
      ineligible: true,
      cannot_transfer_in_kind: true,
      liquidation_instruction: true,
    });
    expect(eligibilityColumns("LIQUIDATE").ineligible).toBe(true);
    expect(eligibilityColumns("ACAT")).toEqual({
      ineligible: false,
      cannot_transfer_in_kind: false,
      liquidation_instruction: false,
    });
    markCase(SUITE, "liquidation-keeps-ineligible");
  });

  it("flag-off", () => {
    const inKind: EligibilityHolding[] = [{ symbol: "SYN-Y", isTransferring: true, cannotTransferInKind: true }];
    expect(fullAcatRefused(false, inKind)).toBe(false);
    expect(acatFullOptionDisabled(cardMarkup(inKind, false))).toBe(false);
    const list = renderToStaticMarkup(createElement(InstructionList, { holdings: inKind, enabled: false }));
    expect(list).not.toContain('data-refused="ACAT_FULL"');
    const setFundingType = vi.fn();
    chooseFundingType("ACAT_FULL", fullAcatRefused(false, inKind), setFundingType, vi.fn());
    expect(setFundingType).toHaveBeenCalledWith("ACAT_FULL");
    expect(eligibilityColumns("NON-ACAT").cannot_transfer_in_kind).toBe(true);
    markCase(SUITE, "flag-off");
  });
});
