import type { Prisma } from "@prisma/client";
import type { Identity } from "@/lib/rls";
import {
  writeAudit,
  TRANSFER_CREATE,
  TRANSFER_UPDATE,
} from "@/lib/audit";
import { isLinkableAcatTransferId } from "./acat-lane";
import {
  validateTransferInput,
  type TransferValidationError,
} from "@/lib/data/transfer-validate";
import {
  DEFAULT_TASKS,
  type TransferInput,
} from "@/lib/data/transfer-types";

// ACAT LINK / ONBOARD core (WO ticket, transfer-centric step 3) — the seam
// module the thin `acat-tracking/actions.ts` "use server" surface wraps (the
// deal-stage-write.ts idiom: extracted so the create-vs-attach decision logic
// and the one-tx + same-tx-audit write shape are unit-testable with a FAKE
// transaction client — no auth/next/DB imports here).
//
// Two layers:
//   • PURE (no Prisma value import, no server-only, no next/*): the input
//     builders + decision predicates, unit-tested in the node vitest env.
//   • SEAM (takes a Prisma.TransactionClient — a TYPE-only import, erased at
//     runtime): the two write functions, exercised with a fake tx in CI and a
//     real RLS-scoped tx in the co-located server actions.
//
// The write shape mirrors asset-transfer/actions.ts (createTransfer / setOwner)
// verbatim — same enumerated `?? null` columns (never a `...input` spread, which
// would pass `undefined` for unset optionals and break the null-not-undefined
// discipline), same seeded DEFAULT_TASKS, same TRANSFER_CREATE / TRANSFER_UPDATE
// audit events (no new action name), same one-tx + same-tx writeAudit guarantee.

// ---------------------------------------------------------------------------
// PURE layer
// ---------------------------------------------------------------------------

/** The thing an operator links a loose ACAT to. A `client`/`household` carries
 *  the CRM ids (the matched marker); a `prospect` is a free-text name only —
 *  NO CRM/household record is created, and null client/household sf_ids are the
 *  "unmatched prospect" marker (see `isUnmatchedProspect`). */
export type LinkTarget =
  | {
      kind: "client";
      clientSfId: string;
      firstName: string;
      lastName: string;
      householdSfId: string | null;
      householdName: string | null;
    }
  | {
      kind: "household";
      householdSfId: string;
      householdName: string;
      firstName: string;
      lastName: string;
    }
  | { kind: "prospect"; name: string };

/** What the picker/drawer hands the write path: the tracker record PK (always
 *  present — the PRIMARY link key) + the raw acatTransferId as the tracker
 *  reported it (may be "", "N/A", a placeholder, or a real UUID). */
export type AcatLinkKey = { recordId: string; acatTransferId: string | null };

/** D2 — ONE normalization rule, ONE place: store the UUID only when it is a
 *  real, linkable tracker transfer id; placeholders/blanks (isBlankAcatId's
 *  blank case is subsumed by isLinkableAcatTransferId) normalize to NULL.
 *  Actual UUIDs have one lowercase representation; other tracker identifiers
 *  retain their case because their semantics are not necessarily UUID-like. */
export function normalizeAcatTransferId(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string" || !isLinkableAcatTransferId(raw)) return null;
  const value = raw.trim();
  return ACAT_UUID_SHAPE.test(value) ? value.toLowerCase() : value;
}

/** Apex transfer UUID shape (8-4-4-4-12 hex) — the ONLY shape routed to the
 *  legacy by-UUID tracker read. Anything else routes as a tracker RECORD id
 *  FIRST: real tracker record PKs are cuids (`c…`), but dev fixture ids are
 *  `rec-…`, so shape-detection must never allowlist a cuid pattern — non-UUID
 *  means "try the by-record read". */
export const ACAT_UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Older UUID-only links may predate canonical casing. Match those without
 * rewriting existing rows or treating arbitrary tracker IDs as case-insensitive.
 * The text unique index still cannot arbitrate mixed-case concurrent writes
 * from a separate writer that does not use canonical UUIDs. */
function transferIdDuplicateWhere(acatTransferId: string): Prisma.TransferWhereInput {
  return {
    acat_transfer_id: ACAT_UUID_SHAPE.test(acatTransferId)
      ? { equals: acatTransferId, mode: "insensitive" }
      : acatTransferId,
  };
}

/**
 * What the edit-form's free-text ACAT field should do with a submitted value,
 * given the transfer's STORED link (fix/acat-link-either-id). Pure — the
 * caller (the transfer create/update actions) performs the tracker
 * verification the two `verify_*` plans demand BEFORE any write.
 *
 *   unchanged     — blank with nothing stored, or the value matches EITHER
 *                   stored column (resubmitting the shown link id is a no-op —
 *                   and must NOT call the tracker).
 *   clear         — blank while a link is stored: an explicit unlink of BOTH
 *                   columns.
 *   verify_record — non-UUID shape: verify via getAcatStatusByRecordId and
 *                   store as acat_record_id (+ the resolved real UUID, if any).
 *   verify_uuid   — UUID shape: verify via getAcatStatus and store as
 *                   acat_transfer_id.
 */
export type AcatLinkPlan =
  | { kind: "unchanged" }
  | { kind: "clear" }
  | { kind: "verify_record"; id: string }
  | { kind: "verify_uuid"; id: string };

export function planAcatLinkChange(
  submitted: string,
  stored: { acat_record_id: string | null; acat_transfer_id: string | null },
): AcatLinkPlan {
  const value = submitted.trim();
  if (value === "") {
    return stored.acat_record_id == null && stored.acat_transfer_id == null
      ? { kind: "unchanged" }
      : { kind: "clear" };
  }
  // Same value as EITHER stored column → the link is untouched. The edit form
  // seeds the field record-id-first (transferToFormValues), but a legacy row
  // shows its UUID — both must round-trip as a no-op. UUIDs compare
  // case-insensitively (the shape regex is i-flagged): retyping a stored UUID
  // in different case must not trigger a re-verify or drop a record link.
  if (value === stored.acat_record_id || value === stored.acat_transfer_id) {
    return { kind: "unchanged" };
  }
  if (
    ACAT_UUID_SHAPE.test(value) &&
    stored.acat_transfer_id != null &&
    value.toLowerCase() === stored.acat_transfer_id.toLowerCase()
  ) {
    return { kind: "unchanged" };
  }
  return ACAT_UUID_SHAPE.test(value)
    ? { kind: "verify_uuid", id: value }
    : { kind: "verify_record", id: value };
}

/** Field-keyed link errors (the WRITE_REJECTED / field-error idiom) so the
 *  picker renders them inline. Shaped as TransferValidationError. */
export const LINK_ERRORS = {
  ACAT_ALREADY_LINKED: {
    field: "acat_transfer_id",
    message: "This ACAT is already linked to a transfer.",
  },
  TRANSFER_ALREADY_HAS_ACAT: {
    field: "acat_transfer_id",
    message: "That transfer already has an ACAT linked to it.",
  },
  VALUE_REQUIRED: {
    field: "value",
    message: "Enter a transfer value greater than zero before linking.",
  },
  TRANSFER_NOT_FOUND: {
    field: "form",
    message: "That transfer no longer exists.",
  },
  ACAT_RECORD_ID_REQUIRED: {
    field: "form",
    message: "Missing ACAT record id — reopen the ACAT and try again.",
  },
  TRANSFER_ARCHIVED: {
    field: "form",
    message: "Archived transfers cannot be unlinked.",
  },
  ACAT_LINK_CHANGED: {
    field: "form",
    message: "This ACAT link has changed. Refresh the page and try again.",
  },
  // Edit-form either-id routing (fix/acat-link-either-id): the field-keyed
  // outcomes of the pre-write tracker verification. Both fail CLOSED — an
  // unverified id is NEVER stored.
  ACAT_NOT_FOUND: {
    field: "acat_transfer_id",
    message: "No Transfer Tracker record found for this id.",
  },
  ACAT_UNVERIFIED: {
    field: "acat_transfer_id",
    message: "Couldn't verify the ACAT id — tracker unreachable. Try again.",
  },
} as const satisfies Record<string, TransferValidationError>;

/** Blank/whitespace guard for the ACAT RECORD id (the required, primary link
 *  key) — a link with no record id is a bug (the id is the tracker row's own
 *  PK, always present), never a valid write. */
function isBlankAcatId(id: string | null | undefined): boolean {
  return id == null || id.trim() === "";
}

/**
 * Split a free-text prospect name into first/last on the LAST space, both
 * trimmed. A single token mirrors itself into `last` so BOTH are non-blank and
 * the frozen `validateTransferInput` (which requires first + last) passes. An
 * empty string yields two blanks — validation then rejects it, no silent write.
 */
export function splitProspectName(full: string): {
  first: string;
  last: string;
} {
  const trimmed = full.trim();
  const idx = trimmed.lastIndexOf(" ");
  if (idx === -1) return { first: trimmed, last: trimmed };
  return {
    first: trimmed.slice(0, idx).trim(),
    last: trimmed.slice(idx + 1).trim(),
  };
}

/**
 * Build the write contract for a NEW linked transfer from the chosen target.
 * Always `source:"APP"`, `stage:"IN_TRANSFER"`, `owner_kind:"OPERATIONS"`, with
 * BOTH link ids set from the AcatLinkKey — `acat_record_id` (the tracker record
 * PK, always present, the PRIMARY key) verbatim, and `acat_transfer_id` only
 * when the tracker's raw UUID is real (D2: `normalizeAcatTransferId` turns
 * ""/"N/A"/placeholders into NULL). `value` is seeded from the ACAT
 * statementAmount (operator-overridable, required > 0 by the frozen validator).
 * A prospect carries null client/household ids (the unmatched marker); the
 * null-not-"" discipline of `toTransferInput` is preserved.
 */
export function buildLinkTransferInput(
  target: LinkTarget,
  key: AcatLinkKey,
  value: number,
): TransferInput {
  const base = {
    source: "APP",
    value,
    stage: "IN_TRANSFER",
    owner_kind: "OPERATIONS",
    acat_record_id: key.recordId,
    acat_transfer_id: normalizeAcatTransferId(key.acatTransferId),
  } as const;

  if (target.kind === "prospect") {
    const { first, last } = splitProspectName(target.name);
    return {
      ...base,
      client_first_name: first,
      client_last_name: last,
      client_sf_id: null,
      household_name: null,
      household_sf_id: null,
    };
  }

  if (target.kind === "household") {
    return {
      ...base,
      client_first_name: target.firstName,
      client_last_name: target.lastName,
      client_sf_id: null,
      household_name: target.householdName,
      household_sf_id: target.householdSfId,
    };
  }

  return {
    ...base,
    client_first_name: target.firstName,
    client_last_name: target.lastName,
    client_sf_id: target.clientSfId,
    household_name: target.householdName,
    household_sf_id: target.householdSfId,
  };
}

/** The "unmatched prospect" marker predicate: no CRM linkage at all. Audited
 *  (rides the create detail as `prospect`) + drives the picker's cleanup note. */
export function isUnmatchedProspect(input: TransferInput): boolean {
  return input.client_sf_id == null && input.household_sf_id == null;
}

/**
 * The attach-candidate filter: from the caller's visible transfers, the OPEN
 * (stage ≠ FUNDED) ones that carry NO Transfer linkage yet (neither the record-id
 * primary key nor the legacy acat_transfer_id UUID) AND belong to the chosen
 * client/household. These are the transfers an ACAT can graduate ONTO instead
 * of creating a duplicate. A prospect target has no existing record, so it
 * never matches (always a new transfer).
 */
export function attachableTransfers<
  T extends {
    id: string;
    stage: string;
    acat_transfer_id: string | null;
    acat_record_id: string | null;
    client_sf_id: string | null;
    household_sf_id: string | null;
  },
>(rows: T[], target: LinkTarget): T[] {
  if (target.kind === "prospect") return [];
  return rows.filter((r) => {
    if (r.acat_transfer_id != null || r.acat_record_id != null) return false;
    if (r.stage === "FUNDED") return false;
    if (target.kind === "client") return r.client_sf_id === target.clientSfId;
    return r.household_sf_id === target.householdSfId;
  });
}

// ---------------------------------------------------------------------------
// SEAM layer (fake-tx testable — never a real DB in CI)
// ---------------------------------------------------------------------------

export type LinkWriteResult =
  | { ok: true; id: string }
  | { ok: false; errors: TransferValidationError[] };

export type AttachWriteResult =
  | { ok: true }
  | { ok: false; errors: TransferValidationError[] };

/**
 * Create the linked transfer + seed IN_TRANSFER tasks + write the
 * TRANSFER_CREATE audit, all in the caller's one user-scoped transaction.
 * Order: validate FIRST (fail → no write), then the duplicate-ACAT guards
 * (record-id PRIMARY, legacy-UUID secondary — another visible transfer already
 * carries this ACAT → reject), then the enumerated create (the createTransfer
 * body verbatim), then the same-tx audit (detail enriched with the link
 * provenance — ids/enums/bool only, no PII).
 */
export async function createLinkedTransfer(
  tx: Prisma.TransactionClient,
  identity: Identity,
  input: TransferInput,
): Promise<LinkWriteResult> {
  const result = validateTransferInput(input);
  if (!result.ok) return { ok: false, errors: result.errors }; // no row, no audit

  // The record id is the REQUIRED, primary link key (every tracker record has
  // one — its own PK); a blank one is a bug, rejected before any read/write.
  if (isBlankAcatId(input.acat_record_id))
    return { ok: false, errors: [LINK_ERRORS.ACAT_RECORD_ID_REQUIRED] }; // no row, no audit
  const acatRecordId = input.acat_record_id as string;
  // buildLinkTransferInput already normalizes (D2), but re-normalize at the
  // seam anyway — idempotent for the builder path, and it guarantees a future
  // DIRECT caller can never persist an ""/"N/A" placeholder into the
  // unique-indexed acat_transfer_id column (the attach path guards the same
  // way; the two write seams must not differ).
  const acatTransferId = normalizeAcatTransferId(input.acat_transfer_id ?? null);

  // Fast, friendly pre-checks for the non-concurrent case. The TWO PARTIAL
  // UNIQUE INDEXES (transfer_acat_record_id_key, 20260723000000;
  // transfer_acat_transfer_id_key, 20260716000000) are the real backstops
  // against the TOCTOU race between these reads and the create below — a lost
  // race throws P2002, which the action maps to the same "already linked"
  // message.
  // PRIMARY: by the tracker record PK.
  const dupe = await tx.transfer.findFirst({
    where: { acat_record_id: acatRecordId },
  });
  if (dupe) return { ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] };
  // SECONDARY (legacy): rows linked before record-id linking carry a UUID but
  // no record id — without this check the same ACAT could be linked twice.
  if (acatTransferId != null) {
    const dupeByUuid = await tx.transfer.findFirst({
      where: transferIdDuplicateWhere(acatTransferId),
    });
    if (dupeByUuid)
      return { ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] };
  }

  const transfer = await tx.transfer.create({
    data: {
      source: input.source,
      client_first_name: input.client_first_name,
      client_last_name: input.client_last_name,
      client_sf_id: input.client_sf_id ?? null,
      household_name: input.household_name ?? null,
      household_sf_id: input.household_sf_id ?? null,
      value: input.value,
      stage: input.stage,
      owner_kind: input.owner_kind,
      acat_record_id: acatRecordId,
      acat_transfer_id: acatTransferId,
      acat_auto_link_hold: true,
      acat_link_provenance: "MANUAL",
      acat_link_decision_id: null,
      created_by: identity.email ?? null,
      updated_by: identity.email ?? null,
      // stage_entered_at: DB default now() — enters IN_TRANSFER at creation.
      tasks: {
        create: DEFAULT_TASKS[input.stage].map((title, i) => ({
          title,
          sort_order: i,
        })),
      },
    },
  });

  await writeAudit(tx, identity, {
    action: TRANSFER_CREATE,
    entityType: "transfer",
    entityId: transfer.id,
    detail: {
      stage: input.stage,
      value: input.value,
      source: input.source,
      acat_record_id: acatRecordId,
      acat_transfer_id: acatTransferId,
      prospect: isUnmatchedProspect(input),
    },
  });

  return { ok: true, id: transfer.id };
}

/**
 * Attach an ACAT onto an EXISTING open transfer instead of creating a
 * duplicate. Guards: a non-blank record id (the required, primary link key),
 * the transfer must exist, must not already carry an ACAT by EITHER column
 * (TRANSFER_ALREADY_HAS_ACAT), and the ACAT must not be linked elsewhere —
 * record-id PRIMARY, legacy-UUID secondary (ACAT_ALREADY_LINKED). Updates only
 * the two link ids + `updated_by`, then writes the TRANSFER_UPDATE audit with
 * the {from:null,to} change map (the setOwner / updateTransfer idiom).
 */
export async function attachAcatToTransfer(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transferId: string,
  key: AcatLinkKey,
): Promise<AttachWriteResult> {
  if (isBlankAcatId(key.recordId))
    return { ok: false, errors: [LINK_ERRORS.ACAT_RECORD_ID_REQUIRED] };
  const current = await tx.transfer.findUnique({ where: { id: transferId } });
  if (!current) return { ok: false, errors: [LINK_ERRORS.TRANSFER_NOT_FOUND] };
  if (current.acat_record_id != null || current.acat_transfer_id != null)
    return { ok: false, errors: [LINK_ERRORS.TRANSFER_ALREADY_HAS_ACAT] };
  const result = await setManualAcatLinkWithinScope(tx, identity, {
    transferId, expectedVersion: current.acat_link_version,
    expectedRecordId: null, expectedTransferUuid: null,
    recordId: key.recordId, acatTransferId: key.acatTransferId,
  });
  return !result.ok && result.errors[0] === LINK_ERRORS.ACAT_LINK_CHANGED
    ? { ok: false, errors: [LINK_ERRORS.TRANSFER_ALREADY_HAS_ACAT] } : result;
}

/**
 * Clear only the ACAT reference on the intended visible, active transfer. The
 * drawer's tracker record ID is authoritative; a legacy UUID may match only
 * when the transfer has no record ID. No tracker read is needed to remove a
 * stale/unavailable reference, and no upstream tracker record is changed.
 *
 * The conditional update pins BOTH stored IDs and the archive boundary from
 * this read. A concurrent relink, unlink or archive therefore writes nothing
 * and produces no audit. The caller owns the user-scoped transaction, including
 * the TRANSFER_UPDATE audit, so audit failure rolls back the unlink.
 */
export async function unlinkAcatFromTransfer(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transferId: string,
  expectedAcat: AcatLinkKey,
): Promise<AttachWriteResult> {
  if (typeof transferId !== "string" || transferId.trim() === "") {
    return { ok: false, errors: [LINK_ERRORS.TRANSFER_NOT_FOUND] };
  }
  if (typeof expectedAcat?.recordId !== "string" || isBlankAcatId(expectedAcat.recordId)) {
    return { ok: false, errors: [LINK_ERRORS.ACAT_RECORD_ID_REQUIRED] };
  }

  const current = await tx.transfer.findUnique({
    where: { id: transferId },
    select: { id: true, acat_record_id: true, acat_transfer_id: true, archived_at: true, acat_link_version: true },
  });
  if (!current) return { ok: false, errors: [LINK_ERRORS.TRANSFER_NOT_FOUND] };
  if (current.archived_at != null) {
    return { ok: false, errors: [LINK_ERRORS.TRANSFER_ARCHIVED] };
  }
  // Retrying after a successful request (for example a lost response) is a
  // no-op. Keep the visibility/archive checks above, and do not write a second
  // audit or touch updated_by when there is no remaining association.
  if (current.acat_record_id == null && current.acat_transfer_id == null) {
    return { ok: true };
  }

  const expectedUuid = normalizeAcatTransferId(expectedAcat.acatTransferId);
  const matches = current.acat_record_id != null
    ? current.acat_record_id === expectedAcat.recordId
    : expectedUuid != null && normalizeAcatTransferId(current.acat_transfer_id) === expectedUuid;
  if (!matches) return { ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] };

  return setManualAcatLinkWithinScope(tx, identity, {
    transferId, expectedVersion: current.acat_link_version,
    expectedRecordId: current.acat_record_id, expectedTransferUuid: current.acat_transfer_id,
    recordId: null, acatTransferId: null,
  });
}

export type AcatLinkMutationInput = {
  transferId: string;
  expectedVersion: number;
  expectedRecordId: string | null;
  expectedTransferUuid: string | null;
  recordId: string | null;
  acatTransferId: string | null;
  hold: boolean;
  provenance: "MANUAL" | "AUTOMATIC" | "REVIEWED" | "UNDO";
  decisionId: string | null;
  auditAction: string;
};

/** Sole link-column update seam. Caller owns the scoped transaction, source
 * authorization and candidate-set checks. The conditional UPDATE fences even
 * callers that did not lock the row, and DB unique indexes reserve all links.
 * Revision is database-owned; never calculate or write an old counter back. */
export async function writeAcatLinkWithinScope(
  tx: Prisma.TransactionClient,
  identity: Identity,
  input: AcatLinkMutationInput,
): Promise<{ ok: true; appliedVersion: number } | { ok: false; errors: TransferValidationError[] }> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
    return { ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] };
  if (input.recordId !== null && isBlankAcatId(input.recordId))
    return { ok: false, errors: [LINK_ERRORS.ACAT_RECORD_ID_REQUIRED] };
  const uuid = input.provenance === "UNDO" ? input.acatTransferId : normalizeAcatTransferId(input.acatTransferId);
  if (input.recordId !== null) {
    const other = await tx.transfer.findFirst({ where: {
      id: { not: input.transferId }, acat_record_id: input.recordId,
    } });
    if (other) return { ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] };
  }
  if (uuid !== null) {
    const other = await tx.transfer.findFirst({ where: {
      ...transferIdDuplicateWhere(uuid), id: { not: input.transferId },
    } });
    if (other) return { ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] };
  }
  const updated = await tx.transfer.updateMany({
    where: { id: input.transferId, acat_link_version: input.expectedVersion,
      ...(input.provenance === "MANUAL" ? { archived_at: null } : {}),
      acat_record_id: input.expectedRecordId, acat_transfer_id: input.expectedTransferUuid },
    data: { acat_record_id: input.recordId, acat_transfer_id: uuid,
      acat_auto_link_hold: input.hold, acat_link_provenance: input.provenance,
      acat_link_decision_id: input.decisionId, updated_by: identity.email ?? null },
  });
  if (updated.count !== 1) return { ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] };
  const current = await tx.transfer.findUnique({ where: { id: input.transferId }, select: { acat_link_version: true } });
  if (!current) throw new Error("ACAT link target disappeared after update");
  const changes: Record<string, { from: string | null; to: string | null }> = {};
  if (input.expectedRecordId !== input.recordId) changes.acat_record_id = { from: input.expectedRecordId, to: input.recordId };
  if (input.expectedTransferUuid !== uuid) changes.acat_transfer_id = { from: input.expectedTransferUuid, to: uuid };
  await writeAudit(tx, identity, { action: input.auditAction, entityType: "transfer", entityId: input.transferId,
    detail: { changes, acat_link_version: current.acat_link_version, provenance: input.provenance, automation_hold: input.hold,
      decision_id: input.decisionId,
      link_before: { recordId: input.expectedRecordId, transferUuid: input.expectedTransferUuid },
      link_after: { recordId: input.recordId, transferUuid: uuid } } });
  return { ok: true, appliedVersion: current.acat_link_version };
}

export async function setManualAcatLinkWithinScope(
  tx: Prisma.TransactionClient,
  identity: Identity,
  input: Omit<AcatLinkMutationInput, "hold" | "provenance" | "decisionId" | "auditAction">,
): Promise<AttachWriteResult> {
  const result = await writeAcatLinkWithinScope(tx, identity, {
    ...input, hold: true, provenance: "MANUAL", decisionId: null, auditAction: TRANSFER_UPDATE,
  });
  return result.ok ? { ok: true } : result;
}
