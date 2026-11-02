import { createHash } from "node:crypto";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function reviewQueueTradeSubjectKey(clientReference: string): string {
  return hash(`trade-client:${clientReference}`);
}

export function reviewQueueTradeDetectorKey(
  clientReference: string,
  type: string,
  discriminator: string,
): string {
  return hash(`trade:${clientReference}:${type}:${discriminator}`);
}

export function reviewQueueCrmDetectorKey(exceptionId: string): string {
  return hash(`crm:${exceptionId}`);
}

export function reviewQueueCrmSubjectKey(identityId: string): string {
  return hash(`crm-identity:${identityId}`);
}
