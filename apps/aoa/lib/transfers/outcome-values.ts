export const TRANSFER_OUTCOMES = ["Client declined", "Deferred", "Canceled", "Purged"] as const;
export type TransferOutcomeValue = (typeof TRANSFER_OUTCOMES)[number];
