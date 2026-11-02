import "server-only";
import { Prisma } from "@prisma/client";
import { CUSTODIAN_AUTHORITY_MERGE, CUSTODIAN_AUTHORITY_SAVE, writeAudit } from "@/lib/audit";
import { custodianAdminAllowed, custodianAuthorityStorageWritesEnabled } from "@/lib/flags";
import { withUserScope, type Identity } from "@/lib/rls";

export type CustodianAuthorityRefusal =
  | "writes_disabled"
  | "not_permitted"
  | "transfer_copy_behind"
  | "not_found"
  | "invalid_merge"
  | "save_failed"
  | "merge_failed"
  | "read_failed";

export type CustodianAuthorityResult<T> = { ok: true; value: T } | { ok: false; reason: CustodianAuthorityRefusal };

export type CustodianProfileInput = {
  id?: string;
  name: string;
  acat_fee_amount?: number;
  avg_processing_days?: number;
  contact_email?: string | null;
  contact_method?: string | null;
  contact_details?: string | null;
  review_status?: string;
  transfer_type?: string | null;
  documentation_status?: string | null;
  dtc_number?: string | null;
  receiving_account_number?: string | null;
  signature?: string | null;
  letter_of_acceptance?: string | null;
  medallion_required?: string | null;
  liquidation_method?: string | null;
  return_method?: string | null;
  watchouts?: string | null;
  paperwork_on_file?: boolean | null;
  transfers_to_date?: number | null;
};

export type CustodianFeeRuleInput = {
  id?: string;
  fee_type: string;
  account_type?: string;
  transfer_type?: string;
  direction?: string;
  amount?: number | null;
  amount_text?: string | null;
  notes?: string | null;
  documentation?: string | null;
};

/** The complete desired state of one custodian: active fee rules missing from `fees` are retired. */
export type CustodianSaveInput = { profile: CustodianProfileInput; fees: CustodianFeeRuleInput[] };

/** One accepted change-log row. `body` is that event's payload. ticket delivers these in `revision` order. */
export type CustodianAuthorityRevision = {
  readonly revision: number;
  readonly body: unknown;
};

export type CustodianAuthorityFeeRecord = {
  readonly id: string;
  readonly feeType: string;
  readonly accountType: string;
  readonly transferType: string;
  readonly direction: string;
  readonly amount: number | null;
  readonly amountText: string | null;
  readonly notes: string | null;
  readonly documentation: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: string;
};

/** Active profile as stored. Observed timing is not stored here; ticket overlays it. */
export type CustodianAuthorityProfileRecord = {
  readonly id: string;
  readonly name: string;
  readonly acatFeeAmount: number;
  readonly avgProcessingDays: number;
  readonly contactEmail: string | null;
  readonly contactMethod: string | null;
  readonly contactDetails: string | null;
  readonly reviewStatus: string;
  readonly transferType: string | null;
  readonly documentationStatus: string | null;
  readonly dtcNumber: string | null;
  readonly receivingAccountNumber: string | null;
  readonly signature: string | null;
  readonly letterOfAcceptance: string | null;
  readonly medallionRequired: string | null;
  readonly liquidationMethod: string | null;
  readonly returnMethod: string | null;
  readonly watchouts: string | null;
  readonly paperworkOnFile: boolean | null;
  readonly transfersToDate: number | null;
  readonly mergedIntoId: string | null;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fees: readonly CustodianAuthorityFeeRecord[];
};

/**
 * ticket's cron has no user session. Listing and confirming run as ADMIN so the
 * existing read and state-update policies apply. This email is the row-change actor
 * for a confirmation; it is not a person.
 */
const DELIVERY_IDENTITY: Identity = {
  role: "ADMIN",
  email: "custodian-authority-delivery@example.test",
};

class CustodianAuthorityRefused extends Error {
  constructor(readonly reason: CustodianAuthorityRefusal) {
    super(reason);
  }
}

function writeGate(identity: Identity): CustodianAuthorityRefusal | null {
  if (!custodianAuthorityStorageWritesEnabled()) return "writes_disabled";
  if (!custodianAdminAllowed(identity.role)) return "not_permitted";
  return null;
}

function readGate(role: string): CustodianAuthorityRefusal | null {
  if (role !== "ADMIN" && role !== "OPERATIONS") return "not_permitted";
  return null;
}

async function nextRevision(tx: Prisma.TransactionClient): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ accepted_revision: bigint; confirmed_revision: bigint }>>`
    SELECT accepted_revision, confirmed_revision
      FROM app.custodian_authority_state
     WHERE id = 1
       FOR UPDATE`;
  const state = rows[0];
  if (!state) throw new Error("custodian authority state row is missing");
  if (state.accepted_revision !== state.confirmed_revision) throw new CustodianAuthorityRefused("transfer_copy_behind");
  return state.accepted_revision + BigInt(1);
}

async function acceptRevision(tx: Prisma.TransactionClient, revision: bigint): Promise<void> {
  await tx.custodianAuthorityState.update({ where: { id: 1 }, data: { accepted_revision: revision } });
}

async function custodianSnapshot(tx: Prisma.TransactionClient, custodianId: string): Promise<Prisma.InputJsonValue> {
  const profile = await tx.custodianProfile.findUniqueOrThrow({
    where: { id: custodianId },
    include: { fee_rules: { where: { retired_at: null }, orderBy: { id: "asc" } } },
  });
  return JSON.parse(JSON.stringify(profile, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
}

/** JSON trace only. Tests record the case with `markCase`. Never include the profile, the event body, or an email. */
function traceCustodianAuthority(fields: {
  operation: "save" | "merge" | "read" | "confirm";
  outcome: CustodianAuthorityRefusal | "revision_not_accepted";
}): void {
  const runId = process.env.TEST_RUN_ID ?? "runtime";
  console.error(JSON.stringify({
    feature: "custodian-authority", operation: fields.operation, outcome: fields.outcome, run_id: runId,
  }));
}

function refuseRevision(): never {
  traceCustodianAuthority({ operation: "confirm", outcome: "revision_not_accepted" });
  throw new Error("revision_not_accepted");
}

function feeRecord(fee: {
  id: string;
  fee_type: string;
  account_type: string;
  transfer_type: string;
  direction: string;
  amount: number | null;
  amount_text: string | null;
  notes: string | null;
  documentation: string | null;
  created_at: Date;
  updated_at: Date;
  revision: bigint;
}): CustodianAuthorityFeeRecord {
  return {
    id: fee.id,
    feeType: fee.fee_type,
    accountType: fee.account_type,
    transferType: fee.transfer_type,
    direction: fee.direction,
    amount: fee.amount,
    amountText: fee.amount_text,
    notes: fee.notes,
    documentation: fee.documentation,
    createdAt: fee.created_at.toISOString(),
    updatedAt: fee.updated_at.toISOString(),
    revision: fee.revision.toString(),
  };
}

/**
 * Save one custodian profile and its complete fee-rule set as one authority revision.
 * Everything (profile, fee rules, change-log event, audit row, accepted revision) commits
 * in one transaction or not at all; a refused or failed save leaves every prior row unchanged.
 */
export async function saveCustodianAuthority(
  identity: Identity,
  input: CustodianSaveInput,
): Promise<CustodianAuthorityResult<{ custodianId: string; revision: bigint }>> {
  const refused = writeGate(identity);
  if (refused) return { ok: false, reason: refused };
  try {
    const value = await withUserScope(identity, async (tx) => {
      const revision = await nextRevision(tx);
      const { id, ...profileFields } = input.profile;
      let custodianId: string;
      let created = false;
      if (id) {
        const existing = await tx.custodianProfile.findUnique({ where: { id }, select: { retired_at: true } });
        if (existing?.retired_at) throw new CustodianAuthorityRefused("not_found");
        if (existing) {
          await tx.custodianProfile.update({ where: { id }, data: { ...profileFields, revision } });
          custodianId = id;
        } else {
          await tx.custodianProfile.create({ data: { id, ...profileFields, revision } });
          custodianId = id;
          created = true;
        }
      } else {
        const row = await tx.custodianProfile.create({ data: { ...profileFields, revision }, select: { id: true } });
        custodianId = row.id;
        created = true;
      }

      const active = await tx.custodianFeeRule.findMany({
        where: { custodian_id: custodianId, retired_at: null },
        select: { id: true },
      });
      const activeIds = new Set(active.map((fee) => fee.id));
      const keptIds = new Set<string>();
      for (const { id: feeId, ...feeFields } of input.fees) {
        if (feeId && activeIds.has(feeId)) {
          await tx.custodianFeeRule.update({ where: { id: feeId }, data: { ...feeFields, revision } });
          keptIds.add(feeId);
        } else if (feeId && created) {
          const owner = await tx.custodianFeeRule.findUnique({ where: { id: feeId }, select: { id: true } });
          if (owner) throw new CustodianAuthorityRefused("not_found");
          await tx.custodianFeeRule.create({
            data: { id: feeId, ...feeFields, custodian_id: custodianId, revision },
          });
          keptIds.add(feeId);
        } else if (feeId) {
          throw new CustodianAuthorityRefused("not_found");
        } else {
          await tx.custodianFeeRule.create({ data: { ...feeFields, custodian_id: custodianId, revision } });
        }
      }
      const retiredIds = [...activeIds].filter((feeId) => !keptIds.has(feeId));
      if (retiredIds.length > 0) {
        await tx.custodianFeeRule.updateMany({
          where: { id: { in: retiredIds } },
          data: { retired_at: new Date(), revision },
        });
      }

      await tx.custodianAuthorityEvent.create({
        data: {
          revision, kind: "CUSTODIAN_SAVE", custodian_id: custodianId,
          payload: await custodianSnapshot(tx, custodianId), actor_email: identity.email ?? "",
        },
      });
      await writeAudit(tx, identity, {
        action: CUSTODIAN_AUTHORITY_SAVE, entityType: "custodian", entityId: custodianId,
        detail: { revision: revision.toString(), created, feeRules: input.fees.length, retiredFeeRules: retiredIds.length },
      });
      await acceptRevision(tx, revision);
      return { custodianId, revision };
    });
    return { ok: true, value };
  } catch (error) {
    const reason = error instanceof CustodianAuthorityRefused ? error.reason : "save_failed";
    traceCustodianAuthority({ operation: "save", outcome: reason });
    return { ok: false, reason };
  }
}

/**
 * Merge `sourceId` into `targetId` as one authority revision: the source is retired with
 * merged_into_id = target and one CUSTODIAN_MERGE event is logged for the transfer copy,
 * which reassigns its transfers when it applies that event. A refused or failed merge
 * writes nothing, so both custodians and the change log stay unchanged.
 */
export async function mergeCustodianAuthority(
  identity: Identity,
  input: { sourceId: string; targetId: string },
): Promise<CustodianAuthorityResult<{ targetId: string; revision: bigint }>> {
  const refused = writeGate(identity);
  if (refused) return { ok: false, reason: refused };
  if (!input.sourceId || input.sourceId === input.targetId) return { ok: false, reason: "invalid_merge" };
  try {
    const value = await withUserScope(identity, async (tx) => {
      const revision = await nextRevision(tx);
      const rows = await tx.$queryRaw<Array<{ id: string; name: string; retired_at: Date | null }>>`
        SELECT id, name, retired_at
          FROM app.custodian_profile
         WHERE id IN (${input.sourceId}, ${input.targetId})
           FOR UPDATE`;
      const source = rows.find((row) => row.id === input.sourceId);
      const target = rows.find((row) => row.id === input.targetId);
      if (!source || !target || source.retired_at || target.retired_at) throw new CustodianAuthorityRefused("not_found");

      await tx.custodianProfile.update({
        where: { id: source.id },
        data: { retired_at: new Date(), merged_into_id: target.id, revision },
      });
      await tx.custodianProfile.update({ where: { id: target.id }, data: { revision } });
      await tx.custodianAuthorityEvent.create({
        data: {
          revision, kind: "CUSTODIAN_MERGE", custodian_id: target.id, merged_from_id: source.id,
          payload: { source: { id: source.id, name: source.name }, target: await custodianSnapshot(tx, target.id) },
          actor_email: identity.email ?? "",
        },
      });
      await writeAudit(tx, identity, {
        action: CUSTODIAN_AUTHORITY_MERGE, entityType: "custodian", entityId: target.id,
        detail: { revision: revision.toString(), sourceId: source.id },
      });
      await acceptRevision(tx, revision);
      return { targetId: target.id, revision };
    });
    return { ok: true, value };
  } catch (error) {
    const reason = error instanceof CustodianAuthorityRefused ? error.reason : "merge_failed";
    traceCustodianAuthority({ operation: "merge", outcome: reason });
    return { ok: false, reason };
  }
}

/**
 * Active custodian profiles and their active fee rules. Retired profiles and retired
 * fee rules are omitted. This does not read the write switch: the library can be on
 * while new edits are off. ticket maps this shape onto the library schema and
 * overlays observed timing; it does not rename this function. The argument is the
 * role string `getCustodianLibrary` already receives. Profile SELECT RLS keys off
 * `app.user_role` only, so no email is required. Save and merge still take Identity.
 */
export async function readCustodianAuthorityProfiles(
  role: string,
): Promise<CustodianAuthorityResult<readonly CustodianAuthorityProfileRecord[]>> {
  const refused = readGate(role);
  if (refused) return { ok: false, reason: refused };
  try {
    const value = await withUserScope({ role }, async (tx) => {
      const rows = await tx.custodianProfile.findMany({
        where: { retired_at: null },
        orderBy: { name: "asc" },
        include: { fee_rules: { where: { retired_at: null }, orderBy: { id: "asc" } } },
      });
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        acatFeeAmount: row.acat_fee_amount,
        avgProcessingDays: row.avg_processing_days,
        contactEmail: row.contact_email,
        contactMethod: row.contact_method,
        contactDetails: row.contact_details,
        reviewStatus: row.review_status,
        transferType: row.transfer_type,
        documentationStatus: row.documentation_status,
        dtcNumber: row.dtc_number,
        receivingAccountNumber: row.receiving_account_number,
        signature: row.signature,
        letterOfAcceptance: row.letter_of_acceptance,
        medallionRequired: row.medallion_required,
        liquidationMethod: row.liquidation_method,
        returnMethod: row.return_method,
        watchouts: row.watchouts,
        paperworkOnFile: row.paperwork_on_file,
        transfersToDate: row.transfers_to_date,
        mergedIntoId: row.merged_into_id,
        revision: row.revision.toString(),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        fees: row.fee_rules.map(feeRecord),
      }));
    });
    return { ok: true, value };
  } catch (error) {
    const reason = error instanceof CustodianAuthorityRefused ? error.reason : "read_failed";
    traceCustodianAuthority({ operation: "read", outcome: reason });
    return { ok: false, reason };
  }
}

/**
 * Every accepted revision, oldest first. `body` is the event payload.
 * Confirmed revisions stay in the list: ticket walks all of them and treats
 * Tracker's duplicate answer as its cursor.
 */
export async function listCustodianAuthorityRevisions(): Promise<readonly CustodianAuthorityRevision[]> {
  return withUserScope(DELIVERY_IDENTITY, async (tx) => {
    const events = await tx.custodianAuthorityEvent.findMany({ orderBy: { revision: "asc" } });
    return events.map((event) => ({ revision: Number(event.revision), body: event.payload }));
  });
}

/**
 * Record that the transfer copy has confirmed `revision`.
 * A revision already at or behind `confirmed_revision` resolves without a write.
 * The next unconfirmed revision resolves by advancing `confirmed_revision` by one,
 * and only when that revision is an event and is not past `accepted_revision`.
 * Any other revision throws `revision_not_accepted` and writes nothing.
 * Not gated by the write switch: turning edits off must not strand an accepted revision.
 */
export async function confirmCustodianAuthorityRevision(revision: number): Promise<void> {
  if (!Number.isSafeInteger(revision) || revision < 1) refuseRevision();
  await withUserScope(DELIVERY_IDENTITY, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ accepted_revision: bigint; confirmed_revision: bigint }>>`
      SELECT accepted_revision, confirmed_revision
        FROM app.custodian_authority_state
       WHERE id = 1
         FOR UPDATE`;
    const state = rows[0];
    if (!state) throw new Error("custodian authority state row is missing");
    const target = BigInt(revision);
    if (target <= state.confirmed_revision) return;
    if (target > state.accepted_revision || target !== state.confirmed_revision + BigInt(1)) refuseRevision();
    const event = await tx.custodianAuthorityEvent.findUnique({ where: { revision: target }, select: { revision: true } });
    if (!event) refuseRevision();
    await tx.custodianAuthorityState.update({ where: { id: 1 }, data: { confirmed_revision: target } });
  });
}
