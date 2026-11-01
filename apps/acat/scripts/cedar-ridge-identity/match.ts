import { canonicalJson, normalizeKey, normalizeName, sha256, uniqueSorted } from "./canonical";
import { evidenceSchema, type Evidence, type ManifestRow, type TrackerRow } from "./contracts";

export function validateEvidence(input: unknown): Evidence {
  const evidence = evidenceSchema.parse(input);
  const ids = new Set<string>();
  for (const client of evidence.clients) {
    if (ids.has(client.userId)) throw new Error("DUPLICATE_CLIENT_ID");
    ids.add(client.userId);
  }
  const accountPairs = new Set<string>();
  const accountNumbers = new Map<string, string>();
  const normalizedAccounts = new Map<string, string>();
  for (const account of evidence.accounts) {
    const number = normalizeKey(account.accountNumber);
    const previousNumber = normalizedAccounts.get(account.accountId);
    if (previousNumber !== undefined && previousNumber !== number) throw new Error("INCONSISTENT_ACCOUNT_NUMBER");
    normalizedAccounts.set(account.accountId, number);
    const previousId = accountNumbers.get(number);
    if (number && previousId && previousId !== account.accountId) throw new Error("ACCOUNT_NUMBER_COLLISION");
    if (number) accountNumbers.set(number, account.accountId);
    const key = canonicalJson([account.accountId, account.userId]);
    if (accountPairs.has(key)) throw new Error("DUPLICATE_ACCOUNT_MEMBERSHIP");
    accountPairs.add(key);
    if (account.userId && !ids.has(account.userId)) throw new Error("ORPHAN_ACCOUNT_USER");
  }
  const transferPairs = new Set<string>();
  for (const transfer of evidence.transfers) {
    const key = canonicalJson([normalizeKey(transfer.transferId), transfer.userId]);
    if (transferPairs.has(key)) throw new Error("DUPLICATE_TRANSFER_MEMBERSHIP");
    transferPairs.add(key);
    if (!ids.has(transfer.userId)) throw new Error("ORPHAN_TRANSFER_USER");
  }
  if (!evidence.clients.length) throw new Error("EMPTY_DIRECTORY");
  return evidence;
}

export function matchRecord(record: TrackerRow, evidence: Evidence): ManifestRow {
  const accounts = evidence.accounts.filter((entry) => normalizeKey(record.apexAccountId) !== "" && normalizeKey(entry.accountNumber) === normalizeKey(record.apexAccountId));
  const transfers = evidence.transfers.filter((entry) => normalizeKey(record.acatTransferId) !== "" && normalizeKey(entry.transferId) === normalizeKey(record.acatTransferId));
  const names = evidence.clients.filter((entry) => normalizeName(entry.name) === normalizeName(record.clientName));
  const accountCandidateIds = uniqueSorted(accounts.flatMap((entry) => entry.userId ? [entry.userId] : []));
  const transferCandidateIds = uniqueSorted(transfers.map((entry) => entry.userId));
  const nameCandidateIds = uniqueSorted(names.map((entry) => entry.userId));
  const stable = uniqueSorted([...accountCandidateIds, ...transferCandidateIds]);
  const candidateIds = stable.length ? stable : nameCandidateIds;
  const relevantIds = uniqueSorted([...candidateIds, ...nameCandidateIds, ...record.cedarRidgeUserIds]);
  const evidenceHash = sha256({
    ...(evidence.ownerCoverageAssumption ? { ownerCoverageAssumption: evidence.ownerCoverageAssumption } : {}),
    clients: evidence.clients.filter((entry) => relevantIds.includes(entry.userId)).sort((a, b) => a.userId.localeCompare(b.userId)),
    accounts: [...accounts].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    transfers: [...transfers].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
  });
  const disjoint = accountCandidateIds.length > 0 && transferCandidateIds.length > 0 && !accountCandidateIds.some((id) => transferCandidateIds.includes(id));
  let category: ManifestRow["category"];
  if (record.cedarRidgeUserIds.length) category = "already-linked";
  else if (disjoint) category = "evidence-conflict";
  else if (accountCandidateIds.length > 1 && accounts.every((account) => account.userId && account.relationshipType === "JOINT") &&
    transferCandidateIds.every((id) => accountCandidateIds.includes(id))) category = "joint-account-members";
  else if (stable.length > 1) category = "multiple-users";
  else if (stable.length === 1) category = nameCandidateIds.includes(stable[0]) ? "stable-name-agrees" : "stable-name-varies";
  else category = nameCandidateIds.length ? "name-only" : "unmatched";
  return { expected: record, category, candidateIds, accountCandidateIds, transferCandidateIds, nameCandidateIds, evidenceHash, directoryEvidenceHash: null, decision: { kind: "unresolved" } };
}
