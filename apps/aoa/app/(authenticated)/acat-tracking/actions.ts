"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { withUserScope, type Identity } from "@/lib/rls";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { listClients } from "@/lib/data/clients";
import { listHouseholdPickerTargets } from "@/lib/data/household-picker";
import { listTransfers } from "@/lib/data/transfers";
import type { TransferValidationError } from "@/lib/data/transfer-validate";
import {
  attachAcatToTransfer,
  buildLinkTransferInput,
  createLinkedTransfer,
  unlinkAcatFromTransfer,
  LINK_ERRORS,
  type AcatLinkKey,
  type LinkTarget,
} from "@/lib/data/acat-link";
import { scheduleCrmIdentityReconciliation } from "@/lib/crm/post-commit-signal";

// Thin "use server" surface for the ACAT link / onboard write (WO ticket,
// transfer-centric step 3). The link write lives HERE — co-located with the
// /acat-tracking page — rather than in asset-transfer/actions.ts, so the
// `canSeeUnlinkedAcats` firm-wide surface gate is enforced where the (firm-wide)
// ACAT is linked. The transfer create/update PATTERN is reused verbatim via
// lib/data/acat-link.ts (one-tx + same-tx writeAudit + the frozen validator);
// asset-transfer/actions.ts is left byte-identical.
//
// GATE / BACKSTOP (QC MEDIUM-2 correction): the ADMIN/OPERATIONS restriction for
// THIS feature is enforced at the APP LAYER (`canSeeUnlinkedAcats`), NOT by RLS.
// The historical transfer write RLS policy also names the retired
// HEAD_OF_ADVISORY value (see 20260702141028_app_transfer); current application
// identities are ADMIN/OPERATIONS/ADVISOR/CLIENT_SERVICE or VIEWER. So
// RLS is a defense-in-depth backstop for the VIEWER case ONLY; the ADMIN/OPS
// boundary that keeps advisors/client-service out of ACAT linking is the
// `requireLinkRole` check below. The 1:1 ACAT↔transfer invariant is backstopped
// by the partial UNIQUE INDEX (migration 20260716000000): a lost duplicate-link
// race surfaces as Prisma P2002, mapped to the friendly "already linked" result.
//
// Every action: auth() → canSeeUnlinkedAcats gate (VIEWER/advisor never reach a
// write) → withUserScope tx wrapping one seam writer.

const LOG_TAG = "acat-link";

/**
 * Classify a thrown write error so the actions can respond precisely instead of
 * collapsing everything into the generic WRITE_REJECTED "permission" message:
 *   • "already_linked" — P2002 unique violation on the partial ACAT index (the
 *     duplicate-link race lost); mapped to the friendly ACAT_ALREADY_LINKED.
 *   • "rejected" — a KNOWN rejection (P2025 record-not-found / not visible, or an
 *     RLS policy denial via SQLSTATE 42501); the caller sees WRITE_REJECTED, no
 *     server-log noise (an expected outcome).
 *   • "unexpected" — anything else (a genuine bug / infra failure); the caller
 *     sees WRITE_REJECTED AND we emit a STATIC server marker (no PII/token/id).
 */
function classifyWriteError(
  e: unknown,
): "already_linked" | "rejected" | "unexpected" {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") return "already_linked";
    if (e.code === "P2025") return "rejected";
    const meta = e.meta as { code?: string } | undefined;
    if (meta?.code === "42501") return "rejected"; // RLS policy denial
  }
  return "unexpected";
}

const ALREADY_LINKED: LinkActionResult = {
  ok: false,
  errors: [LINK_ERRORS.ACAT_ALREADY_LINKED],
};

/** Turn a caught write error into the right result, logging only genuine faults. */
function resultForWriteError(e: unknown): LinkActionResult {
  switch (classifyWriteError(e)) {
    case "already_linked":
      return ALREADY_LINKED;
    case "rejected":
      return WRITE_REJECTED;
    default:
      // STATIC marker only — never the id/target/token/PII (the no-log rule).
      console.error(`[${LOG_TAG}] write_failed`);
      return WRITE_REJECTED;
  }
}

export type LinkTargetsResult =
  | { ok: false; reason: "forbidden" | "error" }
  | {
      ok: true;
      clients: {
        sfId: string;
        name: string;
        householdId: string | null;
        householdName: string | null;
      }[];
      households: { sfId: string; name: string; sourceNames?: string[] }[];
      openTransfers: {
        id: string;
        name: string;
        stage: string;
        clientSfId: string | null;
        householdSfId: string | null;
      }[];
    };

export type LinkActionResult = { ok: false; errors: TransferValidationError[] };

// File-local non-field failure (copied, NOT imported — the asset-transfer
// WRITE_REJECTED is un-exported). An RLS rejection and a vanished row look the
// same to the caller by design.
const WRITE_REJECTED: LinkActionResult = {
  ok: false,
  errors: [
    {
      field: "form",
      message:
        "Link failed — the database rejected the change. The record may not exist, or your role may not have permission to write transfers.",
    },
  ],
};

async function identityFromSession(): Promise<Identity> {
  const session = await auth();
  if (!session?.user) redirect("/");
  return {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };
}

/** Resolve the identity and enforce the firm-wide ACAT gate. `ok:false` means
 *  the caller is not permitted — return `forbidden` WITHOUT opening any scope. */
async function requireLinkRole(): Promise<
  { ok: true; identity: Identity } | { ok: false }
> {
  const identity = await identityFromSession();
  if (!canSeeUnlinkedAcats(identity.role)) return { ok: false };
  return { ok: true, identity };
}

async function pickerDependency<T>(
  branch: "clients" | "households" | "transfers",
  read: Promise<T>,
): Promise<T> {
  try { return await read; }
  catch {
    // Closed set of static markers: no exception, query, identifier or PII.
    console.error(`[${LOG_TAG}] load_targets_failed:${branch}`);
    throw new Error("picker_target_read_failed");
  }
}

/**
 * Picker data — READ, gated. Lazily loaded when the operator opens the picker
 * (keeps the tracking page non-blocking). listClients / listHouseholdPickerTargets /
 * listTransfers each open their OWN withUserScope, so they are called directly
 * (never nested in an outer scope — that would double-wrap RLS). openTransfers
 * is pre-filtered to the attachable predicate (open, no ACAT yet); the picker
 * narrows to the chosen client/household with `attachableTransfers`.
 */
export async function loadLinkTargets(): Promise<LinkTargetsResult> {
  const gate = await requireLinkRole();
  if (!gate.ok) return { ok: false, reason: "forbidden" };
  const { identity } = gate;

  try {
    const [clients, households, transfers] = await Promise.all([
      pickerDependency("clients", listClients(identity)),
      pickerDependency("households", listHouseholdPickerTargets(identity)),
      // Default (archived EXCLUDED) is deliberate: an archived transfer is out
      // of the working set and must never be offered as an attach target for a
      // live ACAT — that would resurrect it in spirit while it stays invisible
      // on the board.
      pickerDependency("transfers", listTransfers(identity)),
    ]);
    return {
      ok: true,
      clients: clients.map((c) => ({
        sfId: c.sf_id,
        name: c.name,
        householdId: c.household_id,
        householdName: c.household_name,
      })),
      households: households.map((h) => ({
        sfId: h.sf_id,
        name: h.name,
        sourceNames: h.source_names,
      })),
      openTransfers: transfers
        .filter(
          (t) =>
            t.acat_transfer_id == null &&
            t.acat_record_id == null &&
            t.stage !== "FUNDED",
        )
        .map((t) => ({
          id: t.id,
          name: `${t.client_first_name} ${t.client_last_name}`.trim(),
          stage: t.stage,
          clientSfId: t.client_sf_id,
          householdSfId: t.household_sf_id,
        })),
    };
  } catch {
    // Tracker/DB read failure — the picker degrades to a quiet error, not a
    // crash. The rejected dependency has already emitted its static marker.
    return { ok: false, reason: "error" };
  }
}

/**
 * Link an un-linked ACAT into a NEW IN_TRANSFER transfer for the chosen
 * client/household/prospect. WRITE, gated. On success revalidate + redirect to
 * the new transfer's detail page; on validation/guard failure return the
 * field-keyed errors for the picker; an RLS rejection surfaces as WRITE_REJECTED.
 */
export async function linkAcatToNewTransfer(
  target: LinkTarget,
  acat: AcatLinkKey,
  value: number,
  options?: { stay?: boolean },
): Promise<LinkActionResult | { ok: true; transferId: string } | void> {
  const gate = await requireLinkRole();
  if (!gate.ok) return { ok: false, errors: WRITE_REJECTED.errors };
  const { identity } = gate;

  let outcome: LinkActionResult | { ok: true; id: string };
  try {
    outcome = await withUserScope(identity, (tx) =>
      createLinkedTransfer(
        tx,
        identity,
        buildLinkTransferInput(target, acat, value),
      ),
    );
  } catch (e) {
    // P2002 (lost duplicate-link race) → friendly "already linked"; a known
    // rejection → WRITE_REJECTED; a genuine fault → WRITE_REJECTED + static log.
    return resultForWriteError(e);
  }

  if (!outcome.ok) return outcome;
  // createLinkedTransfer's transfer + audit transaction has committed. The
  // identity signal therefore cannot hold locks or roll back the source write.
  scheduleCrmIdentityReconciliation("acat_link");
  revalidatePath("/acat-tracking");
  // The board keys ACAT chips by the link ids this write just stored — without
  // this, a cached /asset-transfer keeps rendering the pre-link board.
  revalidatePath("/asset-transfer");
  if (options?.stay) return { ok: true, transferId: outcome.id };
  redirect(`/asset-transfer/${outcome.id}`);
}

/**
 * Attach an un-linked ACAT onto an EXISTING open transfer (no duplicate). WRITE,
 * gated. On success revalidate + redirect to that transfer's detail; guard
 * failures return the field errors; an RLS rejection → WRITE_REJECTED.
 */
export async function attachAcatToExistingTransfer(
  transferId: string,
  acat: AcatLinkKey,
  options?: { stay?: boolean },
): Promise<LinkActionResult | { ok: true; transferId: string } | void> {
  const gate = await requireLinkRole();
  if (!gate.ok) return { ok: false, errors: WRITE_REJECTED.errors };
  const { identity } = gate;

  let outcome: LinkActionResult | { ok: true };
  try {
    outcome = await withUserScope(identity, (tx) =>
      attachAcatToTransfer(tx, identity, transferId, acat),
    );
  } catch (e) {
    return resultForWriteError(e);
  }

  if (!outcome.ok) return outcome;
  revalidatePath("/acat-tracking");
  // Board freshness: the attached transfer's card + chip live on the board.
  revalidatePath("/asset-transfer");
  if (options?.stay) return { ok: true, transferId };
  redirect(`/asset-transfer/${transferId}`);
}

export type UnlinkActionResult =
  | { ok: true }
  | { ok: false; errors: TransferValidationError[] };

/** Remove the AoA link only, returning in place to the drawer. */
export async function unlinkAcatFromExistingTransfer(
  transferId: string,
  expectedAcat: AcatLinkKey,
): Promise<UnlinkActionResult> {
  // Unlike linking, this drawer action never redirects, including when a
  // session expires. Recheck authorization before opening any database scope.
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (!session?.user || !canSeeUnlinkedAcats(role)) {
    return {
      ok: false,
      errors: [{ field: "form", message: "You do not have permission to unlink ACATs." }],
    };
  }
  const identity: Identity = { role, email: session.user.email ?? null };

  let outcome: UnlinkActionResult;
  try {
    outcome = await withUserScope(identity, (tx) =>
      unlinkAcatFromTransfer(tx, identity, transferId, expectedAcat),
    );
  } catch (e) {
    if (classifyWriteError(e) === "unexpected") {
      console.error(`[${LOG_TAG}] unlink_failed`);
    }
    return {
      ok: false,
      errors: [{ field: "form", message: "Unlink failed. Refresh the page and try again." }],
    };
  }
  if (!outcome.ok) return outcome;

  revalidatePath("/acat-tracking");
  revalidatePath("/asset-transfer");
  revalidatePath(`/asset-transfer/${transferId}`);
  return { ok: true };
}
