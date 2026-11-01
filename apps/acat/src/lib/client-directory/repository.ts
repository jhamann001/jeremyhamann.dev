import { createHash } from "node:crypto";
import type { Prisma, CedarRidgeDirectorySync } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ClientDirectoryStatus, ClientIdentityErrorCode, ClientSearchResponse } from "@/lib/client-identity-contract";
import { CLIENT_IDENTITY_MAX_CLIENTS, CLIENT_SEARCH_MAX_LENGTH, CLIENT_SEARCH_MAX_RESULTS, CLIENT_SEARCH_MIN_LENGTH } from "@/lib/client-identity-contract";
import { clientSearchCrmOnly, directoryFreshnessPolicy } from "@/lib/client-identity-policy";
import { normalizeAccountNumber, normalizeName, USER_ID_PATTERN } from "./source";

export class ClientDirectoryError extends Error {
  constructor(public readonly code: ClientIdentityErrorCode, message: string, public readonly httpStatus: number) {
    super(message); this.name = "ClientDirectoryError";
  }
}

export function ttlSeconds(name: string): number | null {
  const value = process.env[name];
  return value && /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 604800 ? Number(value) : null;
}

export function directoryStatusFromState(state: CedarRidgeDirectorySync | null, now = new Date()): ClientDirectoryStatus {
  const freshnessBasis = directoryFreshnessPolicy();
  const enabled = process.env.CLIENT_IDENTITY_ENABLED === "true";
  const pendingAccountPolicy = process.env.CLIENT_IDENTITY_PENDING_ACCOUNT_POLICY === "ACCOUNT_REQUIRED"
    ? "ACCOUNT_REQUIRED" : "PENDING_ACCOUNT_OPENING_ONLY";
  let health: ClientDirectoryStatus["health"] = "UNAVAILABLE";
  if (state?.activeSnapshotId && state.lastSuccessAt) {
    const maxAge = ttlSeconds("CLIENT_DIRECTORY_MAX_AGE_SECONDS");
    const sourceMaxAge = ttlSeconds("CLIENT_DIRECTORY_SOURCE_MAX_AGE_SECONDS");
    if (state.lastErrorCode) health = "UNAVAILABLE";
    else if (state.sourceHealth === "STALE") health = "STALE";
    else if (!maxAge || state.lastSuccessAt.getTime() > now.getTime() + 300_000 ||
      (state.sourceAsOf && state.sourceAsOf.getTime() > now.getTime() + 300_000)) health = "UNKNOWN";
    else if (freshnessBasis === "FETCH_SUCCESS") {
      // This policy accepts coverage as an explicit operating assumption. It
      // never changes the stored upstream health or creates a source watermark.
      if (!["FRESH", "UNKNOWN"].includes(state.sourceHealth)) health = "UNKNOWN";
      else health = now.getTime() - state.lastSuccessAt.getTime() > maxAge * 1000 ? "STALE" : "FRESH";
    }
    else if (state.sourceHealth === "UNKNOWN" || !state.sourceAsOf || !sourceMaxAge) health = "UNKNOWN";
    else if (state.sourceHealth !== "FRESH" || now.getTime() - state.lastSuccessAt.getTime() > maxAge * 1000 ||
      now.getTime() - state.sourceAsOf.getTime() > sourceMaxAge * 1000) health = "STALE";
    else health = "FRESH";
  }
  return { enabled, health, writeEligible: enabled && health === "FRESH", pendingAccountPolicy, freshnessBasis,
    lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null, sourceAsOf: state?.sourceAsOf?.toISOString() ?? null };
}

export async function getDirectoryStatus(db: Prisma.TransactionClient = prisma): Promise<ClientDirectoryStatus> {
  return directoryStatusFromState(await db.cedarRidgeDirectorySync.findUnique({ where: { id: "global" } }));
}

/** Bind administrative manifests to the actual installation, not a caller's
 * label or a database name shared by several environments. No source health is
 * required for this read-only target check. Never include it in browser DTOs. */
export async function getDirectoryInstallationId(db: Prisma.TransactionClient = prisma): Promise<string> {
  const state = await db.cedarRidgeDirectorySync.findUnique({ where: { id: "global" }, select: { installationId: true } });
  if (!state) throw new ClientDirectoryError("DIRECTORY_UNAVAILABLE", "The client directory is unavailable.", 503);
  return state.installationId;
}

/** Caller must hold this until the identity mutation AND audit commit. Lock
 * order everywhere is directory singleton first, then ACAT rows in ID order. */
export async function lockDirectory(tx: Prisma.TransactionClient): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "CedarRidgeDirectorySync" WHERE "id" = 'global' FOR SHARE
  `;
  if (rows.length !== 1) throw new ClientDirectoryError("DIRECTORY_UNAVAILABLE", "The client directory is unavailable.", 503);
}

async function verifiedState(tx: Prisma.TransactionClient) {
  const state = await tx.cedarRidgeDirectorySync.findUnique({ where: { id: "global" } });
  const status = directoryStatusFromState(state);
  // enabled only controls cutover. Existing linked rows never bypass source
  // integrity when the cutover flag is off.
  if (status.health !== "FRESH" || !state?.activeSnapshotId) {
    throw new ClientDirectoryError(status.health === "STALE" ? "DIRECTORY_STALE" : "DIRECTORY_UNAVAILABLE", "The client directory cannot currently verify identities.", 503);
  }
  return { ...state, activeSnapshotId: state.activeSnapshotId, freshnessBasis: directoryFreshnessPolicy() };
}

export type ResolveClientInput = {
  cedarRidgeUserId: string;
  apexAccountId: string;
  /** Root authorizes this only for the agreed pending-account workflow. */
  allowPendingAccount?: boolean;
  /** Backfill/explicit historical decisions only, never a browser-controlled flag. */
  allowHistoricalAccount?: boolean;
};

export async function resolveClientIdentity(tx: Prisma.TransactionClient, input: ResolveClientInput) {
  const state = await verifiedState(tx);
  if (!USER_ID_PATTERN.test(input.cedarRidgeUserId)) throw new ClientDirectoryError("CLIENT_NOT_FOUND", "The selected client is unavailable.", 422);
  const client = await tx.cedarRidgeClient.findUnique({ where: { cedarRidgeUserId: input.cedarRidgeUserId } });
  if (!client || (!input.allowHistoricalAccount && (client.eligibility === "INACTIVE" || client.lastSeenSnapshotId !== state.activeSnapshotId))) {
    throw new ClientDirectoryError("CLIENT_NOT_FOUND", "The selected client is unavailable.", 422);
  }
  const number = normalizeAccountNumber(input.apexAccountId);
  let investmentAccountId: string | null = null;
  let relationshipType: string | null = null;
  if (!number && input.allowPendingAccount) {
    // No placeholder values are introduced or treated as real memberships.
  } else {
    const membership = number ? await tx.cedarRidgeAccountMember.findFirst({ where: {
      cedarRidgeUserId: client.cedarRidgeUserId,
      ...(!input.allowHistoricalAccount ? { isCurrent: true } : {}),
      account: { custodian: "APEX", normalizedAccountNumber: number,
        ...(!input.allowHistoricalAccount ? { isCurrent: true, OR: [{ status: null }, { status: { notIn: ["CLOSED", "INACTIVE"] } }] } : {}) },
    }, include: { account: true } }) : null;
    if (!membership) throw new ClientDirectoryError("ACCOUNT_NOT_LINKED", "The selected client is not linked to that Apex account.", 422);
    investmentAccountId = membership.investmentAccountId;
    relationshipType = membership.relationshipType;
  }
  const evidenceDigest = createHash("sha256").update(JSON.stringify({
    cedarRidgeUserId: client.cedarRidgeUserId, canonicalName: client.canonicalName,
    eligibility: client.eligibility, accountNumber: number, investmentAccountId, relationshipType,
    freshnessBasis: state.freshnessBasis,
  })).digest("hex");
  return { cedarRidgeUserId: client.cedarRidgeUserId, canonicalName: client.canonicalName,
    snapshotId: state.activeSnapshotId, freshnessBasis: state.freshnessBasis, investmentAccountId, relationshipType, evidenceDigest };
}

export type ResolveClientsInput = Omit<ResolveClientInput, "cedarRidgeUserId"> & { cedarRidgeUserIds: string[] };

function validatedClientIds(ids: string[], allowEmpty = false): string[] {
  if ((!allowEmpty && ids.length === 0) || ids.length > CLIENT_IDENTITY_MAX_CLIENTS ||
      ids.some((id) => !USER_ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    throw new ClientDirectoryError("INVALID_REQUEST", "Select a valid set of clients.", 400);
  }
  return [...ids].sort();
}

/** Caller holds the directory share-lock through validation, set replacement
 * and audit commit. Multiple people require the complete verified JOINT set;
 * a transfer-only user or an unrelated account member is never added by name. */
export async function resolveClientIdentities(tx: Prisma.TransactionClient, input: ResolveClientsInput) {
  const cedarRidgeUserIds = validatedClientIds(input.cedarRidgeUserIds);
  if (cedarRidgeUserIds.length === 1) {
    const identity = await resolveClientIdentity(tx, { ...input, cedarRidgeUserId: cedarRidgeUserIds[0] });
    return { cedarRidgeUserIds, clients: [{ cedarRidgeUserId: identity.cedarRidgeUserId,
      canonicalName: identity.canonicalName, relationshipType: identity.relationshipType,
      investmentAccountId: identity.investmentAccountId }], canonicalName: identity.canonicalName,
      snapshotId: identity.snapshotId, freshnessBasis: identity.freshnessBasis, evidenceDigest: identity.evidenceDigest };
  }
  const state = await verifiedState(tx);
  const number = normalizeAccountNumber(input.apexAccountId);
  if (!number) throw new ClientDirectoryError("ACCOUNT_NOT_LINKED", "Multiple clients require a verified joint Apex account.", 422);
  const account = await tx.cedarRidgeAccount.findUnique({
    where: { custodian_normalizedAccountNumber: { custodian: "APEX", normalizedAccountNumber: number } },
    include: { members: { where: input.allowHistoricalAccount ? {} : { isCurrent: true },
      include: { client: true }, orderBy: { cedarRidgeUserId: "asc" } } },
  });
  if (!account || (!input.allowHistoricalAccount && (!account.isCurrent || ["CLOSED", "INACTIVE"].includes(account.status ?? ""))) ||
      account.members.length !== cedarRidgeUserIds.length || account.members.some((member, index) =>
        member.cedarRidgeUserId !== cedarRidgeUserIds[index] || member.relationshipType !== "JOINT")) {
    throw new ClientDirectoryError("ACCOUNT_NOT_LINKED", "Select every verified joint holder of the same Apex account.", 422);
  }
  if (!input.allowHistoricalAccount && account.members.some(({ client }) =>
    client.eligibility === "INACTIVE" || client.lastSeenSnapshotId !== state.activeSnapshotId)) {
    throw new ClientDirectoryError("CLIENT_NOT_FOUND", "A selected client is unavailable.", 422);
  }
  const clients = account.members.map((member) => ({ cedarRidgeUserId: member.cedarRidgeUserId,
    canonicalName: member.client.canonicalName, relationshipType: member.relationshipType,
    investmentAccountId: account.investmentAccountId }));
  const evidenceDigest = createHash("sha256").update(JSON.stringify({ cedarRidgeUserIds,
    accountNumber: number, investmentAccountId: account.investmentAccountId, accountStatus: account.status,
    accountIsCurrent: account.isCurrent, freshnessBasis: state.freshnessBasis,
    clients: account.members.map((member) => ({ cedarRidgeUserId: member.cedarRidgeUserId,
      canonicalName: member.client.canonicalName, eligibility: member.client.eligibility,
      relationshipType: member.relationshipType, isCurrent: member.isCurrent })),
  })).digest("hex");
  return { cedarRidgeUserIds, clients, canonicalName: clients.map((client) => client.canonicalName).join(" & "),
    snapshotId: state.activeSnapshotId, freshnessBasis: state.freshnessBasis, evidenceDigest };
}

/** Display projection only, including during an outage. Callers requiring a
 * consistent mutation snapshot hold the directory and parent locks first. */
export async function getAcatRecordClients(tx: Prisma.TransactionClient, recordId: string) {
  const links = await tx.acatRecordClient.findMany({ where: { acatRecordId: recordId },
    orderBy: { cedarRidgeUserId: "asc" }, select: { cedarRidgeUserId: true, client: { select: { canonicalName: true } } } });
  return { cedarRidgeUserIds: links.map((link) => link.cedarRidgeUserId),
    linkedClients: links.map((link) => ({ cedarRidgeUserId: link.cedarRidgeUserId, displayName: link.client.canonicalName })) };
}

/** Internal persistence primitive, not identity authorization. Caller has
 * resolved the selected people or approved exact undo evidence. Empty sets are
 * allowed for internal undo only; public API validators must require a person.
 * Read the final version again if later parent-field updates occur in this tx. */
export async function replaceAcatRecordClients(tx: Prisma.TransactionClient, input: {
  recordId: string; cedarRidgeUserIds: string[]; expectedIdentityVersion: number;
}) {
  const cedarRidgeUserIds = validatedClientIds(input.cedarRidgeUserIds, true);
  await lockDirectory(tx);
  await tx.$queryRaw`SELECT "id" FROM "AcatRecord" WHERE "id" = ${input.recordId} FOR UPDATE`;
  const record = await tx.acatRecord.findUnique({ where: { id: input.recordId }, select: { identityVersion: true } });
  if (!record) throw new ClientDirectoryError("INVALID_REQUEST", "ACAT record not found.", 404);
  if (record.identityVersion !== input.expectedIdentityVersion) {
    throw new ClientDirectoryError("IDENTITY_CONFLICT", "This record changed. Reload it before changing its clients.", 409);
  }
  const before = await getAcatRecordClients(tx, input.recordId);
  const removed = before.cedarRidgeUserIds.filter((id) => !cedarRidgeUserIds.includes(id));
  const added = cedarRidgeUserIds.filter((id) => !before.cedarRidgeUserIds.includes(id));
  if (removed.length) await tx.acatRecordClient.deleteMany({ where: { acatRecordId: input.recordId, cedarRidgeUserId: { in: removed } } });
  if (added.length) await tx.acatRecordClient.createMany({ data: added.map((cedarRidgeUserId) => ({ acatRecordId: input.recordId, cedarRidgeUserId })) });
  const after = await tx.acatRecord.findUniqueOrThrow({ where: { id: input.recordId },
    select: { cedarRidgeUserId: true, identityVersion: true } });
  return { cedarRidgeUserIds: (await getAcatRecordClients(tx, input.recordId)).cedarRidgeUserIds, ...after };
}

export async function searchClients(query: string, limit = CLIENT_SEARCH_MAX_RESULTS): Promise<ClientSearchResponse> {
  const normalized = normalizeName(query);
  if (normalized.length < CLIENT_SEARCH_MIN_LENGTH || normalized.length > CLIENT_SEARCH_MAX_LENGTH ||
      !Number.isInteger(limit) || limit < 1 || limit > CLIENT_SEARCH_MAX_RESULTS) {
    throw new ClientDirectoryError("INVALID_REQUEST", "Enter a valid client search.", 400);
  }
  // One shared publication lock ensures names, hints and returned health come
  // from one snapshot, while still allowing concurrent searches/identity writes.
  return prisma.$transaction(async (tx) => {
    await lockDirectory(tx);
    const state = await tx.cedarRidgeDirectorySync.findUnique({ where: { id: "global" } });
    const directory = directoryStatusFromState(state);
    if (!state?.activeSnapshotId) throw new ClientDirectoryError("DIRECTORY_UNAVAILABLE", "The client directory is unavailable.", 503);
    const clients = await tx.cedarRidgeClient.findMany({
      where: { normalizedName: { contains: normalized }, eligibility: { not: "INACTIVE" }, lastSeenSnapshotId: state.activeSnapshotId,
        ...(clientSearchCrmOnly() ? { crmStage: { in: ["Client", "Lost Client"] } } : {}) },
      orderBy: [{ normalizedName: "asc" }, { cedarRidgeUserId: "asc" }], take: limit + 1,
      include: { memberships: { where: { isCurrent: true, account: { isCurrent: true } },
        orderBy: { investmentAccountId: "asc" }, take: 5, include: { account: true } } },
    });
    return { items: clients.slice(0, limit).map((client) => ({ cedarRidgeUserId: client.cedarRidgeUserId,
      displayName: client.canonicalName, accountHints: client.memberships.map((member) => ({
        maskedAccountNumber: member.account.accountNumber ? (member.account.accountNumber.length > 4 ? `••••${member.account.accountNumber.slice(-4)}` : "••••") : null,
        custodian: member.account.custodian, relationshipType: member.relationshipType,
      })) })), hasMore: clients.length > limit, directory };
  }, { maxWait: 3000, timeout: 5000 });
}

/** Read-only evidence for an approved backfill dossier. Does not authorize a
 * name-only link or substitute a selected person for all joint members. */
export async function readBackfillDirectoryEvidence(tx: Prisma.TransactionClient, input: {
  accountNumber: string | null; candidateUserIds: string[];
}) {
  const state = await verifiedState(tx);
  const number = input.accountNumber ? normalizeAccountNumber(input.accountNumber) : null;
  const accounts = number ? await tx.cedarRidgeAccount.findMany({
    where: { custodian: "APEX", normalizedAccountNumber: number }, orderBy: { investmentAccountId: "asc" },
    include: { members: { include: { client: true }, orderBy: { cedarRidgeUserId: "asc" } } },
  }) : [];
  const clients = await tx.cedarRidgeClient.findMany({ where: { cedarRidgeUserId: { in: input.candidateUserIds } },
    orderBy: { cedarRidgeUserId: "asc" } });
  return { snapshotId: state.activeSnapshotId, freshnessBasis: state.freshnessBasis,
    accounts: accounts.map((account) => ({ investmentAccountId: account.investmentAccountId,
      custodian: account.custodian, accountNumber: account.accountNumber, normalizedAccountNumber: account.normalizedAccountNumber,
      status: account.status, isCurrent: account.isCurrent, members: account.members.map((m) => ({
        cedarRidgeUserId: m.cedarRidgeUserId, canonicalName: m.client.canonicalName, eligibility: m.client.eligibility,
        relationshipType: m.relationshipType, isCurrent: m.isCurrent,
      })) })),
    clients: clients.map((client) => ({ cedarRidgeUserId: client.cedarRidgeUserId, canonicalName: client.canonicalName,
      eligibility: client.eligibility, presentInSnapshot: client.lastSeenSnapshotId === state.activeSnapshotId })),
  };
}
