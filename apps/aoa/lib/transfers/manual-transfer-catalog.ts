/**
 * Snapshot of the Tracker's nine explicit form variants; no fallback resolver.
 * Source: cedar-ridge-wealth/transfer-tracker, src/lib/manual-transfer-forms.ts
 * Commit: 30f0a9efe540a69189bbae016e35119aee0a2d9f (reviewed 2026-09-22).
 * The Tracker remains the catalog owner during this review-only first slice.
 * Institutional requirements must come from the current custodian library.
 * Historical routing and default asset instructions are reference data, never
 * client authorization or permission to populate a form.
 */
export const MANUAL_TRANSFER_CATALOG_VERSION =
  "tracker-catalog@30f0a9efe540a69189bbae016e35119aee0a2d9f";

export type ManualFormTemplateKey =
  | "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST"
  | "EMPOWER_WITHDRAWAL_DIRECT_ROLLOVER_TRANSFER_REQUEST";

export type ApexTransferSelection =
  | "BROKERAGE_FIRM_TRANSFER"
  | "NON_ACAT_TRANSFER"
  | "LIQUIDATE_ALL_ASSETS_TRANSFER_AS_CASH"
  | "LIQUIDATE_ANNUITY_TRANSFER_AS_CASH"
  | "PARTIAL_TRANSFER"
  | "LIQUIDATE_CDS_IMMEDIATELY"
  | "MUTUAL_FUND_COMPANY_TRANSFER"
  | "TRANSFER_CD_PROCEEDS_AT_MATURITY";

export type AssetInstruction = "IN_KIND" | "LIQUIDATE";

export type AssetHandlingRule =
  | { mode: "FIXED"; instruction: AssetInstruction }
  | {
      mode: "CLIENT_DIRECTED";
      options: readonly AssetInstruction[];
      defaultInstruction: AssetInstruction;
      preferredInstruction?: AssetInstruction;
      watchout?: string;
    };

export interface SuggestedDeliveringFirm {
  name: string;
  dtcNumber?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface ManualTransferFormRule {
  /** Stable form-workflow variant identifier; not a custodian identity. */
  id: string;
  /** Exact Custodian.name that owns this workflow. */
  custodianName: string;
  displayName: string;
  template: ManualFormTemplateKey;
  apexTransferSelection?: ApexTransferSelection;
  /** Overrides a historical/default Apex section when the client chooses a different asset instruction. */
  apexTransferSelectionByInstruction?: Partial<
    Record<AssetInstruction, ApexTransferSelection>
  >;
  assetHandling?: AssetHandlingRule;
  apexSignatureRequirement?: "WET_REQUIRED";
  generationSupport?: "AUTOMATED" | "MANUAL_ONLY";
  /** True only for the universal brokerage-firm fallback. */
  isDefaultFallback?: boolean;
  /** Require a user-confirmed receiving/house account before generation. */
  requiresVerifiedReceivingAccountNumber?: boolean;
  /** Historical form values are suggestions; current documentation wins. */
  suggestedDeliveringFirm?: SuggestedDeliveringFirm;
  /** Form-specific implementation guidance, never institutional requirements. */
  note?: string;
}

export const MANUAL_TRANSFER_FORM_RULES: readonly ManualTransferFormRule[] = [
  {
    id: "victory-funds",
    custodianName: "Victory Funds",
    displayName: "Victory Funds",
    template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
    apexTransferSelection: "MUTUAL_FUND_COMPANY_TRANSFER",
    assetHandling: { mode: "FIXED", instruction: "LIQUIDATE" },
    requiresVerifiedReceivingAccountNumber: true,
    note: "Use the mutual fund company section and select Liquidate for every fund. Generate an additional fund list when holdings exceed the rows on the Apex form.",
  },
  {
    id: "t-rowe-price",
    custodianName: "T. Rowe Price / Pershing",
    displayName: "T. Rowe Price",
    template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
    apexTransferSelection: "MUTUAL_FUND_COMPANY_TRANSFER",
    assetHandling: {
      mode: "CLIENT_DIRECTED",
      options: ["IN_KIND", "LIQUIDATE"],
      defaultInstruction: "LIQUIDATE",
      preferredInstruction: "LIQUIDATE",
      watchout: "T. Rowe Price has previously liquidated holdings despite in-kind instructions. Confirm the instruction, but plan for the possibility that cash arrives.",
    },
    apexSignatureRequirement: "WET_REQUIRED",
    note: "Use the mutual fund company section.",
  },
  {
    id: "empower-pershing",
    custodianName: "Empower / Pershing",
    displayName: "Empower via Pershing",
    template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
    apexTransferSelection: "NON_ACAT_TRANSFER",
    apexTransferSelectionByInstruction: {
      LIQUIDATE: "LIQUIDATE_ALL_ASSETS_TRANSFER_AS_CASH",
    },
    suggestedDeliveringFirm: {
      name: "Pershing Advisor Solutions",
      dtcNumber: "0443",
    },
    note: "Use the actual delivering or carrying firm from the current paperwork rather than assuming the client-facing Empower label.",
  },
  {
    id: "empower-direct-rollover",
    custodianName: "Empower / Pershing",
    displayName: "Empower direct rollover",
    template: "EMPOWER_WITHDRAWAL_DIRECT_ROLLOVER_TRANSFER_REQUEST",
    generationSupport: "MANUAL_ONLY",
    note: "Direct rollover is a separate Empower form workflow; do not generate the Apex CATR for this branch.",
  },
  {
    id: "bny-mellon",
    custodianName: "BNY Investments",
    displayName: "BNY Investments",
    template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
    apexTransferSelection: "MUTUAL_FUND_COMPANY_TRANSFER",
    suggestedDeliveringFirm: {
      name: "BNY Mellon Securities Corporation",
      dtcNumber: "5523",
      address: "500 Ross Street, 12th Floor",
      city: "Pittsburgh",
      state: "PA",
      zip: "15262-0001",
    },
  },
  {
    id: "acorns-securities-historical",
    custodianName: "Acorns",
    displayName: "Acorns Securities (historical route)",
    template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
    apexTransferSelection: "BROKERAGE_FIRM_TRANSFER",
    apexTransferSelectionByInstruction: {
      LIQUIDATE: "LIQUIDATE_ALL_ASSETS_TRANSFER_AS_CASH",
    },
    suggestedDeliveringFirm: {
      name: "Acorns Securities, LLC",
      dtcNumber: "0235",
      address: "5300 California Avenue",
      city: "Irvine",
      state: "CA",
    },
    note: "Historical 2026 packets used Acorns Securities directly. Retain this route for audit history and select it only when current documentation supports it.",
  },
  {
    id: "acorns-computershare",
    custodianName: "Acorns",
    displayName: "Acorns via Computershare",
    template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
    apexTransferSelection: "BROKERAGE_FIRM_TRANSFER",
    apexTransferSelectionByInstruction: {
      LIQUIDATE: "LIQUIDATE_ALL_ASSETS_TRANSFER_AS_CASH",
    },
    suggestedDeliveringFirm: {
      name: "Computershare Trust Company, N.A.",
      dtcNumber: "7807",
      address: "PO Box 43006",
      city: "Providence",
      state: "RI",
      zip: "02940",
    },
    note: "A later reviewed Acorns packet routed through Computershare. Select this route only when current documentation supports it.",
  },
  {
    id: "sparrow-growth-funds",
    custodianName: "Sparrow Growth Funds",
    displayName: "Sparrow Growth Funds",
    template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
    apexTransferSelection: "LIQUIDATE_ALL_ASSETS_TRANSFER_AS_CASH",
    apexTransferSelectionByInstruction: {
      IN_KIND: "MUTUAL_FUND_COMPANY_TRANSFER",
    },
    suggestedDeliveringFirm: {
      name: "Sparrow Growth Funds",
      dtcNumber: "5908",
      address: "8000 Town Centre Drive, Suite 400",
      city: "Broadview Heights",
      state: "OH",
      zip: "44147",
    },
    note: "The reviewed example also populated the mutual fund detail section.",
  },
  {
    id: "capital-group-american-funds",
    custodianName: "The Capital Group",
    displayName: "Capital Group / American Funds",
    template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
    apexTransferSelection: "MUTUAL_FUND_COMPANY_TRANSFER",
    suggestedDeliveringFirm: {
      name: "Capital Group / American Funds",
      dtcNumber: "5107",
      address: "PO Box 2560",
      city: "Norfolk",
      state: "VA",
      zip: "23501-2560",
    },
  },
] as const;
