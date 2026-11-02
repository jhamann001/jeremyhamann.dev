"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { withUserScope, type Identity } from "@/lib/rls";
import {
  writeAudit,
  ASSET_MAP_LINK_CONFIRM,
  ASSET_MAP_LINK_REJECT,
  ASSET_MAP_ACCOUNT_CONFIRM,
  ASSET_MAP_ACCOUNT_REJECT,
} from "@/lib/audit";
import { getLink, updateLinkDecision } from "@/lib/data/asset-map-link";
import {
  rejectAccountOwners,
  replaceAccountOwnerDecision,
  type AccountOwner,
  type AccountOwnerRole,
} from "@/lib/data/asset-map-account-link";
import {
  resolveAccountForReview,
  resolveClientForLink,
  resolveMemberForAccountLink,
} from "@/lib/data/asset-map-review";
import { canReviewAssetMapLinks } from "@/lib/data/asset-map-review-authz";
import { listClients } from "@/lib/data/clients";

// Thin "use server" surface for the asset-mapping review queue's confirm/reject
// write-back (P2.3, design §4.3 / §5). Co-located with the /asset-mapping-review
// page. Every action follows the deals/transfer D3 posture:
//   • identity ALWAYS from auth(), never the client;
//   • the ADMIN/OPERATIONS/HoA surface gate (canReviewAssetMapLinks) runs FIRST
//     — a VIEWER/advisor/client-service caller never opens a scope or writes;
//   • the write is ONE withUserScope tx (app_rw) so the link table's ops-UPDATE
//     RLS policy (migration 20260720000000) is the real backstop — even if the
//     app gate were bypassed, a non-ops role's UPDATE matches zero rows;
//   • writeAudit runs in the SAME tx as the row write (ADR-5): the human's own
//     identity, ids/enum only — NEVER a client name (design §6 PII/no-log).
//
// THE ARCHITECTURE DECISION (flagged in the PR): the write lands on
// mirror.acat_asset_map_link as an APP-OWNED (app_rw) human write, NOT by
// borrowing the machine ingest role — the link table is a deliberate HYBRID
// (machine matches via ingest_rw + human confirmations via app_rw-ops).
//
// SAFETY (design "never bind an arbitrary unvalidated sf_id"): confirmLink
// resolves the chosen sf_id against mirror.client (resolveClientForLink) INSIDE
// the tx and binds ONLY the ids that read returns — an invented / placeholder /
// out-of-scope client can never be written. A confirm may target the matcher's
// own auto-linked client OR a different candidate OR a free-searched client; all
// three are validated identically. Confirming an AUTO_LINKED row graduates it to
// CONFIRMED (human sign-off, preserved by future matcher runs); rejecting sets
// REJECTED (link cleared, not re-queued).

const LOG_TAG = "asset-map-review";

/** The queue action result. `ok:false` collapses the RLS-rejection, the vanished
 *  row, the not-permitted gate, and the invalid-client cases into ONE opaque
 *  failure (no PII, no distinguishing internal detail leaks to the client). */
export type ReviewActionResult = { ok: true } | { ok: false; error: string };

const OK: ReviewActionResult = { ok: true };
// One generic failure — an RLS denial and a bad/absent row look identical by
// design (no oracle for a caller probing folder ids or client ids).
const FAILURE: ReviewActionResult = {
  ok: false,
  error:
    "The change could not be saved. The item may no longer be pending, the selected client may be invalid, or your role may not permit this action.",
};

async function identityFromSession(): Promise<Identity> {
  const session = await auth();
  if (!session?.user) redirect("/");
  return {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };
}

/** Resolve identity + enforce the review-surface gate. `ok:false` → the caller is
 *  not permitted; return WITHOUT opening any scope (the acat-tracking
 *  requireLinkRole idiom). */
async function requireReviewRole(): Promise<
  { ok: true; identity: Identity } | { ok: false }
> {
  const identity = await identityFromSession();
  if (!canReviewAssetMapLinks(identity.role)) return { ok: false };
  return { ok: true, identity };
}

/**
 * CONFIRM a mapping-household → client link. Works from BOTH the NEEDS_REVIEW
 * group (pick a candidate) and the AUTO_LINKED group (sign off on the machine's
 * client, or override to a different one). Validates the chosen client against
 * mirror.client, writes match_status='CONFIRMED' + the resolved ids +
 * confirmed_by/at, and audits — all in one ops-scoped tx. On success revalidate
 * so the confirmed row drops out of the queue.
 */
export async function confirmLink(
  sourceFolderId: string,
  chosenClientSfId: string,
): Promise<ReviewActionResult> {
  const gate = await requireReviewRole();
  if (!gate.ok) return FAILURE;
  const { identity } = gate;

  if (!sourceFolderId || !chosenClientSfId) return FAILURE;

  let ok = false;
  try {
    ok = await withUserScope(identity, async (tx) => {
      // Validate the chosen client — bind ONLY ids this read returns.
      const client = await resolveClientForLink(tx, chosenClientSfId);
      if (!client) return false;

      const n = await updateLinkDecision(tx, {
        sourceFolderId,
        matchStatus: "CONFIRMED",
        clientSfId: client.clientSfId,
        cedarRidgeUserId: client.cedarRidgeUserId,
        householdSfId: client.householdSfId,
        confirmedBy: identity.email ?? null,
        confirmedAt: new Date(),
      });
      // 0 rows → no such queued row OR RLS denied the write (fails closed).
      if (n === 0) return false;

      await writeAudit(tx, identity, {
        action: ASSET_MAP_LINK_CONFIRM,
        entityType: "asset_map_link",
        entityId: sourceFolderId,
        detail: {
          status: "CONFIRMED",
          clientSfId: client.clientSfId,
          householdSfId: client.householdSfId,
        },
      });
      return true;
    });
  } catch {
    // STATIC marker only — never the folder id / client id / PII (no-log rule).
    console.error(`[${LOG_TAG}] confirm_failed`);
    return FAILURE;
  }

  if (!ok) return FAILURE;
  revalidatePath("/asset-mapping-review");
  return OK;
}

/**
 * REJECT a mapping-household link — a human declares no candidate is right (or a
 * wrong auto-link). Sets match_status='REJECTED', CLEARS any resolved ids, and
 * stamps confirmed_by/at, so the reconcile pass never re-queues it. One
 * ops-scoped tx + same-tx audit. On success revalidate so the row drops out.
 */
export async function rejectLink(
  sourceFolderId: string,
): Promise<ReviewActionResult> {
  const gate = await requireReviewRole();
  if (!gate.ok) return FAILURE;
  const { identity } = gate;

  if (!sourceFolderId) return FAILURE;

  let ok = false;
  try {
    ok = await withUserScope(identity, async (tx) => {
      const n = await updateLinkDecision(tx, {
        sourceFolderId,
        matchStatus: "REJECTED",
        clientSfId: null,
        cedarRidgeUserId: null,
        householdSfId: null,
        confirmedBy: identity.email ?? null,
        confirmedAt: new Date(),
      });
      if (n === 0) return false;

      await writeAudit(tx, identity, {
        action: ASSET_MAP_LINK_REJECT,
        entityType: "asset_map_link",
        entityId: sourceFolderId,
        detail: { status: "REJECTED" },
      });
      return true;
    });
  } catch {
    console.error(`[${LOG_TAG}] reject_failed`);
    return FAILURE;
  }

  if (!ok) return FAILURE;
  revalidatePath("/asset-mapping-review");
  return OK;
}

/**
 * CONFIRM an account's OWNER SET (P2.5, design §8.6) — now with the FOLD-IN
 * (design "fold household resolution into the account row"). Multi-owner +
 * all-or-nothing: for a joint account the reviewer selects both owners and this
 * writes one owner row per selected person in ONE tx; for an entity account
 * `isEntity` is true and `chosenClientSfIds` is empty → one "entity — no person"
 * row. Same posture as confirmLink (auth-first gate, one withUserScope tx,
 * same-tx audit, generic FAILURE).
 *
 * FOLD-IN: when the folder's household is NOT yet bound (the matcher left it
 * NEEDS_REVIEW), the reviewer picks the client right on the account row and passes
 * it as `householdClientSfId`. This action then resolves the folder link
 * (household → client, the write the retired household card used to do) AND
 * attributes the account owner(s) — both in the one ops tx, with an audit row for
 * each. On an already-resolved folder `householdClientSfId` is ignored.
 *
 * Every chosen owner is validated against the (resolved-or-just-resolved) household
 * (resolveMemberForAccountLink) — a non-member (D-j) fails the whole confirm, so an
 * arbitrary or cross-household owner can never be bound.
 */
export async function confirmAccountOwners(
  accountId: string,
  chosenClientSfIds: string[],
  isEntity: boolean,
  householdClientSfId?: string | null,
): Promise<ReviewActionResult> {
  const gate = await requireReviewRole();
  if (!gate.ok) return FAILURE;
  const { identity } = gate;

  if (typeof accountId !== "string" || !accountId.trim() || accountId.length > 256) return FAILURE;
  // De-dupe + drop empties; multi-select is REQUIRED for a non-entity account (§8.6).
  const chosen = [...new Set(chosenClientSfIds.filter((s) => s))];
  if (!isEntity && chosen.length === 0) return FAILURE;

  let ok = false;
  try {
    ok = await withUserScope(identity, async (tx) => {
      const account = await resolveAccountForReview(tx, accountId);
      if (!account) return false;
      const { sourceFolderId, custodian, accountNumber } = account;
      const link = await getLink(tx, sourceFolderId);
      if (!link) return false;

      const alreadyResolved =
        (link.matchStatus === "CONFIRMED" || link.matchStatus === "AUTO_LINKED") &&
        link.householdSfId != null;

      // FOLD-IN: resolve the folder from the account row when it isn't bound yet.
      let householdSfId = link.householdSfId;
      let foldInClientSfId: string | null = null;
      if (!alreadyResolved) {
        if (!householdClientSfId) return false; // can't attribute with no household
        const hh = await resolveClientForLink(tx, householdClientSfId);
        if (!hh) return false; // binds ONLY a real, non-placeholder client (safety gate)
        const nFolder = await updateLinkDecision(tx, {
          sourceFolderId,
          matchStatus: "CONFIRMED",
          clientSfId: hh.clientSfId,
          cedarRidgeUserId: hh.cedarRidgeUserId,
          householdSfId: hh.householdSfId,
          confirmedBy: identity.email ?? null,
          confirmedAt: new Date(),
        });
        if (nFolder === 0) throw new Error("account_review_failed"); // no queued folder row / RLS denied
        householdSfId = hh.householdSfId;
        foldInClientSfId = hh.clientSfId;
      }
      if (householdSfId == null) throw new Error("account_review_failed");

      const owners: AccountOwner[] = [];
      if (!isEntity) {
        const role: AccountOwnerRole = chosen.length >= 2 ? "JOINT" : "PRIMARY";
        for (const sfId of chosen) {
          // Membership enforced (D-j) — ALL must resolve against the (now-)bound
          // household, else no write.
          const member = await resolveMemberForAccountLink(tx, sfId, householdSfId);
          if (!member) throw new Error("account_review_failed");
          owners.push({
            cedarRidgeUserId: member.cedarRidgeUserId,
            clientSfId: member.clientSfId,
            ownershipRole: role,
          });
        }
      }

      const n = await replaceAccountOwnerDecision(tx, {
        sourceFolderId,
        custodian,
        accountNumber,
        owners,
        isEntity,
        confirmedBy: identity.email ?? null,
        confirmedAt: new Date(),
      });
      // 0 rows, or fewer confirmed than chosen (a chosen owner collided with a
      // terminal row) → all-or-nothing failure (the tx rolls back).
      if (n === 0 || (!isEntity && n < owners.length)) throw new Error("account_review_failed");

      // Fold-in path: audit the folder resolution too (ids only, no PII), so the
      // household binding done from the account row has its own trail — the same
      // event the retired household card emitted.
      if (foldInClientSfId != null) {
        await writeAudit(tx, identity, {
          action: ASSET_MAP_LINK_CONFIRM,
          entityType: "asset_map_link",
          entityId: sourceFolderId,
          detail: {
            status: "CONFIRMED",
            clientSfId: foldInClientSfId,
            householdSfId,
            via: "account_fold_in",
          },
        });
      }

      await writeAudit(tx, identity, {
        action: ASSET_MAP_ACCOUNT_CONFIRM,
        entityType: "asset_map_account_link",
        // The DURABLE folder id — NEVER the account number (sensitive, §6).
        entityId: sourceFolderId,
        detail: {
          status: "CONFIRMED",
          custodian,
          ownerCount: owners.length,
          isEntity,
          clientSfIds: owners.map((o) => o.clientSfId),
          householdSfId,
        },
      });
      return true;
    });
  } catch {
    // STATIC marker only — never the account number / holder / PII (no-log rule).
    console.error(`[${LOG_TAG}] confirm_account_failed`);
    return FAILURE;
  }

  if (!ok) return FAILURE;
  revalidatePath("/asset-mapping-review");
  return OK;
}

/**
 * REJECT a whole account's ownership (P2.5) — a human declares no owner is right.
 * Marks every queued owner row for the account REJECTED (soft-remove, no DELETE).
 * Same posture as rejectLink. entityId is the durable folder id (never the account
 * number); detail is custodian + status only.
 */
export async function rejectAccount(
  accountId: string,
): Promise<ReviewActionResult> {
  const gate = await requireReviewRole();
  if (!gate.ok) return FAILURE;
  const { identity } = gate;

  if (typeof accountId !== "string" || !accountId.trim() || accountId.length > 256) return FAILURE;

  let ok = false;
  try {
    ok = await withUserScope(identity, async (tx) => {
      const account = await resolveAccountForReview(tx, accountId);
      if (!account) return false;
      const { sourceFolderId, custodian, accountNumber } = account;
      const n = await rejectAccountOwners(tx, {
        sourceFolderId,
        custodian,
        accountNumber,
        confirmedBy: identity.email ?? null,
        confirmedAt: new Date(),
      });
      if (n === 0) return false;

      await writeAudit(tx, identity, {
        action: ASSET_MAP_ACCOUNT_REJECT,
        entityType: "asset_map_account_link",
        entityId: sourceFolderId,
        detail: { status: "REJECTED", custodian },
      });
      return true;
    });
  } catch {
    console.error(`[${LOG_TAG}] reject_account_failed`);
    return FAILURE;
  }

  if (!ok) return FAILURE;
  revalidatePath("/asset-mapping-review");
  return OK;
}

/** The free client-search result for the picker (ops picks a client the scorer
 *  missed). Reuses the Client Portrait picker read (lib/data/clients.listClients),
 *  RLS-scoped — ops sees the firm. `forbidden` degrades the picker quietly. */
export type ReviewClientsResult =
  | { ok: false; reason: "forbidden" | "error" }
  | { ok: true; clients: { sfId: string; name: string; householdName: string | null }[] };

/**
 * Load the ops-visible client list for the review picker's free search. READ,
 * gated. Lazily invoked when an operator opens the search (keeps the queue read
 * non-blocking). listClients opens its OWN withUserScope, so it is called
 * directly (never nested in an outer scope). A confirm still re-validates the
 * chosen sf_id server-side, so this list is only a convenience, not the trust
 * boundary.
 */
export async function loadReviewClients(): Promise<ReviewClientsResult> {
  const gate = await requireReviewRole();
  if (!gate.ok) return { ok: false, reason: "forbidden" };

  try {
    const clients = await listClients(gate.identity);
    return {
      ok: true,
      clients: clients.map((c) => ({
        sfId: c.sf_id,
        name: c.name,
        householdName: c.household_name,
      })),
    };
  } catch {
    console.error(`[${LOG_TAG}] load_clients_failed`);
    return { ok: false, reason: "error" };
  }
}
