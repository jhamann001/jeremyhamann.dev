import { readAcatStatusForTransferCached } from "@/lib/data/acat-status";
import type { TransferStage } from "@/lib/data/transfer-types";
import { trackerStatus, trackerTone, type OutcomeStatus } from "./detail-model";

export type StatusPillInput = {
  stage: TransferStage;
  outcome: OutcomeStatus;
  outcomeLabel: string;
  trackingStage: string | null;
};

export function StatusPill({ input, acatStatus }: { input: StatusPillInput; acatStatus: string | null }) {
  const status = trackerStatus({ ...input, acatStatus });
  return <dd className={`transfer-status-pill ${trackerTone(status, input.stage, input.outcome)}`}>{status}</dd>;
}

/** The linked Transfer Tracker's status, read once per request; any failure falls back to the funding stage. */
export async function LinkedAcatStatus({ acatRecordId, acatTransferId, input }: {
  acatRecordId: string | null; acatTransferId: string | null; input: StatusPillInput;
}) {
  let acatStatus: string | null = null;
  try {
    acatStatus = (await readAcatStatusForTransferCached(acatRecordId, acatTransferId))?.status ?? null;
  } catch {
    acatStatus = null;
  }
  return <StatusPill input={input} acatStatus={acatStatus} />;
}
