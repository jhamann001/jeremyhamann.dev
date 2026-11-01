import { describe, expect, it } from "vitest";
import {
  MANUAL_TRANSFER_FORM_RULES,
  buildManualTransferFormRecommendation,
  getApexTransferSelection,
  getManualTransferFormRule,
  getManualTransferFormRulesForCustodian,
  getAssetHandlingRule,
  parseRequiredFlag,
} from "./manual-transfer-forms";

const tRowePricePlaybook = {
  id: "CUST-TROWE",
  name: "T. Rowe Price / Pershing",
  signature: "Wet only",
  letterOfAcceptance: "Required",
  medallionRequired: "Required",
  liquidationMethod: "Check",
  returnMethod: "Email / fax",
  watchouts: "Apex signs the paperwork.",
};

describe("manual transfer form rules", () => {
  it.each([
    "ACAT",
    "MANUAL",
    "PAPERWORK",
    "DRS",
    "RESIDUAL",
    "UNCLASSIFIED",
  ])("offers reviewed paperwork for the %s workflow", (transferWorkflow) => {
    const recommendation = buildManualTransferFormRecommendation(
      { transferWorkflow, dtccNumber: "0443" },
      tRowePricePlaybook
    );

    expect(recommendation.status).toBe("ACTION_REQUIRED");
    expect(recommendation.candidates[0]?.id).toBe("t-rowe-price");
  });

  it("resolves workflows from the linked Custodian name", () => {
    expect(getManualTransferFormRulesForCustodian("Victory Funds")).toHaveLength(1);
    expect(
      getManualTransferFormRulesForCustodian("T. Rowe Price / Pershing")[0]?.id
    ).toBe("t-rowe-price");
    expect(getManualTransferFormRulesForCustodian("Acorns")).toHaveLength(2);
    expect(getManualTransferFormRulesForCustodian("Unknown Contra")).toEqual([]);
  });

  it("keeps both reviewed Acorns routes explicit and suggested", () => {
    const historical = getManualTransferFormRule("acorns-securities-historical");
    const current = getManualTransferFormRule("acorns-computershare");

    expect(historical?.suggestedDeliveringFirm?.name).toBe("Acorns Securities, LLC");
    expect(historical?.suggestedDeliveringFirm?.dtcNumber).toBe("0235");
    expect(current?.suggestedDeliveringFirm?.name).toBe(
      "Computershare Trust Company, N.A."
    );
    expect(current?.suggestedDeliveringFirm?.dtcNumber).toBe("7807");
  });

  it("separates Empower/Pershing from Empower direct rollover", () => {
    const workflows = getManualTransferFormRulesForCustodian("Empower / Pershing");
    expect(workflows.map((rule) => rule.template)).toEqual([
      "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
      "EMPOWER_WITHDRAWAL_DIRECT_ROLLOVER_TRANSFER_REQUEST",
    ]);
    expect(
      getManualTransferFormRule("empower-pershing")?.suggestedDeliveringFirm
        ?.dtcNumber
    ).toBe("0443");
  });

  it("makes Victory liquidation a fixed current form instruction", () => {
    const victory = getManualTransferFormRule("victory-funds");
    expect(victory?.assetHandling).toEqual({
      mode: "FIXED",
      instruction: "LIQUIDATE",
    });
    expect(victory?.apexTransferSelection).toBe("MUTUAL_FUND_COMPANY_TRANSFER");
    expect(victory?.requiresVerifiedReceivingAccountNumber).toBe(true);

    const recommendation = buildManualTransferFormRecommendation(
      { transferWorkflow: "MANUAL", dtccNumber: "5686" },
      {
        ...tRowePricePlaybook,
        name: "Victory Funds",
        receivingAccountNumber: "DEMOOMNI01",
      }
    );
    expect(recommendation.actions).toContainEqual(
      expect.objectContaining({ code: "VERIFY_RECEIVING_ACCOUNT_NUMBER" })
    );
    expect(recommendation.custodian?.receivingAccountNumber).toBe(
      "DEMOOMNI01"
    );
  });

  it("makes T. Rowe Price client-directed and flags its unique Apex wet signature", () => {
    const tRowePrice = getManualTransferFormRule("t-rowe-price");
    expect(tRowePrice?.assetHandling).toEqual(
      expect.objectContaining({
        mode: "CLIENT_DIRECTED",
        options: ["IN_KIND", "LIQUIDATE"],
        defaultInstruction: "LIQUIDATE",
        preferredInstruction: "LIQUIDATE",
      })
    );
    expect(tRowePrice?.assetHandling).toHaveProperty(
      "watchout",
      expect.stringContaining("previously liquidated")
    );
    expect(tRowePrice?.apexSignatureRequirement).toBe("WET_REQUIRED");
    expect(JSON.stringify(tRowePrice)).not.toMatch(/revision/i);
    expect(
      MANUAL_TRANSFER_FORM_RULES.filter(
        (rule) => rule.apexSignatureRequirement === "WET_REQUIRED"
      ).map((rule) => rule.id)
    ).toEqual(["t-rowe-price"]);
  });

  it("assumes in kind for other workflows but still requires confirmation", () => {
    const bnyMellon = getManualTransferFormRule("bny-mellon");
    expect(bnyMellon && getAssetHandlingRule(bnyMellon)).toEqual({
      mode: "CLIENT_DIRECTED",
      options: ["IN_KIND", "LIQUIDATE"],
      defaultInstruction: "IN_KIND",
    });
    const recommendation = buildManualTransferFormRecommendation(
      { transferWorkflow: "MANUAL", dtccNumber: "5523" },
      { ...tRowePricePlaybook, name: "BNY Investments" }
    );
    expect(recommendation.actions).toContainEqual(
      expect.objectContaining({ code: "CONFIRM_ASSET_INSTRUCTION" })
    );
  });

  it("uses a standard brokerage fallback for custodians without a specialized rule", () => {
    const recommendation = buildManualTransferFormRecommendation(
      {
        transferWorkflow: "ACAT",
        transferringContra: "Charles Schwab",
        dtccNumber: "0164",
      },
      { ...tRowePricePlaybook, name: "Charles Schwab" }
    );
    const fallback = recommendation.candidates[0];

    expect(recommendation.status).toBe("ACTION_REQUIRED");
    expect(fallback).toEqual(
      expect.objectContaining({
        id: "default-brokerage-firm-transfer",
        displayName: "Standard brokerage transfer",
        isDefaultFallback: true,
      })
    );
    expect(fallback && getApexTransferSelection(fallback, "IN_KIND")).toBe(
      "BROKERAGE_FIRM_TRANSFER"
    );
    expect(fallback && getApexTransferSelection(fallback, "LIQUIDATE")).toBe(
      "LIQUIDATE_ALL_ASSETS_TRANSFER_AS_CASH"
    );
    expect(fallback && getAssetHandlingRule(fallback)).toEqual({
      mode: "CLIENT_DIRECTED",
      options: ["IN_KIND", "LIQUIDATE"],
      defaultInstruction: "IN_KIND",
    });
    expect(recommendation.actions).toContainEqual(
      expect.objectContaining({
        code: "VERIFY_DEFAULT_BROKERAGE_WORKFLOW",
      })
    );
  });

  it("keeps the standard form available for unlinked legacy records", () => {
    const recommendation = buildManualTransferFormRecommendation(
      {
        transferWorkflow: "UNCLASSIFIED",
        transferringContra: "Legacy Brokerage",
        dtccNumber: null,
      },
      null
    );

    expect(recommendation.candidates[0]).toEqual(
      expect.objectContaining({
        id: "default-brokerage-firm-transfer",
        custodianName: "Legacy Brokerage",
      })
    );
    expect(recommendation.actions).toContainEqual(
      expect.objectContaining({ code: "VERIFY_UNLINKED_CUSTODIAN" })
    );
  });

  it("keeps the Apex section consistent with the client instruction", () => {
    const acorns = getManualTransferFormRule("acorns-computershare");
    const sparrow = getManualTransferFormRule("sparrow-growth-funds");
    expect(acorns && getApexTransferSelection(acorns, "IN_KIND")).toBe(
      "BROKERAGE_FIRM_TRANSFER"
    );
    expect(acorns && getApexTransferSelection(acorns, "LIQUIDATE")).toBe(
      "LIQUIDATE_ALL_ASSETS_TRANSFER_AS_CASH"
    );
    expect(sparrow && getApexTransferSelection(sparrow)).toBe(
      "MUTUAL_FUND_COMPANY_TRANSFER"
    );
    expect(sparrow && getApexTransferSelection(sparrow, "LIQUIDATE")).toBe(
      "LIQUIDATE_ALL_ASSETS_TRANSFER_AS_CASH"
    );
  });

  it("keeps Empower direct rollovers documented but out of generation scope", () => {
    expect(
      getManualTransferFormRule("empower-direct-rollover")?.generationSupport
    ).toBe("MANUAL_ONLY");
    const recommendation = buildManualTransferFormRecommendation(
      { transferWorkflow: "MANUAL", dtccNumber: "0443" },
      { ...tRowePricePlaybook, name: "Empower / Pershing" }
    );
    expect(recommendation.candidates.map((candidate) => candidate.id)).toEqual([
      "empower-pershing",
    ]);
    expect(recommendation.actions).not.toContainEqual(
      expect.objectContaining({ code: "SELECT_FORM_WORKFLOW" })
    );
  });

  it("hydrates institutional requirements only from the Custodian playbook", () => {
    const recommendation = buildManualTransferFormRecommendation(
      { transferWorkflow: "MANUAL", dtccNumber: "0443" },
      tRowePricePlaybook
    );

    expect(recommendation.custodian).toBe(tRowePricePlaybook);
    expect(recommendation.custodian).toEqual(
      expect.objectContaining({
        signature: "Wet only",
        letterOfAcceptance: "Required",
        medallionRequired: "Required",
        liquidationMethod: "Check",
        returnMethod: "Email / fax",
        watchouts: "Apex signs the paperwork.",
      })
    );
    for (const rule of MANUAL_TRANSFER_FORM_RULES) {
      expect(rule).not.toHaveProperty("signature");
      expect(rule).not.toHaveProperty("letterOfAcceptance");
      expect(rule).not.toHaveProperty("medallionRequired");
      expect(rule).not.toHaveProperty("liquidationMethod");
      expect(rule).not.toHaveProperty("returnMethod");
      expect(rule).not.toHaveProperty("watchouts");
    }
  });

  it("requires the T. Rowe Price client instruction without overriding it", () => {
    const recommendation = buildManualTransferFormRecommendation(
      { transferWorkflow: "MANUAL", dtccNumber: "0443" },
      tRowePricePlaybook
    );
    expect(recommendation.status).toBe("ACTION_REQUIRED");
    expect(recommendation.actions).toContainEqual(
      expect.objectContaining({ code: "CONFIRM_ASSET_INSTRUCTION" })
    );
  });

  it.each([
    "Joint Account (JTWROS - Rights of Survivorship)",
    "Joint Account (TIC - Tenants in Common)",
    "JTWROS",
  ])(
    "requires two client signatures for the joint account type %s",
    (accountType) => {
      const recommendation = buildManualTransferFormRecommendation(
        { transferWorkflow: "ACAT", accountType, dtccNumber: "0443" },
        tRowePricePlaybook
      );

      expect(recommendation.secondaryClientSignatureRequired).toBe(true);
      expect(recommendation.actions).toContainEqual({
        code: "REQUIRE_SECONDARY_CLIENT_SIGNATURE",
        message: expect.stringMatching(/second client signature is mandatory/i),
      });
    }
  );

  it("does not add a second-signature requirement to an individual account", () => {
    const recommendation = buildManualTransferFormRecommendation(
      {
        transferWorkflow: "ACAT",
        accountType: "Brokerage / Individual",
        dtccNumber: "0443",
      },
      tRowePricePlaybook
    );

    expect(recommendation.secondaryClientSignatureRequired).toBe(false);
    expect(recommendation.actions).not.toContainEqual(
      expect.objectContaining({
        code: "REQUIRE_SECONDARY_CLIENT_SIGNATURE",
      })
    );
  });

  it.each([
    "Inherited Traditional IRA (w/ beneficiaries)",
    "Inherited Roth IRA",
  ])("requires a title comparison for the inherited account type %s", (accountType) => {
    const recommendation = buildManualTransferFormRecommendation(
      { transferWorkflow: "ACAT", accountType, dtccNumber: "0443" },
      tRowePricePlaybook
    );

    expect(recommendation.inheritedAccountTitleReviewRequired).toBe(true);
    expect(recommendation.actions).toContainEqual({
      code: "VERIFY_INHERITED_ACCOUNT_TITLES",
      message: expect.stringMatching(
        /if it differs.*letter of authorization is required/i
      ),
    });
  });

  it("does not add an inherited-title review to a standard IRA", () => {
    const recommendation = buildManualTransferFormRecommendation(
      {
        transferWorkflow: "ACAT",
        accountType: "Traditional IRA",
        dtccNumber: "0443",
      },
      tRowePricePlaybook
    );

    expect(recommendation.inheritedAccountTitleReviewRequired).toBe(false);
    expect(recommendation.actions).not.toContainEqual(
      expect.objectContaining({
        code: "VERIFY_INHERITED_ACCOUNT_TITLES",
      })
    );
  });

  it("surfaces a DTC discrepancy and never silently overwrites it", () => {
    const recommendation = buildManualTransferFormRecommendation(
      { transferWorkflow: "MANUAL", dtccNumber: "9999" },
      { ...tRowePricePlaybook, name: "BNY Investments" }
    );
    expect(recommendation.discrepancies).toEqual([
      expect.objectContaining({
        field: "dtcNumber",
        recordedValue: "9999",
        suggestedValue: "5523",
      }),
    ]);
    expect(recommendation.sourceGuidance.join(" ")).toMatch(
      /current client-specific documentation wins/i
    );
  });

  it("does not silently coerce ambiguous requirement text", () => {
    expect(parseRequiredFlag("Required")).toBe(true);
    expect(parseRequiredFlag("Not required")).toBe(false);
    expect(parseRequiredFlag("Yes")).toBe(true);
    expect(parseRequiredFlag("No")).toBe(false);
    expect(parseRequiredFlag("Unknown")).toBeNull();
    expect(parseRequiredFlag("Not required / Required")).toBeNull();
    expect(parseRequiredFlag(null)).toBeNull();
  });

  it("has unique workflow ids", () => {
    const ids = MANUAL_TRANSFER_FORM_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
