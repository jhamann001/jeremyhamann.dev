import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lockDirectory, resolveClientIdentities, replaceAcatRecordClients } from "@/lib/client-directory";
import { acatClientLinksSelection } from "@/lib/acat-identity-dto";
import { requestedClientIds, type clientIdentityRelinkSchema } from "@/lib/validators";
import { allowsPendingAccount } from "@/lib/client-identity-policy";
import { identityError, IDENTITY_RESPONSE_HEADERS } from "@/lib/client-identity-http";
import type { z } from "zod";

export type ClientIdentityRelinkInput = z.infer<typeof clientIdentityRelinkSchema>;

// The record shape both callers project (browser DTO or machine redaction).
type RelinkedRecord = Awaited<ReturnType<typeof loadStored>>;

function loadStored(tx: Prisma.TransactionClient, id: string) {
  return tx.acatRecord.findUniqueOrThrow({
    where: { id },
    include: { assets: true, clientLinks: acatClientLinksSelection, custodian: { omit: { requiresManualReview: true } } },
  });
}

export type ClientIdentityRelinkResult =
  | { kind: "record"; record: RelinkedRecord }
  | { kind: "response"; response: NextResponse };

/**
 * Replace the client(s) on one transfer. Shared by the signed-in browser route
 * (`PUT /api/acats/[id]/client-identity`) and the trusted machine drawer route.
 * Caller authorization is the caller's job and runs OUTSIDE this transaction.
 * Directory errors propagate to the caller (`directoryErrorResponse`).
 */
export async function relinkAcatClients({
  id,
  input,
  performedBy,
}: {
  id: string;
  input: ClientIdentityRelinkInput;
  performedBy: string;
}): Promise<ClientIdentityRelinkResult> {
  return prisma.$transaction(async (tx): Promise<ClientIdentityRelinkResult> => {
    // All identity writers take these locks in the same order. A publisher
    // cannot replace account membership between validation and persistence.
    await lockDirectory(tx);
    await tx.$queryRaw`SELECT id FROM "AcatRecord" WHERE id = ${id} FOR UPDATE`;
    const existing = await tx.acatRecord.findUnique({ where: { id, deletedAt: null },
      include: { assets: true, clientLinks: acatClientLinksSelection, custodian: { omit: { requiresManualReview: true } } } });
    if (!existing) {
      return { kind: "response", response: NextResponse.json({ error: "ACAT record not found" }, { status: 404, headers: IDENTITY_RESPONSE_HEADERS }) };
    }
    if (existing.identityVersion !== input.expectedIdentityVersion) {
      return { kind: "response", response: identityError("IDENTITY_CONFLICT", "This record changed. Reload it before changing the client.", 409) };
    }
    const beforeIds = existing.clientLinks.map((link) => link.cedarRidgeUserId).sort();
    if (input.cedarRidgeUserId && beforeIds.length > 1) {
      return { kind: "response", response: identityError("IDENTITY_CONFLICT", "This record links multiple people. Reload it to review the complete client selection.", 409) };
    }
    const apexAccountId = input.apexAccountId ?? existing.apexAccountId;
    const identity = await resolveClientIdentities(tx, {
      cedarRidgeUserIds: requestedClientIds(input),
      apexAccountId,
      allowPendingAccount: allowsPendingAccount(existing.status),
    });
    const clientName = input.replaceDisplayName ? identity.canonicalName : existing.clientName;
    const nameChanged = clientName !== existing.clientName;
    if (nameChanged && existing.mappingAccountId && !input.acknowledgeMappingInvalidation) {
      return { kind: "response", response: identityError("MAPPING_INVALIDATION_REQUIRED", "Changing the saved name clears its asset mapping link. Confirm this change first.", 400) };
    }
    const changes: Array<[string, string | null, string | null]> = ([
      ["cedarRidgeUserIds", JSON.stringify(beforeIds), JSON.stringify(identity.cedarRidgeUserIds)],
      ["apexAccountId", existing.apexAccountId, apexAccountId],
      ["clientName", existing.clientName, clientName],
    ] as Array<[string, string | null, string | null]>).filter(([, oldValue, newValue]) => oldValue !== newValue);
    if (changes.length === 0) {
      return { kind: "record", record: existing };
    }
    const linked = await replaceAcatRecordClients(tx, { recordId: id,
      cedarRidgeUserIds: identity.cedarRidgeUserIds, expectedIdentityVersion: input.expectedIdentityVersion });
    if (nameChanged || apexAccountId !== existing.apexAccountId) {
      await tx.acatRecord.update({
        where: { id, identityVersion: linked.identityVersion },
        data: {
          apexAccountId, clientName,
          // Identity-only corrections preserve the operational activity clock.
          ...(nameChanged && existing.mappingAccountId ? { mappingAccountId: null, mappingAccountSummary: Prisma.DbNull } : {}),
        },
      });
    }
    const updated = await loadStored(tx, id);
    if (nameChanged && existing.mappingAccountId) changes.push(["mappingAccountId", existing.mappingAccountId, null]);
    await tx.auditLog.createMany({ data: changes.map(([field, oldValue, newValue]) => ({
      acatRecordId: id, action: "identity-relink", field, oldValue, newValue, performedBy,
    })) });
    await tx.auditLog.create({ data: {
      acatRecordId: id, action: "identity-relink-provenance", field: "cedarRidgeUserIds", performedBy,
      newValue: JSON.stringify({ reason: input.reason, snapshotId: identity.snapshotId, freshnessBasis: identity.freshnessBasis, evidenceDigest: identity.evidenceDigest,
        oldUserIds: beforeIds, newUserIds: identity.cedarRidgeUserIds,
        beforeVersion: existing.identityVersion, afterVersion: updated.identityVersion }),
    } });
    return { kind: "record", record: updated };
  });
}
