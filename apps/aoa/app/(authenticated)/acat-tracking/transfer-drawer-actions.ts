"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import { readAcatMachine, writeAcatBookRecord, type AcatWriteResponse } from "@/lib/data/acat-status";
import { markAcatBookStale } from "@/lib/data/acat-workspace";
import { ACAT_EDITS_OFF } from "@/lib/data/acat-book-edit";
import { CLIENT_SEARCH_LIMIT } from "@/lib/data/acat-create-contract";
import { CustodianLibraryError, getCustodianLibrary } from "@/lib/data/custodian-library";
import { acatOpsEditsEnabled, acatTransferDrawerEnabled } from "@/lib/flags";
import {
  ACAT_DRAWER_ADMIN_ONLY,
  ACAT_DRAWER_LOAD_FAILURE,
  ACAT_DRAWER_OFF,
  ACAT_DRAWER_SEARCH_FAILURE,
  ACAT_EDIT_FORBIDDEN,
  ACAT_WRITE_UNAVAILABLE,
  DRAWER_STATUS_OPTIONS,
  buildChangeRequest,
  buildCompleteRequest,
  buildDeleteRequest,
  buildRejectRequest,
  buildReplaceRequest,
  drawerFailureFrom,
  dtccSuggestionFrom,
  mapDrawerTransfer,
  parseClientSearch,
  refusal,
  type DrawerClientSearchResult,
  type DrawerContraResult,
  type DrawerFailure,
  type DrawerReadResult,
  type DrawerTransfer,
  type DrawerWriteResult,
  type DtccSuggestion,
} from "@/lib/data/acat-drawer-contract";

const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Gate = { ok: true; role: string } | DrawerFailure;

async function gate(kind: "read" | "write"): Promise<Gate> {
  const session = await auth();
  if (!session?.user) return refusal(ACAT_EDIT_FORBIDDEN);
  if (!acatTransferDrawerEnabled()) return refusal(ACAT_DRAWER_OFF);
  if (kind === "write" && !acatOpsEditsEnabled()) return refusal(ACAT_EDITS_OFF);
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!canSeeUnlinkedAcats(role) || !canReadCustodianLibrary(role)) return refusal(ACAT_EDIT_FORBIDDEN);
  return { ok: true, role };
}

const byRecord = (id: string) => `/api/machine/acats/by-record/${encodeURIComponent(id)}`;
const drawerRoute = (id: string) => `${byRecord(id)}/drawer`;
const opsDrawerRoute = (id: string) => `/api/machine/acats/ops-drawer/${encodeURIComponent(id)}`;

/** The operations drawer read carries full Apex and statement numbers. The
 *  tracker refuses it with 401 for any identity but production AoA, and a
 *  tracker without the route answers 404; the drawer then shows the masked
 *  by-record read. */
async function readDrawerRecord(recordId: string): Promise<AcatWriteResponse> {
  const ops = await readAcatMachine(opsDrawerRoute(recordId));
  return ops.status === 401 || ops.status === 404 ? readAcatMachine(byRecord(recordId)) : ops;
}

/** Write responses carry the masked projection. Take the two account numbers
 *  from the operations read when it answers for the same record. */
async function withOpsAccounts(recordId: string, transfer: DrawerTransfer): Promise<DrawerTransfer> {
  const res = await readAcatMachine(opsDrawerRoute(recordId));
  const ops = res.status === 200 ? mapDrawerTransfer(res.data) : null;
  if (!ops || ops.id !== transfer.id) return transfer;
  return { ...transfer, apexAccountId: ops.apexAccountId, statementAccountNumber: ops.statementAccountNumber };
}

function unavailable(retryable = true): DrawerFailure {
  return { ok: false, reason: ACAT_WRITE_UNAVAILABLE, retryable };
}

async function stored(recordId: string, transfer: unknown): Promise<DrawerWriteResult> {
  const mapped = mapDrawerTransfer(transfer);
  if (!mapped) return unavailable();
  markAcatBookStale();
  revalidatePath("/acat-tracking");
  return { ok: true, transfer: await withOpsAccounts(recordId, mapped) };
}

function failed(status: number | null, body: unknown): DrawerFailure {
  console.error("[acat-drawer] write_failed");
  return drawerFailureFrom(status, body);
}

async function drawerWrite(recordId: string, body: unknown): Promise<DrawerWriteResult> {
  const res = await writeAcatBookRecord("PATCH", drawerRoute(recordId), body);
  if (res.status !== 200) return failed(res.status, res.data);
  return stored(recordId, (res.data as { transfer?: unknown } | null)?.transfer);
}

async function generalWrite(recordId: string, patch: Record<string, unknown>): Promise<DrawerWriteResult> {
  const res = await writeAcatBookRecord("PATCH", byRecord(recordId), patch);
  if (res.status !== 200) return failed(res.status, res.data);
  return stored(recordId, res.data);
}

export async function loadTransferDrawer(recordId: string): Promise<DrawerReadResult> {
  const allowed = await gate("read");
  if (!allowed.ok) return allowed;
  if (!RECORD_ID.test(recordId)) return refusal(ACAT_DRAWER_LOAD_FAILURE);
  const res = await readDrawerRecord(recordId);
  if (res.status === 200) {
    const transfer = mapDrawerTransfer(res.data);
    if (transfer) return { ok: true, transfer };
  }
  return { ok: false, reason: ACAT_DRAWER_LOAD_FAILURE, retryable: res.status !== 404 };
}

export async function changeTransferField(
  recordId: string,
  field: string,
  value: string,
  options: { direction?: string | null; identityVersion?: number | null } = {},
): Promise<DrawerWriteResult> {
  const allowed = await gate("write");
  if (!allowed.ok) return allowed;
  if (!RECORD_ID.test(recordId)) return refusal(ACAT_WRITE_UNAVAILABLE);
  const request = buildChangeRequest(field, value, options);
  if (!request.ok) return refusal(request.reason);
  return drawerWrite(recordId, request.body);
}

export async function completeTransfer(
  recordId: string,
  input: { apexCompletionDate: string; controlNumber: string },
): Promise<DrawerWriteResult> {
  const allowed = await gate("write");
  if (!allowed.ok) return allowed;
  if (!RECORD_ID.test(recordId)) return refusal(ACAT_WRITE_UNAVAILABLE);
  const request = buildCompleteRequest(input);
  if (!request.ok) return refusal(request.reason);
  return drawerWrite(recordId, request.body);
}

export async function rejectTransfer(recordId: string, reason: string): Promise<DrawerWriteResult> {
  const allowed = await gate("write");
  if (!allowed.ok) return allowed;
  if (!RECORD_ID.test(recordId)) return refusal(ACAT_WRITE_UNAVAILABLE);
  const request = buildRejectRequest(reason);
  if (!request.ok) return refusal(request.reason);
  return drawerWrite(recordId, request.body);
}

const GENERAL_STATUSES: ReadonlySet<string> = new Set(
  DRAWER_STATUS_OPTIONS.map((o) => o.value).filter((v) => v !== "Completed" && v !== "Rejected"),
);

export async function changeTransferStatus(recordId: string, status: string): Promise<DrawerWriteResult> {
  const allowed = await gate("write");
  if (!allowed.ok) return allowed;
  if (!RECORD_ID.test(recordId) || !GENERAL_STATUSES.has(status)) return refusal(ACAT_WRITE_UNAVAILABLE);
  return generalWrite(recordId, { status });
}

const TEXT_FIELDS: ReadonlySet<string> = new Set(["controlNumber", "notes", "tradeInstructions"]);

export async function saveTransferText(recordId: string, field: string, value: string): Promise<DrawerWriteResult> {
  const allowed = await gate("write");
  if (!allowed.ok) return allowed;
  if (!RECORD_ID.test(recordId) || !TEXT_FIELDS.has(field)) return refusal(ACAT_WRITE_UNAVAILABLE);
  const text = (value ?? "").trim();
  return generalWrite(recordId, { [field]: text === "" ? null : text });
}

export async function deleteTransfer(recordId: string, reason: string): Promise<DrawerWriteResult> {
  const allowed = await gate("write");
  if (!allowed.ok) return allowed;
  if (allowed.role !== "ADMIN") return refusal(ACAT_DRAWER_ADMIN_ONLY);
  if (!RECORD_ID.test(recordId)) return refusal(ACAT_WRITE_UNAVAILABLE);
  const request = buildDeleteRequest(reason);
  if (!request.ok) return refusal(request.reason);
  const res = await writeAcatBookRecord("DELETE", drawerRoute(recordId), request.body);
  const data = res.data as { removed?: unknown; transfer?: unknown } | null;
  if (res.status !== 200 || data?.removed !== true) return failed(res.status, res.data);
  const result = await stored(recordId, data.transfer);
  return result.ok ? { ...result, removed: true } : result;
}

export async function replaceTransferClient(
  recordId: string,
  input: {
    cedarRidgeUserIds: string[];
    expectedIdentityVersion: number | null;
    reason: string;
    apexAccountId: string;
    acknowledgeMappingInvalidation: boolean;
  },
): Promise<DrawerWriteResult> {
  const allowed = await gate("write");
  if (!allowed.ok) return allowed;
  if (!RECORD_ID.test(recordId)) return refusal(ACAT_WRITE_UNAVAILABLE);
  const request = buildReplaceRequest(input);
  if (!request.ok) return refusal(request.reason);
  return drawerWrite(recordId, request.body);
}

export async function searchTransferClients(query: string): Promise<DrawerClientSearchResult> {
  const allowed = await gate("write");
  if (!allowed.ok) return allowed;
  const text = (query ?? "").trim();
  if (text.length < 2 || text.length > 120) return refusal("Type at least 2 characters.");
  const res = await readAcatMachine(
    `/api/machine/clients/search?query=${encodeURIComponent(text)}&limit=${CLIENT_SEARCH_LIMIT}`,
  );
  if (res.status !== 200) return { ok: false, reason: ACAT_DRAWER_SEARCH_FAILURE, retryable: true };
  return { ok: true, ...parseClientSearch(res.data) };
}

export async function listTransferContras(): Promise<DrawerContraResult> {
  const allowed = await gate("write");
  if (!allowed.ok) return allowed;
  try {
    const library = await getCustodianLibrary(allowed.role);
    return {
      ok: true,
      contras: library.custodians.map((c) => ({ name: c.name, dtcNumber: c.dtcNumber ?? null })),
    };
  } catch (error) {
    if (!(error instanceof CustodianLibraryError)) throw error;
    console.error("[acat-drawer] contra_read_failed");
    return { ok: false, reason: "Custodian list is unavailable", retryable: true };
  }
}

export type DrawerSuggestionResult = ({ ok: true } & DtccSuggestion) | DrawerFailure;

export async function loadDtccSuggestion(contra: string): Promise<DrawerSuggestionResult> {
  const allowed = await gate("write");
  if (!allowed.ok) return allowed;
  const text = (contra ?? "").trim();
  if (text === "" || text.length > 120) return { ok: true, status: "none", dtccNumber: null };
  const res = await readAcatMachine(`/api/machine/dtcc-suggestion?contra=${encodeURIComponent(text)}`);
  if (res.status !== 200) return { ok: true, status: "none", dtccNumber: null };
  return { ok: true, ...dtccSuggestionFrom(res.data) };
}
