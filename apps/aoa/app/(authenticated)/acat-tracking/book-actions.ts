"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import { readAcatMachine, writeAcatBookRecord } from "@/lib/data/acat-status";
import { markAcatBookStale } from "@/lib/data/acat-workspace";
import type { AcatBookRow } from "@/lib/data/acat-book";
import {
  ACAT_DAY_TO_DAY_OFF,
  ACAT_EDIT_FORBIDDEN,
  ACAT_EDIT_NO_CHANGES,
  ACAT_EDIT_NOT_LIFECYCLE,
  ACAT_EDITS_OFF,
  ACAT_WRITE_UNAVAILABLE,
  bookRowFromSaved,
  buildAcatPatch,
  buildDayToDayPatch,
  isLifecycleStatus,
  writeRejectionReason,
  type AcatBookWriteResult,
} from "@/lib/data/acat-book-edit";
import {
  buildAcatCreateBody,
  CLIENT_SEARCH_LIMIT,
  type AcatAccountHint,
  type AcatClientResult,
  type AcatCreateDraft,
  type AcatDirectoryStatus,
} from "@/lib/data/acat-create-contract";
import { CustodianLibraryError, getCustodianLibrary } from "@/lib/data/custodian-library";
import { acatOpsBookEnabled, acatOpsEditsEnabled, epicAcatBookDayToDayActionsEnabled } from "@/lib/flags";

async function gate(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const session = await auth();
  if (!session?.user) return { ok: false, reason: ACAT_EDIT_FORBIDDEN };
  if (!(acatOpsBookEnabled() && acatOpsEditsEnabled())) return { ok: false, reason: ACAT_EDITS_OFF };
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!canSeeUnlinkedAcats(role) || !canReadCustodianLibrary(role)) return { ok: false, reason: ACAT_EDIT_FORBIDDEN };
  return { ok: true };
}

function saved(row: AcatBookRow | null): AcatBookWriteResult {
  if (!row) return { ok: false, reason: ACAT_WRITE_UNAVAILABLE };
  markAcatBookStale();
  revalidatePath("/acat-tracking");
  return { ok: true, row };
}

export async function saveAcatBookRecord(
  row: AcatBookRow,
  draft: Partial<Record<string, string>>,
): Promise<AcatBookWriteResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed;
  if (typeof row?.id !== "string" || row.id === "" || row.id.length >= 200) {
    return { ok: false, reason: ACAT_WRITE_UNAVAILABLE };
  }
  const status = (draft.status ?? "").trim();
  const statusChanged = status !== (row.status ?? "").trim();
  if (status !== "" && statusChanged && !isLifecycleStatus(status)) return { ok: false, reason: ACAT_EDIT_NOT_LIFECYCLE };
  const dayToDay = epicAcatBookDayToDayActionsEnabled();
  const base = buildAcatPatch(row, draft);
  const extra = dayToDay ? buildDayToDayPatch(row, draft) : { patch: {}, changed: 0 };
  const patch = { ...base.patch, ...extra.patch };
  if (base.changed + extra.changed === 0) return { ok: false, reason: ACAT_EDIT_NO_CHANGES };
  const res = await writeAcatBookRecord("PATCH", `/api/machine/acats/by-record/${encodeURIComponent(row.id)}`, patch);
  if (res.status !== 200) return { ok: false, reason: writeRejectionReason(res.status, res.data) };
  const sent = dayToDay && !row.textLoadError
    ? { notes: draft.notes, tradeInstructions: draft.tradeInstructions }
    : undefined;
  return saved(bookRowFromSaved(res.data, row, new Date().toISOString(), sent));
}

export async function createAcatBookRecord(
  draft: AcatCreateDraft,
  directory: AcatDirectoryStatus | null,
): Promise<AcatBookWriteResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed;
  if (!epicAcatBookDayToDayActionsEnabled()) return { ok: false, reason: ACAT_DAY_TO_DAY_OFF };
  const valid = buildAcatCreateBody(draft, directory);
  if (!valid.ok) return valid;
  const res = await writeAcatBookRecord("POST", "/api/machine/acats", valid.body);
  if (res.status !== 201) return { ok: false, reason: writeRejectionReason(res.status, res.data) };
  return saved(bookRowFromSaved(res.data, null, new Date().toISOString()));
}

const SELECTED_CLIENT = /^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const textOrNull = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);

function directoryFrom(raw: unknown): AcatDirectoryStatus | null {
  const d = (raw ?? null) as Record<string, unknown> | null;
  if (!d || typeof d.writeEligible !== "boolean" || typeof d.enabled !== "boolean"
    || typeof d.health !== "string" || typeof d.pendingAccountPolicy !== "string") return null;
  return { writeEligible: d.writeEligible, enabled: d.enabled, health: d.health, pendingAccountPolicy: d.pendingAccountPolicy };
}

export type AcatClientSearchResult =
  | { ok: true; clients: AcatClientResult[]; hasMore: boolean; directory: AcatDirectoryStatus | null }
  | { ok: false; reason: string };

export async function searchAcatBookClients(query: string): Promise<AcatClientSearchResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed;
  if (!epicAcatBookDayToDayActionsEnabled()) return { ok: false, reason: ACAT_DAY_TO_DAY_OFF };
  const res = await readAcatMachine(
    `/api/machine/clients/search?query=${encodeURIComponent(query)}&limit=${CLIENT_SEARCH_LIMIT}`,
  );
  if (res.status !== 200) return { ok: false, reason: writeRejectionReason(res.status, res.data) };
  const payload = (res.data ?? {}) as { items?: unknown; hasMore?: unknown; directory?: unknown };
  const clients = (Array.isArray(payload.items) ? payload.items : []).flatMap((item) => {
    const row = (item ?? {}) as { cedarRidgeUserId?: unknown; displayName?: unknown; accountHints?: unknown };
    const cedarRidgeUserId = typeof row.cedarRidgeUserId === "string" ? row.cedarRidgeUserId : "";
    const displayName = typeof row.displayName === "string" ? row.displayName.trim() : "";
    if (!SELECTED_CLIENT.test(cedarRidgeUserId) || displayName === "") return [];
    const accountHints: AcatAccountHint[] = (Array.isArray(row.accountHints) ? row.accountHints : []).map((hint) => {
      const h = (hint ?? {}) as Record<string, unknown>;
      return {
        custodian: textOrNull(h.custodian),
        maskedAccountNumber: textOrNull(h.maskedAccountNumber),
        relationshipType: textOrNull(h.relationshipType),
      };
    });
    return [{ cedarRidgeUserId, displayName, accountHints }];
  });
  return { ok: true, clients, hasMore: payload.hasMore === true, directory: directoryFrom(payload.directory) };
}

export async function listAcatContras(): Promise<
  { ok: true; contras: { name: string; dtcNumber: string | null }[] } | { ok: false; reason: string }
> {
  const allowed = await gate();
  if (!allowed.ok) return allowed;
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role ?? "VIEWER";
  try {
    const library = await getCustodianLibrary(role);
    return {
      ok: true,
      contras: library.custodians.map((c) => ({ name: c.name, dtcNumber: c.dtcNumber ?? null })),
    };
  } catch (error) {
    if (!(error instanceof CustodianLibraryError)) throw error;
    console.error("[acat-book] contra_read_failed");
    return { ok: false, reason: "Custodian list is unavailable" };
  }
}

export type AcatBookRestoreResult = { ok: true } | { ok: false; reason: string };

export async function restoreAcatBookRecord(row: AcatBookRow): Promise<AcatBookRestoreResult> {
  const allowed = await gate();
  if (!allowed.ok) return allowed;
  if (typeof row?.id !== "string" || row.id === "" || row.id.length >= 200) {
    return { ok: false, reason: ACAT_WRITE_UNAVAILABLE };
  }
  const res = await writeAcatBookRecord("POST", `/api/machine/acats/by-record/${encodeURIComponent(row.id)}/restore`, {});
  if (res.status !== 200) return { ok: false, reason: writeRejectionReason(res.status, res.data) };
  markAcatBookStale();
  revalidatePath("/acat-tracking");
  return { ok: true };
}
