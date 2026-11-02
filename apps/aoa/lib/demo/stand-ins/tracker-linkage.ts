// The Transfer Tracker's transfer-linkage snapshot (GET /api/machine/transfer-linkage), the evidence AoA's ACAT link
// review and auto-link match against. Ported from the tracker demo's lib/transfer-linkage/projection.ts, with the
// Cedar Ridge client directory (kind "client") as the account evidence. The demo's directory is one published
// snapshot, fresh at every read.

import { createHash } from "node:crypto";
import type { TrackerClient, TrackerRecord } from "./tracker-model";

/** The installation id the demo's TRANSFER_LINKAGE_INSTALLATION_ID names; AoA refuses a snapshot from any other. */
export const DEMO_LINKAGE_INSTALLATION_ID = "7c2e4b1a-9d3f-4e8a-b6c5-1f0d2a3e4b5c";
export const DEMO_DIRECTORY_SNAPSHOT_ID = "demo-directory";

const digest = (facts: unknown) => createHash("sha256").update(JSON.stringify(facts)).digest("hex");
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function canonicalTransferId(value: string | null): string | null {
  const clean = value?.trim() ?? "";
  return UUID.test(clean) ? clean.toLowerCase() : null;
}

/** Salesforce ids: a 15-character id's checksum is derived before folding to the 18-character form. */
function canonicalCrmId(value: string): string | null {
  const clean = value.trim();
  if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(clean)) return null;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  let base = clean.slice(0, 15);
  if (clean.length === 18) {
    const suffix = clean.slice(15).toUpperCase();
    if (![...suffix].every((char) => alphabet.includes(char))) return null;
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

interface AccountEvidence {
  investmentAccountId: string;
  status: string | null;
  isCurrent: boolean;
  members: Array<{ cedarRidgeUserId: string; relationshipType: string | null; isCurrent: boolean; eligibility: string }>;
}

/** The directory's Apex accounts by normalized number, each with every client who holds it. */
function apexAccounts(clients: TrackerClient[]): Map<string, AccountEvidence> {
  const accounts = new Map<string, AccountEvidence>();
  for (const client of clients) {
    for (const held of client.accounts) {
      if (held.custodian.toUpperCase() !== "APEX" || !held.accountNumber) continue;
      const number = held.accountNumber.trim().toUpperCase();
      const account = accounts.get(number) ?? { investmentAccountId: held.investmentAccountId, status: held.status, isCurrent: held.isCurrent, members: [] };
      account.members.push({ cedarRidgeUserId: client.cedarRidgeUserId, relationshipType: held.relationshipType, isCurrent: held.isCurrent, eligibility: client.eligibility });
      accounts.set(number, account);
    }
  }
  return accounts;
}

function receivingAccount(ids: string[], number: string, account: AccountEvidence | null) {
  const members = (account?.members ?? []).map((member) => ({
    cedarRidgeUserId: member.cedarRidgeUserId,
    relationshipType: member.relationshipType,
    isCurrent: member.isCurrent,
    clientEligibility: (["ACTIVE", "INACTIVE"].includes(member.eligibility) ? member.eligibility : "UNKNOWN") as "ACTIVE" | "INACTIVE" | "UNKNOWN",
    presentInSnapshot: true,
  })).sort((a, b) => compareIds(a.cedarRidgeUserId, b.cedarRidgeUserId));
  const current = members.filter((m) => m.isCurrent);
  const holderSetComplete = ids.length > 0 && current.length === ids.length
    && current.every((m, i) => m.cedarRidgeUserId === ids[i])
    && (ids.length === 1 || current.every((m) => m.relationshipType === "JOINT"));
  const facts = {
    namespace: "cedarRidge.investment_account" as const,
    id: account?.investmentAccountId ?? null,
    status: account?.status ?? null,
    isCurrent: !!account?.isCurrent,
    members,
    holderSetComplete,
  };
  type Verification = "VERIFIED" | "MISSING_IDENTITY" | "MISSING_ACCOUNT" | "ACCOUNT_UNRESOLVED" | "HOLDER_MISMATCH" | "HISTORICAL";
  let verification: Verification = "VERIFIED";
  if (!ids.length) verification = "MISSING_IDENTITY";
  else if (!number) verification = "MISSING_ACCOUNT";
  else if (!account) verification = "ACCOUNT_UNRESOLVED";
  else if (!facts.isCurrent || ["CLOSED", "INACTIVE"].includes(facts.status ?? "")
    || members.some((m) => ids.includes(m.cedarRidgeUserId) && m.clientEligibility === "INACTIVE")) verification = "HISTORICAL";
  else if (!holderSetComplete) verification = "HOLDER_MISMATCH";
  return { receivingAccount: { ...facts, verification }, accountEvidenceDigest: digest(facts) };
}

function linkageRecord(record: TrackerRecord, accounts: Map<string, AccountEvidence>) {
  const cedarRidgeUserIds = [...record.cedarRidgeUserIds].sort();
  const number = record.apexAccountId.trim().toUpperCase();
  const account = receivingAccount(cedarRidgeUserIds, number, accounts.get(number) ?? null);
  const fields = {
    recordId: record.id,
    cedarRidgeUserIds,
    identityVersion: record.identityVersion,
    acatTransferId: canonicalTransferId(record.acatTransferId),
    controlNumber: record.controlNumber && /^[a-zA-Z0-9_-]{1,64}$/.test(record.controlNumber.trim()) ? record.controlNumber.trim() : null,
    crmDealId: canonicalCrmId(record.crmDealId),
    crmDealIdProvenance: (record.crmDealId.trim() ? "LEGACY_UNVERIFIED" : "ABSENT") as "LEGACY_UNVERIFIED" | "ABSENT",
    direction: (["IN", "OUT"].includes(record.direction?.toUpperCase() ?? "") ? record.direction!.toUpperCase() : "UNKNOWN") as "IN" | "OUT" | "UNKNOWN",
    transferType: (["FULL", "PARTIAL"].includes(record.type?.toUpperCase() ?? "") ? record.type!.toUpperCase() : "UNKNOWN") as "FULL" | "PARTIAL" | "UNKNOWN",
    workflow: record.transferWorkflow,
    status: record.status,
    deletedAt: record.deletedAt ? new Date(record.deletedAt).toISOString() : null,
    createdAt: new Date(record.createdAt).toISOString(),
    requestDate: dateOnly(record.originalClientRequestDate),
  };
  const recordEvidenceDigest = digest({ ...fields, receivingAccountNumber: number,
    rawReferences: [record.acatTransferId, record.controlNumber, record.crmDealId],
    rawDirection: record.direction, rawType: record.type, rawRequestDate: record.originalClientRequestDate });
  return { ...fields, ...account, recordEvidenceDigest };
}

/** Every record, removed ones included, with its receiving-account evidence; refuses when the demo's linkage
 *  environment is not configured, as the tracker does. */
export function linkageSnapshot(records: TrackerRecord[], clients: TrackerClient[], now = new Date()) {
  const environment = process.env.TRANSFER_LINKAGE_ENVIRONMENT;
  if (environment !== "production" && environment !== "synthetic") return null;
  const source = { system: "transfer-tracker" as const, installationId: DEMO_LINKAGE_INSTALLATION_ID, environment };
  const observedAt = now.toISOString();
  const directory = {
    snapshotId: DEMO_DIRECTORY_SNAPSHOT_ID, publishedGeneration: 1, health: "FRESH" as const,
    freshnessBasis: "FETCH_SUCCESS" as const, lastSuccessAt: observedAt, sourceAsOf: observedAt,
  };
  const accounts = apexAccounts(clients);
  const rows = records.map((r) => linkageRecord(r, accounts)).sort((a, b) => compareIds(a.recordId, b.recordId));
  return {
    contractVersion: 1 as const, source, scope: "ALL_RECORDS_INCLUDING_DELETED" as const, complete: true as const, observedAt,
    recordCount: rows.length, directory, records: rows,
    snapshotDigest: digest({ contractVersion: 1, source, scope: "ALL_RECORDS_INCLUDING_DELETED",
      records: rows.map((r) => [r.recordId, r.recordEvidenceDigest, r.accountEvidenceDigest]) }),
  };
}
