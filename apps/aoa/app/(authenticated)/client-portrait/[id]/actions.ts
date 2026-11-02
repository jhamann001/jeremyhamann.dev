"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { withUserScope, type Identity } from "@/lib/rls";
import {
  writeAudit,
  TAX_BUDGET_SET,
  TAX_BUDGET_UPDATE,
  TRADE_PROFILE_SOURCE_CHANGE,
  TRADE_PROFILE_SOURCE_CONFIRM,
} from "@/lib/audit";
import { currentTaxYear } from "@/lib/data/tax-budget";
import { apexAccountsForClient } from "@/lib/data/account-aum";
import { getCedarRidgeUserIdForLinkedReads } from "@/lib/data/clients";
import { tradeProfileRecordsFromSummaries } from "@/lib/data/trade-request-profile";
import { getTradeRequestsForUser } from "@/lib/data/trade-requests";
import { canConfirmTradeProfile } from "@/lib/data/trade-profile-selection";
import {
  canWriteTaxBudget,
  validateTaxBudgetValues,
  type TaxBudgetValidationError,
} from "@/lib/data/tax-budget-write";
import type { TaxBudgetYear } from "@/lib/data/types";
import { plaidHoldingsPreviewAllowed } from "@/lib/auth/plaid-holdings-preview";
import { linkedExternalSummariesForClient } from "@/lib/data/linked-external-account-summary";
import {
  loadLinkedHoldingsCard,
  type HoldingsPreviewResult,
} from "@/lib/data/linked-external-holdings-preview";
import {
  classifyHoldingsTransferability,
  degradedTransferability,
} from "@/lib/data/holdings-transferability-preview";

export type SaveTaxBudgetResult =
  | { ok: true; budget: TaxBudgetYear }
  | { ok: false; errors: TaxBudgetValidationError[] };

const WRITE_REJECTED: SaveTaxBudgetResult = {
  ok: false,
  errors: [
    {
      field: "budget",
      message:
        "Save failed. The client may not exist, or your role may not have permission to update this tax budget.",
    },
  ],
};

export type ConfirmTradeProfileSourceResult =
  | { ok: true }
  | { ok: false; message: string };

const PROFILE_SOURCE_REJECTED: ConfirmTradeProfileSourceResult = {
  ok: false,
  message:
    "Confirmation failed. The request may no longer qualify, the account may not match, or your role may not have permission.",
};

export type PreviewLinkedHoldingsResult =
  | ({ ok: true } & HoldingsPreviewResult)
  | { ok: false; reason: "unauthorized" | "preview_failed" };

const PREVIEW_UNAUTHORIZED: PreviewLinkedHoldingsResult = { ok: false, reason: "unauthorized" };

async function sessionIdentity(): Promise<Identity> {
  const session = await auth();
  if (!session?.user) redirect("/");
  return {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };
}

/**
 * Create or replace this client's budget for the current server-side tax year.
 * Identity, year, and set_by are derived on the server; the browser supplies
 * only the three editable values. The row write, raw DB audit trigger, and
 * business audit event commit together inside the caller's RLS transaction.
 */
export async function saveTaxBudget(
  clientSfId: string,
  input: { budget: unknown; realized: unknown; note: unknown },
): Promise<SaveTaxBudgetResult> {
  const identity = await sessionIdentity();
  if (!canWriteTaxBudget(identity.role)) return WRITE_REJECTED;

  const validated = validateTaxBudgetValues(input);
  if (!validated.ok) return validated;

  const sfId = clientSfId.trim();
  if (!sfId) return WRITE_REJECTED;

  const year = currentTaxYear();
  const { budget, realized, note } = validated.values;

  try {
    const saved = await withUserScope(identity, async (tx) => {
      // This lookup runs through mirror.client's own FORCE-RLS policy. It both
      // distinguishes an authorized client from an arbitrary id and ensures an
      // out-of-book caller reaches no tax-budget write.
      const visible = await tx.$queryRaw<Array<{ sf_id: string }>>`
        SELECT sf_id FROM mirror.client WHERE sf_id = ${sfId} LIMIT 1`;
      if (!visible[0]) throw new Error("client_not_visible");

      const existing = await tx.taxBudgetRecord.findUnique({
        where: { client_sf_id_year: { client_sf_id: sfId, year } },
        select: { id: true },
      });
      const row = await tx.taxBudgetRecord.upsert({
        where: { client_sf_id_year: { client_sf_id: sfId, year } },
        create: {
          client_sf_id: sfId,
          year,
          budget,
          realized,
          note,
          set_by: identity.email ?? null,
        },
        update: {
          budget,
          realized,
          note,
          set_by: identity.email ?? null,
        },
      });

      await writeAudit(tx, identity, {
        action: existing ? TAX_BUDGET_UPDATE : TAX_BUDGET_SET,
        entityType: "tax_budget",
        entityId: row.id,
        // No free-text note in the business audit. The field-level privileged
        // audit captures the exact row change; this event stays compact.
        detail: { clientSfId: sfId, year, budget, realized, notePresent: note !== "" },
      });
      return row;
    });

    revalidatePath(`/client-portrait/${encodeURIComponent(sfId)}`);
    return {
      ok: true,
      budget: {
        budget: Number(saved.budget),
        realized: Number(saved.realized),
        note: saved.note,
      },
    };
  } catch {
    // Do not leak whether the client was absent, outside the caller's book, or
    // rejected by the DB role policy.
    return WRITE_REJECTED;
  }
}

/**
 * Confirm one approved Trade Request as the complete current profile source for
 * one active Apex account. The source facts stay in Trade Request; AOA stores
 * only the reviewed request reference, decision timestamp, actor and note.
 */
export async function confirmTradeProfileSource(
  clientSfId: string,
  accountId: string,
  requestId: string,
  note: unknown,
): Promise<ConfirmTradeProfileSourceResult> {
  const identity = await sessionIdentity();
  if (!canConfirmTradeProfile(identity.role)) return PROFILE_SOURCE_REJECTED;

  const sfId = clientSfId.trim();
  const apexAccountId = accountId.trim();
  const sourceRequestId = requestId.trim();
  const selectionNote = typeof note === "string" ? note.trim() : "";
  if (
    !sfId ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(apexAccountId) ||
    !/^REQ-[A-Za-z0-9-]{1,120}$/.test(sourceRequestId) ||
    selectionNote.length > 500
  ) {
    return PROFILE_SOURCE_REJECTED;
  }

  try {
    const cedarRidgeUserId = await getCedarRidgeUserIdForLinkedReads(identity, sfId);
    if (!cedarRidgeUserId) return PROFILE_SOURCE_REJECTED;

    const [requests, accounts] = await Promise.all([
      getTradeRequestsForUser(cedarRidgeUserId),
      apexAccountsForClient(identity, sfId),
    ]);
    const account = accounts.find(
      (candidate) =>
        candidate.custodianAccountId === apexAccountId &&
        !["CLOSED", "RESTRICTED"].includes(
          candidate.accountStatus?.trim().toUpperCase() ?? "",
        ),
    );
    if (!account) return PROFILE_SOURCE_REJECTED;

    const eligibleSources = tradeProfileRecordsFromSummaries(requests).filter(
      (record) =>
        record.clientIds.includes(cedarRidgeUserId) &&
        (record.status === "Approved" || record.status === "Completed") &&
        (record.tradeType === "Initial Funding" || record.tradeType === "Rebalance") &&
        record.accounts?.some((candidate) => candidate.accountId === apexAccountId),
    );
    const source = eligibleSources.find(
      (record) => record.requestId === sourceRequestId,
    );
    if (!source || !source.decidedAt || Number.isNaN(Date.parse(source.decidedAt))) {
      return PROFILE_SOURCE_REJECTED;
    }

    await withUserScope(identity, async (tx) => {
      // A second RLS-backed visibility check keeps authorization and the write
      // in the same transaction; an out-of-book client never reaches upsert.
      const visible = await tx.$queryRaw<Array<{ sf_id: string }>>`
        SELECT sf_id FROM mirror.client WHERE sf_id = ${sfId} LIMIT 1`;
      if (!visible[0]) throw new Error("client_not_visible");

      const existing = await tx.tradeProfileSelection.findUnique({
        where: {
          client_sf_id_custodian_account_id: {
            client_sf_id: sfId,
            custodian_account_id: apexAccountId,
          },
        },
        select: { id: true, selected_request_id: true },
      });
      const row = await tx.tradeProfileSelection.upsert({
        where: {
          client_sf_id_custodian_account_id: {
            client_sf_id: sfId,
            custodian_account_id: apexAccountId,
          },
        },
        create: {
          client_sf_id: sfId,
          custodian_account_id: apexAccountId,
          selected_request_id: sourceRequestId,
          selected_request_decided_at: new Date(source.decidedAt),
          reviewed_request_ids: eligibleSources.map((record) => record.requestId).sort(),
          selection_note: selectionNote,
          selected_by: identity.email ?? null,
        },
        update: {
          selected_request_id: sourceRequestId,
          selected_request_decided_at: new Date(source.decidedAt),
          reviewed_request_ids: eligibleSources.map((record) => record.requestId).sort(),
          selection_note: selectionNote,
          selected_by: identity.email ?? null,
          selected_at: new Date(),
        },
      });

      await writeAudit(tx, identity, {
        action: existing
          ? TRADE_PROFILE_SOURCE_CHANGE
          : TRADE_PROFILE_SOURCE_CONFIRM,
        entityType: "trade_profile_selection",
        entityId: row.id,
        detail: {
          clientSfId: sfId,
          accountId: apexAccountId,
          requestId: sourceRequestId,
          priorRequestId: existing?.selected_request_id ?? null,
          notePresent: selectionNote !== "",
        },
      });
    });

    revalidatePath(`/client-portrait/${encodeURIComponent(sfId)}`);
    return { ok: true };
  } catch {
    return PROFILE_SOURCE_REJECTED;
  }
}

/**
 * Read-only holdings preview for one active Plaid-linked account (ticket).
 * Admin/Operations only, and only while the preview switch is on. The account
 * must be an active mirrored link visible to the caller under RLS. Results are
 * returned to the browser for display and are never stored or logged.
 */
export async function previewLinkedHoldings(args: {
  clientSfId: unknown;
  externalAccountId: unknown;
}): Promise<PreviewLinkedHoldingsResult> {
  const identity = await sessionIdentity();
  if (!plaidHoldingsPreviewAllowed(identity.role)) return PREVIEW_UNAUTHORIZED;

  const sfId = typeof args.clientSfId === "string" ? args.clientSfId.trim() : "";
  const externalAccountId =
    typeof args.externalAccountId === "string" ? args.externalAccountId.trim() : "";
  if (!sfId || sfId.length > 64 || !externalAccountId || externalAccountId.length > 256) {
    return PREVIEW_UNAUTHORIZED;
  }

  let summary;
  try {
    const summaries = await linkedExternalSummariesForClient(identity, sfId);
    summary = summaries.find(
      (s) => s.externalAccountId === externalAccountId && s.linkStatus === "ACTIVE",
    );
  } catch {
    return PREVIEW_UNAUTHORIZED;
  }
  if (!summary) return PREVIEW_UNAUTHORIZED;

  try {
    const { preview, inputs } = await loadLinkedHoldingsCard(externalAccountId);
    let annotations;
    try {
      annotations = await classifyHoldingsTransferability(inputs);
    } catch {
      annotations = degradedTransferability(inputs.length);
    }
    const institutionBalance = preview.institutionBalance ?? summary.institutionBalance;
    return {
      ok: true,
      ...preview,
      institutionBalance,
      difference:
        preview.holdingsTotal == null || institutionBalance == null
          ? null
          : preview.holdingsTotal - institutionBalance,
      rows: preview.rows.map((row, index) => ({
        symbol: row.symbol,
        name: row.name,
        quantity: row.quantity,
        value: row.value,
        label: annotations[index]?.label ?? "unknown",
        reason: annotations[index]?.reason ?? "rules_unavailable",
      })),
    };
  } catch {
    // The transport logs status only; never log holdings rows or amounts here.
    return { ok: false, reason: "preview_failed" };
  }
}
