"use server";

import { z } from "zod";
import { auth } from "@/auth";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { getAcatStatusByRecordId } from "@/lib/data/acat-status";
import { getCustodianLibrary } from "@/lib/data/custodian-library";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import {
  resolveTransferPreparation,
  type PreparationChoices,
  type PreparationContext,
  type TransferPreparation,
} from "@/lib/transfers/transfer-preparation";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const requestSchema = z.object({
  recordId: id,
  choices: z.object({ custodianId: id.optional(), workflowId: id.optional() }).strict(),
}).strict();

export type TransferPreparationResult =
  | { ok: true; context: PreparationContext; preparation: TransferPreparation; checkedAt: string }
  | { ok: false; reason: "forbidden" | "invalid" | "not_found" | "unavailable" };

/** Read-only requirements preview. Authorize before every source read and use
 * the Tracker's record PK, never a nullable/non-unique transfer identifier.
 * Only already-authorized reference information and minimal transfer facts
 * cross this boundary; no account identifiers, holdings or client name.
 * Route choices affect this unsaved preview only, never the source record. */
export async function loadTransferPreparation(
  recordId: string,
  choices: PreparationChoices = {},
): Promise<TransferPreparationResult> {
  try {
    const session = await auth();
    const role = (session?.user as { role?: string } | undefined)?.role ?? null;
    if (!session?.user || !canSeeUnlinkedAcats(role) || !canReadCustodianLibrary(role)) {
      return { ok: false, reason: "forbidden" };
    }
    const parsed = requestSchema.safeParse({ recordId, choices });
    if (!parsed.success) return { ok: false, reason: "invalid" };

    // Bound the combined read, including slow credential discovery. The
    // record reader also stops a late credential result from starting a fetch.
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        controller.abort();
        reject(new Error("preparation_source_timeout"));
      }, 8_000);
    });
    let sources;
    try {
      // Fresh reads, not the list's cached presentation snapshot.
      sources = await Promise.race([
        Promise.all([
          getAcatStatusByRecordId(parsed.data.recordId, { signal: controller.signal }),
          getCustodianLibrary(role!),
        ]),
        expired,
      ]);
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
    const [record, library] = sources;
    if (!record) return { ok: false, reason: "not_found" };
    if (parsed.data.choices.custodianId &&
        !library.custodians.some((custodian) => custodian.id === parsed.data.choices.custodianId)) {
      return { ok: false, reason: "invalid" };
    }
    const context: PreparationContext = {
      recordId: parsed.data.recordId,
      record: {
        direction: record.direction,
        type: record.type,
        accountType: record.accountType,
        transferringContra: record.transferringContra,
      },
      library,
    };
    const preparation = resolveTransferPreparation(context, parsed.data.choices);
    if (parsed.data.choices.workflowId &&
        !preparation.candidateWorkflows.some((workflow) => workflow.id === parsed.data.choices.workflowId)) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, context, preparation, checkedAt: new Date().toISOString() };
  } catch {
    // No source errors, identifiers, credentials or payloads enter logs/results.
    // Never return a previously successful plan after either source fails.
    return { ok: false, reason: "unavailable" };
  }
}
