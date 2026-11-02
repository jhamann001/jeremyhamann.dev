/** Browser-safe projection. IDs identify a record; they never authorize a write. */
export type TransferAcatCandidate = {
  recordId: string;
  clientName: string | null;
  transferringCustodian: string | null;
  statementAccountMasked: string | null;
  receivingAccountMasked: string | null;
  accountType: string | null;
  transferType: string | null;
  direction: string | null;
  status: string | null;
  acatDate: string | null;
  amountCents: number | null;
  /** A freshly calculated identity fingerprint, not an authorization token. */
  confirmationKey: string;
  /** Linked elsewhere or to this transfer. Visible for context; not selectable. */
  unavailableReason: string | null;
};

export type TransferAcatDestination = {
  id: string;
  clientName: string;
  householdName: string | null;
  /** Detect a changed target identity while the operator reviews the match. */
  confirmationKey: string;
};

export type TransferAcatCandidatesResult =
  | { ok: true; destination: TransferAcatDestination; candidates: TransferAcatCandidate[] }
  | { ok: false; message: string };

export type TransferAcatLinkInput = {
  recordId: string;
  confirmationKey: string;
  destinationConfirmationKey: string;
  confirmed: boolean;
};

export type TransferAcatLinkResult =
  | { ok: true }
  | { ok: false; message: string };
