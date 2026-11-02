// ATW-03 holding eligibility (AC-27..AC-29). Pure: no Prisma and no
// server-only, so client components can import it.

export type EligibilityHolding = {
  symbol: string;
  description?: string | null;
  marketValue?: number | null;
  decision?: string | null;
  isTransferring?: boolean | null;
  ineligible?: boolean;
  cannotTransferInKind?: boolean;
};

export type EligibilityColumns = {
  ineligible: boolean;
  cannot_transfer_in_kind: boolean;
  liquidation_instruction: boolean;
};

export const FULL_ACAT_REFUSED_MESSAGE =
  "Full ACAT is unavailable while an included holding is ineligible or cannot transfer in kind. Leave it behind or choose another funding type.";

/** AC-27: left at the delivering firm when LEAVE_GIFT or not transferring. */
export function includedInInstructions(holding: Pick<EligibilityHolding, "decision" | "isTransferring">): boolean {
  return holding.decision !== "LEAVE_GIFT" && holding.isTransferring !== false;
}

/** AC-28: any included holding that is ineligible or cannot transfer in kind. */
export function fullAcatRefused(enabled: boolean, holdings: readonly EligibilityHolding[]): boolean {
  if (!enabled) return false;
  return holdings.some((holding) =>
    includedInInstructions(holding) && (holding.ineligible === true || holding.cannotTransferInKind === true));
}

/**
 * The three decision columns from the asset-map status (effective_status ??
 * transfer_eligible). AC-29: a liquidation instruction never clears ineligible.
 */
export function eligibilityColumns(status: string | null | undefined): EligibilityColumns {
  const normalized = (status ?? "").trim().toUpperCase();
  const ineligible = normalized !== "ACAT";
  return {
    ineligible,
    cannot_transfer_in_kind: ineligible,
    liquidation_instruction: normalized === "LIQUIDATE",
  };
}
