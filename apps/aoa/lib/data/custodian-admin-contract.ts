import {
  CONTACT_METHOD_LABELS,
  CUSTODIAN_CONTACT_METHODS,
  LIQUIDATION_OPTIONS,
  REQUIREMENT_OPTIONS,
  RETURN_METHOD_OPTIONS,
  SIGNATURE_OPTIONS,
  feeDirectionLabel,
  playbookOptionLabel,
  resolveCustodianContact,
  type CustodianContactMethod,
  type CustodianFee,
  type CustodianLibrary,
  type CustodianProfile,
} from "./custodian-library-contract";

// Option lists, labels and copy are the Transfer Tracker's own, copied verbatim from
// its custodian admin screens so both apps read the same.
export const PLAYBOOK_TRANSFER_TYPES: ReadonlyArray<readonly [string, string]> = [
  ["", "— (unset)"], ["ACAT_API", "ACAT"], ["MANUAL", "Manual"], ["MIXED", "Mixed"],
  ["INTERNAL", "Internal"], ["UNCONFIRMED", "Unconfirmed"],
];
export const DOCUMENTATION_STATUSES: ReadonlyArray<readonly [string, string]> = [
  ["", "— (unset)"], ["DOCUMENTED", "Documented"], ["PARTIAL", "Partial docs"], ["NEEDS_CALL", "Needs call"],
];
export const FEE_ACCOUNT_TYPES = ["ANY", "IRA", "BROKERAGE"] as const;
export const FEE_TRANSFER_TYPES = ["ANY", "FULL", "PARTIAL"] as const;
export const FEE_DIRECTIONS = ["ANY", "IN", "OUT"] as const;
export const FEE_DIRECTION_LABELS: Record<(typeof FEE_DIRECTIONS)[number], string> = {
  ANY: feeDirectionLabel("ANY"),
  IN: feeDirectionLabel("IN"),
  OUT: feeDirectionLabel("OUT"),
};
export const FEE_DIRECTION_TITLE =
  "When this custodian's fee applies, based on the transfer's direction relative to Apex";
export const CONTACT_METHOD_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["", "— (unset)"],
  ...CUSTODIAN_CONTACT_METHODS.map((method) => [method, CONTACT_METHOD_LABELS[method]] as const),
];
export const CONFIRM_DELETE_FEE = "Delete this fee row? This cannot be undone.";
export const CONFIRM_MERGE_CUSTODIAN =
  "Merge this custodian into the selected one? Its ACAT records and attached fee schedules will be moved, and this card deleted.";

const TRANSFER_TYPE_LABELS = Object.fromEntries(PLAYBOOK_TRANSFER_TYPES.filter(([k]) => k));
const DOCUMENTATION_LABELS = Object.fromEntries(DOCUMENTATION_STATUSES.filter(([k]) => k));
export const transferTypeLabel = (value: string | null) => (value ? TRANSFER_TYPE_LABELS[value] ?? value : null);
export const documentationLabel = (value: string | null) => (value ? DOCUMENTATION_LABELS[value] ?? value : null);

export type PlaybookDraft = {
  dtcNumber: string; receivingAccountNumber: string; transferType: string;
  documentationStatus: string; signature: string; letterOfAcceptance: string;
  medallionRequired: string; paperworkOnFile: boolean; liquidationMethod: string;
  returnMethod: string; contactMethod: CustodianContactMethod | "";
  contactDetails: string; contactDetailsByMethod: Partial<Record<CustodianContactMethod, string>>;
  transfersToDate: string; watchouts: string;
};

function draftContactFrom(profile: CustodianProfile): Pick<PlaybookDraft, "contactMethod" | "contactDetails"> {
  const contact = resolveCustodianContact(profile);
  return {
    contactMethod: contact.contactMethod ?? "",
    contactDetails: contact.contactDetails ?? "",
  };
}

export function playbookDraftFrom(profile: CustodianProfile): PlaybookDraft {
  return {
    dtcNumber: profile.dtcNumber ?? "",
    receivingAccountNumber: profile.receivingAccountNumber ?? "",
    transferType: profile.transferType ?? "",
    documentationStatus: profile.documentationStatus ?? "",
    signature: profile.signature ?? "",
    letterOfAcceptance: profile.letterOfAcceptance ?? "",
    medallionRequired: profile.medallionRequired ?? "",
    paperworkOnFile: profile.paperworkOnFile ?? false,
    liquidationMethod: profile.liquidationMethod ?? "",
    returnMethod: profile.returnMethod ?? "",
    ...draftContactFrom(profile),
    contactDetailsByMethod: {},
    transfersToDate: profile.transfersToDate != null ? String(profile.transfersToDate) : "",
    watchouts: profile.watchouts ?? "",
  };
}

const TEXT_KEYS = [
  "dtcNumber", "receivingAccountNumber", "signature", "letterOfAcceptance", "medallionRequired",
  "liquidationMethod", "returnMethod", "watchouts",
] as const;

/** The tracker's `savePlaybook` rules: trim text, blank → null, send only what changed. */
export function playbookPatch(profile: CustodianProfile, draft: PlaybookDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of TEXT_KEYS) {
    const next = draft[key].trim() || null;
    if (next !== (profile[key] ?? null)) patch[key] = next;
  }
  const transferType = draft.transferType || null;
  if (transferType !== (profile.transferType ?? null)) patch.transferType = transferType;
  const documentationStatus = draft.documentationStatus || null;
  if (documentationStatus !== (profile.documentationStatus ?? null)) patch.documentationStatus = documentationStatus;
  if (draft.paperworkOnFile !== (profile.paperworkOnFile ?? false)) patch.paperworkOnFile = draft.paperworkOnFile;
  const raw = draft.transfersToDate.trim();
  const transfers = raw === "" ? null : parseInt(raw, 10);
  if (transfers !== (profile.transfersToDate ?? null) && !(transfers != null && Number.isNaN(transfers))) {
    patch.transfersToDate = transfers;
  }
  const current = draftContactFrom(profile);
  const nextContactDetails = draft.contactDetails.trim() || null;
  if (
    draft.contactMethod !== current.contactMethod ||
    (draft.contactDetails !== current.contactDetails &&
      nextContactDetails !== (current.contactDetails || null))
  ) {
    patch.contactMethod = draft.contactMethod || null;
    patch.contactDetails = draft.contactMethod ? nextContactDetails : null;
  }
  return patch;
}

export function changePlaybookContactMethod(
  draft: PlaybookDraft,
  next: CustodianContactMethod | "",
): PlaybookDraft {
  const contactDetailsByMethod = { ...draft.contactDetailsByMethod };
  if (draft.contactMethod) contactDetailsByMethod[draft.contactMethod] = draft.contactDetails;
  return {
    ...draft,
    contactMethod: next,
    contactDetails: next ? contactDetailsByMethod[next] ?? "" : "",
    contactDetailsByMethod,
  };
}

export function playbookSelectOptions(
  existingValue: string | null | undefined,
  options: ReadonlyArray<{ value: string; label: string }>,
): ReadonlyArray<readonly [string, string]> {
  const custom = existingValue && !options.some((option) => option.value === existingValue)
    ? existingValue
    : null;
  return [
    ["", "— (unset)"],
    ...(custom ? [[custom, `Existing: ${custom}`] as const] : []),
    ...options.map((option) => [option.value, option.label] as const),
  ];
}

export const signatureOptionsFor = (existing: string | null | undefined) =>
  playbookSelectOptions(existing, SIGNATURE_OPTIONS);
export const requirementOptionsFor = (existing: string | null | undefined) =>
  playbookSelectOptions(existing, REQUIREMENT_OPTIONS);
export const liquidationOptionsFor = (existing: string | null | undefined) =>
  playbookSelectOptions(existing, LIQUIDATION_OPTIONS);
export const returnMethodOptionsFor = (existing: string | null | undefined) =>
  playbookSelectOptions(existing, RETURN_METHOD_OPTIONS);

export const signatureDisplay = (value: string | null) => playbookOptionLabel(value, SIGNATURE_OPTIONS) ?? "—";
export const requirementDisplay = (value: string | null) => playbookOptionLabel(value, REQUIREMENT_OPTIONS) ?? "—";
export const liquidationDisplay = (value: string | null) => playbookOptionLabel(value, LIQUIDATION_OPTIONS) ?? "—";
export const returnMethodDisplay = (value: string | null) => playbookOptionLabel(value, RETURN_METHOD_OPTIONS) ?? "—";


export function nameFailure(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name is required";
  if (trimmed.length > 120) return "Name is too long";
  return null;
}

export type DetailsDraft = { name: string; avgProcessingDays: string };

export function detailsPatch(
  profile: CustodianProfile, draft: DetailsDraft,
): { ok: true; patch: Record<string, unknown> } | { ok: false; reason: string } {
  const name = draft.name.trim();
  if (!name) return { ok: false, reason: "Name is required" };
  const patch: Record<string, unknown> = {};
  if (name !== profile.name) patch.name = name;
  const days = parseInt(draft.avgProcessingDays, 10);
  if (!Number.isNaN(days) && days !== profile.configuredExpectedProcessingDays) patch.avgProcessingDays = days;
  return { ok: true, patch };
}

export type FeeDraft = {
  feeType: string; accountType: string; transferType: string; direction: string;
  amount: string; amountText: string; notes: string; documentation: string;
};
export const BLANK_FEE: FeeDraft = {
  feeType: "", accountType: "ANY", transferType: "ANY", direction: "ANY",
  amount: "", amountText: "", notes: "", documentation: "",
};

export function feeDraftFrom(fee: CustodianFee): FeeDraft {
  return {
    feeType: fee.feeType, accountType: fee.accountType, transferType: fee.transferType,
    direction: fee.direction || "ANY", amount: fee.amount != null ? String(fee.amount) : "",
    amountText: fee.amountText ?? "", notes: fee.notes ?? "", documentation: fee.documentation ?? "",
  };
}

export function feePayload(draft: FeeDraft): Record<string, unknown> {
  const amount = parseFloat(draft.amount);
  return {
    feeType: draft.feeType.trim(),
    accountType: draft.accountType,
    transferType: draft.transferType,
    direction: draft.direction,
    amount: Number.isFinite(amount) ? amount : null,
    amountText: draft.amountText.trim() || null,
    notes: draft.notes.trim() || null,
    documentation: draft.documentation.trim() || null,
  };
}

export const feeFailure = (draft: FeeDraft): string | null =>
  draft.feeType.trim() ? null : "Fee type is required";

export const feeAmountLabel = (fee: Pick<CustodianFee, "amount" | "amountText">): string =>
  fee.amount != null ? `$${fee.amount.toFixed(2)}` : fee.amountText || "—";

function isRequirementNotable(value: string | null): boolean {
  if (!value) return false;
  return /required/i.test(value) && !/^\s*not required\s*$/i.test(value);
}

/** The tracker's dialog subtitle: a one-line summary built from the playbook. */
export function playbookSummary(profile: CustodianProfile): string {
  const parts: string[] = [];
  const transfer = transferTypeLabel(profile.transferType);
  const documentation = documentationLabel(profile.documentationStatus);
  if (transfer) parts.push(transfer);
  if (documentation) parts.push(documentation);
  if (profile.signature === "DocuSign OK / Wet only") parts.push("Signature varies");
  else if (profile.signature && /wet/i.test(profile.signature)) parts.push("Wet signature");
  if (profile.letterOfAcceptance === "Not required / Required") parts.push("LOA required in some cases");
  else if (isRequirementNotable(profile.letterOfAcceptance)) parts.push("LOA required");
  if (profile.medallionRequired === "Not required / Required") parts.push("Medallion required in some cases");
  else if (isRequirementNotable(profile.medallionRequired)) parts.push("Medallion required");
  return parts.length ? parts.join(" · ") : "Custodian record + fee schedule";
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const CSV_HEADER = [
  "Custodian", "Observed Avg Processing Business Days", "Completed Timing Sample",
  "Contact Email", "Fee Type", "Account Type", "Transfer Type", "Amount", "Amount Text",
];

/** The tracker's Export CSV, byte for byte, over the custodians shown. */
export function custodiansCsv(custodians: CustodianProfile[]): string {
  const rows: string[][] = [];
  for (const c of custodians) {
    const base = [
      c.name,
      c.observedAvgProcessingBusinessDays == null ? "" : String(c.observedAvgProcessingBusinessDays),
      String(c.observedCompletedTransfers),
      c.contactEmail ?? "",
    ];
    if (c.fees.length === 0) {
      rows.push([...base, "", "", "", "", ""]);
      continue;
    }
    for (const f of c.fees) {
      rows.push([
        ...base, f.feeType, f.accountType, f.transferType,
        f.amount != null ? f.amount.toFixed(2) : "", f.amountText ?? "",
      ]);
    }
  }
  return [CSV_HEADER, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

export const csvFilename = (now: Date): string =>
  `custodians-fees-${now.toISOString().slice(0, 10)}.csv`;

export function applySaved(list: CustodianProfile[], saved: CustodianProfile): CustodianProfile[] {
  if (list.some((c) => c.id === saved.id)) return list.map((c) => (c.id === saved.id ? saved : c));
  return [...list, saved].sort((a, b) => a.name.localeCompare(b.name));
}

export function applyMerge(list: CustodianProfile[], deletedId: string, kept: CustodianProfile): CustodianProfile[] {
  return applySaved(list.filter((c) => c.id !== deletedId), kept);
}

/** One message per tracker refusal. `body` is the tracker's JSON, if any. */
export function adminFailureMessage(status: number | null, body: unknown): string {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if ((status === 400 || status === 409) && typeof error === "string") return error.slice(0, 300);
  if (status === 401) return "Always On Advice could not authenticate to the tracker. Try again, or contact an administrator.";
  if (status === 403) return "You are not allowed to change custodians in the tracker.";
  if (status === 404) {
    if (error === "Fee not found") return "This fee rule no longer exists in the tracker.";
    if (typeof error === "string" && /custodian not found$/i.test(error)) return "This custodian no longer exists in the tracker.";
    return "Custodian editing is not available in the tracker right now.";
  }
  if (status === 429) return "Too many changes — wait and try again.";
  return "The tracker did not save this change. Try again.";
}

type SnapshotEntry = { response: { snapshot: { view: string; data: unknown } } };

/** Applies `update` to the library inside an AcatWorkspace snapshot map, keeping
 * the entry's lease. No library entry means nothing to patch. */
export function patchLibrarySnapshot<T extends SnapshotEntry>(
  snapshots: Partial<Record<"library" | "tracking", T>>,
  update: (library: CustodianLibrary) => CustodianLibrary,
): Partial<Record<"library" | "tracking", T>> {
  const entry = snapshots.library;
  if (!entry || entry.response.snapshot.view !== "library") return snapshots;
  const snapshot = { ...entry.response.snapshot, data: update(entry.response.snapshot.data as CustodianLibrary) };
  return { ...snapshots, library: { ...entry, response: { ...entry.response, snapshot } } };
}
