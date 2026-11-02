"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  appendTradeReconciliationNote,
  appendTradeReconciliationBulkReview,
  appendTradeReconciliationReview,
  persistCompletedTradeReconciliation,
  tradeReconciliationHistory,
  type TradeReconciliationPageData,
} from "@/lib/data/trade-reconciliation";
import { operationsTradeReconciliationPreviewEnabled } from "@/lib/flags";
import { isTradingDay, previousTradingDay, toDateStr } from "@/lib/market-calendar";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import { fetchTradeReconciliationSources, TradeReconciliationSourceError } from "@/lib/operations/trade-reconciliation-source";
import type { Identity } from "@/lib/rls";

export type TradeReconciliationMutationResult = { ok: boolean; message: string };
export type TradeReconciliationHistoryResult = {
  ok: boolean;
  history: TradeReconciliationPageData["history"];
};

async function authorizedIdentity(): Promise<Identity | null> {
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role ?? "VIEWER";
  if (
    !session?.user ||
    !operationsTradeReconciliationPreviewEnabled() ||
    !canAccessOperationsTools(role)
  ) return null;
  return { role, email: session.user.email ?? null };
}

export async function loadTradeReconciliationHistory(): Promise<TradeReconciliationHistoryResult> {
  const identity = await authorizedIdentity();
  const empty = { daily: [], monthly: [], quarterly: [] };
  if (!identity) return { ok: false, history: empty };
  try {
    return { ok: true, history: await tradeReconciliationHistory(identity) };
  } catch {
    console.error("[trade-reconciliation] history_load_failed");
    return { ok: false, history: empty };
  }
}

export async function runTradeReconciliation(formData: FormData): Promise<void> {
  const identity = await authorizedIdentity();
  if (!identity) redirect("/");
  const runDate = String(formData.get("runDate") ?? "").trim();
  const today = toDateStr(new Date());
  let tradeDate: string;
  try {
    if (runDate > today || !isTradingDay(runDate)) throw new Error("invalid_date");
    tradeDate = previousTradingDay(runDate);
  } catch {
    redirect("/operations/trade-reconciliation?message=invalid-date");
  }

  let runId: string;
  try {
    const sources = await fetchTradeReconciliationSources(tradeDate);
    runId = await persistCompletedTradeReconciliation(identity, { runDate, tradeDate }, sources);
  } catch (error) {
    console.error("[trade-reconciliation] run_failed");
    if (error instanceof TradeReconciliationSourceError &&
      ["source_truncated", "source_limit_exceeded"].includes(error.reason)) {
      redirect(`/operations/trade-reconciliation?date=${runDate}&message=${error.reason.replaceAll("_", "-")}`);
    }
    redirect(`/operations/trade-reconciliation?date=${runDate}&message=run-failed`);
  }
  revalidatePath("/operations/trade-reconciliation");
  redirect(`/operations/trade-reconciliation?run=${encodeURIComponent(runId)}&message=run-complete`);
}

export async function saveTradeReconciliationReview(input: {
  runId: string;
  rowFingerprint: string;
  classification: string;
  explanation: string;
}): Promise<TradeReconciliationMutationResult> {
  const identity = await authorizedIdentity();
  if (!identity) return { ok: false, message: "Not authorized." };
  try {
    const ok = await appendTradeReconciliationReview(identity, input);
    if (!ok) return { ok: false, message: "Review could not be saved." };
    revalidatePath("/operations/trade-reconciliation");
    return { ok: true, message: "Review saved." };
  } catch {
    return { ok: false, message: "Review could not be saved." };
  }
}

export async function saveTradeReconciliationBulkReview(input: {
  runId: string;
  rowFingerprints: string[];
  classification: string;
  explanation: string;
}): Promise<TradeReconciliationMutationResult> {
  const identity = await authorizedIdentity();
  if (!identity) return { ok: false, message: "Not authorized." };
  try {
    const result = await appendTradeReconciliationBulkReview(identity, input);
    if (result === "already-reviewed") {
      return { ok: false, message: "One or more selected breaks were already reviewed. Refresh and select only unresolved breaks." };
    }
    if (result !== "saved") return { ok: false, message: "Bulk review could not be saved." };
    revalidatePath("/operations/trade-reconciliation");
    return { ok: true, message: `Review saved for ${input.rowFingerprints.length} breaks.` };
  } catch {
    return { ok: false, message: "Bulk review could not be saved." };
  }
}

export async function saveTradeReconciliationNote(input: {
  runId: string;
  note: string;
}): Promise<TradeReconciliationMutationResult> {
  const identity = await authorizedIdentity();
  if (!identity) return { ok: false, message: "Not authorized." };
  try {
    const ok = await appendTradeReconciliationNote(identity, input.runId, input.note);
    if (!ok) return { ok: false, message: "Run note could not be saved." };
    revalidatePath("/operations/trade-reconciliation");
    return { ok: true, message: "Run note saved." };
  } catch {
    return { ok: false, message: "Run note could not be saved." };
  }
}
