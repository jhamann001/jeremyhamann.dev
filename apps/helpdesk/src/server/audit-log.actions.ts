"use server";
/**
 * Audit-chain verification.
 *
 * Walks the ledger seq-ascending in pages of 1000 with the pure `verifyChainRows` walker, then records
 * its own verdict as AUDIT_CHAIN_VERIFIED (newValue "OK" | "FAIL@<seq>", metadata = the full result).
 * Compliance-only (audit:verify); the shared action runner records denials and never throws to the client.
 */
import type { ActionResult, ChainVerification } from "@/types/domain";
import { actorFromViewer, verifyChainRows, writeAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { assertCan, canVerifyAudit } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";

const PAGE_SIZE = 1000;
const DECIMAL_SEQ = /^\d{1,19}$/;

function parseSeqBound(raw: string | undefined, name: "fromSeq" | "toSeq"): bigint | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (!DECIMAL_SEQ.test(trimmed)) {
    throw new ValidationError("Invalid sequence bound", { [name]: ["Must be a positive decimal integer"] });
  }
  const value = BigInt(trimmed);
  if (value < BigInt(1)) {
    throw new ValidationError("Invalid sequence bound", { [name]: ["Must be >= 1"] });
  }
  return value;
}

export async function verifyAuditChain(range?: {
  fromSeq?: string;
  toSeq?: string;
}): Promise<ActionResult<ChainVerification>> {
  return runAction("verifyAuditChain", async (viewer, ctx) => {
    assertCan(canVerifyAudit(viewer.groups), "audit:verify");

    const fromSeq = parseSeqBound(range?.fromSeq, "fromSeq");
    const toSeq = parseSeqBound(range?.toSeq, "toSeq");
    if (fromSeq !== undefined && toSeq !== undefined && toSeq < fromSeq) {
      throw new ValidationError("Invalid sequence range", { toSeq: ["toSeq must be >= fromSeq"] });
    }

    // The hash the first examined row must link to: null (GENESIS) from the start of the ledger, otherwise the
    // hash of the last row before `fromSeq`.
    let previousHash: string | null = null;
    if (fromSeq !== undefined && fromSeq > BigInt(1)) {
      const prev = await prisma.auditLog.findFirst({
        where: { seq: { lt: fromSeq } },
        orderBy: { seq: "desc" },
        select: { hash: true },
      });
      previousHash = prev?.hash ?? null;
    }

    let cursor: bigint | undefined = fromSeq !== undefined ? fromSeq - BigInt(1) : undefined;
    let checkedRows = 0;
    let firstSeq: bigint | null = null;
    let lastSeq: bigint | null = null;
    let firstBadSeq: bigint | null = null;
    let reason: ChainVerification["reason"] = "EMPTY";
    let ok = true;

    for (;;) {
      const rows = await prisma.auditLog.findMany({
        where: {
          seq: {
            ...(cursor !== undefined ? { gt: cursor } : {}),
            ...(toSeq !== undefined ? { lte: toSeq } : {}),
          },
        },
        orderBy: { seq: "asc" },
        take: PAGE_SIZE,
      });
      if (rows.length === 0) break;

      if (firstSeq === null) firstSeq = rows[0].seq;
      const result = verifyChainRows(rows, previousHash);
      checkedRows += result.checked;
      if (!result.ok) {
        ok = false;
        firstBadSeq = result.firstBadSeq;
        reason = result.reason;
        lastSeq = result.firstBadSeq ?? rows[rows.length - 1].seq;
        break;
      }
      reason = "OK";
      const tail = rows[rows.length - 1];
      lastSeq = tail.seq;
      previousHash = tail.hash;
      cursor = tail.seq;
      if (rows.length < PAGE_SIZE) break;
    }

    const verification: ChainVerification = {
      ok,
      checkedRows,
      fromSeq: (firstSeq ?? fromSeq ?? BigInt(0)).toString(),
      toSeq: (lastSeq ?? toSeq ?? firstSeq ?? fromSeq ?? BigInt(0)).toString(),
      firstBadSeq: firstBadSeq === null ? null : firstBadSeq.toString(),
      reason,
      verifiedAt: new Date().toISOString(),
    };

    await writeAudit(prisma, actorFromViewer(viewer), ctx, {
      action: "AUDIT_CHAIN_VERIFIED",
      entityType: "AUDIT_LOG",
      newValue: ok ? "OK" : `FAIL@${verification.firstBadSeq ?? "?"}`,
      metadata: verification,
    });

    return verification;
  });
}
