// ATW-04 route labels and paperwork rules (AC-34..AC-36, AC-40). Pure: no
// Prisma and no server-only, so client components can import it.
import type { FundingType } from "@/lib/data/transfer-types";
import {
  MANUAL_TRANSFER_FORM_RULES,
  type ManualTransferFormRule,
} from "@/lib/transfers/manual-transfer-catalog";

export type RouteLabel =
  | "Full ACAT · app authorization · Apex API"
  | "Full ACAT · signed paperwork · Apex API"
  | "Partial ACAT · signed paperwork · Ascend entry"
  | "DRS · Apex service request"
  | "Manual · custodian-library process"
  | "Rollover · physical check"
  | "ACH · client self-service"
  | "Wire · client instructions";

/** AC-36. App authorization and signed paperwork are both ACAT_FULL. */
export function routeLabel(fundingType: FundingType, appAuthorizationRecorded: boolean): RouteLabel {
  switch (fundingType) {
    case "ACAT_FULL":
      return appAuthorizationRecorded
        ? "Full ACAT · app authorization · Apex API"
        : "Full ACAT · signed paperwork · Apex API";
    case "ACAT_PARTIAL":
      return "Partial ACAT · signed paperwork · Ascend entry";
    case "DRS":
      return "DRS · Apex service request";
    case "MANUAL":
      return "Manual · custodian-library process";
    case "CHECK":
      return "Rollover · physical check";
    case "ACH":
      return "ACH · client self-service";
    case "WIRE":
      return "Wire · client instructions";
    default: {
      const unhandled: never = fundingType;
      return unhandled;
    }
  }
}

/** AC-34, AC-35: the signed-paperwork routes need a returned signature. */
export function signatureBlocks(route: RouteLabel, returnedSignatureRecorded: boolean): boolean {
  if (returnedSignatureRecorded) return false;
  switch (route) {
    case "Full ACAT · signed paperwork · Apex API":
    case "Partial ACAT · signed paperwork · Ascend entry":
    case "Manual · custodian-library process":
    case "DRS · Apex service request":
      return true;
    case "Full ACAT · app authorization · Apex API":
    case "Rollover · physical check":
    case "ACH · client self-service":
    case "Wire · client instructions":
      return false;
    default: {
      const unhandled: never = route;
      return unhandled;
    }
  }
}

/** The routes whose paperwork steps (packet sent, returned signature) apply. */
export function routeRequiresSignature(route: RouteLabel): boolean {
  return signatureBlocks(route, false);
}

const text = (value: string | null | undefined) => value?.trim() ?? "";

export function formTitleVersion(receivingFormTitle: string, sourceFormTitle: string): string {
  return JSON.stringify([receivingFormTitle.trim(), sourceFormTitle.trim()]);
}

/**
 * The "Titles printed on the form" section: both titles present, and either
 * unchanged from the verified account titles or changed and confirmed for the
 * current pair.
 */
export function titlesSectionComplete(fields: {
  receivingFormTitle: string | null;
  sourceFormTitle: string | null;
  titleOwnersConfirmed: string | null;
  receivingAccountTitle: string | null;
  sourceAccountTitle: string | null;
}): boolean {
  const receiving = text(fields.receivingFormTitle);
  const source = text(fields.sourceFormTitle);
  if (!receiving || !source) return false;
  const changed = receiving !== text(fields.receivingAccountTitle) ||
    source !== text(fields.sourceAccountTitle);
  return !changed || fields.titleOwnersConfirmed === formTitleVersion(receiving, source);
}

const firmName = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/** AC-40: exact custodian-name match against the catalog; no fallback form. */
export function manualRouteForms(transferringFirm: string | null): readonly ManualTransferFormRule[] {
  if (!transferringFirm?.trim()) return [];
  const wanted = firmName(transferringFirm);
  return MANUAL_TRANSFER_FORM_RULES.filter((rule) => firmName(rule.custodianName) === wanted);
}
