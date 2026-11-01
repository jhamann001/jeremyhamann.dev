/**
 * Form-specific rules for transfer paperwork.
 *
 * Institutional requirements are intentionally absent from this catalog.
 * LOA, medallion, client signature, return method, liquidation guidance, and
 * watchouts come from the linked Custodian record at recommendation time.
 */

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

export interface CustodianPlaybookSource {
  id: string;
  name: string;
  receivingAccountNumber?: string | null;
  signature?: string | null;
  letterOfAcceptance?: string | null;
  medallionRequired?: string | null;
  liquidationMethod?: string | null;
  returnMethod?: string | null;
  watchouts?: string | null;
}

export interface ManualTransferRecordSource {
  transferWorkflow?: string | null;
  accountType?: string | null;
  transferringContra?: string | null;
  dtccNumber?: string | null;
}

export interface RecommendationAction {
  code:
    | "SELECT_FORM_WORKFLOW"
    | "CONFIRM_ASSET_INSTRUCTION"
    | "VERIFY_DEFAULT_BROKERAGE_WORKFLOW"
    | "VERIFY_UNLINKED_CUSTODIAN"
    | "VERIFY_RECEIVING_ACCOUNT_NUMBER"
    | "REQUIRE_SECONDARY_CLIENT_SIGNATURE"
    | "VERIFY_INHERITED_ACCOUNT_TITLES"
    | "VERIFY_DTC_AGAINST_CURRENT_DOCUMENTATION";
  message: string;
}

export interface RecommendationDiscrepancy {
  field: "dtcNumber";
  recordedValue: string;
  suggestedValue: string;
  message: string;
}

export interface ManualTransferFormRecommendation {
  status: "READY" | "ACTION_REQUIRED";
  custodian: CustodianPlaybookSource | null;
  candidates: readonly ManualTransferFormRule[];
  actions: RecommendationAction[];
  discrepancies: RecommendationDiscrepancy[];
  inheritedAccountTitleReviewRequired: boolean;
  secondaryClientSignatureRequired: boolean;
  sourceGuidance: readonly string[];
}

const SOURCE_GUIDANCE = [
  "Treat DTC, address, and routing values as suggestions; current client-specific documentation wins.",
  "Generate holdings from the current source documents. If holdings changed after the statement, revise the packet using the current holdings.",
] as const;

const DEFAULT_ASSET_HANDLING: AssetHandlingRule = {
  mode: "CLIENT_DIRECTED",
  options: ["IN_KIND", "LIQUIDATE"],
  defaultInstruction: "IN_KIND",
};

function isJointAccountType(accountType?: string | null): boolean {
  const normalized = accountType?.trim().toLowerCase() ?? "";
  return (
    /\bjoint\b/.test(normalized) ||
    /\bjtwros\b/.test(normalized) ||
    /\btenants in common\b/.test(normalized) ||
    /\btic\b/.test(normalized)
  );
}

function isInheritedAccountType(accountType?: string | null): boolean {
  return /\binherited\b/.test(accountType?.trim().toLowerCase() ?? "");
}

/**
 * Reviewed historical workflows plus confirmed current Ops corrections.
 * Multiple entries for one custodian are deliberate when the record does not
 * yet contain enough structured data to choose a route safely.
 */
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

export function getManualTransferFormRule(id: string): ManualTransferFormRule | null {
  return MANUAL_TRANSFER_FORM_RULES.find((rule) => rule.id === id) ?? null;
}

/** Resolve by linked Custodian.name; never by a second alias/key system. */
export function getManualTransferFormRulesForCustodian(
  custodianName: string
): readonly ManualTransferFormRule[] {
  const normalized = custodianName.trim().toLocaleLowerCase();
  return MANUAL_TRANSFER_FORM_RULES.filter(
    (rule) => rule.custodianName.toLocaleLowerCase() === normalized
  );
}

export function getAssetHandlingRule(
  rule: ManualTransferFormRule
): AssetHandlingRule {
  return rule.assetHandling ?? DEFAULT_ASSET_HANDLING;
}

export function getApexTransferSelection(
  rule: ManualTransferFormRule,
  instruction?: AssetInstruction
): ApexTransferSelection | null {
  const handling = getAssetHandlingRule(rule);
  const resolvedInstruction =
    instruction ??
    (handling.mode === "FIXED"
      ? handling.instruction
      : handling.defaultInstruction);
  return (
    rule.apexTransferSelectionByInstruction?.[resolvedInstruction] ??
    rule.apexTransferSelection ??
    null
  );
}

function createDefaultBrokerageFormRule(
  deliveringFirmName?: string | null
): ManualTransferFormRule {
  const custodianName = deliveringFirmName?.trim() || "Delivering firm";
  return {
    id: "default-brokerage-firm-transfer",
    custodianName,
    displayName: "Standard brokerage transfer",
    template: "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
    apexTransferSelection: "BROKERAGE_FIRM_TRANSFER",
    apexTransferSelectionByInstruction: {
      LIQUIDATE: "LIQUIDATE_ALL_ASSETS_TRANSFER_AS_CASH",
    },
    assetHandling: DEFAULT_ASSET_HANDLING,
    isDefaultFallback: true,
    note: `No custodian-specific form rule is configured for ${custodianName}. Brokerage Firm Transfer is selected by default; verify it against the current client request.`,
  };
}

function normalizeDtc(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  return trimmed.padStart(4, "0");
}

export function buildManualTransferFormRecommendation(
  record: ManualTransferRecordSource,
  custodian: CustodianPlaybookSource | null
): ManualTransferFormRecommendation {
  const inheritedAccountTitleReviewRequired = isInheritedAccountType(
    record.accountType
  );
  const secondaryClientSignatureRequired = isJointAccountType(
    record.accountType
  );
  const reviewedCandidates = custodian
    ? getManualTransferFormRulesForCustodian(custodian.name).filter(
        (rule) => rule.generationSupport !== "MANUAL_ONLY"
      )
    : [];
  const usesDefaultFallback = reviewedCandidates.length === 0;
  const candidates = usesDefaultFallback
    ? [
        createDefaultBrokerageFormRule(
          custodian?.name ?? record.transferringContra
        ),
      ]
    : reviewedCandidates;

  const actions: RecommendationAction[] = [];
  if (secondaryClientSignatureRequired) {
    actions.push({
      code: "REQUIRE_SECONDARY_CLIENT_SIGNATURE",
      message:
        "Joint account: a second client signature is mandatory. Both account holders must sign the transfer form and any populated letter of authorization.",
    });
  }
  if (inheritedAccountTitleReviewRequired) {
    actions.push({
      code: "VERIFY_INHERITED_ACCOUNT_TITLES",
      message:
        "Inherited account: confirm the exact delivering title from the current statement. If it differs from the receiving Apex title, the letter of authorization is required and will be populated.",
    });
  }
  if (usesDefaultFallback) {
    actions.push({
      code: "VERIFY_DEFAULT_BROKERAGE_WORKFLOW",
      message:
        "A custodian-specific form rule is not on file. Brokerage Firm Transfer is selected by default; confirm it against the current client request.",
    });
  }
  if (!custodian) {
    actions.push({
      code: "VERIFY_UNLINKED_CUSTODIAN",
      message:
        "No Custodian Library record is linked. Verify the delivering firm and current documentation before generating.",
    });
  }
  if (
    candidates.some(
      (candidate) => candidate.requiresVerifiedReceivingAccountNumber
    )
  ) {
    actions.push({
      code: "VERIFY_RECEIVING_ACCOUNT_NUMBER",
      message:
        "Verify the receiving/house account number with Apex MF Ops before generating. The Custodian Library value is the last successful value and may have changed.",
    });
  }
  if (candidates.length > 1) {
    actions.push({
      code: "SELECT_FORM_WORKFLOW",
      message: "Select the form workflow supported by the current client documentation.",
    });
  }
  if (
    candidates.some(
      (candidate) => getAssetHandlingRule(candidate).mode === "CLIENT_DIRECTED"
    )
  ) {
    actions.push({
      code: "CONFIRM_ASSET_INSTRUCTION",
      message: "Confirm whether the client directed an in-kind transfer or liquidation before generating the form.",
    });
  }

  const recordDtc = normalizeDtc(record.dtccNumber);
  const suggestedDtcs = new Set(
    candidates
      .map((candidate) =>
        normalizeDtc(candidate.suggestedDeliveringFirm?.dtcNumber)
      )
      .filter((value): value is string => value !== null)
  );
  const discrepancies: RecommendationDiscrepancy[] = [];
  if (recordDtc && suggestedDtcs.size === 1 && !suggestedDtcs.has(recordDtc)) {
    const [suggestedValue] = [...suggestedDtcs];
    discrepancies.push({
      field: "dtcNumber",
      recordedValue: recordDtc,
      suggestedValue,
      message: "The transfer DTC differs from the historical form suggestion. Verify the current client documentation; do not overwrite it automatically.",
    });
    actions.push({
      code: "VERIFY_DTC_AGAINST_CURRENT_DOCUMENTATION",
      message: "Review the DTC discrepancy against current client-specific documentation.",
    });
  }

  return {
    status: actions.length > 0 ? "ACTION_REQUIRED" : "READY",
    custodian,
    candidates,
    actions,
    discrepancies,
    inheritedAccountTitleReviewRequired,
    secondaryClientSignatureRequired,
    sourceGuidance: SOURCE_GUIDANCE,
  };
}

/**
 * Convert an existing free-text playbook value into a strict yes/no when a
 * downstream form field requires one. Ambiguous values remain unresolved.
 */
export function parseRequiredFlag(
  value: string | null | undefined
): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "required" || normalized === "yes") return true;
  if (normalized === "not required" || normalized === "no") return false;
  return null;
}
