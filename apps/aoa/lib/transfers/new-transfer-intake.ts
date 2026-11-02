// Client-safe: the mockup's New transfer intake (source account, receiving
// account and proposed movement path) and its validation.
import type { FundingType } from "@/lib/data/transfer-types";

export const INTAKE_ACCOUNT_TYPES = [
  "Individual", "Joint", "Traditional IRA", "Roth IRA", "Employer retirement plan", "Trust", "Bank account",
] as const;
export const RECEIVING_ACCOUNT_TYPES = INTAKE_ACCOUNT_TYPES.filter(
  (type) => type !== "Employer retirement plan" && type !== "Bank account",
);

export const INTAKE_ROUTES = [
  { value: "paper_acat", label: "Full ACAT · signed paperwork", fundingType: "ACAT_FULL" },
  { value: "app_acat", label: "Full ACAT · app authorization", fundingType: "ACAT_FULL" },
  { value: "partial_acat", label: "Partial ACAT", fundingType: "ACAT_PARTIAL" },
  { value: "manual", label: "Manual transfer", fundingType: "MANUAL" },
  { value: "drs", label: "DRS · Apex service request", fundingType: "DRS" },
  { value: "rollover_check", label: "Rollover check", fundingType: "CHECK" },
  { value: "ach", label: "ACH · cash only", fundingType: "ACH" },
  { value: "wire", label: "Wire · cash only", fundingType: "WIRE" },
] as const satisfies readonly { value: string; label: string; fundingType: FundingType }[];
export type IntakeRoute = (typeof INTAKE_ROUTES)[number]["value"];

/** An existing account the dialog offers, taken from another transfer of the same client. */
export type ExistingIntakeAccount = { transferId: string; institution: string | null; type: string | null; last4: string | null; title: string | null };
export type ExistingReceivingAccount = { transferId: string; label: string; type: string | null; title: string | null };

export type ValidIntake = {
  source: { institution: string; type: string; last4: string; title: string };
  receiving: { type: string; title: string; label: string; open: boolean };
  fundingType: FundingType;
};

export type IntakeError = { field: string; message: string };

function oneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/**
 * The workspace intake, chosen from AOA records: a directory client, an
 * optional deal, a source account from the client's asset map or the deal
 * (or left for Operations to link from the asset map), a delivering firm from
 * the custodian library, and an Apex account or a new one to open.
 */
export type ConnectedIntakeInput = {
  clientSfId: string;
  dealId: string;
  sourceMode: string;
  assetMapAccountId: string;
  sourceType: string;
  deliveringCustodianId: string;
  destinationMode: string;
  apexAccountKey: string;
  destinationType: string;
  destinationTitle: string;
  route: string;
};

export const CONNECTED_SOURCE_MODES = ["asset_map", "deal", "pending"] as const;
export type ConnectedSourceMode = (typeof CONNECTED_SOURCE_MODES)[number];

export type IntakeSourceFacts = { institution: string | null; type: string | null; last4: string | null; title: string | null };

/** What the server resolved for the submitted ids. A missing entry means the id did not resolve. */
export type ConnectedIntakeContext = {
  clientName: string;
  deal: { accountLast4: string | null; transferringFirm: string | null } | null;
  assetMap: IntakeSourceFacts | null;
  apexReceiving: readonly { key: string; type: string; masked: string | null }[];
  custodian: { id: string; name: string } | null;
};

export type ConnectedIntake = {
  source: IntakeSourceFacts;
  custodianId: string | null;
  receiving: ValidIntake["receiving"];
  fundingType: FundingType;
};

const field = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function lastFourOf(value: string | null | undefined): string | null {
  const compact = (value ?? "").replace(/[^A-Za-z0-9]/g, "");
  return compact.length >= 4 ? compact.slice(-4) : null;
}

export function validateConnectedIntake(
  input: ConnectedIntakeInput,
  context: ConnectedIntakeContext,
): { ok: true; value: ConnectedIntake } | { ok: false; errors: IntakeError[] } {
  const errors: IntakeError[] = [];
  let source: IntakeSourceFacts | null = null;
  const mode = input.sourceMode as ConnectedSourceMode;
  switch (mode) {
    case "asset_map":
      if (!context.assetMap) errors.push({ field: "assetMapAccountId", message: "Choose a source account from an asset map." });
      else source = context.assetMap;
      break;
    case "deal": {
      const last4 = lastFourOf(context.deal?.accountLast4);
      const type = field(input.sourceType);
      if (!context.deal || !last4) errors.push({ field: "dealId", message: "Choose a deal that records the source account's last four." });
      if (!oneOf(INTAKE_ACCOUNT_TYPES, type)) errors.push({ field: "sourceType", message: "Choose the source account type." });
      if (context.deal && last4 && oneOf(INTAKE_ACCOUNT_TYPES, type)) {
        source = { institution: context.deal.transferringFirm?.trim() || null, type, last4, title: context.clientName };
      }
      break;
    }
    case "pending":
      source = { institution: null, type: null, last4: null, title: null };
      break;
    default: {
      const unhandled: never = mode;
      void unhandled;
      errors.push({ field: "sourceMode", message: "Choose where the source account comes from." });
    }
  }
  if (field(input.deliveringCustodianId) && !context.custodian) {
    errors.push({ field: "deliveringCustodianId", message: "Choose the delivering firm from the custodian library." });
  }
  let receiving: ValidIntake["receiving"] | null = null;
  if (input.destinationMode === "apex") {
    const chosen = context.apexReceiving.find((account) => account.key === field(input.apexAccountKey));
    if (!chosen) errors.push({ field: "apexAccountKey", message: "Choose one of the client's open Apex accounts." });
    else receiving = { type: chosen.type, title: context.clientName, label: `${chosen.type} · Apex ${chosen.masked ?? "account"}`, open: true };
  } else if (input.destinationMode === "new") {
    const type = field(input.destinationType);
    const title = field(input.destinationTitle);
    if (!oneOf(RECEIVING_ACCOUNT_TYPES, type)) errors.push({ field: "destinationType", message: "Choose the receiving account type." });
    if (!title || title.length > 250) errors.push({ field: "destinationTitle", message: "Enter the registered receiving account title, within 250 characters." });
    receiving = { type, title, label: `${type} · ${title}`, open: false };
  } else {
    errors.push({ field: "destinationMode", message: "Choose an open Apex account or a new account to open." });
  }
  const route = INTAKE_ROUTES.find((option) => option.value === field(input.route));
  if (!route) errors.push({ field: "route", message: "Choose the proposed movement path." });
  if (errors.length || !source || !receiving || !route) return { ok: false, errors };
  return {
    ok: true,
    value: {
      source: context.custodian ? { ...source, institution: context.custodian.name } : source,
      custodianId: context.custodian?.id ?? null,
      receiving,
      fundingType: route.fundingType,
    },
  };
}

/** One of the client's existing transfers, as the intake sees it. */
export type IntakeTransferRow = {
  transferId: string;
  institution: string | null;
  type: string | null;
  last4: string | null;
  title: string | null;
  receivingType: string | null;
  receivingTitle: string | null;
  openAccounts: string[];
  /** Not funded and not declined, canceled or purged. */
  active: boolean;
};

export const STOPPED_OUTCOMES = ["Client declined", "Canceled", "Purged"] as const;

export function intakeAccountsFrom(rows: readonly IntakeTransferRow[]): {
  sources: ExistingIntakeAccount[]; receiving: ExistingReceivingAccount[];
} {
  const sources = new Map<string, ExistingIntakeAccount>();
  const receiving = new Map<string, ExistingReceivingAccount>();
  for (const row of rows) {
    if (row.institution && row.type && row.last4) {
      const key = [row.institution.toLowerCase(), row.type, row.last4.toUpperCase()].join("|");
      if (!sources.has(key)) sources.set(key, { transferId: row.transferId, institution: row.institution, type: row.type, last4: row.last4, title: row.title });
    }
    for (const label of row.openAccounts) {
      if (!receiving.has(label)) receiving.set(label, { transferId: row.transferId, label, type: row.receivingType, title: row.receivingTitle });
    }
  }
  return { sources: [...sources.values()], receiving: [...receiving.values()] };
}

/** An active transfer already moving this source account, if any. */
export function overlappingTransfer(rows: readonly IntakeTransferRow[], source: ValidIntake["source"]): string | null {
  const institution = source.institution.toLowerCase();
  const last4 = source.last4.toUpperCase();
  return rows.find((row) => row.active && row.institution?.toLowerCase() === institution && row.last4?.toUpperCase() === last4)?.transferId ?? null;
}
