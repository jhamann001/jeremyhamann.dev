import { createHash } from "node:crypto";
import type { LinkageDirectory, LinkageRecord, LinkageReceivingAccount, LinkageSnapshot, LinkageSource } from "./contract";
import { TRANSFER_LINKAGE_CONTRACT_VERSION, TRANSFER_LINKAGE_MAX_RECORDS, LinkageError } from "./contract";

export interface RecordEvidence {
  id: string;
  identityVersion: number;
  clientLinks: Array<{ cedarRidgeUserId: string }>;
  acatTransferId: string | null;
  controlNumber: string | null;
  crmDealId: string;
  direction: string | null;
  type: string | null;
  transferWorkflow: string;
  status: string;
  deletedAt: Date | null;
  createdAt: Date;
  originalClientRequestDate: string | null;
  apexAccountId: string;
}

export interface AccountEvidence {
  investmentAccountId: string;
  normalizedAccountNumber: string | null;
  status: string | null;
  isCurrent: boolean;
  lastSeenSnapshotId: string;
  members: Array<{
    cedarRidgeUserId: string;
    relationshipType: string | null;
    isCurrent: boolean;
    lastSeenSnapshotId: string;
    client: { eligibility: string; lastSeenSnapshotId: string };
  }>;
}

export const digest = (facts: unknown): string => createHash("sha256").update(JSON.stringify(facts)).digest("hex");
const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function canonicalTransferId(value: string | null): string | null {
  const clean = value?.trim() ?? "";
  return UUID.test(clean) ? clean.toLowerCase() : null;
}

/** Salesforce 15-character IDs are case-sensitive. Derive their checksum
 * before folding the 18-character form; supplied 18-char checksums must be valid. */
export function canonicalCrmId(value: string): string | null {
  const clean = value.trim();
  if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(clean)) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  let base = clean.slice(0, 15);
  if (clean.length === 18) {
    const suffix = clean.slice(15).toUpperCase();
    if (![...suffix].every((char) => alphabet.includes(char))) return null;
    // The suffix preserves the original case even after the full ID was folded.
    let recovered = "";
    for (let i = 0; i < 15; i++) {
      const upper = (alphabet.indexOf(suffix[Math.floor(i / 5)]) & (1 << (i % 5))) !== 0;
      if (upper && /[0-9]/.test(base[i])) return null;
      recovered += upper ? base[i].toUpperCase() : base[i].toLowerCase();
    }
    base = recovered;
  }
  let suffix = "";
  for (let group = 0; group < 3; group++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) if (/[A-Z]/.test(base[group * 5 + i])) bits |= 1 << i;
    suffix += alphabet[bits];
  }
  return `${base}${suffix}`.toUpperCase();
}

function dateOnly(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function accountProjection(ids: string[], number: string, account: AccountEvidence | null, directory: LinkageDirectory) {
  const members = (account?.members ?? []).map((member) => ({
    cedarRidgeUserId: member.cedarRidgeUserId,
    relationshipType: member.relationshipType,
    isCurrent: member.isCurrent && member.lastSeenSnapshotId === directory.snapshotId,
    clientEligibility: (["ACTIVE", "INACTIVE"].includes(member.client.eligibility)
      ? member.client.eligibility : "UNKNOWN") as "ACTIVE" | "INACTIVE" | "UNKNOWN",
    presentInSnapshot: member.client.lastSeenSnapshotId === directory.snapshotId,
  })).sort((a, b) => compareIds(a.cedarRidgeUserId, b.cedarRidgeUserId));
  const current = members.filter((member) => member.isCurrent);
  const holderSetComplete = ids.length > 0 && current.length === ids.length &&
    current.every((member, index) => member.cedarRidgeUserId === ids[index]) &&
    (ids.length === 1 || current.every((member) => member.relationshipType === "JOINT"));
  const facts = {
    namespace: "cedarRidge.investment_account" as const,
    id: account?.investmentAccountId ?? null,
    status: account?.status ?? null,
    isCurrent: !!account?.isCurrent && account.lastSeenSnapshotId === directory.snapshotId,
    members,
    holderSetComplete,
  };
  let verification: LinkageReceivingAccount["verification"] = "VERIFIED";
  if (directory.health !== "FRESH") verification = "SOURCE_UNAVAILABLE";
  else if (!ids.length) verification = "MISSING_IDENTITY";
  else if (!number) verification = "MISSING_ACCOUNT";
  else if (!account) verification = "ACCOUNT_UNRESOLVED";
  else if (!facts.isCurrent || ["CLOSED", "INACTIVE"].includes(facts.status ?? "") ||
    members.some((member) => ids.includes(member.cedarRidgeUserId) && (!member.presentInSnapshot || member.clientEligibility === "INACTIVE"))) verification = "HISTORICAL";
  else if (!holderSetComplete) verification = "HOLDER_MISMATCH";
  return { receivingAccount: { ...facts, verification }, accountEvidenceDigest: digest(facts) };
}

export function projectRecord(record: RecordEvidence, account: AccountEvidence | null, directory: LinkageDirectory): LinkageRecord {
  const cedarRidgeUserIds = record.clientLinks.map((link) => link.cedarRidgeUserId).sort();
  const number = record.apexAccountId.trim().toUpperCase();
  const accountFields = accountProjection(cedarRidgeUserIds, number, account, directory);
  const fields = {
    recordId: record.id,
    cedarRidgeUserIds,
    identityVersion: record.identityVersion,
    acatTransferId: canonicalTransferId(record.acatTransferId),
    controlNumber: record.controlNumber && /^[a-zA-Z0-9_-]{1,64}$/.test(record.controlNumber.trim()) ? record.controlNumber.trim() : null,
    crmDealId: canonicalCrmId(record.crmDealId),
    crmDealIdProvenance: (record.crmDealId.trim() ? "LEGACY_UNVERIFIED" : "ABSENT") as LinkageRecord["crmDealIdProvenance"],
    direction: (["IN", "OUT"].includes(record.direction?.toUpperCase() ?? "") ? record.direction!.toUpperCase() : "UNKNOWN") as LinkageRecord["direction"],
    transferType: (["FULL", "PARTIAL"].includes(record.type?.toUpperCase() ?? "") ? record.type!.toUpperCase() : "UNKNOWN") as LinkageRecord["transferType"],
    workflow: record.transferWorkflow,
    status: record.status,
    deletedAt: record.deletedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    requestDate: dateOnly(record.originalClientRequestDate),
  };
  // Include raw matching inputs whose invalid/unknown wire projection could
  // otherwise hide an edit. No private input is emitted on the wire.
  const recordEvidenceDigest = digest({ ...fields, receivingAccountNumber: number,
    rawReferences: [record.acatTransferId, record.controlNumber, record.crmDealId],
    rawDirection: record.direction, rawType: record.type, rawRequestDate: record.originalClientRequestDate });
  return { ...fields, ...accountFields, recordEvidenceDigest };
}

export function projectSnapshot(source: LinkageSource, directory: LinkageDirectory, observedAt: Date, records: LinkageRecord[]): LinkageSnapshot {
  if (records.length > TRANSFER_LINKAGE_MAX_RECORDS) throw new LinkageError("SNAPSHOT_OVERFLOW");
  const sorted = [...records].sort((a, b) => compareIds(a.recordId, b.recordId));
  return { contractVersion: TRANSFER_LINKAGE_CONTRACT_VERSION, source,
    scope: "ALL_RECORDS_INCLUDING_DELETED", complete: true, observedAt: observedAt.toISOString(),
    recordCount: sorted.length, directory, records: sorted,
    snapshotDigest: digest({ contractVersion: TRANSFER_LINKAGE_CONTRACT_VERSION, source,
      scope: "ALL_RECORDS_INCLUDING_DELETED", records: sorted.map((record) => [record.recordId, record.recordEvidenceDigest, record.accountEvidenceDigest]) }) };
}
