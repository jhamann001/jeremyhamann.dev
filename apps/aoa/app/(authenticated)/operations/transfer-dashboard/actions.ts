"use server";

import { auth } from "@/auth";
import type { AcatBookRow } from "@/lib/data/acat-book";
import {
  boundedRecordId,
  postAcatDashboardReview,
  type ReviewWriteResult,
} from "@/lib/data/acat-dashboard";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { readAcatBook, type AcatBookSnapshot } from "@/lib/data/acat-workspace";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import {
  acatOpsEditsEnabled,
  epicAcatBookDayToDayActionsEnabled,
  operationsAcatTransferDashboardEnabled,
} from "@/lib/flags";
import { canAccessOperationsTools } from "@/lib/operations/authorization";

export type DashboardRecordResult =
  | { ok: true; row: AcatBookRow; transferId: string | null; editsEnabled: boolean; dayToDay: boolean }
  | { ok: false; retry: true; reason: "unauthorized" | "invalid" | "not_found" | "unavailable" };

async function guard(): Promise<{ ok: true; role: string; email: string | null } | { ok: false; reason: "unauthorized" }> {
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role ?? "VIEWER";
  if (!session?.user || !canAccessOperationsTools(role) || !operationsAcatTransferDashboardEnabled()) {
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: true, role, email: session.user.email ?? null };
}

export async function reviewDashboardException(input: unknown): Promise<ReviewWriteResult> {
  const gate = await guard();
  if (!gate.ok) return { ok: false, open: true, reason: "unauthorized" };
  return postAcatDashboardReview(input);
}

export async function openDashboardRecord(recordId: string): Promise<DashboardRecordResult> {
  const gate = await guard();
  if (!gate.ok) return { ok: false, retry: true, reason: "unauthorized" };
  if (!canSeeUnlinkedAcats(gate.role) || !canReadCustodianLibrary(gate.role)) {
    return { ok: false, retry: true, reason: "unauthorized" };
  }
  const id = boundedRecordId(recordId);
  if (!id) return { ok: false, retry: true, reason: "invalid" };
  let snapshot: AcatBookSnapshot;
  try {
    snapshot = await readAcatBook({ role: gate.role, email: gate.email });
  } catch {
    return { ok: false, retry: true, reason: "unavailable" };
  }
  const row = snapshot.rows.find((candidate) => candidate.id === id);
  if (!row) return { ok: false, retry: true, reason: "not_found" };
  const transferId = snapshot.linkedByRecordId[id]
    ?? (row.acatTransferId ? snapshot.linkedTransferIds[row.acatTransferId] : undefined)
    ?? null;
  return {
    ok: true,
    row,
    transferId,
    editsEnabled: acatOpsEditsEnabled(),
    dayToDay: epicAcatBookDayToDayActionsEnabled(),
  };
}
