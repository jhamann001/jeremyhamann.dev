export interface OperationalTransferShape {
  direction?: string | null;
  type?: string | null;
  transferWorkflow?: string | null;
}

export function isOutgoingTransfer(record: OperationalTransferShape): boolean {
  return record.direction?.trim().toLowerCase() === "out";
}

export function isResidualTransfer(record: OperationalTransferShape): boolean {
  return record.type?.trim().toLowerCase() === "residual credit";
}

export function isFullOutgoingTransfer(record: OperationalTransferShape): boolean {
  return isOutgoingTransfer(record) && record.type?.trim().toLowerCase() === "full";
}

export function isDrsTransfer(record: OperationalTransferShape): boolean {
  return record.transferWorkflow?.trim().toUpperCase() === "DRS";
}

export function defaultFeeCharged(record: OperationalTransferShape): "Yes" | "No" | undefined {
  // DRS takes precedence over the general full-outgoing fee assumption.
  if (isDrsTransfer(record)) return "No";
  return isFullOutgoingTransfer(record) ? "Yes" : undefined;
}

export function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function defaultResidualFollowUpDate(now = new Date()): string {
  return localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
}
